/** API — the provider-agnostic HTTP client: request shaping, retry/backoff, and streaming.
 *  Where the requests go, which headers they carry, and whether optional fields like
 *  `reasoning_effort` belong on the wire all come from the selected provider (provider.ts). */
import { C } from "../ansi.ts";
import { RUN, StoppedError } from "../live.ts";
import { ENGINE, progress, progressDone } from "./engine-state.ts";
import { warn } from "./warnings.ts";
import { topLevelObjects } from "./json-extract.ts";
import { PROVIDER } from "./provider.ts";
import { onceAdmitted, QueueGaveUpError, TELEMETRY, announceProviderState } from "./req-queue.ts";
import type { ThinkLevel } from "./story-schema.ts";

/** A deliberately pessimistic token estimate -- prose runs about 4 chars/token, the JSON the
 *  architect trades in runs denser, and guessing high is the safe direction for a fit check. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 3.5);

type Role = "system" | "user" | "assistant";
/** One chat message: role plus content. */
export interface Msg { role: Role; content: string; }

/** Token counts an OpenAI-compatible server may report for a completion. */
export interface CompletionUsage {
  promptTokens: number;
  completionTokens: number;
}

/** The result of a completion: the answer text plus whatever usage the server reported (null when
 *  absent). `reasoning` carries the model's chain-of-thought when the server delivered it as a
 *  field separate from the answer — it is never part of `text`. `reasoningOnly` marks the reply
 *  that arrived entirely through the reasoning channel (some thinking models do this), where the
 *  fallback made it the answer after all. */
export interface Completion {
  text: string;
  usage: CompletionUsage | null;
  reasoning: string | null;
  finishReason: string | null;
  reasoningOnly: boolean;
  /** True when the stream broke off mid-reply but a finished object was salvaged from what had
   *  already arrived — the text is real, but it is not the whole reply the model meant to send. */
  brokenOff: boolean;
}

/** What either transport path sees before classification. */
interface RawReply { content: string; reasoning: string; finishReason: string | null }

/** The one classification rule for what part of a reply is the answer, shared by both transport
 *  paths so a thinking model behaves identically streamed or buffered: content wins wholesale and
 *  any separate reasoning is carried alongside it — never concatenated with the text. A reply that
 *  arrived only as reasoning falls back to being the text, flagged. */
function assembleReply(r: RawReply): Omit<Completion, "usage"> {
  const content = r.content.trim();
  const reason = r.reasoning.trim();
  if (content)
    return { text: content, reasoning: reason || null, finishReason: r.finishReason,
             reasoningOnly: false, brokenOff: false };
  return { text: reason, reasoning: null, finishReason: r.finishReason,
           reasoningOnly: true, brokenOff: false };
}

/** Normalize an OpenAI-style `usage` object into our shape, or null when it is missing/invalid. */
function parseUsage(u: any): CompletionUsage | null {
  const pt = u?.prompt_tokens, ct = u?.completion_tokens;
  if (typeof pt !== "number" || typeof ct !== "number") return null;
  return { promptTokens: pt, completionTokens: ct };
}

/** The retry/backoff knobs, settable per run from a story's config. */
export const NET = { retries: 2, timeoutMs: 120_000, backoffMs: 800,
                     probeTimeoutMs: 1500, recoveryProbes: 2, maxCallMs: 600_000,
                     loadWaitMs: 300_000 };

/** The JSON body for one completion. Exported for the capability tests: whether
 *  `reasoning_effort` goes on the wire is the provider's decision, not the caller's. */
export function requestBody(model: string, messages: Msg[], temperature: number, stream: boolean, think: ThinkLevel) {
  const body: Record<string, unknown> = { model, messages, temperature, max_tokens: ENGINE.maxTokens, stream };
  if (stream) body.stream_options = { include_usage: true };
  if (think !== "default" && PROVIDER.capabilities.reasoningEffort)
    body.reasoning_effort = think === "off" ? "none" : think;
  return JSON.stringify(body);
}

class LmError extends Error {
  constructor(message: string, public status?: number, public retryable = false) { super(message); }
}

/** Thrown when the provider stops answering the model list during recovery — retrying blind
 *  would only wait. The message names the endpoint and what to do. */
export class ProviderDownError extends Error { }
/** Thrown when a logical call has spent its whole wall-clock budget across attempts. */
export class CallBudgetError extends Error { }

const retryableStatus = (s: number) => s === 408 || s === 409 || s === 425 || s === 429 || s >= 500;

