/** API — the LM Studio HTTP client: request shaping, retry/backoff, and streaming. */
import { C } from "../ansi.ts";
import { RUN, StoppedError } from "../live.ts";
import { ENGINE, progressDone } from "./engine-state.ts";
import { topLevelObjects } from "./json-extract.ts";

export const LMSTUDIO_URL = "http://localhost:1234/v1/chat/completions";
export const LMSTUDIO_MODELS_URL = LMSTUDIO_URL.replace(/\/chat\/completions\/?$/, "/models");

type Role = "system" | "user" | "assistant";
export interface Msg { role: Role; content: string; }

export const THINK_LEVELS = ["off", "low", "medium", "high", "default"] as const;
export type ThinkLevel = (typeof THINK_LEVELS)[number];

function requestBody(model: string, messages: Msg[], temperature: number, stream: boolean, think: ThinkLevel) {
  const body: Record<string, unknown> = { model, messages, temperature, max_tokens: ENGINE.maxTokens, stream };
  if (think !== "default") body.reasoning_effort = think === "off" ? "none" : think;
  return JSON.stringify(body);
}

class LmError extends Error {
  constructor(message: string, public status?: number, public retryable = false) { super(message); }
}

export const NET = { retries: 2, timeoutMs: 120_000, backoffMs: 800 };

const retryableStatus = (s: number) => s === 408 || s === 409 || s === 425 || s === 429 || s >= 500;

async function withRetry<T>(what: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; ; attempt++) {
    if (RUN.stopped) throw new StoppedError();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), NET.timeoutMs);
    const onStop = () => ac.abort();
    RUN.abort.signal.addEventListener("abort", onStop, { once: true });
    try {
      return await fn(ac.signal);
    } catch (e) {
      if (RUN.stopped) throw new StoppedError();
      last = e;
      // Our own deadline and dropped connections are worth a retry; a 4xx we caused is not.
      const aborted = ac.signal.aborted;
      const err = e as LmError;
      const retryable = aborted || err.retryable
        || (err.status === undefined && e instanceof Error && e.name !== "SyntaxError");
      if (aborted) last = new LmError(`${what}: no reply within ${NET.timeoutMs / 1000}s`, undefined, true);
      if (!retryable || attempt >= NET.retries) break;
      const wait = NET.backoffMs * 2 ** attempt + Math.floor(Math.random() * 250);
      progressDone();
      console.warn(`   ${C.yellow}⟳${C.reset} ${what} failed (${(last as Error).message}) — retry `
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

export async function complete(model: string, messages: Msg[], temperature: number, think: ThinkLevel = "low"): Promise<string> {
  return withRetry(`${model} completion`, async signal => {
    const res = await postChat(requestBody(model, messages, temperature, false, think), signal);
    const data = await res.json() as any;
    const choice = data.choices?.[0];
    const text = (choice?.message?.content || choice?.message?.reasoning_content || "").trim();
    if (ENGINE.debug) process.stderr.write(`\n[DEBUG complete] model=${model} len=${text.length} src=${choice?.message?.content ? "content" : "reasoning_content"} raw=${JSON.stringify(text.slice(0, 300))}\n`);
    // An empty 200 is the other shape "never replied" takes; spend a retry rather than a caller call.
    if (!text) throw new LmError(`${model} returned an empty completion`, undefined, true);
    return text;
  });
}

// Returns the FULL text so the caller still buffers -> parses -> checks; onDelta is preview only.
export async function completeStream(model: string, messages: Msg[], temperature: number,
                                     onDelta: (d: string) => void, think: ThinkLevel = "low"): Promise<string> {
  return withRetry(`${model} stream`, async signal => {
    const res = await postChat(requestBody(model, messages, temperature, true, think), signal);
    if (!res.body) throw new LmError(`LM Studio returned no stream body`, undefined, true);
    const reader = (res.body as any).getReader();
    const decoder = new TextDecoder();
    let buffer = "", full = "", frameCount = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
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
            const d = parsed.choices?.[0]?.delta;
            // Qwen3 thinking models put output in reasoning_content when content is empty
            const delta = d?.content || d?.reasoning_content || "";
            if (delta) { full += delta; onDelta(delta); }
          } catch (e) {
            if (ENGINE.debug) process.stderr.write(`[SSE parse error] ${(e as Error).message} on: ${t.slice(0, 80)}\n`);
          }
        }
      }
    } catch (e) {
      if (RUN.stopped) throw e;
      const sofar = full.trim();
      if (sofar && topLevelObjects(sofar).length) {
        progressDone();
        console.warn(`   ${C.yellow}⏱${C.reset} ${model} broke off (${(e as Error).message}) but had already `
          + `finished a reply — keeping it`);
        return sofar;
      }
      throw e;
    }
    if (ENGINE.debug) process.stderr.write(`\n[DEBUG stream done] model=${model} len=${full.length} raw=${JSON.stringify(full.slice(0, 300))}\n`);
    const text = full.trim();
    if (!text) throw new LmError(`${model} streamed an empty completion`, undefined, true);
    return text;
  });
}
