/** API — the LM Studio HTTP client: request shaping, retry/backoff, and streaming. */
import { C } from "../ansi.ts";
import { RUN, StoppedError } from "../live.ts";
import { ENGINE, progressDone } from "./engine-state.ts";
import { warn } from "./warnings.ts";
import { topLevelObjects } from "./json-extract.ts";
import type { ThinkLevel } from "./story-schema.ts";

export const LMSTUDIO_URL = process.env.LM_STUDIO_URL ?? "http://localhost:1234/v1/chat/completions";
export const LMSTUDIO_MODELS_URL = LMSTUDIO_URL.replace(/\/chat\/completions\/?$/, "/models");
/** LM Studio's own REST API, which unlike /v1/models reports load state and context length. */
export const LMSTUDIO_REST_MODELS_URL = LMSTUDIO_URL.replace(/\/v1\/chat\/completions\/?$/, "/api/v0/models");

/** Whether the two /models endpoints above can actually be derived from a chat-completions URL:
 *  both rewrite the trailing path, so an override without that suffix silently points the model
 *  checks at the chat route. The composition root warns once when an env override breaks this. */
export const lmUrlsDerivable = (url: string) => /\/chat\/completions\/?$/.test(url.trim());

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
export const NET = { retries: 2, timeoutMs: 120_000, backoffMs: 800 };

function requestBody(model: string, messages: Msg[], temperature: number, stream: boolean, think: ThinkLevel) {
  const body: Record<string, unknown> = { model, messages, temperature, max_tokens: ENGINE.maxTokens, stream };
  if (stream) body.stream_options = { include_usage: true };
  if (think !== "default") body.reasoning_effort = think === "off" ? "none" : think;
  return JSON.stringify(body);
}

class LmError extends Error {
  constructor(message: string, public status?: number, public retryable = false) { super(message); }
}

const retryableStatus = (s: number) => s === 408 || s === 409 || s === 425 || s === 429 || s >= 500;

async function withRetry<T>(what: string, fn: (signal: AbortSignal, heartbeat: () => void) => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; ; attempt++) {
    if (RUN.stopped) throw new StoppedError();
    const ac = new AbortController();
    // An IDLE deadline, not a total-duration cap: `heartbeat()` pushes it back on each sign of
    // progress, so a long-but-streaming generation is never aborted mid-reply -- only a stalled
    // connection that goes NET.timeoutMs without a byte is.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const heartbeat = () => { clearTimeout(timer); timer = setTimeout(() => ac.abort(), NET.timeoutMs); };
    heartbeat();
    const onStop = () => ac.abort();
    RUN.abort.signal.addEventListener("abort", onStop, { once: true });
    try {
      return await fn(ac.signal, heartbeat);
    } catch (e) {
      if (RUN.stopped) throw new StoppedError();
      last = e;
      // Our own deadline, dropped connections, and any failure carrying no HTTP status (fetch
      // itself, a reply body that never parsed) are worth a retry; a 4xx we caused is not.
      // Body-parse failures arrive already wrapped as retryable LmErrors by complete(), so nothing
      // needs name-based special-casing here.
      const aborted = ac.signal.aborted;
      const err = e as LmError;
      const retryable = aborted || err.retryable
        || (err.status === undefined && e instanceof Error);
      if (aborted) last = new LmError(`${what}: no reply within ${NET.timeoutMs / 1000}s`, undefined, true);
      if (!retryable || attempt >= NET.retries) break;
      const wait = NET.backoffMs * 2 ** attempt + Math.floor(Math.random() * 250);
      progressDone();
      warn(`   ${C.yellow}⟳${C.reset} ${what} failed (${(last as Error).message}) — retry `
        + `${attempt + 1}/${NET.retries} in ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
    } finally {
      clearTimeout(timer);
      RUN.abort.signal.removeEventListener("abort", onStop);
    }
  }
  throw last;
}

async function postChat(body: string, signal: AbortSignal) {
  const res = await fetch(LMSTUDIO_URL, {
    method: "POST", headers: { "Content-Type": "application/json" }, body, signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new LmError(`LM Studio ${res.status}: ${detail.slice(0, 200)}`, res.status, retryableStatus(res.status));
  }
  return res;
}

/** One non-streaming completion, with retry/backoff; throws StoppedError when the run is stopped. */
export async function complete(model: string, messages: Msg[], temperature: number, think: ThinkLevel = "low"): Promise<Completion> {
  return withRetry(`${model} completion`, async signal => {
    const res = await postChat(requestBody(model, messages, temperature, false, think), signal);
    // Read the body as text first: a 200 whose body will not parse (a proxy error page, LM Studio
    // dying mid-request) is a transient infrastructure failure, so it becomes a retryable LmError
    // that names the model and carries a snippet -- not an opaque SyntaxError that kills the call
    // on its first attempt. An empty body lands in the same bucket as an empty completion.
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
  });
}

/** A streaming completion. Returns the FULL text (the caller buffers -> parses -> checks); onDelta is preview only. */
export async function completeStream(model: string, messages: Msg[], temperature: number,
                                     onDelta: (d: string) => void, think: ThinkLevel = "low"): Promise<Completion> {
  return withRetry(`${model} stream`, async (signal, heartbeat) => {
    const res = await postChat(requestBody(model, messages, temperature, true, think), signal);
    if (!res.body) throw new LmError(`LM Studio returned no stream body`, undefined, true);
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
  });
}