/** What kind of failure an attempt ended with — the retry decision and every diagnostic word
 *  hang off this. Exported for the failure tests. */
export function failureKind(e: unknown): string {
  if (e instanceof LmError) {
    if (e.status !== undefined) return "http-error";
    if (/non-JSON/.test(e.message)) return "invalid-response";
    if (/empty/.test(e.message)) return "empty-response";
    return "unknown";
  }
  const cause = String((e as { cause?: unknown })?.cause ?? "");
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(cause)) return "unreachable";
  if (/ECONNRESET|EPIPE|socket hang up|terminated|fetch failed/i.test(cause + String(e)))
    return "connection-dropped";
  return "unknown";
}

async function withRetry<T>(what: string, fn: (signal: AbortSignal, heartbeat: () => void) => Promise<T>,
                            call?: CallSite): Promise<T> {
  let last: unknown;
  const startedAt = Date.now();
  for (let attempt = 0; ; attempt++) {
    if (RUN.stopped) throw new StoppedError();
    // Whether OUR idle deadline aborted the request (as opposed to the run's stop signal).
    let idleAborted = false;
    try {
      // One transport attempt holds the queue slot; the backoff between attempts, and a retry's
      // re-entry, happen off it — so a retry cannot monopolize a slot it is not using.
      return await onceAdmitted(what, call, async () => {
        const ac = new AbortController();
        // An IDLE deadline, not a total-duration cap: `heartbeat()` pushes it back on each sign of
        // progress, so a long-but-streaming generation is never aborted mid-reply -- only a stalled
        // connection that goes NET.timeoutMs without a byte is.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const heartbeat = () => {
          clearTimeout(timer);
          timer = setTimeout(() => { idleAborted = true; ac.abort(); }, NET.timeoutMs);
        };
        heartbeat();
        const onStop = () => ac.abort();
        RUN.abort.signal.addEventListener("abort", onStop, { once: true });
        try {
          return await fn(ac.signal, heartbeat);
        } finally {
          clearTimeout(timer);
          RUN.abort.signal.removeEventListener("abort", onStop);
        }
      });
    } catch (e) {
      if (RUN.stopped) throw new StoppedError();
      last = e;
      // Waiting twice cannot help: the holder of the slot was stuck for the whole budget, and
      // re-queueing would only wait again. Say what was holding it and let the caller see it.
      if (e instanceof QueueGaveUpError) throw e;
      if (e instanceof ProviderDownError || e instanceof CallBudgetError) throw e;
      // The idle deadline aborts with an opaque AbortError — the one classification failureKind
      // cannot see, and the one the reader of a failure most wants named.
      const kind = idleAborted ? "idle-timeout" : failureKind(e);
      TELEMETRY.last = { what, kind, message: (e as Error).message, site: call?.site, agent: call?.agent, at: Date.now() };
      announceProviderState();
      const err = e as LmError;
      const retryable = idleAborted || err.retryable
        || (err.status === undefined && e instanceof Error);
      if (idleAborted) last = new LmError(`${what}: no reply within ${NET.timeoutMs / 1000}s`, undefined, true);
      if (!retryable || attempt >= NET.retries) break;
      const wait = NET.backoffMs * 2 ** attempt + Math.floor(Math.random() * 250);
      if (Date.now() - startedAt + wait > NET.maxCallMs)
        throw new CallBudgetError(`${what}: gave up after ${Math.round((Date.now() - startedAt) / 1000)}s `
          + `across ${attempt + 1} attempt${attempt ? "s" : ""} — the call's total budget is `
          + `${Math.round(NET.maxCallMs / 1000)}s`);
      progressDone();
      warn(`   ${C.yellow}⟳${C.reset} ${what} failed (${(last as Error).message}) — retry `
        + `${attempt + 1}/${NET.retries} in ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
      // Health gate before spending another model attempt. This is reachability, not model
      // state: any HTTP answer (even a 500) means the server is standing. The probe is metadata
      // only — no generation, no preemption — so it is asked directly, not through the queue.
      let down = 0;
      for (;;) {
        if (await PROVIDER.health(NET.probeTimeoutMs)) {
          if (kind === "unreachable" || kind === "connection-dropped")
            warn(`   ${C.dim}${PROVIDER.displayName} is answering again — retrying${C.reset}`);
          else if (idleAborted)
            warn(`   ${C.yellow}${PROVIDER.displayName} is alive but the model stopped replying — `
              + `another client may be preempting it${C.reset}`);
          break;
        }
        down++;
        if (down > NET.recoveryProbes)
          throw new ProviderDownError(`${PROVIDER.displayName} at ${PROVIDER.baseUrl} is not answering `
            + `— is its server running?`);
        progressDone();
        warn(`   ${C.dim}${PROVIDER.displayName} is not answering — giving it ${down}/${NET.recoveryProbes} `
          + `chances to come back before giving up${C.reset}`);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
  throw last;
}

/** The header carrying the engine's own name for the call site behind a request — `writer.draft`,
 *  `judge.answer`. It rides OUTSIDE the JSON body on purpose: the model never sees it, so it cannot
 *  affect tokenization or a reply, while anything sitting on the wire (a test's fetch fake, a
 *  recording proxy, the replay harness) can tell one caller from another without matching on prompt
 *  text. Prompt text drifts — the writer's system prompt moved by a thousand characters in four days
 *  of ordinary work — and a matcher keyed on it silently misroutes when it does. */
export const SITE_HEADER = "X-SW-Site";
/** The agent that made the call, beside its site. Both are needed to name a call uniquely: two
 *  characters in one scene share the site `character.consult` and differ only by who is answering,
 *  and serving one character's reply to the other would be silently wrong. This pair is exactly the
 *  key the transcripts are written under, so the wire and the log name a call the same way. */
export const AGENT_HEADER = "X-SW-Agent";

/** Who is calling and from where — the transport sends both as headers, never in the body. */
export interface CallSite { site: string; agent?: string }

async function postChat(body: string, signal: AbortSignal, call?: CallSite) {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...PROVIDER.headers() };
  if (call?.site) headers[SITE_HEADER] = call.site;
  if (call?.agent) headers[AGENT_HEADER] = call.agent;
  const res = await fetch(PROVIDER.chatUrl, { method: "POST", headers, body, signal });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new LmError(`${PROVIDER.displayName} ${res.status}: ${detail.slice(0, 200)}`, res.status, retryableStatus(res.status));
  }
  return res;
}

// -- MODEL READINESS --------------------------------------------------------
/** Thrown when the server never finishes bringing a model up within the wait budget. */
export class ModelLoadTimeoutError extends Error { }

/** Models the not-loaded warning has already fired for — once per process, not once per call. */
const notLoadedWarned = new Set<string>();

/** Wait for the server to finish bringing `model` up before the first attempt, so a load in
 *  progress never burns retry attempts or trips the idle deadline. A model the server reports
 *  as not loaded is only warned about: the engine never loads models on its own — that is
 *  orchestration, and on a limited-VRAM box it is the operator's call. Metadata only, asked
 *  before the queue: it does no model work and never preempts anything. */
async function waitReady(model: string) {
  if (!PROVIDER.capabilities.modelRuntimeInspection) return;
  const m = (await PROVIDER.inspectModels(NET.probeTimeoutMs))?.get(model);
  if (!m || m.state === "loaded" || m.state === "unknown") return;
  if (m.state === "not-loaded") {
    if (!notLoadedWarned.has(model)) {
      notLoadedWarned.add(model);
      warn(`   ${C.yellow}⚠${C.reset} ${model} is not loaded in ${PROVIDER.displayName} — the first call `
        + `may wait on a just-in-time load, or fail fast if JIT loading is off`);
    }
    return;
  }
  // state "loading": the server is already bringing it up — wait it out.
  const startedAt = Date.now();
  try {
    for (;;) {
      if (RUN.stopped) throw new StoppedError();
      if (Date.now() - startedAt > NET.loadWaitMs)
        throw new ModelLoadTimeoutError(`${model} is still loading after ${Math.round(NET.loadWaitMs / 1000)}s `
          + `— load it in ${PROVIDER.displayName} first, or raise the wait`);
      await new Promise(r => setTimeout(r, 1000));
      const state = (await PROVIDER.inspectModels(NET.probeTimeoutMs))?.get(model)?.state;
      if (state !== "loading") return;   // loaded — or the load gave up server-side; let the call report it
      progress(`waiting for ${model} to load… ${Math.round((Date.now() - startedAt) / 1000)}s`);
    }
  } finally {
    progressDone();
  }
}

/** One non-streaming completion, with retry/backoff; throws StoppedError when the run is stopped. */
export async function complete(model: string, messages: Msg[], temperature: number, think: ThinkLevel = "low",
                               call?: CallSite): Promise<Completion> {
  await waitReady(model);
  return withRetry(`${model} completion`, async signal => {
    const res = await postChat(requestBody(model, messages, temperature, false, think), signal, call);
    // Read the body as text first: a 200 whose body will not parse (a proxy error page, LM Studio
    // dying mid-request) is transient infrastructure failure, so it becomes a retryable LmError
    // naming the model with a snippet — not an opaque SyntaxError that kills the call on its first
    // attempt. An empty body lands in the same bucket as an empty completion.
    const rawBody = await res.text();
    let data: any;
    try { data = JSON.parse(rawBody); }
    catch {
      throw new LmError(`${model} sent a non-JSON reply: ${rawBody.slice(0, 120) || "(empty body)"}`,
                        undefined, true);
    }
    const choice = data.choices?.[0];
    const assembled = assembleReply({
      content: typeof choice?.message?.content === "string" ? choice.message.content : "",
      reasoning: typeof choice?.message?.reasoning_content === "string" ? choice.message.reasoning_content : "",
      finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
    });
    if (ENGINE.debug) process.stderr.write(`\n[DEBUG complete] model=${model} len=${assembled.text.length} src=${assembled.reasoningOnly ? "reasoning_content" : "content"} raw=${JSON.stringify(assembled.text.slice(0, 300))}\n`);
    // An empty 200 is the other shape "never replied" takes; spend a retry rather than a caller call.
    if (!assembled.text) throw new LmError(`${model} returned an empty completion`, undefined, true);
    return { ...assembled, brokenOff: false, usage: parseUsage(data.usage) };
  }, call);
}

/** A streaming completion. Returns the FULL text (the caller buffers -> parses -> checks); onDelta is preview only. */
export async function completeStream(model: string, messages: Msg[], temperature: number,
                                     onDelta: (d: string) => void, think: ThinkLevel = "low",
                                     call?: CallSite): Promise<Completion> {
  await waitReady(model);
  return withRetry(`${model} stream`, async (signal, heartbeat) => {
    const res = await postChat(requestBody(model, messages, temperature, true, think), signal, call);
    if (!res.body) throw new LmError(`${PROVIDER.displayName} returned no stream body`, undefined, true);
    const reader = (res.body as any).getReader();
    const decoder = new TextDecoder();
    let buffer = "", contentBuf = "", reasonBuf = "", frameCount = 0;
    let usage: CompletionUsage | null = null, finishReason: string | null = null;
    const assembled = () => assembleReply({ content: contentBuf, reasoning: reasonBuf, finishReason });
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        heartbeat();  // a chunk arrived -- the model is still answering, so push the idle deadline back
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const t = line.trim();
          if (ENGINE.debug && t) process.stderr.write(`[SSE frame ${frameCount++}] ${t.slice(0, 120)}\n`);
          if (!t.startsWith("data:")) continue;
          const payload = t.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const parsed = JSON.parse(payload);
            const choice = parsed.choices?.[0];
            const d = choice?.delta;
            // Qwen3 thinking models put output in reasoning_content when content is empty. The two
            // channels accumulate separately; assembleReply() decides at the end what the answer
            // was, so reasoning frames can no longer leak into the reply text. The preview (onDelta)
            // shows both kinds as they arrive.
            const dc = typeof d?.content === "string" ? d.content : "";
            const dr = typeof d?.reasoning_content === "string" ? d.reasoning_content : "";
            if (dc) { contentBuf += dc; onDelta(dc); }
            else if (dr) { reasonBuf += dr; onDelta(dr); }
            // finish_reason typically arrives in a final frame after the last delta.
            if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
            // The usage frame arrives in its own SSE chunk (often with an empty choices array) when
            // stream_options.include_usage is honored; capture it and let the loop continue.
            if (parsed.usage) usage = parseUsage(parsed.usage);
          } catch (e) {
            if (ENGINE.debug) process.stderr.write(`[SSE parse error] ${(e as Error).message} on: ${t.slice(0, 80)}\n`);
          }
        }
      }
    } catch (e) {
      if (RUN.stopped) throw e;
      const sofar = assembled().text;
      if (sofar && topLevelObjects(sofar).length) {
        progressDone();
        warn(`   ${C.yellow}⏱${C.reset} ${model} broke off (${(e as Error).message}) but had already `
          + `finished a reply — keeping it`);
        return { ...assembled(), brokenOff: true, usage };
      }
      throw e;
    }
    if (ENGINE.debug) process.stderr.write(`\n[DEBUG stream done] model=${model} len=${assembled().text.length} raw=${JSON.stringify(assembled().text.slice(0, 300))}\n`);
    const out = assembled();
    if (!out.text) throw new LmError(`${model} streamed an empty completion`, undefined, true);
    return { ...out, brokenOff: false, usage };
  }, call);
}
