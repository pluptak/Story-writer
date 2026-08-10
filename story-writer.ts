/**
 * STORY WRITER — a writer agent that consults character agents.
 *
 * A single **writer** agent drafts prose from a premise. Whenever it needs to know how a character
 * would actually behave or speak, it stops writing and *consults* that character's agent. The
 * character answers from its own persona, its own declared skills, and only what the writer told
 * it — never from the draft, never from another character's replies. The writer may accept the
 * answer or rewrite the question and ask again, and each retry gets a FRESH character instance that
 * never learns it was rejected.
 *
 * Forked from the "Multimodel AI roleplay" game-master engine, which this shares no code path with:
 * the transport, JSON extraction, agent/history windowing, markdown parsing and config-validation
 * policy are carried over as source; the Director/Warden/Ledger/WorldState machinery is not.
 *
 * BLOCK W1 — this file currently holds the salvaged infrastructure only. The story format, the
 * consult protocol and the scene loop land in W2-W5.
 */

import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { createServer } from "node:http";
import { createInterface } from "node:readline/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { isAbsolute, join as joinPath, resolve as resolvePath, relative as relativePath } from "node:path";

// -- CONFIG ----------------------------------------------------------------
const LMSTUDIO_URL = "http://localhost:1234/v1/chat/completions";
// Same server, model-listing endpoint. Used ONLY by pre-flight to check a story's model ids against
// what LM Studio actually has loaded — a wrong id otherwise fails on every single call at runtime,
// which is the most expensive way possible to learn about a typo.
const LMSTUDIO_MODELS_URL = LMSTUDIO_URL.replace(/\/chat\/completions\/?$/, "/models");
// Shared by the reasoning pass and the reply on thinking models: a budget that only just fits the
// answer yields an empty `content` whenever the model thinks for a while. Overridable per story
// (`config.max_tokens`). See requestBody() for the measurements.
//
// 2000 rather than the 1200 this was forked with, because here one reply carries PROSE: a draft of
// 250 words plus a consult block is 600-800 tokens before the model has thought at all, and a draft
// truncated at the cap is a JSON object that never closes. Observed: ~200 written words lost to a
// mid-string cut-off. `salvageProse()` is the safety net; this is the fix.
let MAX_TOKENS = 2000;
const WINDOW = { cap: 24, keepRecent: 14 };

// CLI: first non-flag arg is the story dir. `--preflight` structurally checks stories and exits —
// no model calls, no files written. `--serve` opens the live viewer; `--port=NNNN` moves it.
const CLI = process.argv.slice(2);
const PREFLIGHT = CLI.includes("--preflight");
const SERVE = CLI.includes("--serve");
const PORT = Number(CLI.find(a => a.startsWith("--port="))?.slice(7)) || 8080;
let STORY_DIR = CLI.find(a => !a.startsWith("--")) ?? "";   // resolved at run time: arg, else picker / sole

// Where this run's artifacts land: `<story dir>/out/`, so each story keeps its own outputs and a run
// of one never overwrites another's. Also makes outputs independent of the cwd you launched from.
let OUT_DIR = "";

// Set by the story loader before the loop runs
let STREAM = true;
let DEBUG  = false;

// -- ANSI (console only; the saved files stay plain text) -------------------
const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m", gray: "\x1b[90m",
};
const CHARACTER_PALETTE = [C.cyan, C.yellow, C.green, C.magenta];

// A single rewritten status line, so "the model is working" costs one line rather than a screenful
// of its raw JSON. Only on a TTY: piped or redirected output gets nothing, because carriage returns
// in a log file are worse than silence.
let progressOpen = false;
function progress(text: string) {
  if (!process.stdout.isTTY) return;
  process.stdout.write(`\r\x1b[2K  ${text}`);
  progressOpen = true;
}
/** Clear the status line before anything else prints, so real output never lands on top of it. */
function progressDone() {
  if (!progressOpen) return;
  process.stdout.write(`\r\x1b[2K`);
  progressOpen = false;
}

// -- API -------------------------------------------------------------------
type Role = "system" | "user" | "assistant";
export interface Msg { role: Role; content: string; }

// How much reasoning a role may spend. "default" sends nothing and lets the model do as it likes.
export const THINK_LEVELS = ["off", "low", "medium", "high", "default"] as const;
export type ThinkLevel = (typeof THINK_LEVELS)[number];

// Request body shared by both transports.
//
// THINKING — measured against `gemma-4-12b-it-qat-uncensored-heretic`, max_tokens 800, and
// the numbers are the reason this looks the way it does:
//
//   thinking:{type:"disabled"}                 ~59s   usable content in 1 of 2 samples
//   thinking:{type:"disabled"} + kwargs        ~44s   usable content in 0 of 2 samples
//   reasoning_effort                           ~25-36s  usable content in 4 of 4 samples
//
// So the OpenAI-standard `reasoning_effort` is what actually works here, and the two alternatives
// are worse than doing nothing: on this model the reasoning pass routinely ate the whole token
// budget, leaving `content` EMPTY and the call wasted. That silent failure is most of why runs felt
// slow — the time was spent and then thrown away.
//
// What this cannot do is switch thinking OFF. No setting tested reached reasoning=0; this finetune
// always thinks. `off` asks for `reasoning_effort:"none"` and a model that cannot honour it will
// warn and clamp (LM Studio logs *"'minimal' reasoning effort is not directly supported. Mapping to
// 'low'"* for exactly this reason) — hence `low`, not `minimal`, as the default: same result on such
// models, without the warning spam or the pretence of a distinction.
//
// Deliberately NOT sent: `chat_template_kwargs.enable_thinking` (measured actively harmful above),
// the Anthropic-shaped `thinking` field (measured worse than nothing), and `/no_think` in the
// prompt — a Qwen-only soft switch that reaches a non-Qwen model as literal text.
function requestBody(model: string, messages: Msg[], temperature: number, stream: boolean, think: ThinkLevel) {
  const body: Record<string, unknown> = { model, messages, temperature, max_tokens: MAX_TOKENS, stream };
  if (think !== "default") body.reasoning_effort = think === "off" ? "none" : think;
  return JSON.stringify(body);
}

class LmError extends Error {
  constructor(message: string, public status?: number, public retryable = false) { super(message); }
}

// Transport resilience. LM Studio will occasionally accept a request and never answer — most often
// when it decides to swap or unload a model underneath us — and with no timeout that hangs the run
// forever. Every call gets a deadline, and is retried on the failures that are worth retrying.
export const NET = { retries: 2, timeoutMs: 120_000, backoffMs: 800 };

// -- STOPPING A RUN --------------------------------------------------------
// A run is abandonable from outside it: the viewer's stop button, or anything else that calls
// `stopRun()`. Two halves, because a run spends nearly all of its wall time inside ONE model call:
// the flag is what the loop checks at each boundary, and the AbortController is what cuts the call
// already in flight. Without the second, "stop" would mean "stop in up to request_timeout seconds"
// on a run that is not doing anything you want to wait for.
//
// A stop is NOT a failure. It must never be retried, never salvaged into a half-draft, and never
// reported as the model having gone wrong — hence its own error type rather than a message string.
export class StoppedError extends Error {
  constructor() { super("stopped"); this.name = "StoppedError"; }
}
export const RUN = { stopped: false, abort: new AbortController() };

/** Request that the current run end at its next boundary, cutting any call in flight. Returns false
 *  when one was already asked for, so a second click is not a second stop. */
export function stopRun(): boolean {
  if (RUN.stopped) return false;
  RUN.stopped = true;
  RUN.abort.abort();
  return true;
}

/** Arm a fresh run. The abort controller is single-use, so a stopped session would otherwise refuse
 *  to start the next story. */
export function armRun() {
  RUN.stopped = false;
  RUN.abort = new AbortController();
}

const retryableStatus = (s: number) => s === 408 || s === 409 || s === 425 || s === 429 || s >= 500;

async function withRetry<T>(what: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; ; attempt++) {
    if (RUN.stopped) throw new StoppedError();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), NET.timeoutMs);
    // A stop cuts the request that is already in flight rather than waiting out its deadline.
    const onStop = () => ac.abort();
    RUN.abort.signal.addEventListener("abort", onStop, { once: true });
    try {
      return await fn(ac.signal);
    } catch (e) {
      // A stopped run is not a call that failed — it is the answer. Retrying it, or reporting it as
      // a transport problem, would both be lies about what happened.
      if (RUN.stopped) throw new StoppedError();
      last = e;
      // Retryable: our own deadline, a dropped/refused connection, and the server-side statuses
      // above. A 4xx we caused (bad model id, malformed body) is not — retrying just burns time.
      const aborted = ac.signal.aborted;
      const err = e as LmError;
      const retryable = aborted || err.retryable
        || (err.status === undefined && e instanceof Error && e.name !== "SyntaxError");
      if (aborted) last = new LmError(`${what}: no reply within ${NET.timeoutMs / 1000}s`, undefined, true);
      if (!retryable || attempt >= NET.retries) break;
      const wait = NET.backoffMs * 2 ** attempt + Math.floor(Math.random() * 250);
      progressDone();               // never print a warning on top of the live status line
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
    if (DEBUG) process.stderr.write(`\n[DEBUG complete] model=${model} len=${text.length} src=${choice?.message?.content ? "content" : "reasoning_content"} raw=${JSON.stringify(text.slice(0, 300))}\n`);
    // An empty 200 is the other shape "never replied" takes. It would cost the caller a whole
    // wasted call, so spend a retry on it instead.
    if (!text) throw new LmError(`${model} returned an empty completion`, undefined, true);
    return text;
  });
}

// Streaming transport (LM Studio OpenAI-compatible SSE). Returns the FULL text so the caller can
// buffer -> parse -> check exactly as before; onDelta is only a live preview side-channel.
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
        buffer = lines.pop() ?? "";                 // keep the last partial line
        for (const line of lines) {
          const t = line.trim();
          if (DEBUG && t) process.stderr.write(`[SSE frame ${frameCount++}] ${t.slice(0, 120)}\n`);
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
            if (DEBUG) process.stderr.write(`[SSE parse error] ${(e as Error).message} on: ${t.slice(0, 80)}\n`);
          }
        }
      }
    } catch (e) {
      // The stream broke — usually our own deadline on a long reply. If what arrived before it broke
      // already contains a COMPLETE object, that reply is finished in every way that matters and
      // retrying would only regenerate it. Measured: an architect proposal that had closed its brace
      // was discarded twice this way, costing six minutes and losing the better of three stories.
      //
      // Deliberately checked with topLevelObjects and not extractJson: the prose fallback would call
      // a half-written reply "complete" on the strength of one labelled line.
      // ...unless the break was a stop. Keeping a reply then would hand the loop one more usable
      // draft and buy another consult out of a run the author has already abandoned.
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
    if (DEBUG) process.stderr.write(`\n[DEBUG stream done] model=${model} len=${full.length} raw=${JSON.stringify(full.slice(0, 300))}\n`);
    const text = full.trim();
    // A stream that opens, sends nothing and closes is the commonest "never replied" shape here.
    if (!text) throw new LmError(`${model} streamed an empty completion`, undefined, true);
    return text;
  });
}

// -- JSON EXTRACTION -------------------------------------------------------
// Scan forward from `start` (which must be a "{") for its matching "}", ignoring braces that sit
// inside JSON strings and honouring backslash escapes. Returns the index just past the closing
// brace, or -1 if it never closes. This is the bit a naive brace counter gets wrong: a model
// writing  {"speech":"Use the character } carefully."}  has unbalanced braces at the character
// level but perfectly balanced *structure*.
export function balancedObjectEnd(s: string, start: number): number {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

/** Every TOP-LEVEL object in `s` that actually parses, in order. After a candidate parses the scan
 *  skips past it, so a nested `{"b":1}` inside the real object is never itself a candidate. Shared
 *  by `extractJson` (which wants the last one) and the streaming transport (which only wants to know
 *  whether a reply cut short is nevertheless complete). */
export function topLevelObjects(s: string): Record<string, any>[] {
  const found: Record<string, any>[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{") continue;
    const end = balancedObjectEnd(s, i);
    if (end === -1) continue;
    try {
      const o = JSON.parse(s.slice(i, end));
      if (o && typeof o === "object") { found.push(o); i = end - 1; }
    } catch { /* not a JSON object starting here — try the next "{" */ }
  }
  return found;
}

// The keys the prose fallback below recognises — this mode's JSON contracts (writer draft/clarify/
// judge, character answer/need), not the parent engine's channels.
const PROSE_KEYS = ["prose", "question", "situation", "need", "speech", "action", "thought",
                    "verdict", "note", "answer", "skills_used", "character"] as const;
const PROSE_ALT = PROSE_KEYS.join("|");

export function extractJson(raw: string): Record<string, any> {
  // Strip Qwen3-style <think>…</think> blocks.
  const stripped = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const afterThink = stripped.includes("</think>")
    ? stripped.slice(stripped.lastIndexOf("</think>") + 8).trim()
    : stripped;

  // Collect every TOP-LEVEL balanced object, in order, then take the LAST one. Both halves matter:
  //   - top-level: after a candidate parses we skip past it, so a nested `{"b":1}` inside the real
  //     object is never itself a candidate (a plain "last object wins" search would return it);
  //   - last: models routinely emit a worked example, a retry, or a preamble before the real reply,
  //     and the real one is the final one.
  // A "{" that never closes — a stray brace in prose, or output truncated mid-object — simply fails
  // and the scan moves to the next one.
  const found = topLevelObjects(afterThink);
  if (found.length) return found[found.length - 1];

  // Prose fallback: model wrote labelled lines instead of JSON.
  const prose: Record<string, string> = {};
  const labelRe = new RegExp(
    `(?:^|\\n)\\s*\\*{0,2}(${PROSE_ALT})\\*{0,2}\\s*[:：]\\s*["“]?(.+?)["”]?\\s*` +
    `(?=\\n\\s*\\*{0,2}(?:${PROSE_ALT})\\*{0,2}\\s*[:：]|$)`, "gis");
  let m: RegExpExecArray | null;
  while ((m = labelRe.exec(afterThink)) !== null) prose[m[1].toLowerCase()] = m[2].trim();
  if (Object.keys(prose).length > 0) {
    if (DEBUG) process.stderr.write(`[extractJson prose fallback] keys=${Object.keys(prose).join(",")}\n`);
    return prose;
  }

  if (DEBUG) process.stderr.write(`[extractJson failed] stripped=${JSON.stringify(afterThink.slice(0, 200))}\n`);
  return {};
}

/**
 * Last-ditch recovery of a draft whose JSON never closed — nearly always output truncated at the
 * token cap partway through the `prose` string. `extractJson` correctly finds no object and the
 * whole draft is lost, which is the single most expensive way this can fail: the words were
 * written, and the only thing missing is a closing brace. Cuts back to the last finished sentence
 * so a half-line never reaches the page, and returns "" when there is nothing worth keeping.
 */
export function salvageProse(raw: string): string {
  const m = raw.match(/"?prose"?\s*:\s*"/);
  if (!m) return "";
  let out = "", esc = false;
  for (let i = m.index! + m[0].length; i < raw.length; i++) {
    const c = raw[i];
    if (esc) { out += c === "n" ? "\n" : c === "t" ? "\t" : c; esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') break;                       // the string did close after all
    out += c;
  }
  const end = Math.max(out.lastIndexOf("."), out.lastIndexOf("?"), out.lastIndexOf("!"));
  return end < 0 ? "" : out.slice(0, end + 1).trim();
}

// -- CONFIG VALIDATION -----------------------------------------------------
// Config values are validated rather than coerced. The policy across all three helpers is
// warn-and-use-the-documented-default (never throw) — the same policy pre-flight is built around, so
// every rejection shows up in `--preflight` output. What they must NOT do is accept a value
// silently: a typo changing runtime semantics with no trace is the failure mode being prevented.
//   - num:  the whole value must be an integer. parseInt would accept any numeric *prefix*
//           ("16garbage" -> 16, "10.9" -> 10), and a NaN that reaches a loop bound poisons it
//           silently (`n >= NaN` is always false).
//   - bool: "flase"/"ture" must not land on the default silently.
//   - enumOf: an unknown value must not become the default silently.
const configLabel = (key: string) => key.replace(/^config\./, "");

export function num(kv: Record<string, string>, key: string, def: number): number {
  const raw = kv[key];
  if (raw == null) return def;
  const n = Number(raw);
  if (!Number.isInteger(n)) { console.warn(`   (config "${configLabel(key)}: ${raw}" is not a whole number — using ${def})`); return def; }
  if (n < 1)                { console.warn(`   (config "${configLabel(key)}: ${raw}" must be at least 1 — using ${def})`); return def; }
  return n;
}

export function bool(kv: Record<string, string>, key: string, def: boolean): boolean {
  const raw = kv[key];
  if (raw == null) return def;
  const v = raw.trim().toLowerCase();
  if (v === "true")  return true;
  if (v === "false") return false;
  console.warn(`   (config "${configLabel(key)}: ${raw}" is not true/false — using ${def})`);
  return def;
}

export function enumOf<T extends string>(kv: Record<string, string>, key: string, allowed: readonly T[], def: T): T {
  const raw = kv[key];
  if (raw == null) return def;
  const v = raw.trim().toLowerCase();
  if ((allowed as readonly string[]).includes(v)) return v as T;
  console.warn(`   (config "${configLabel(key)}: ${raw}" is not one of ${allowed.join("/")} — using ${def})`);
  return def;
}

// -- AGENT -----------------------------------------------------------------
// One generic agent for both roles. A writer and a character differ only by system prompt,
// temperature and model — never by class.
export class Agent {
  history: Msg[] = [];
  digest = "";                    // rolling summary of trimmed-off older history
  think: ThinkLevel = "low";      // reasoning budget for this role (config `thinking` / `thinking_<role>`)
  constructor(public name: string, public model: string, public system: string,
              public temperature = 0.85, public maxMessages = WINDOW.cap) {}
  hear(c: string) { this.history.push({ role: "user", content: c }); }
  said(c: string) { this.history.push({ role: "assistant", content: c }); }

  // A character consulted a second time about the same beat must not see the first attempt. `fork()`
  // is that instance: same persona, same model, EMPTY history — it never learns it was rejected.
  fork(): Agent {
    const a = new Agent(this.name, this.model, this.system, this.temperature, this.maxMessages);
    a.think = this.think;
    return a;
  }

  // system + (digest of old events) + windowed recent history + any ephemeral extra.
  // The trailing assistant prefix "{" forces the model to continue inside JSON.
  buildMessages(extra: Msg[] = []): Msg[] {
    const head: Msg[] = [{ role: "system", content: this.system }];
    if (this.digest) head.push({ role: "user", content: `[SO FAR -- your memory of earlier exchanges]\n${this.digest}` });
    return [...head, ...this.history, ...extra, { role: "assistant", content: "{" }];
  }

  // Generate a reply. buildMessages appends `{`, so we re-prepend it.
  //
  // When STREAM is on the terminal gets a PROGRESS line, not the raw draft. Dumping the model's
  // JSON live — escaped newlines, the whole consult block, and the same object emitted twice —
  // buried the formatted output it was interleaved with and made a run genuinely hard to follow.
  // The text is still buffered and returned exactly as before; only the display changed.
  async generate(label: string, extra: Msg[] = []): Promise<string> {
    const msgs = this.buildMessages(extra);
    const prepend = "{";
    if (!STREAM) return prepend + await complete(this.model, msgs, this.temperature, this.think);
    const started = Date.now();
    let chars = 0, lastPaint = 0;
    const paint = () => {
      const secs = Math.round((Date.now() - started) / 1000);
      progress(`${label} ${C.dim}composing… ${String(secs).padStart(2)}s · ${chars} chars${C.reset}`);
      sseWrite({ t: "composing", who: this.name, secs, chars });
    };
    paint();
    const rest = await completeStream(this.model, msgs, this.temperature, d => {
      chars += d.length;
      if (Date.now() - lastPaint > 250) { lastPaint = Date.now(); paint(); }
    }, this.think);
    progressDone();
    sseWrite({ t: "idle" });
    return prepend + rest;
  }
}

// -- HISTORY WINDOWING -----------------------------------------------------
// When an agent's history overflows, summarize the oldest messages into its digest and drop them.
// Each agent is summarized ONLY from its own history, so a character's digest never contains
// anything it was not itself told.
export async function trimHistory(agent: Agent, summarizerModel: string, summarizerThink: ThinkLevel = "low") {
  if (agent.history.length <= agent.maxMessages) return;
  const overflowCount = agent.history.length - WINDOW.keepRecent;
  const overflow = agent.history.slice(0, overflowCount);
  const recent = agent.history.slice(overflowCount);
  const text = overflow.map(m => `${m.role === "assistant" ? agent.name : "input"}: ${m.content}`).join("\n");
  const prompt =
    (agent.digest ? `Existing summary:\n${agent.digest}\n\n` : "") +
    `Earlier exchanges to fold in:\n${text}\n\n` +
    `Rewrite ONE concise summary (<=180 words) from ${agent.name}'s perspective, preserving: established facts, ` +
    `what ${agent.name} knows or has decided, unresolved threads, and current intentions. Output only the summary.`;
  try {
    agent.digest = await complete(summarizerModel, [
      { role: "system", content: "You compress transcripts faithfully and briefly. Output only the summary." },
      { role: "user", content: prompt },
    ], 0.3, summarizerThink);
    agent.history = recent;
  } catch (e) {
    console.warn(`   (digest skipped for ${agent.name}: ${(e as Error).message})`);
  }
}

// -- SKILL CATALOG ---------------------------------------------------------
// The general skills every character starts with. A character's EFFECTIVE set is this catalog minus
// its `lacks:` plus its `skills:`, and that set is the menu rendered into its prompt and the list
// its `skills_used` is checked against.
//
// These are deliberately senses and plain bodily acts rather than story-specific abilities: they are
// what makes "can I reach the door handle?" a question a character knows it is entitled to ask. A
// story adds what it needs (`lockpicking`, `piloting`) and removes what a character lacks (`sight`).
export const SKILL_CATALOG: Readonly<Record<string, string>> = Object.freeze({
  movement: "moving your own body through the space you are in",
  speech:   "saying things aloud",
  hearing:  "perceiving sound",
  sight:    "perceiving light, shape and colour",
  touch:    "perceiving and handling things by contact",
  taste:    "perceiving flavour",
  smell:    "perceiving scent",
  recall:   "drawing on your own memory of what you have lived through",
});

export interface Skill { name: string; meaning: string; source: "general" | "story"; }

// Skill names are matched case- and spacing-insensitively so `Lock Picking` and `lockpicking` are
// not two skills. The authored spelling is what the character is shown.
const canonSkill = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, "");

// A story may write `name :: what it means`. Splits on the FIRST "::" (surrounding whitespace
// optional). A meaning is optional; text is not.
export function splitMeaning(raw: string): { text: string; meaning: string } {
  const i = raw.indexOf("::");
  if (i < 0) return { text: raw.trim(), meaning: "" };
  return { text: raw.slice(0, i).trim(), meaning: raw.slice(i + 2).trim() };
}

/** Resolve one character's effective skill set: catalog − `lacks:` + `skills:`.
 *  Warn-never-throw, like config validation — every complaint surfaces in `--preflight`.
 *  Order is fixed and documented: `lacks` applies to the CATALOG only, then `skills` are added. So a
 *  name in both ends up present with the story's meaning, and says so. */
export function resolveSkills(who: string, skillsRaw: string, lacksRaw: string): Skill[] {
  const split = (s: string) => s.split("|").map(x => x.trim()).filter(Boolean);
  const lacks = new Map<string, string>();          // canon -> authored spelling
  for (const entry of split(lacksRaw)) {
    const { text } = splitMeaning(entry);
    if (!text) continue;
    const key = canonSkill(text);
    if (!(key in SKILL_CATALOG))
      console.warn(`   (character ${who}: lacks "${text}" — not a general skill, so there is nothing to remove; known: ${Object.keys(SKILL_CATALOG).join(", ")})`);
    lacks.set(key, text);
  }

  const out = new Map<string, Skill>();
  for (const [name, meaning] of Object.entries(SKILL_CATALOG))
    if (!lacks.has(canonSkill(name))) out.set(canonSkill(name), { name, meaning, source: "general" });

  for (const entry of split(skillsRaw)) {
    const { text, meaning } = splitMeaning(entry);
    if (!text) { console.warn(`   (character ${who}: a skills entry has a meaning but no name before the "::" — dropped)`); continue; }
    const key = canonSkill(text);
    if (key in SKILL_CATALOG && !lacks.has(key))
      console.warn(`   (character ${who}: skills "${text}" redeclares a general skill — the story's wording wins)`);
    if (lacks.has(key))
      console.warn(`   (character ${who}: "${text}" is in both skills and lacks — added back, so they HAVE it)`);
    out.set(key, { name: text, meaning, source: "story" });
  }
  return [...out.values()];
}

// -- STORY FORMAT ----------------------------------------------------------
/** Parse story.md into flat config + a list of character sub-blocks. */
export interface ParsedStory {
  kv: Record<string, string>;                    // "section.key" -> value
  characters: Array<Record<string, string>>;     // one map per ### block under ## Characters
  premise: string;
}
export function parseStoryMd(src: string): ParsedStory {
  const kv: Record<string, string> = {};
  const characters: Array<Record<string, string>> = [];
  let premise = "";
  let section = "";
  let character: Record<string, string> | null = null;

  for (const raw of src.split("\n")) {
    const line = raw.trimEnd();
    const h2 = line.match(/^##\s+(.+)/);
    const h3 = line.match(/^###\s+(.+)/);
    if (h3 && section === "characters") {              // new character sub-block
      character = { name: h3[1].trim() };
      characters.push(character);
      continue;
    }
    if (h2) { section = h2[1].trim().toLowerCase(); character = null; continue; }
    if (line.startsWith("#")) continue;                // top-level title / comment heading

    if (section === "premise") {
      // Blank lines are KEPT (collapsed to one, below): a premise is prose the writer reads, and
      // paragraphing is part of it. It is also what lets a scaffolded story survive the round trip
      // spec -> story.md -> loadStory -> the same spec exactly (SPEC-S §1).
      premise += (premise ? "\n" : "") + line.trim();
      continue;
    }

    const kvm = line.match(/^(\w[\w\s]*?)\s*:\s*(.+)/);
    if (!kvm) continue;
    const key = kvm[1].trim().toLowerCase();
    const val = kvm[2].trim();
    // A character's `knows`/`skills` are free-text prose; leave them untouched. For the structured
    // sections (scene/config/models/writer) strip a trailing inline "# comment" so
    // `key: value   # note` parses as just `value`.
    if (section === "characters" && character) character[key] = val;
    else kv[`${section}.${key}`] = val.replace(/\s+#.*$/, "").trim();
  }
  return { kv, characters, premise: premise.replace(/\n{3,}/g, "\n\n").trim() };
}

export interface CharacterDef {
  name: string;
  file: string;
  model: string;
  persona: string;      // raw persona markdown
  knows: string;        // what they know entering the scene
  skills: Skill[];      // effective set (catalog − lacks + skills)
}
export interface StoryConfig {
  dir: string;
  premise: string;
  scene: { place: string; question: string; pov: string; length: number };
  writerStyle: string;             // optional ## Writer / file: markdown, "" when undeclared
  retries: number;                 // writer rewrites per consult
  clarifications: number;          // questions a character may ask before it must answer
  maxSteps: number;                // soft budget of writer draft calls
  stream: boolean;
  debug: boolean;
  thinking: { writer: ThinkLevel; character: ThinkLevel; summary: ThinkLevel };
  requestTimeout: number;          // seconds before a model call is abandoned and retried
  attempts: number;                // TOTAL tries per model call (1 = never retry)
  maxTokens: number;
  models: { default: string; writer: string; summary: string };
  characters: CharacterDef[];
}

// Story dirs resolve against THIS FILE's folder, not the cwd, so `npx tsx story-writer.ts
// stories/doorway` behaves the same from anywhere. (The parent engine resolved `scenarios/` against
// the cwd, which quietly made discovery depend on where you launched from.)
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const resolveStoryDir = (dir: string) => (isAbsolute(dir) ? dir : resolvePath(ROOT, dir));

export async function loadStory(dir: string): Promise<StoryConfig> {
  const base = resolveStoryDir(dir);
  const read = (file: string) => readFile(joinPath(base, file), "utf8");
  const parsed = parseStoryMd(await read("story.md"));
  const kv = parsed.kv;

  const thinkingDefault = enumOf(kv, "config.thinking", THINK_LEVELS, "low");
  const thinking = {
    writer:    enumOf(kv, "config.thinking_writer",    THINK_LEVELS, thinkingDefault),
    character: enumOf(kv, "config.thinking_character", THINK_LEVELS, thinkingDefault),
    summary:   enumOf(kv, "config.thinking_summary",   THINK_LEVELS, thinkingDefault),
  };
  // Authored as TOTAL attempts rather than retries because `num` rejects anything below 1 — this way
  // "no retrying" is expressible as `attempts: 1`.
  const requestTimeout = num(kv, "config.request_timeout", 120);   // seconds
  const attempts       = num(kv, "config.attempts", 3);
  const maxTokens      = num(kv, "config.max_tokens", 1200);
  const retries        = num(kv, "config.retries", 2);
  const clarifications = num(kv, "config.clarifications", 2);
  const maxSteps       = num(kv, "config.max_steps", 24);
  const stream         = bool(kv, "config.stream", true);
  const debug          = bool(kv, "config.debug", false);

  const defaultModel = kv["models.default"] ?? "qwen3.6-35b-a3b";
  const models = {
    default: defaultModel,
    writer:  kv["models.writer"]  ?? defaultModel,
    summary: kv["models.summary"] ?? defaultModel,
  };

  const premise = parsed.premise.trim();
  if (!premise) throw new Error(`## Premise is empty in ${dir}/story.md — there is nothing to write.`);

  const scene = {
    place:    kv["scene.place"] ?? "",
    question: kv["scene.question"] ?? "",
    pov:      kv["scene.pov"] ?? "",
    length:   num(kv, "scene.length", 700),
  };
  if (!scene.question)
    console.warn(`   (## Scene has no "question:" — the writer has no dramatic question to close, so it decides alone when the scene is done)`);

  // Optional style guide for the writer. Declared-but-unreadable is a hard failure, as every file
  // reference is; undeclared is simply absent and needs no warning.
  const writerFile = kv["writer.file"];
  const writerStyle = writerFile
    ? await read(writerFile).catch(() => { throw new Error(`Writer style file "${writerFile}" (## Writer → file:) could not be read in ${dir}.`); })
    : "";

  if (!parsed.characters.length)
    throw new Error(`## Characters has no "### NAME" blocks in ${dir}/story.md — the writer would have nobody to consult.`);

  const characters: CharacterDef[] = [];
  const seen = new Set<string>();
  for (const c of parsed.characters) {
    const name = (c.name ?? "").trim();
    if (!name) throw new Error(`A ### character block in ${dir}/story.md has no name.`);
    if (seen.has(name.toLowerCase())) throw new Error(`Duplicate character "${name}" in ${dir}/story.md.`);
    seen.add(name.toLowerCase());
    if (!c.file) throw new Error(`Character "${name}" has no "file:" in ${dir}/story.md.`);
    const persona = await read(c.file).catch(() => {
      throw new Error(`Persona file "${c.file}" for ${name} could not be read in ${dir}.`);
    });
    characters.push({
      name, file: c.file,
      model: c.model ?? models.default,
      persona,
      knows: (c.knows ?? "").trim(),
      skills: resolveSkills(name, c.skills ?? "", c.lacks ?? ""),
    });
  }

  if (scene.pov && !characters.some(c => c.name.toLowerCase() === scene.pov.trim().toLowerCase()))
    console.warn(`   (## Scene pov: "${scene.pov}" is not one of the characters — ignored)`);

  return {
    dir: base, premise, scene, writerStyle,
    retries, clarifications, maxSteps, stream, debug, thinking,
    requestTimeout, attempts, maxTokens, models, characters,
  };
}

// -- DISCOVERY -------------------------------------------------------------
/** Every `stories/*` folder that contains a story.md (sorted), as paths relative to this file. */
export async function discoverStories(): Promise<string[]> {
  const choices: string[] = [];
  try {
    const dirents = await readdir(joinPath(ROOT, "stories"), { withFileTypes: true });
    for (const d of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!d.isDirectory()) continue;
      try { await readFile(joinPath(ROOT, "stories", d.name, "story.md"), "utf8"); choices.push(`stories/${d.name}`); } catch {}
    }
  } catch {}
  return choices;
}

/** Resolve which story to write: explicit CLI arg wins; otherwise discover, and if there is a
 *  choice and we're on a TTY, ask. Falls back to the sole/first story when non-interactive. */
export const NEW_STORY = "\0new";
export async function chooseStory(arg: string): Promise<string> {
  if (arg) return arg;
  const choices = await discoverStories();
  // Non-interactive: never offer to build one — there would be nobody to describe it. Unchanged.
  if (!process.stdin.isTTY) {
    if (!choices.length) throw new Error("No stories found under stories/.");
    return choices[0];
  }
  if (!choices.length) {
    console.log(`\n${C.dim}No stories yet — let's build one.${C.reset}`);
    return NEW_STORY;
  }

  console.log("\nAvailable stories:");
  choices.forEach((c, i) => console.log(`  ${i + 1}. ${c.replace(/^stories\//, "")}`));
  console.log(`  n. ${C.green}new story…${C.reset} ${C.dim}(describe an idea and have one built)${C.reset}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question(`Pick a story [1-${choices.length}] or "n" (default 1): `)).trim();
  rl.close();
  if (/^n/i.test(ans)) return NEW_STORY;
  const idx = parseInt(ans, 10) - 1;
  return choices[Number.isInteger(idx) && idx >= 0 && idx < choices.length ? idx : 0];
}

/**
 * Resolve a story directory that came from OUTSIDE the process — the browser picker — to one the
 * engine actually discovered, or null.
 *
 * A path from a client is not a path: it is a request to read one. The engine owns which directories
 * exist for the same reason `slugify()` owns which ones may be written, and a match against the
 * discovered list is the whole check — no normalizing, no prefix test, nothing a `..` can survive.
 */
export async function selectableStory(dir: string): Promise<string | null> {
  const want = String(dir ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!want) return null;
  const choices = await discoverStories();
  return choices.find(c => c === want || c === `stories/${want}`) ?? null;
}

// -- DEFAULTS (used before any story exists) -------------------------------
// `## Models` lives inside a story, and scaffolding happens before there is one. Resolution order is
// `--model=` > defaults.md > these constants. The file is optional; absent means the constants,
// silently. SPEC-S-scaffold.md §2.
const BUILTIN_MODEL = "qwen3.6-35b-a3b";
export interface Defaults {
  models: { default: string; architect: string };
  thinking: { architect: ThinkLevel };
  requestTimeout: number; attempts: number; maxTokens: number; stream: boolean; debug: boolean;
}
export async function loadDefaults(override = ""): Promise<Defaults> {
  let kv: Record<string, string> = {};
  try { kv = parseStoryMd(await readFile(joinPath(ROOT, "defaults.md"), "utf8")).kv; } catch { /* built-ins */ }
  const def = override || kv["models.default"] || BUILTIN_MODEL;
  const thinkingDefault = enumOf(kv, "config.thinking", THINK_LEVELS, "low");
  return {
    models: { default: def, architect: override || kv["models.architect"] || def },
    thinking: { architect: enumOf(kv, "config.thinking_architect", THINK_LEVELS, thinkingDefault) },
    requestTimeout: num(kv, "config.request_timeout", 120),
    attempts: num(kv, "config.attempts", 3),
    maxTokens: num(kv, "config.max_tokens", 2000),
    stream: bool(kv, "config.stream", true),
    debug: bool(kv, "config.debug", false),
  };
}

// -- STORY SPEC (what the architect proposes) ------------------------------
// The architect returns THIS, never markdown. `renderStory()` (S3) turns it into the files
// loadStory() reads, which is what makes "spec -> files -> loadStory -> the same spec" a testable
// invariant instead of a hope. `slug` is deliberately absent: the engine derives it from the title,
// because a model that picks its own path is a model that can write outside stories/.
export interface StorySpec {
  title: string;
  premise: string;
  scene: { place: string; question: string; pov: string; length: number };
  writerStyle: string;
  characters: Array<{ name: string; persona: string; knows: string; skills: string[]; lacks: string[] }>;
}

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean)
  : typeof v === "string" ? v.split("|").map(s => s.trim()).filter(Boolean)
  : [];

/** Coerce whatever the architect returned into a StorySpec, reporting problems rather than throwing
 *  — the caller is a conversation, and "that gave me nothing to work with" is a thing to say to the
 *  author, not an exception. Pure. */
export function normalizeSpec(raw: any): { spec: StorySpec; problems: string[] } {
  const problems: string[] = [];
  const o = raw ?? {};
  const s = (o.scene && typeof o.scene === "object") ? o.scene : {};

  const seen = new Set<string>();
  const characters: StorySpec["characters"] = [];
  for (const c of (Array.isArray(o.characters) ? o.characters : [])) {
    const name = String(c?.name ?? "").trim();
    if (!name) { problems.push("a character came back with no name — dropped"); continue; }
    if (seen.has(name.toLowerCase())) { problems.push(`two characters called "${name}" — kept the first`); continue; }
    seen.add(name.toLowerCase());
    const lacks = asStrings(c?.lacks).filter(l => {
      // A `lacks:` the catalog does not contain removes nothing, which is the silent opposite of
      // what was asked for. Catch it here, in the round that caused it.
      const ok = Object.keys(SKILL_CATALOG).some(g => canonSkill(g) === canonSkill(splitMeaning(l).text));
      if (!ok) problems.push(`${name} "lacks: ${l}" — not a general skill, so it would remove nothing`);
      return ok;
    });
    characters.push({
      name, persona: String(c?.persona ?? "").trim(), knows: String(c?.knows ?? "").trim(),
      skills: asStrings(c?.skills), lacks,
    });
    if (!c?.persona) problems.push(`${name} has no persona`);
    // Observed: the architect writes "LACKS: none" / "KNOWS: ..." into the persona prose. The engine
    // renders those fields itself from the structured data, so a persona that also states them puts
    // a contradiction inside the character's own prompt — it is told it lacks nothing while being
    // handed a skill list with something missing.
    else if (/\b(LACKS|KNOWS|SKILLS)\s*:/.test(String(c.persona)))
      problems.push(`${name}'s persona restates knows/skills/lacks — the engine renders those, and the persona will contradict them`);
  }
  if (!characters.length) problems.push("no characters at all");
  if (characters.length > 4) { problems.push(`${characters.length} characters — keeping the first 4`); characters.length = 4; }

  const lengthRaw = Number(s.length);
  const pov = String(s.pov ?? "").trim();
  const povOk = !pov || characters.some(c => c.name.toLowerCase() === pov.toLowerCase());
  if (pov && !povOk) problems.push(`pov "${pov}" is not one of the characters — cleared`);

  const spec: StorySpec = {
    title: String(o.title ?? "").trim(),
    premise: String(o.premise ?? "").trim(),
    scene: {
      place: String(s.place ?? "").trim(),
      question: String(s.question ?? "").trim(),
      pov: povOk ? pov : "",
      length: Number.isFinite(lengthRaw) && lengthRaw >= 1 ? Math.round(lengthRaw) : 700,
    },
    writerStyle: String(o.writer_style ?? o.writerStyle ?? "").trim(),
    characters,
  };
  if (!spec.title) problems.push("no title");
  if (!spec.premise) problems.push("no premise");
  if (!spec.scene.question) problems.push("no scene question — nothing for the scene to answer");
  // The architect is told to build in an imbalance and will sometimes propose two people who can
  // both do everything. That reads fine and scenes badly: with nothing one of them cannot perceive
  // or cannot do, the writer has far less it must stop and ask about. Code cannot judge whether a
  // design is interesting, but it can notice the one absence that reliably makes it dull.
  if (characters.length > 1 && !characters.some(c => c.lacks.length))
    problems.push("nobody lacks anything — no perceptual asymmetry for the consult to bite on");
  return { spec, problems };
}

/**
 * Apply the architect's edits to a spec (SPEC-S §4.2). A refinement round is a PATCH against a
 * closed list of field paths, not a fresh proposal: re-proposing the whole story each round would
 * make "it kept the parts I liked" a hope, and this makes it a property of the code. Unknown paths
 * are reported, never guessed at. Pure — the result is re-normalized, so a removed character takes
 * a stale `pov` with it and a bad `lacks:` is caught in the round that introduced it.
 */
export function applyEdits(spec: StorySpec, raw: any): {
  spec: StorySpec; applied: string[]; ignored: string[]; problems: string[];
} {
  const applied: string[] = [], ignored: string[] = [];
  // Work on a plain object in the shape normalizeSpec reads, so one validator covers both paths.
  const draft: any = JSON.parse(JSON.stringify({ ...spec, writer_style: spec.writerStyle }));
  const edits = Array.isArray(raw?.edits) ? raw.edits : [];
  const findChar = (name: string) =>
    draft.characters.find((c: any) => String(c.name).toLowerCase() === name.trim().toLowerCase());

  for (const e of edits) {
    const field = String(e?.field ?? "").trim();
    const value = e?.value;
    const scalar = () => String(value ?? "").trim();

    if (field === "title" || field === "premise") { draft[field] = scalar(); applied.push(field); continue; }
    if (field === "writer_style" || field === "writerStyle") { draft.writer_style = scalar(); applied.push("writer_style"); continue; }

    const sceneKey = field.match(/^scene\.(place|question|pov|length)$/)?.[1];
    if (sceneKey) {
      draft.scene[sceneKey] = sceneKey === "length" ? Number(value) : scalar();
      applied.push(field);
      continue;
    }

    if (field === "add_character") {
      const name = String(value?.name ?? "").trim();
      if (!name) { ignored.push(`add_character with no name`); continue; }
      if (findChar(name)) { ignored.push(`add_character "${name}" — already in the cast`); continue; }
      draft.characters.push(value);
      applied.push(`added ${name}`);
      continue;
    }
    if (field === "remove_character") {
      const name = scalar();
      const idx = draft.characters.findIndex((c: any) => String(c.name).toLowerCase() === name.toLowerCase());
      if (idx < 0) { ignored.push(`remove_character "${name}" — not in the cast`); continue; }
      draft.characters.splice(idx, 1);
      applied.push(`removed ${name}`);
      continue;
    }

    const cm = field.match(/^characters\.(.+)\.(persona|knows|skills|lacks)$/);
    if (cm) {
      const c = findChar(cm[1]);
      if (!c) { ignored.push(`${field} — no character called "${cm[1]}"`); continue; }
      c[cm[2]] = (cm[2] === "skills" || cm[2] === "lacks") ? asStrings(value) : scalar();
      applied.push(`${c.name}.${cm[2]}`);
      continue;
    }

    ignored.push(field ? `unknown field "${field}"` : "an edit with no field");
  }

  const { spec: next, problems } = normalizeSpec(draft);
  return { spec: next, applied, ignored, problems };
}

/** Folder and file names are the ENGINE's to decide, never the model's — a model that picks its own
 *  path is a model that can write outside stories/. Returns "" when nothing usable survives, which
 *  the caller must handle rather than falling back to something arbitrary. */
export function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

/**
 * Turn a spec into the exact files `loadStory()` reads. Pure — returns filename -> contents and
 * writes nothing, which is what makes the round trip (spec -> files -> loadStory -> the same spec)
 * a unit test with no filesystem and no model in it.
 */
export function renderStory(spec: StorySpec, models: { default: string }): Record<string, string> {
  // Every `key: value` in the grammar is single-line, so anything heading for one is flattened
  // first. Losing a newline out of `knows:` costs nothing; leaking one silently ends the field.
  const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
  const files: Record<string, string> = {};

  const used = new Set<string>();
  const fileFor = (name: string) => {
    let base = slugify(name) || "character";
    let f = `${base}.md`, n = 2;
    while (used.has(f)) f = `${base}-${n++}.md`;    // two names can slug to one file; don't overwrite
    used.add(f);
    return f;
  };

  const blocks = spec.characters.map(c => {
    const file = fileFor(c.name);
    files[file] = `# ${c.name}\n\n${c.persona.trim()}\n`;
    return [
      `### ${c.name}`,
      `file: ${file}`,
      c.skills.length ? `skills: ${c.skills.map(oneLine).join(" | ")}` : "",
      c.lacks.length ? `lacks: ${c.lacks.map(oneLine).join(" | ")}` : "",
      c.knows ? `knows: ${oneLine(c.knows)}` : "",
    ].filter(Boolean).join("\n");
  });

  if (spec.writerStyle.trim()) files["writer.md"] = `# House style\n\n${spec.writerStyle.trim()}\n`;

  const sceneLines = [
    spec.scene.place ? `place: ${oneLine(spec.scene.place)}` : "",
    spec.scene.question ? `question: ${oneLine(spec.scene.question)}` : "",
    spec.scene.pov ? `pov: ${spec.scene.pov}` : "",
    `length: ${spec.scene.length}`,
  ].filter(Boolean).join("\n");

  files["story.md"] = [
    `# ${spec.title}`,
    `## Premise\n${spec.premise.trim()}`,
    `## Scene\n${sceneLines}`,
    ...(files["writer.md"] ? [`## Writer\nfile: writer.md`] : []),
    `## Characters\n\n${blocks.join("\n\n")}`,
    `## Config\nretries: 2\nclarifications: 2\nmax_steps: 24`,
    `## Models\ndefault: ${models.default}`,
  ].join("\n\n") + "\n";

  return files;
}

// -- ARCHITECT -------------------------------------------------------------
const ARCHITECT_FORMAT = `You design scenes for a writing engine, from an author's rough idea.

HOW THE ENGINE WORKS, because it changes what makes a good design: a writer agent drafts the scene,
but it may not write anyone's dialogue or deliberate acts. Whenever a choice is being made it must
stop and ask that character's own agent, which answers from its persona and a fixed list of skills,
and which may ask the writer for a fact it was not given. So the scene is only as good as the people
in it are DIFFERENT from each other -- in what they can perceive, what they can do, what they know,
and what they are each trying to get.

FIRST DECIDE: propose, or ask?

  Read the idea and answer two questions. Does it tell you WHO is in the scene? Does it tell you
  WHAT IS AT STAKE between them? If the answer to either is no, you would be inventing the thing the
  author cares most about, and you must ASK INSTEAD OF PROPOSING:

      {"ask": "your one question", "title": "", "premise": "", "characters": []}

  One question, the most load-bearing one, and every other field empty. "Two lighthouse keepers" is
  not a brief -- it names who, and nothing at stake. "A keeper who cannot hear must decide whether to
  log that the fog signal never fired" is a brief: ask nothing, propose.

  This is the same move the characters make inside a running scene -- ask for the fact you are
  missing rather than making one up. It is not a failure to answer; it is the answer.

  If the idea does tell you both, do NOT ask. Propose, and commit.

Reply with ONE JSON object and nothing else:

{"title": "...",
 "premise": "...",
 "scene": {"place": "...", "question": "...", "pov": "NAME", "length": 700},
 "writer_style": "...",
 "characters": [{"name": "NAME", "persona": "...", "knows": "...",
                 "skills": ["lockpicking :: opening a mechanical lock without its key"],
                 "lacks": ["sight"]}],
 "ask": "",
 "note": ""}

title        -- three words or fewer, concrete.
premise      -- the situation, the place, the hour, the pressure. Enough that a writer could open
                on it cold. A few short paragraphs. Say what the scene is NOT about too, if it keeps
                it honest.
scene.place  -- one line. Where and when.
scene.question -- the dramatic question the scene has to answer, phrased so it CAN be answered in
                the length given. Not a theme; a question with an outcome.
scene.pov    -- whose perception we are inside. One of the character names.
scene.length -- words. 600-900 unless the idea demands otherwise.
writer_style -- house style: person, tense, what to do with dialogue, what to leave out.
characters   -- TWO is the sweet spot; four is the maximum. For each:
  name       -- one word, capitalised, how the writer will refer to them.
  persona    -- who they are: history in a line or two, then VOICE (how they talk), then how they
                are UNDER PRESSURE, then what they want tonight. Concrete and particular. Around
                150 words. Write it addressed to them ("You have...") or about them, either way,
                but never as a summary of their arc -- they must be able to act from it, not
                perform it. PROSE ONLY: do not restate knows, skills or lacks inside it. Those are
                separate fields and the engine renders them itself; a persona that also says
                "LACKS: none" contradicts the skill list the character is actually given.
  knows      -- what they know walking in that the other characters do not. This is where a scene
                gets its friction.
  skills     -- abilities BEYOND the general list below. "name :: what it means". Give someone
                something the other cannot do. Do NOT restate a general skill under a new name:
                "watching :: seeing the lens turn" is just sight, and adds nothing.
  lacks      -- general skills this character does NOT have. MUST be names from the general list.
                One character who cannot see, or cannot speak, or cannot move, will do more for a
                scene than any amount of backstory. AT LEAST ONE character must lack something
                real, unless the idea makes that genuinely impossible.
ask          -- see FIRST DECIDE above. Either this is your whole reply and everything else is
                empty, or it is "". Do not send a full story with a question attached: if you had
                enough to propose, you had enough not to ask.
note         -- "" normally. One line to the author about a choice you made that they might want to
                overturn.

WHEN ASKED FOR A CHANGE -- [CHANGE]:

  {"edits": [{"field": "...", "value": ...}], "ask": "", "note": ""}

  Change ONLY what was asked for, plus anything it makes inconsistent. Do not resend fields you are
  not changing -- everything you leave alone is kept exactly as it is. The field must be one of:

    title · premise · writer_style
    scene.place · scene.question · scene.pov · scene.length
    characters.<NAME>.persona · characters.<NAME>.knows
    characters.<NAME>.skills · characters.<NAME>.lacks     (value is a list)
    add_character      (value is a whole character object, as above)
    remove_character   (value is the name)

  Any other field name is ignored, and the author is told it was. If the change they asked for is
  ambiguous enough that you would be guessing at what they meant, use "ask" and change nothing.

DESIGN FOR ASYMMETRY. Two people who can both see, both move and both talk, who want compatible
things, produce a scene where nothing has to be asked. Give them different senses, different
authority, different information, or different stakes. At least one real imbalance.

Do not write the scene. Do not write dialogue. You are designing the people and the pressure; the
writer and the characters do the rest.

CRITICAL: If your output is not a JSON object starting with { it will be discarded.`;

/** The general skill list, verbatim, so the architect proposes `lacks:` that actually remove
 *  something and `skills:` that do not merely restate a general one. */
function catalogBlock(): string {
  return `THE GENERAL SKILL LIST -- every character has all of these unless "lacks" removes them:\n`
    + Object.entries(SKILL_CATALOG).map(([n, m]) => `  ${n} -- ${m}`).join("\n");
}

/** A real authored story as a worked example, read at run time so it can never drift from the
 *  format the loader actually accepts. Best-effort: absent, the architect just has less to go on. */
async function architectExample(): Promise<string> {
  try {
    const md = await readFile(joinPath(ROOT, "stories/doorway/story.md"), "utf8");
    const persona = await readFile(joinPath(ROOT, "stories/doorway/riven.md"), "utf8");
    return `A WORKED EXAMPLE -- a story of this kind, as its author wrote it:\n\n${md.trim()}\n\n`
      + `and one of its persona files:\n\n${persona.trim()}`;
  } catch { return ""; }
}

export async function buildArchitect(d: Defaults): Promise<Agent> {
  const example = await architectExample();
  const system = `${ARCHITECT_FORMAT}\n\n${catalogBlock()}` + (example ? `\n\n${example}` : "");
  const a = new Agent("ARCHITECT", d.models.architect, system, 0.9);
  a.think = d.thinking.architect;
  return a;
}

/** Render a proposal for a human to read. Never raw JSON — the point of the round is a judgement
 *  about people, and JSON is the wrong shape to make one from. */
export function renderSpec(spec: StorySpec, full = false): string {
  const head = `${C.bold}${spec.title || "(untitled)"}${C.reset}\n`
    + `${C.dim}${spec.scene.place || "(nowhere stated)"} · ~${spec.scene.length} words`
    + `${spec.scene.pov ? ` · pov ${spec.scene.pov}` : ""}${C.reset}\n\n`
    + `${spec.premise || "(no premise)"}\n\n`
    + `${C.bold}Question:${C.reset} ${spec.scene.question || "(none)"}\n`;
  const cast = spec.characters.map(c => {
    const lines = [`\n${C.cyan}${c.name}${C.reset}`];
    if (c.skills.length) lines.push(`  ${C.green}can also:${C.reset} ${c.skills.map(s => splitMeaning(s).text).join(", ")}`);
    if (c.lacks.length)  lines.push(`  ${C.red}cannot:${C.reset}   ${c.lacks.join(", ")}`);
    if (c.knows)         lines.push(`  ${C.dim}knows:${C.reset}    ${c.knows}`);
    lines.push(full ? `\n${c.persona}\n` : `  ${C.dim}${c.persona.replace(/\s+/g, " ").slice(0, 140)}…${C.reset}`);
    return lines.join("\n");
  }).join("\n");
  return head + cast + (spec.writerStyle && full ? `\n\n${C.bold}House style${C.reset}\n${spec.writerStyle}\n` : "");
}

/** The same proposal as plain data, for a caller that is not a terminal. `renderSpec` bakes in ANSI
 *  and line breaks; this bakes in nothing, and splits a `skill :: meaning` so the two can be shown
 *  as what they are rather than as one string with a `::` in it. */
export function specView(spec: StorySpec) {
  return {
    title: spec.title, premise: spec.premise, scene: spec.scene, writerStyle: spec.writerStyle,
    characters: spec.characters.map(c => ({
      name: c.name, persona: c.persona, knows: c.knows,
      skills: c.skills.map(s => splitMeaning(s)),
      lacks: c.lacks,
    })),
  };
}

// -- SCAFFOLD SESSION ------------------------------------------------------
// The interview (SPEC-S §4) with no console in it. Everything the loop actually decides lives here;
// the caller only reads state and renders. That split is what lets one implementation serve both the
// terminal and the browser, and — more useful day to day — it is what makes the state machine
// testable: the proposal-vs-patch rule and the ask budget were previously welded to readline, so the
// bug §4.2 documents could only ever be caught by hand.
//
// The architect is injected rather than built, so a scripted agent drives the whole thing.

/** What one round of the interview did. `spec` and `problems` are read off the session afterwards. */
export type ScaffoldRound =
  | { kind: "proposal"; note: string }
  | { kind: "edits"; applied: string[]; ignored: string[]; note: string }
  | { kind: "question"; ask: string }
  | { kind: "nothing"; why: string }
  | { kind: "failed"; error: string };

/** What accepting did. `needs_folder` is a question for the author, not an error. */
export type ScaffoldAccept =
  | { kind: "written"; dir: string; files: string[]; warnings: string[] }
  | { kind: "unloadable"; dir: string; files: string[]; error: string; warnings: string[] }
  | { kind: "needs_folder"; reason: string }
  | { kind: "no_story" };

/**
 * The note for a round, with any question the architect asked *alongside* its answer folded in.
 *
 * The format tells it to ask INSTEAD of proposing, and it often does both anyway — a whole story
 * plus the question it would have liked answered. Read strictly, that question was being dropped on
 * the floor: `ask` is only honoured when nothing else came back. Dropped is the one thing it must
 * not be. It cannot become `pendingAsk` either, because an outstanding question blocks accepting,
 * and there is a perfectly good story sitting there — so it rides along as a note the author can
 * answer as an ordinary change, or ignore.
 */
function withAsk(out: Record<string, any>): string {
  const note = String(out.note ?? "").trim();
  const ask = String(out.ask ?? "").trim();
  if (!ask) return note;
  return note ? `${note} — it also asks: ${ask}` : `it also asks: ${ask}`;
}

export class ScaffoldSession {
  spec: StorySpec = normalizeSpec({}).spec;    // nothing proposed yet
  problems: string[] = [];
  pendingAsk = "";
  asks = 0;                                    // consecutive questions with no story to show for them
  static readonly MAX_ASKS = 3;

  /** `storiesDir` exists so acceptance can be exercised against a temp folder instead of writing
   *  into the repo. Nothing but tests should pass it. */
  constructor(public architect: Agent, public defaults: Defaults, public idea: string,
              public storiesDir: string = joinPath(ROOT, "stories")) {}

  haveStory(): boolean { return this.spec.characters.length > 0; }

  /**
   * The message for this round. **A round is a PROPOSAL or a PATCH, and which one depends on whether
   * a story exists yet — not on whether this is the first call.** That distinction is the whole fix
   * for an ambiguous idea: the architect is told to ask a question INSTEAD of proposing when the idea
   * is underdetermined, so a vague prompt legitimately produces no story on the first call. Asking it
   * to "reply with edits only" against an empty spec after that is incoherent, and every later round
   * inherited the same emptiness — the scaffolder patched a void and never recovered.
   */
  request(userText: string): string {
    if (!userText) return `[THE IDEA]\n${this.idea}`;
    // The spec as the ENGINE holds it, not as the architect last described it — its own history and
    // the authoritative spec drift apart after a few rounds.
    if (this.haveStory())
      return `[CHANGE] ${userText}\n\n[THE STORY AS IT STANDS]\n`
        + `${JSON.stringify({ ...this.spec, writer_style: this.spec.writerStyle }, null, 1)}\n\n`
        + `Reply with edits only.`;
    // No story yet: carry the original idea plus what has been learned since, and ask for the whole
    // thing. After a few questions, insist — an author who keeps being interrogated instead of shown
    // something has been given nothing to react to.
    return `[MORE] ${userText}\n\n[THE IDEA, AGAIN]\n${this.idea}\n\n`
      + (this.asks >= ScaffoldSession.MAX_ASKS
          ? `Do not ask anything else. Choose the most interesting reading of this and commit to it. `
          : ``)
      + `Propose the whole story now, in the full format.`;
  }

  private async round(userText: string): Promise<{ out: Record<string, any> } | { error: string }> {
    this.architect.hear(this.request(userText));
    try {
      const reply = await this.architect.generate(`${C.magenta}ARCHITECT${C.reset}`);
      this.architect.said(reply.trim());
      return { out: extractJson(reply) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  /** Absorb a reply that is meant to be a whole story. */
  private takeProposal(out: Record<string, any>): ScaffoldRound {
    const n = normalizeSpec(out);
    if (!n.spec.characters.length) {
      const back = String(out.ask ?? "").trim();
      if (back) { this.pendingAsk = back; this.asks++; return { kind: "question", ask: back }; }
      return { kind: "nothing", why: "the reply was neither a story nor a question" };
    }
    this.asks = 0; this.pendingAsk = "";
    this.spec = n.spec; this.problems = n.problems;
    return { kind: "proposal", note: withAsk(out) };
  }

  /** The opening round: the idea, and nothing learned yet. */
  async propose(): Promise<ScaffoldRound> {
    const r = await this.round("");
    return "error" in r ? { kind: "failed", error: r.error } : this.takeProposal(r.out);
  }

  /** Everything the author says after that — a change once a story exists, more detail before. */
  async say(text: string): Promise<ScaffoldRound> {
    const wasPatch = this.haveStory();
    const r = await this.round(text);
    if ("error" in r) return { kind: "failed", error: r.error };
    if (!wasPatch) return this.takeProposal(r.out);

    const back = String(r.out.ask ?? "").trim();
    if (back && !r.out.edits) { this.pendingAsk = back; return { kind: "question", ask: back }; }

    const e = applyEdits(this.spec, r.out);
    this.spec = e.spec; this.problems = e.problems;
    this.pendingAsk = "";        // it asked, and this round answered it
    return { kind: "edits", applied: e.applied, ignored: e.ignored, note: withAsk(r.out) };
  }

  /** How to name a written story: relative to the repo when it is inside it, the way you would type
   *  it, and absolute otherwise. */
  private label(abs: string): string {
    const rel = relativePath(ROOT, abs).replace(/\\/g, "/");
    return rel && !rel.startsWith("..") ? rel : abs;
  }

  /**
   * Write the accepted spec and pre-flight it (SPEC-S §4.3). Returns `needs_folder` rather than
   * prompting — the author has to answer that, and *where* they answer it is the caller's business.
   *
   * The pre-flight is the point: it runs the REAL `loadStory()` on what was just written, so a
   * scaffold that cannot load is caught here rather than becoming a failed run several model calls
   * later. Same check `--preflight` uses, so the two cannot drift.
   */
  async accept(folderName = ""): Promise<ScaffoldAccept> {
    if (!this.haveStory()) return { kind: "no_story" };
    // The engine derives the folder, never the model — a model that picks its own path is a model
    // that can write outside stories/.
    const from = folderName || this.spec.title;
    const slug = slugify(from);
    if (!slug) return { kind: "needs_folder", reason: `"${from}" doesn't give a usable folder name.` };

    const abs = joinPath(this.storiesDir, slug);
    const taken = await readFile(joinPath(abs, "story.md"), "utf8").then(() => true).catch(() => false);
    if (taken) return { kind: "needs_folder", reason: `${this.label(abs)} already exists.` };

    const dir = this.label(abs);
    const rendered = renderStory(this.spec, this.defaults.models);
    await mkdir(abs, { recursive: true });
    for (const [name, body] of Object.entries(rendered)) await writeFile(joinPath(abs, name), body, "utf8");
    const files = Object.keys(rendered).sort();

    const pf = await runPreflight(dir);
    const warnings = pf.warnings.map(w => w.trim());
    return pf.ok
      ? { kind: "written", dir, files, warnings }
      : { kind: "unloadable", dir, files, error: pf.error ?? "unknown", warnings };
  }
}

// -- PRE-FLIGHT ------------------------------------------------------------
// Structural check: actually run the real loadStory() — the authoritative parser — so this can never
// drift from what a real run would do. No model calls; only local file reads. Serialized via
// preflightChain so concurrent checks can't cross-contaminate each other's console.warn capture.
let preflightChain: Promise<unknown> = Promise.resolve();
export interface PreflightResult {
  ok: boolean; error?: string; warnings: string[];
  summary?: {
    // What the story IS, not only whether it loads. The browser picker shows this to choose from,
    // and it is the loader's own copy rather than a second parse of story.md.
    premise: string;
    characters: { name: string; skills: number; added: string[]; lacking: string[] }[];
    scene: { place: string; question: string; pov: string; length: number };
    maxSteps: number; retries: number; clarifications: number;
    models: { default: string; writer: string; summary: string };
    modelCheck: "ok" | "missing" | "unreachable";
    missingModels: string[];
  };
}

/** The model ids LM Studio currently has loaded, or null when it can't be reached. Pre-flight only —
 *  never called on the run path, and never fatal: an unreachable server downgrades to a "couldn't
 *  check" warning rather than blocking a story.
 *
 *  Memoized for a few seconds because pre-flight is now run over EVERY story at once (the browser
 *  picker, `--preflight` with no argument). The loaded set cannot change inside one such sweep, and
 *  without this an unreachable server costs the full timeout once per story. */
let modelIdCache: { at: number; ids: Promise<string[] | null> } | null = null;
async function loadedModelIds(timeoutMs = 1500): Promise<string[] | null> {
  if (modelIdCache && Date.now() - modelIdCache.at < 5000) return modelIdCache.ids;
  const ids = fetchModelIds(timeoutMs);
  modelIdCache = { at: Date.now(), ids };
  return ids;
}
async function fetchModelIds(timeoutMs: number): Promise<string[] | null> {
  try {
    const res = await fetch(LMSTUDIO_MODELS_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const j = await res.json() as { data?: Array<{ id?: unknown }> };
    const ids = (j.data ?? []).map(m => String(m.id ?? "")).filter(Boolean);
    return ids.length ? ids : null;
  } catch { return null; }
}

export function runPreflight(dir: string): Promise<PreflightResult> {
  const task = preflightChain.then(async (): Promise<PreflightResult> => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(" ")); };
    try {
      const sc = await loadStory(dir);

      // Model ids are the one field the structural load cannot validate — a typo passes every check
      // here and then errors on every single call at runtime. Ask the server what it actually has.
      const wanted = [...new Set([sc.models.default, sc.models.writer, sc.models.summary,
                                  ...sc.characters.map(c => c.model)])].filter(Boolean);
      const loaded = await loadedModelIds();
      let modelCheck: "ok" | "missing" | "unreachable" = "ok";
      let missingModels: string[] = [];
      if (loaded === null) {
        modelCheck = "unreachable";
        warnings.push(`   (model check skipped: no model list from LM Studio at ${LMSTUDIO_MODELS_URL})`);
      } else {
        missingModels = wanted.filter(m => !loaded.includes(m));
        if (missingModels.length) {
          modelCheck = "missing";
          warnings.push(`   (not loaded in LM Studio: ${missingModels.join(", ")} — every call using `
            + `${missingModels.length > 1 ? "these" : "this"} will error)`);
        }
      }

      return {
        ok: true, warnings,
        summary: {
          premise: sc.premise,
          characters: sc.characters.map(c => ({
            name: c.name,
            skills: c.skills.length,
            added: c.skills.filter(s => s.source === "story").map(s => s.name),
            lacking: Object.keys(SKILL_CATALOG).filter(g => !c.skills.some(s => canonSkill(s.name) === canonSkill(g))),
          })),
          scene: sc.scene,
          maxSteps: sc.maxSteps, retries: sc.retries, clarifications: sc.clarifications,
          models: sc.models, modelCheck, missingModels,
        },
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message, warnings };
    } finally { console.warn = origWarn; }
  });
  preflightChain = task.catch(() => {});   // keep the chain alive even if a check throws unexpectedly
  return task;
}

/** Every discovered story, pre-flighted, as the browser picker needs it. No model calls — the same
 *  structural check `--preflight` runs, so a story that will not load says so on its card instead of
 *  failing after you pick it. */
export interface StoryCard {
  dir: string; name: string; ok: boolean; error?: string; warnings: string[];
  premise?: string;
  scene?: { place: string; question: string; pov: string; length: number };
  characters?: { name: string; can: string[]; cannot: string[] }[];
  maxSteps?: number;
}
export async function storyCards(): Promise<StoryCard[]> {
  const dirs = await discoverStories();
  const out: StoryCard[] = [];
  for (const dir of dirs) {
    const r = await runPreflight(dir);
    const s = r.summary;
    out.push({
      dir, name: dir.replace(/^stories\//, ""), ok: r.ok, error: r.error,
      warnings: r.warnings.map(w => w.trim()),
      ...(s ? {
        premise: s.premise,
        scene: s.scene,
        characters: s.characters.map(c => ({ name: c.name, can: c.added, cannot: c.lacking })),
        maxSteps: s.maxSteps,
      } : {}),
    });
  }
  return out;
}

/** `--preflight`: structurally check the given story (or every discovered one) and exit. Runs the
 *  real loadStory(), makes no model calls and writes no files. Exit code 1 if any story fails. */
async function runPreflightCli() {
  const dirs = STORY_DIR ? [STORY_DIR] : await discoverStories();
  if (!dirs.length) { console.error("No stories found under stories/."); process.exitCode = 1; return; }
  let failed = 0;
  for (const dir of dirs) {
    const r = await runPreflight(dir);
    const head = r.ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
    console.log(`\n${head} ${C.bold}${dir}${C.reset}`);
    if (!r.ok) { failed++; console.log(`   ${C.red}${r.error}${C.reset}`); }
    else if (r.summary) {
      const s = r.summary;
      for (const c of s.characters)
        console.log(`   ${c.name}: ${c.skills} skills`
          + (c.added.length ? ` (+${c.added.join(", ")})` : "")
          + (c.lacking.length ? ` ${C.dim}(no ${c.lacking.join(", ")})${C.reset}` : ""));
      console.log(`   steps ${s.maxSteps} · retries ${s.retries} · clarifications ${s.clarifications}`
        + (s.scene.pov ? ` · pov ${s.scene.pov}` : "")
        + ` · ~${s.scene.length} words · models ${s.modelCheck}`);
    }
    for (const w of r.warnings) console.log(`   ${C.yellow}⚠${C.reset} ${w.trim()}`);
    if (r.ok && !r.warnings.length) console.log(`   ${C.dim}no warnings${C.reset}`);
  }
  if (failed) process.exitCode = 1;
}

// -- CHARACTER AGENT -------------------------------------------------------
const CHARACTER_FORMAT = `YOUR OUTPUT FORMAT -- follow this exactly. Reply with ONE JSON object and nothing else.

An author is writing a scene you are in. They will describe your situation and ask you something.
You answer as yourself, in the moment -- never about yourself from outside, never as a suggestion
for what the scene could do.

You may reply in one of two ways.

1. If you cannot answer without knowing something about your situation that they have not told you,
   ask for it:

   {"need": "Can I reach the door handle from where I am?"}

   ONE question, the smallest one that unblocks you, about a fact of your situation only. Do not ask
   what you should do, what would be interesting, or what anyone else is thinking or feeling.

2. Otherwise, answer:

   {"thought": "...", "speech": "...", "action": "...", "skills_used": ["..."], "note": ""}

   thought      -- what actually goes through your head, in TWO SENTENCES AT MOST. Not a summary of
                   the situation, not your reasoning about what to do: the thought itself.
   speech       -- the words you say aloud and nothing else, with no quotation marks around them,
                   or "" if you say nothing.
   action       -- what you physically do, in one or two plain sentences, or "" if you do nothing.
   skills_used  -- every skill from YOUR SKILLS below that this answer uses, named exactly as listed.
   note         -- "" normally. Use it to tell the author something out of character: an assumption
                   you had to make, or something you would need and do not have.

WHAT YOU KNOW: your own persona, your own skills, what you knew coming into this scene, the
situation as the author describes it, and what you have already told them in this conversation.
Nothing else. You do not know what the scene is for, what happens next, or what anyone else is
thinking. Do not invent facts about the world -- if you need one, ask for it. Your own body, memory
and feelings are yours to invent freely.

STAY INSIDE YOUR SKILLS. If what you want to do would take a skill that is not on your list, you
cannot do it. Do something you can do instead, and say why in "note".

Answer at the length the moment deserves. One breath is a complete answer.

CRITICAL: If your output is not a JSON object starting with { it will be discarded.`;

/** A character's system prompt: the contract, their persona, where they are, their skill menu, and
 *  what they knew walking in. Deliberately NOT the premise — authorial direction and the shape of
 *  the scene are the writer's, and a character that has read them stops being a source of
 *  independent evidence about itself. */
export function wrapCharacter(def: CharacterDef, place: string): string {
  const menu = def.skills.map(s => `  - ${s.name}${s.meaning ? ` -- ${s.meaning}` : ""}`).join("\n");
  const extras = [
    place ? `WHERE YOU ARE: ${place}` : "",
    `YOUR SKILLS (all of what you can do; nothing else):\n${menu}`,
    def.knows ? `WHAT YOU KNOW COMING INTO THIS: ${def.knows}` : "",
  ].filter(Boolean).join("\n\n");
  return `${CHARACTER_FORMAT}\n\n${def.persona.trim()}\n\n${extras}`;
}

export function buildCharacterAgents(sc: StoryConfig): Map<string, Agent> {
  const agents = new Map<string, Agent>();
  for (const def of sc.characters) {
    const a = new Agent(def.name, def.model, wrapCharacter(def, sc.scene.place), 0.9);
    a.think = sc.thinking.character;
    agents.set(def.name.toLowerCase(), a);
  }
  return agents;
}

// -- CONSULT ---------------------------------------------------------------
export interface ConsultRequest {
  character: string;
  situation: string;    // what the character can perceive right now, in the author's words
  question: string;     // what the author needs to know
  wants: string;        // optional shape of the answer: "speech" | "action" | "reaction" | "decision"
}
export interface ConsultReply {
  character: string;
  thought: string; speech: string; action: string; note: string;
  skillsUsed: string[];
  unverified: string[];                                  // claimed skills this character does not have
  clarifications: { question: string; answer: string }[];
  forced: boolean;                                       // ran out of clarifications and answered anyway
  raw: string;
}
export type ConsultEvent =
  | { t: "consult"; character: string; situation: string; question: string; wants: string; attempt: number }
  | { t: "need"; character: string; question: string }
  | { t: "clarify"; character: string; question: string; answer: string }
  | { t: "forced"; character: string }
  | { t: "repair"; character: string; why: string }
  | { t: "skill_flag"; character: string; claimed: string[]; unknown: string[] }
  | { t: "answer"; character: string; thought: string; speech: string; action: string;
      note: string; skills_used: string[]; unverified: string[] };

/** Who answers a character's clarifying question. In a real run this is the writer; the `--consult`
 *  debug CLI wires it to the console. */
export type Clarifier = (question: string, req: ConsultRequest) => Promise<string>;

const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean)
  : typeof v === "string" ? v.split(/[,;|]/).map(s => s.trim()).filter(Boolean)
  : [];

const askBlock = (req: ConsultRequest) =>
  `[THE AUTHOR ASKS]\nSituation: ${req.situation}\nQuestion: ${req.question}`
  + (req.wants ? `\nWhat they need from you: ${req.wants}` : "");

/**
 * Ask one character one question, resolving clarifications and checking claimed skills.
 *
 * Does NOT touch `agent.history` — every exchange here is ephemeral. The caller decides what
 * becomes part of the character's memory (in a run: only the accepted answer), which is what lets a
 * rejected attempt leave no trace and a retry run against a fresh `agent.fork()`.
 */
export async function consult(
  agent: Agent, req: ConsultRequest, skills: Skill[],
  opts: { clarifications: number; clarify: Clarifier; attempt?: number; log?: (e: ConsultEvent) => void },
): Promise<ConsultReply> {
  const log = opts.log ?? (() => {});
  const have = new Map(skills.map(s => [canonSkill(s.name), s.name]));
  const extra: Msg[] = [{ role: "user", content: askBlock(req) }];
  const clarifications: { question: string; answer: string }[] = [];
  let forced = false, repaired = false;

  log({ t: "consult", character: req.character, situation: req.situation, question: req.question,
        wants: req.wants, attempt: opts.attempt ?? 1 });

  for (;;) {
    const raw = await agent.generate(`${C.cyan}${agent.name}${C.reset}`, extra);
    const o = extractJson(raw);
    const need = String(o.need ?? "").trim();

    // -- the character wants a fact it was not given
    if (need) {
      if (clarifications.length < opts.clarifications) {
        log({ t: "need", character: req.character, question: need });
        const answer = (await opts.clarify(need, req)).trim() || "(no answer)";
        clarifications.push({ question: need, answer });
        log({ t: "clarify", character: req.character, question: need, answer });
        extra.push({ role: "assistant", content: JSON.stringify({ need }) },
                   { role: "user", content: `[THE AUTHOR ANSWERS] ${answer}` });
        continue;
      }
      // Budget spent. One more call, told plainly that nothing else is coming — an author who has
      // stopped answering is a fact about the situation, not a reason to stall.
      if (!forced) {
        forced = true;
        log({ t: "forced", character: req.character });
        extra.push({ role: "assistant", content: JSON.stringify({ need }) },
                   { role: "user", content: `[THE AUTHOR ANSWERS] No more detail is coming. Answer now with `
                     + `what you have: take the most likely reading of your situation, and say which reading `
                     + `you took in "note".` });
        continue;
      }
      // Asked again after being told that. Every branch from here MUST consume a budget, or a
      // character that only ever asks questions loops forever at one model call per turn — which is
      // exactly what it did: a slow infinite loop that looks like a slow model.
      if (!repaired) {
        repaired = true;
        log({ t: "repair", character: req.character, why: "asked again after being told no more detail is coming" });
        extra.push({ role: "assistant", content: JSON.stringify({ need }) },
                   { role: "user", content: `[ANSWER NOW] Do not ask anything else. Give thought, speech `
                     + `and action for what you do with what you already know.` });
        continue;
      }
      // Out of moves. Return the stall honestly rather than spending the rest of the run on it.
      const stalled: ConsultReply = {
        character: req.character, thought: "", speech: "", action: "",
        note: `did not answer; kept asking: ${need}`,
        skillsUsed: [], unverified: [], clarifications, forced: true, raw,
      };
      log({ t: "answer", character: req.character, thought: "", speech: "", action: "",
            note: stalled.note, skills_used: [], unverified: [] });
      return stalled;
    }

    const thought = String(o.thought ?? "").trim();
    const speech  = String(o.speech ?? "").trim();
    const action  = String(o.action ?? "").trim();
    const note    = String(o.note ?? "").trim();
    const claimed = asList(o.skills_used);
    const unknown = claimed.filter(s => !have.has(canonSkill(s)));

    // -- one repair pass, for a reply that is empty or claims a skill this character does not have
    const why = !thought && !speech && !action ? "returned nothing usable"
              : unknown.length ? `used ${unknown.map(s => `"${s}"`).join(", ")}`
              : "";
    if (why && !repaired) {
      repaired = true;
      log({ t: "repair", character: req.character, why });
      extra.push({ role: "assistant", content: raw.trim() },
                 { role: "user", content: unknown.length
                   ? `[SKILL CHECK] ${unknown.map(s => `"${s}"`).join(", ")} ${unknown.length > 1 ? "are" : "is"} `
                     + `not yours. All you can do is: ${[...have.values()].join(", ")}. Answer again doing only `
                     + `what you can actually do.`
                   : `[EMPTY] That reply had no thought, no speech and no action. Answer the question.` });
      continue;
    }

    // Spent the repair and it still claims skills it lacks: the answer goes to the author FLAGGED,
    // never silently accepted. The author is the one who decides what to do with it.
    if (unknown.length) log({ t: "skill_flag", character: req.character, claimed, unknown });

    const reply: ConsultReply = {
      character: req.character, thought, speech, action, note,
      skillsUsed: claimed, unverified: unknown, clarifications, forced, raw,
    };
    log({ t: "answer", character: req.character, thought, speech, action, note,
          skills_used: claimed, unverified: unknown });
    return reply;
  }
}

// -- WRITER AGENT ----------------------------------------------------------
const WRITER_FORMAT = `YOU ARE THE AUTHOR. You are writing one scene, a piece at a time.

You do not decide what the people in this scene do. When what happens next turns on a choice one of
them makes -- what they say, whether they give way, what they reach for -- you STOP and ask them.
They answer as themselves, and their answer is evidence about the scene, not a suggestion you may
overrule because it is inconvenient.

Every reply you make is ONE JSON object and nothing else. Which fields you use depends on what you
have been asked.

WHEN ASKED TO WRITE -- [WRITE]:

  {"prose": "...", "consult": {"character": "NAME", "situation": "...", "question": "...", "wants": "..."}, "scene_done": false}

  prose      -- the next piece of the scene, ready for the page. "" if you are only consulting.
                Bound by THE ONE RULE below.
  consult    -- omit the field entirely when you do not need one.
    character  -- who you are asking.
    situation  -- what THEY can perceive right now, in your words. They know nothing you do not put
                  here: not the scene so far, not what anyone else thought, not what you are steering
                  toward. Give them enough to answer honestly, and no nudge toward the answer you
                  would prefer.
    question   -- what you need to know.
    wants      -- the shape of answer you need: "what they say", "what they do next", "whether they
                  move aside".
  scene_done -- true only when the scene's question has been answered and the last line is written.

  Consult when a choice is being made. Do not consult for scenery, for a gesture that carries
  nothing, or for something you have already asked and had answered.

THE ONE RULE

  Every line of dialogue, and every deliberate act, belongs to the person doing it. You may put it
  on the page ONLY if it came from an answer you have already been given. There is no exception for
  the point-of-view character: what they perceive and what their body does without being asked are
  yours to render; what they say and what they choose are not.

  YOURS without asking -- the place, the light, the cold, the noise, the smell, time passing, what a
  body does without choosing it (a breath, a flinch, an ache, a shiver), and anything already
  answered, in any character's case.
  NOT YOURS -- what anyone says, what anyone decides to do, what anyone is thinking or feeling.

  So write up to the moment of choice and stop there. Send the prose you have and the consult you
  need in the same reply: you will be handed the answer before you are asked to write again, and the
  NEXT piece of prose is where it belongs.

  Writing someone's choice and then asking about it is the one mistake that wastes an answer. You
  will be told they did something else, and the page will already say otherwise.

WHEN A CHARACTER ASKS YOU SOMETHING -- [<NAME> ASKS]:

  {"answer": "..."}

  They are asking for a fact about their situation. Answer it plainly, briefly, and only it. If you
  had not decided yet, decide now -- your answer becomes true for the rest of the scene. Never
  answer with what they should do, and never tell them anything they could not perceive.

WHEN YOU ARE SHOWN AN ANSWER -- [<NAME> ANSWERED]:

  {"verdict": "accept", "note": "", "revised": {"situation": "...", "question": "..."}}

  verdict  -- "accept" or "retry".
  revised  -- only with "retry": the question as you should have asked it. They will be asked again
              from nothing, with no memory of this attempt, so the revised situation and question
              must stand on their own.

  Retry only when the answer is unusable: they answered a different question, or they plainly lacked
  something they needed in order to answer (then fix the SITUATION, not the question), or they did
  something they are not able to do.
  Do NOT retry because the answer is inconvenient, quieter than you hoped, or takes the scene
  somewhere you had not planned. That is the scene telling you something true. Accept it and write it.

CRITICAL: If your output is not a JSON object starting with { it will be discarded.`;

/** The writer's system prompt. The cast is given as names and CAPABILITIES only — never the
 *  personas. That is deliberate: a writer holding everyone's interiority writes them from the
 *  inside and stops asking, and the consult becomes decoration. What it does need is what each
 *  person can and cannot do, so it never writes a blind man watching someone. */
export function wrapWriter(sc: StoryConfig): string {
  const general = Object.keys(SKILL_CATALOG);
  const cast = sc.characters.map(c => {
    const can = c.skills.map(s => s.name).join(", ");
    const cannot = general.filter(g => !c.skills.some(s => canonSkill(s.name) === canonSkill(g)));
    return `  ${c.name} -- can: ${can}` + (cannot.length ? `\n${" ".repeat(4 + c.name.length)}CANNOT: ${cannot.join(", ")}` : "");
  }).join("\n");
  const scene = [
    sc.scene.place ? `Where: ${sc.scene.place}` : "",
    sc.scene.question ? `The question this scene has to answer: ${sc.scene.question}` : "",
    sc.scene.pov ? `Point of view: ${sc.scene.pov} -- we see the scene from inside their perception. `
      + `That is a lens, not a licence: their choices and their words still have to be asked for.` : "",
    `Length: about ${sc.scene.length} words.`,
  ].filter(Boolean).join("\n");
  const style = sc.writerStyle.trim() ? `\n\nHOUSE STYLE:\n${sc.writerStyle.trim()}` : "";
  return `${WRITER_FORMAT}\n\nTHE PREMISE:\n${sc.premise}\n\nTHE SCENE:\n${scene}\n\n`
    + `THE CAST:\n${cast}\n\n`
    + `You have not been given their personalities, their histories, or what they want. That is `
    + `deliberate. You find out who they are the same way anyone does: by asking them and watching `
    + `what they do.${style}`;
}

// -- SCENE LOOP ------------------------------------------------------------
export type RunEvent =
  | ConsultEvent
  | { t: "scene_start"; story: string; characters: string[]; target: number }
  | { t: "draft"; step: number; prose: string; words: number; consulting: string; salvaged: boolean }
  | { t: "judge"; character: string; verdict: string; note: string; attempt: number }
  | { t: "accept"; character: string; attempt: number; speech: string; action: string }
  | { t: "retry"; character: string; attempt: number; situation: string; question: string }
  | { t: "budget"; added: number; budget: number }
  | { t: "scene_end"; steps: number; words: number; done: boolean; stopped: boolean };

// -- LIVE EVENT BUS --------------------------------------------------------
// Every RunEvent is stamped with `seq` and fanned out to three places: the JSONL file, an in-memory
// history (so a viewer that connects late gets the whole run replayed before going live), and any
// attached SSE clients. V2 hangs the HTTP server off this; with nothing attached it is inert.
//
// Frames that are UI state rather than record — `composing`, and V4's out-of-budget prompt — go to
// SSE only and are NEVER written to the log. A run's log has to stay the record of what happened,
// not of what a browser was showing at the time.
export type LiveFrame =
  | ({ seq: number } & RunEvent)
  | { t: "composing"; who: string; secs: number; chars: number }
  | { t: "idle" }
  | { t: "continue_prompt"; steps: number; budget: number; suggested: number }
  | { t: "run_state"; running: boolean; stopping: boolean; where: string; picking: boolean }
  | { t: "run_reset" }
  | { t: "scaffold"; state: unknown };

const sseClients = new Set<{ write: (s: string) => void }>();
export const liveHistory: Array<{ seq: number } & RunEvent> = [];
let liveSeq = 0;

function sseWrite(frame: LiveFrame) {
  if (!sseClients.size) return;
  const line = `data: ${JSON.stringify(frame)}\n\n`;
  for (const c of sseClients) { try { c.write(line); } catch { /* a dropped client is not our problem */ } }
}

/** Record an event: history + SSE. The JSONL file is the caller's, so a run keeps writing its log
 *  whether or not anyone is watching. */
export function publish(ev: RunEvent): { seq: number } & RunEvent {
  const stamped = { seq: ++liveSeq, ...ev };
  liveHistory.push(stamped);
  sseWrite(stamped);
  return stamped;
}

// -- LIVE SERVER -----------------------------------------------------------
// Node built-ins only, no framework, no build step — same shape as the engine this forked from.
// What the viewer needs and nothing else: the page, the event stream, who is in this run, and the
// saved log so a finished run can be re-read at the same URL.
interface RunMeta {
  story: string;
  characters: Array<{ name: string; skills: string[]; lacks: string[] }>;
  target: number;
  question: string;
}
let RUN_META: RunMeta | null = null;
// V4 hangs the out-of-budget prompt here. A viewer that connects *while* one is pending learns of
// it from GET /run rather than from the ephemeral frame it missed.
let awaitingContinue: { steps: number; budget: number } | null = null;
let continueResolve: ((n: number) => void) | null = null;

// Whether a scene is being written right now, and what the process is doing when one is not. Both
// are UI state, not record: they say what the *session* is doing, which is a different question from
// what happened in the story. A viewer that loads mid-session reads them from GET /run.
let RUNNING = false;
let WHERE = "idle";                     // human-readable: what the session is doing between runs

// Set while the session is parked waiting for the browser to choose the next story (§W2). Exposed
// the same way the budget prompt is, and for the same reason: a viewer that connects — or reloads —
// while one is outstanding has to learn about it, or a reload strands the session.
let awaitingPick = false;
let pickResolve: ((dir: string) => void) | null = null;

function runState(): LiveFrame {
  return {
    t: "run_state", running: RUNNING, stopping: RUN.stopped && RUNNING,
    where: WHERE, picking: awaitingPick,
  };
}
/** Announce what the session is doing. Never logged — a run's log is the record of the story, not of
 *  which screen a browser was on. */
export function setWhere(where: string, running = RUNNING) {
  WHERE = where; RUNNING = running;
  sseWrite(runState());
}

// -- THE INTERVIEW, SERVER SIDE --------------------------------------------
// The browser's half of SPEC-S §4. It holds one `ScaffoldSession` and nothing else: every decision
// is the session's, and these are the wires. Note what it does NOT do — the session stays parked in
// `awaitPick()` for the whole interview, so accepting simply resolves that pick with the directory
// it just wrote. The main loop never learns an interview happened; it asked for a story and got one.
let SCAFFOLD: ScaffoldSession | null = null;
let scaffoldBusy = false;                  // one architect at a time
let scaffoldLast: ScaffoldRound | null = null;
let scaffoldFolderAsk = "";                // why accept() would not derive a folder name

function scaffoldState() {
  if (!SCAFFOLD) return { active: false };
  return {
    active: true,
    idea: SCAFFOLD.idea,
    busy: scaffoldBusy,
    haveStory: SCAFFOLD.haveStory(),
    pendingAsk: SCAFFOLD.pendingAsk,
    problems: SCAFFOLD.problems,
    last: scaffoldLast,
    needsFolder: scaffoldFolderAsk,
    spec: SCAFFOLD.haveStory() ? specView(SCAFFOLD.spec) : null,
  };
}
/** Push the interview state to every attached client. A round is a minute of model call; a reload or
 *  a second tab in the middle of one has to be able to catch up, and the POST response only reaches
 *  whoever sent it. Never logged — an interview is not part of any run's record. */
function publishScaffold() { sseWrite({ t: "scaffold", state: scaffoldState() }); }

/** Clear the live history and arm a fresh stop signal. Called at the top of every run, so a second
 *  story in the same process starts from an empty page instead of appending to the last one's — and
 *  an already-attached viewer is told to drop what it is holding, since replay only helps the
 *  clients that connect afterwards. */
function resetLive() {
  liveHistory.length = 0;
  liveSeq = 0;
  awaitingContinue = null; continueResolve = null;
  armRun();
  sseWrite({ t: "run_reset" });
}

let serverStarted = false;
let SERVED_PORT = PORT;         // the port actually bound, which is what any message should name
export function startServer(port = PORT) {
  if (serverStarted) return; serverStarted = true;
  SERVED_PORT = port;
  const viewerPath = new URL("./gui/viewer.html", import.meta.url);
  const json = (res: any, code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    const path = (req.url || "/").split("?")[0];
    if (path === "/" || path === "/index.html") {
      try {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
        res.end(await readFile(viewerPath, "utf8"));
      } catch { res.writeHead(500); res.end("gui/viewer.html not found"); }

    } else if (path === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
        Connection: "keep-alive", "X-Accel-Buffering": "no",
      });
      res.write("retry: 3000\n\n");
      // Replay everything so far, THEN attach: a viewer opened halfway through a run sees the whole
      // scene, not just the rest of it.
      for (const ev of liveHistory) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      // ...then what the session is doing *now*, which the replayed events cannot say.
      res.write(`data: ${JSON.stringify(runState())}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));

    } else if (path === "/run") {
      json(res, 200, {
        run: RUN_META, awaitingContinue, events: liveHistory.length,
        running: RUNNING, stopping: RUN.stopped && RUNNING, where: WHERE, picking: awaitingPick,
      });

    } else if (path === "/stories") {
      // Pre-flighted, so a story that cannot load says so on its card instead of failing after it
      // is picked. Answered whether or not the session is waiting on a choice — reading the shelf
      // is not the same act as taking something off it.
      json(res, 200, { stories: await storyCards(), picking: awaitingPick });

    } else if (path === "/select" && req.method === "POST") {
      let body = ""; req.on("data", c => (body += c));
      req.on("end", async () => {
        if (!awaitingPick || !pickResolve) { json(res, 400, { ok: false, reason: "the session is not waiting on a choice" }); return; }
        let o: any = {}; try { o = JSON.parse(body || "{}"); } catch {}
        // A path from a client is a request to read one, never a path. Only a directory the engine
        // itself discovered can be selected.
        const dir = await selectableStory(String(o.dir ?? ""));
        if (!dir) { json(res, 400, { ok: false, reason: `no such story: ${String(o.dir ?? "")}` }); return; }
        const r = pickResolve; pickResolve = null; awaitingPick = false;
        json(res, 200, { ok: true, dir });
        r(dir);
      });

    } else if (path === "/stop" && req.method === "POST") {
      // Stopping a run that is waiting on the budget question has to answer that question too, or
      // the loop stays parked on a promise nobody will ever resolve.
      if (!RUNNING) { json(res, 400, { ok: false, reason: "no run in progress" }); return; }
      const first = stopRun();
      if (awaitingContinue && continueResolve) {
        const r = continueResolve; continueResolve = null; awaitingContinue = null; r(0);
      }
      if (first) console.log(`\n${C.yellow}Stop requested from the viewer — ending the scene.${C.reset}`);
      sseWrite(runState());
      json(res, 200, { ok: true, already: !first });

    } else if (path === "/continue" && req.method === "POST") {
      let body = ""; req.on("data", c => (body += c));
      req.on("end", () => {
        let steps = 0; try { steps = Number(JSON.parse(body || "{}").steps) || 0; } catch {}
        if (awaitingContinue && continueResolve) {
          const r = continueResolve; continueResolve = null; awaitingContinue = null;
          json(res, 200, { ok: true });
          r(Math.max(0, Math.floor(steps)));
        } else json(res, 400, { ok: false, reason: "no run is waiting on a budget decision" });
      });

    } else if (path === "/scaffold" && req.method !== "POST") {
      json(res, 200, scaffoldState());

    } else if (path.startsWith("/scaffold/") && req.method === "POST") {
      let body = ""; req.on("data", c => (body += c));
      req.on("end", async () => {
        let o: any = {}; try { o = JSON.parse(body || "{}"); } catch {}
        const what = path.slice("/scaffold/".length);
        // An unknown action is unknown whatever the session happens to be doing. Checked first, or a
        // typo'd route name comes back as a state problem and sends you debugging the wrong thing.
        if (!["start", "say", "accept", "abandon"].includes(what)) {
          json(res, 404, { ok: false, reason: `no such scaffold action: ${what}` }); return;
        }

        // Abandoning is allowed mid-round: the in-flight call finishes into a session nobody holds.
        if (what === "abandon") {
          SCAFFOLD = null; scaffoldLast = null; scaffoldFolderAsk = ""; scaffoldBusy = false;
          publishScaffold();
          json(res, 200, { ok: true });
          return;
        }
        // Two overlapping rounds would interleave on one agent's history, which is the one piece of
        // state the whole "it kept the parts I liked" property rests on.
        if (scaffoldBusy) { json(res, 409, { ok: false, reason: "a round is already in flight" }); return; }

        if (what === "start") {
          // An interview only makes sense while the session is waiting for a story to run.
          if (!awaitingPick) { json(res, 400, { ok: false, reason: "the session is not waiting for a story" }); return; }
          const idea = String(o.idea ?? "").trim();
          if (!idea) { json(res, 400, { ok: false, reason: "nothing to work with" }); return; }
          scaffoldBusy = true; scaffoldLast = null; scaffoldFolderAsk = "";
          try {
            SCAFFOLD = await newScaffoldSession(idea);
            setWhere("building a new story", false);
            publishScaffold();
            scaffoldLast = await SCAFFOLD.propose();
          } catch (e) {
            scaffoldLast = { kind: "failed", error: (e as Error).message };
          } finally { scaffoldBusy = false; }
          publishScaffold();
          json(res, 200, scaffoldState());
          return;
        }

        if (!SCAFFOLD) { json(res, 400, { ok: false, reason: "no interview is open" }); return; }

        if (what === "say") {
          const text = String(o.text ?? "").trim();
          if (!text) { json(res, 400, { ok: false, reason: "say something" }); return; }
          scaffoldBusy = true; scaffoldFolderAsk = ""; publishScaffold();
          try { scaffoldLast = await SCAFFOLD.say(text); }
          catch (e) { scaffoldLast = { kind: "failed", error: (e as Error).message }; }
          finally { scaffoldBusy = false; }
          publishScaffold();
          json(res, 200, scaffoldState());
          return;
        }

        if (what === "accept") {
          if (!awaitingPick || !pickResolve) { json(res, 400, { ok: false, reason: "the session is not waiting for a story" }); return; }
          scaffoldBusy = true; publishScaffold();
          let r: ScaffoldAccept;
          try { r = await SCAFFOLD.accept(String(o.folder ?? "").trim()); }
          catch (e) {
            scaffoldBusy = false; publishScaffold();
            json(res, 500, { ok: false, reason: (e as Error).message }); return;
          }
          scaffoldBusy = false;
          // Everything short of `written` leaves the interview open — a folder still to name, or a
          // story on disk that does not load and can be refined and accepted again.
          if (r.kind !== "written") {
            scaffoldFolderAsk = r.kind === "needs_folder" ? r.reason : "";
            publishScaffold();
            json(res, r.kind === "no_story" ? 400 : 200, { ok: false, ...r });
            return;
          }
          SCAFFOLD = null; scaffoldLast = null; scaffoldFolderAsk = "";
          publishScaffold();
          const resolve = pickResolve; pickResolve = null; awaitingPick = false;
          json(res, 200, { ok: true, ...r });
          resolve(r.dir);                 // the parked session gets the story it was waiting for
          return;
        }
      });

    } else if (path === "/log.jsonl") {
      // The current run's saved log. 404 until a run commits one — the server can be up first.
      try {
        if (!OUT_DIR) throw new Error("no run yet");
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.end(await readFile(joinPath(OUT_DIR, "writing-log.jsonl"), "utf8"));
      } catch { res.writeHead(404); res.end(""); }

    } else { res.writeHead(404); res.end("not found"); }
  });

  server.on("error", (e: NodeJS.ErrnoException) => {
    console.error(`\n${C.red}Could not start the viewer on port ${port}: ${e.message}${C.reset}`);
    console.error(`${C.dim}Another run may already be serving. Try --port=${port + 1}.${C.reset}`);
  });
  server.listen(port, () => {
    console.log(`\n${C.bold}▶ live viewer: http://localhost:${port}/${C.reset}\n`);
  });
  // Keep-alive, and what holds the process open after the scene ends so the finished run stays
  // readable in the browser instead of the server dying under it.
  setInterval(() => { for (const c of sseClients) { try { c.write(": ping\n\n"); } catch {} } }, 15000);
}

/**
 * The step budget is soft: spending it asks for more rather than ending the scene. Asked in the
 * VIEWER when one is attached, else at the console, else nobody is there and the run stops — which
 * is the honest thing to do rather than blocking forever.
 *
 * The prompt is deliberately not a RunEvent: it is UI state, not something that happened in the
 * story, so it never reaches the log. A viewer that connects while one is pending learns of it from
 * `GET /run` instead, so a reload cannot strand a blocked run.
 */
async function askMoreSteps(steps: number, budget: number): Promise<number> {
  if (RUN.stopped) return 0;              // already abandoned; do not ask for more of it
  if (sseClients.size) {
    awaitingContinue = { steps, budget };
    progressDone();
    console.log(`\n${C.yellow}Budget spent — waiting on the viewer.${C.reset}`);
    sseWrite({ t: "continue_prompt", steps, budget, suggested: 8 });
    return new Promise<number>(resolve => { continueResolve = resolve; });
  }
  if (!process.stdin.isTTY) {
    console.log(`\n${C.yellow}Step budget (${budget}) spent and the scene is not finished. `
      + `Stopping — nobody to ask.${C.reset}`);
    return 0;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question(`\n${C.yellow}${steps} steps used and the scene is not done. `
    + `How many more? [8, 0 to stop]: ${C.reset}`)).trim();
  rl.close();
  const n = ans === "" ? 8 : Number(ans);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export async function writeScene(sc: StoryConfig, log: (e: RunEvent) => void) {
  const writer = new Agent("WRITER", sc.models.writer, wrapWriter(sc), 0.8);
  writer.think = sc.thinking.writer;
  const agents = buildCharacterAgents(sc);
  const defOf = (name: string) => sc.characters.find(c => c.name.toLowerCase() === name.trim().toLowerCase());

  const pieces: string[] = [];
  const wordCount = () => pieces.join(" ").split(/\s+/).filter(Boolean).length;
  let steps = 0, budget = sc.maxSteps, done = false, empties = 0;

  log({ t: "scene_start", story: sc.dir, characters: sc.characters.map(c => c.name), target: sc.scene.length });

  while (!done) {
    // The cheap half of stopping: every boundary in the loop is a place it can end without losing
    // anything. The expensive half — cutting the call in flight — is in the transport.
    if (RUN.stopped) break;
    if (steps >= budget) {
      const extra = await askMoreSteps(steps, budget);
      if (!extra) break;
      budget += extra;
      log({ t: "budget", added: extra, budget });
    }

    // -- WRITE
    // The instruction goes into HISTORY rather than being passed as an ephemeral extra, so the
    // writer's transcript alternates user/assistant from the start. A history that opened with the
    // writer's own prose left the chat template with no user turn after the system prompt, and the
    // model answered the next call with nothing at all — three empty completions and a dead run.
    const words = wordCount();
    // The reminder rides on every [WRITE] because this is the message closest to the act of writing,
    // and the failure it guards against — writing a character's choice and then asking about it —
    // is the one that wastes a whole consult.
    writer.hear(`[WRITE] ${words} words so far, aiming at about ${sc.scene.length}.`
      + ` Write up to the next choice, then stop and ask for it.`
      + (words >= sc.scene.length ? ` You are at length — bring the scene to its end.` : ""));
    let draftRaw: string;
    try {
      draftRaw = await writer.generate(`${C.magenta}WRITER${C.reset}`);
    } catch (e) {
      // A stop is not a failure and must not be reported as one; everything written so far is
      // already on disk either way.
      if (e instanceof StoppedError || RUN.stopped) break;
      // The transport already retried. Losing everything written so far to one bad call is the
      // expensive failure; stop cleanly instead and keep the prose.
      console.log(`\n${C.red}Writer call failed (${(e as Error).message}) — stopping with what we have.${C.reset}`);
      break;
    }
    steps++;
    const d = extractJson(draftRaw);
    let prose = String(d.prose ?? "").trim();
    let salvaged = false;
    if (!prose) {
      const recovered = salvageProse(draftRaw);
      if (recovered) {
        prose = recovered; salvaged = true;
        console.log(`${C.yellow}(recovered a truncated draft — ${recovered.split(/\s+/).length} words)${C.reset}`);
      }
    }
    const sceneDone = d.scene_done === true || String(d.scene_done ?? "").toLowerCase() === "true";
    const c = (d.consult && typeof d.consult === "object") ? d.consult as Record<string, unknown> : null;
    const who = c ? String(c.character ?? "").trim() : "";

    if (prose) pieces.push(prose);
    // What it said, normalized: the model routinely emits the same object twice, and the raw reply
    // carries the whole consult block. This keeps the history JSON-shaped without the noise.
    writer.said(JSON.stringify({ prose, ...(who ? { consult: { character: who } } : {}), scene_done: sceneDone }));
    log({ t: "draft", step: steps, prose, words: wordCount(), consulting: who, salvaged });
    if (prose) console.log(`\n${prose}\n`);

    if (!prose && !who) {
      // A draft that neither wrote nor asked. Once is a hiccup; three in a row is a stuck writer,
      // and burning the whole budget on empty calls helps nobody.
      if (++empties >= 3) { console.log(`${C.red}Writer returned nothing three times — stopping.${C.reset}`); break; }
    } else empties = 0;

    // -- CONSULT (with accept / retry)
    if (who) {
      const def = defOf(who);
      const persistent = agents.get(who.toLowerCase());
      if (!def || !persistent) {
        writer.hear(`[NO SUCH CHARACTER] There is no "${who}" in this scene. The cast is: `
          + `${sc.characters.map(x => x.name).join(", ")}.`);
      } else {
        let req: ConsultRequest = {
          character: def.name,
          situation: String(c!.situation ?? "").trim(),
          question: String(c!.question ?? "").trim(),
          wants: String(c!.wants ?? "").trim(),
        };
        let reply: ConsultReply | null = null;
        let usedAttempt = 1;
        let failed = "";

        for (let attempt = 1; ; attempt++) {
          usedAttempt = attempt;
          // Attempt 1 uses the character's own agent, which remembers the scene. A RETRY uses a
          // fork: same persona, empty history, only the revised question — it never learns it was
          // rejected, so the second answer is a second reading of the question rather than an
          // attempt to please.
          const agent = attempt === 1 ? persistent : persistent.fork();
          try {
            reply = await consult(agent, req, def.skills, {
              clarifications: sc.clarifications, attempt, log,
              clarify: async (q, r) => {
                let a = "";
                try {
                  const raw = await writer.generate(`${C.magenta}WRITER${C.reset}`, [{
                    role: "user",
                    content: `[${r.character} ASKS] ${q}\n\n[THE SITUATION YOU GAVE THEM] ${r.situation}`,
                  }]);
                  a = String(extractJson(raw).answer ?? "").trim();
                } catch (e) {
                  console.log(`${C.red}(clarification call failed: ${(e as Error).message})${C.reset}`);
                  return "";     // consult turns this into "(no answer)" and the character answers anyway
                }
                // The writer decided a fact about the world; it has to remember deciding it.
                writer.hear(`[${r.character} ASKS] ${q}`);
                writer.said(JSON.stringify({ answer: a }));
                return a;
              },
            });
          } catch (e) {
            failed = (e as Error).message;
            break;
          }

          const flags = [
            reply.unverified.length ? `They used ${reply.unverified.map(s => `"${s}"`).join(", ")}, which they cannot do.` : "",
            reply.forced ? `They asked for detail you did not give and answered anyway.` : "",
          ].filter(Boolean).join(" ");
          // A judge that cannot be reached defaults to ACCEPT. The character did answer; discarding
          // a real answer because the meta-call failed would be the wrong way to fail.
          let j: Record<string, any> = {};
          try {
            const judgeRaw = await writer.generate(`${C.magenta}WRITER${C.reset}`, [{
              role: "user",
              content: `[${def.name} ANSWERED]\nYou asked: ${req.question}\n`
                + `thought: ${reply.thought}\nspeech: ${reply.speech}\naction: ${reply.action}`
                + (reply.note ? `\nnote: ${reply.note}` : "")
                + (flags ? `\n\n[FLAGGED] ${flags}` : ""),
            }]);
            j = extractJson(judgeRaw);
          } catch (e) {
            console.log(`${C.red}(judge call failed: ${(e as Error).message} — accepting)${C.reset}`);
          }
          const verdict = String(j.verdict ?? "accept").trim().toLowerCase() === "retry" ? "retry" : "accept";
          const note = String(j.note ?? "").trim();
          log({ t: "judge", character: def.name, verdict, note, attempt });

          if (verdict === "accept" || attempt > sc.retries) {
            if (verdict === "retry") console.log(`${C.dim}(retries spent — taking ${def.name}'s last answer)${C.reset}`);
            break;
          }
          const rev = (j.revised && typeof j.revised === "object") ? j.revised as Record<string, unknown> : {};
          req = {
            character: def.name,
            situation: String(rev.situation ?? "").trim() || req.situation,
            question: String(rev.question ?? "").trim() || req.question,
            wants: String(rev.wants ?? "").trim() || req.wants,
          };
          console.log(`${C.yellow}retry ${attempt}/${sc.retries} — ${def.name}${C.reset}${note ? ` ${C.dim}(${note})${C.reset}` : ""}`);
          log({ t: "retry", character: def.name, attempt, situation: req.situation, question: req.question });
        }

        // A stop landed in the middle of the consult. There is no answer to judge and none to
        // remember: leave the character's history untouched and end the scene here.
        if (RUN.stopped) break;

        // A stalled consult (kept asking, never answered) reaches here with every channel empty. It
        // is a non-answer like an unreachable model, and must not be written into the character's
        // memory as something they said.
        const stalled = !!reply && !reply.thought && !reply.speech && !reply.action;
        if (failed || !reply || stalled) {
          const why = failed || (stalled ? reply!.note || "did not answer" : "no reply");
          console.log(`${C.red}${def.name}: ${why}.${C.reset}`);
          writer.hear(`[NO ANSWER] ${def.name} did not answer (${why}). Write on without settling `
            + `what they do, or ask again later with more in the situation.`);
        } else {
          // Accepted. Only now does it become the character's memory — a rejected attempt leaves no
          // trace on the persistent agent, and the accepted one is remembered whichever instance
          // produced it.
          const answered = [reply.thought && `thought: ${reply.thought}`,
                            reply.speech && `speech: ${reply.speech}`,
                            reply.action && `action: ${reply.action}`].filter(Boolean).join("\n");
          persistent.hear(askBlock(req)
            + reply.clarifications.map(x => `\n[YOU ASKED] ${x.question}\n[THEY ANSWERED] ${x.answer}`).join(""));
          persistent.said(JSON.stringify({ thought: reply.thought, speech: reply.speech, action: reply.action }));
          writer.hear(`[${def.name} ANSWERED]\n${answered}`);
          log({ t: "accept", character: def.name, attempt: usedAttempt, speech: reply.speech, action: reply.action });
          console.log(`${C.cyan}${def.name}${C.reset} ${C.dim}→${C.reset} `
            + (reply.speech ? `"${reply.speech}" ` : "") + (reply.action ? `${C.dim}${reply.action}${C.reset}` : ""));
        }
      }
    }

    if (sceneDone) done = true;
    if (RUN.stopped) break;              // don't spend summary calls on a run that is over
    await trimHistory(writer, sc.models.summary, sc.thinking.summary);
    for (const a of agents.values()) await trimHistory(a, sc.models.summary, sc.thinking.summary);
  }

  log({ t: "scene_end", steps, words: wordCount(), done, stopped: RUN.stopped });
  return { prose: pieces, steps, words: wordCount(), done, stopped: RUN.stopped };
}

// -- ENTRY POINT -----------------------------------------------------------
const flag = (name: string): string | undefined => {
  const hit = CLI.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (hit === undefined) return undefined;
  const eq = hit.indexOf("=");
  return eq < 0 ? "" : hit.slice(eq + 1);
};

/** `--consult=NAME`: ask one character one question and print the answer. Exercises the character
 *  half — the skill menu, the clarification loop, the skill check — without the writer existing.
 *  Clarifications are answered by you, at the console. */
async function runConsultCli(sc: StoryConfig, who: string) {
  const agents = buildCharacterAgents(sc);
  const def = sc.characters.find(c => c.name.toLowerCase() === who.trim().toLowerCase());
  const agent = agents.get(who.trim().toLowerCase());
  if (!def || !agent) throw new Error(`No character "${who}" in ${sc.dir}. Known: ${sc.characters.map(c => c.name).join(", ")}`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (label: string, preset?: string) => {
    if (preset) return preset;
    return (await rl.question(`${label}: `)).trim();
  };
  const situation = await ask("Situation", flag("situation"));
  const question  = await ask("Question", flag("question"));
  const wants     = flag("wants") ?? "";
  const req: ConsultRequest = { character: def.name, situation, question, wants };

  console.log(`\n${C.bold}${def.name}${C.reset} ${C.dim}(${def.skills.length} skills, ${def.model})${C.reset}`);
  const reply = await consult(agent, req, def.skills, {
    clarifications: sc.clarifications,
    clarify: async (q) => {
      console.log(`\n${C.yellow}${def.name} asks:${C.reset} ${q}`);
      return (await rl.question(`${C.dim}your answer: ${C.reset}`)).trim();
    },
  });
  rl.close();

  console.log(`\n${C.dim}--- ${def.name} ---${C.reset}`);
  if (reply.thought) console.log(`${C.gray}thought:${C.reset} ${reply.thought}`);
  if (reply.speech)  console.log(`${C.cyan}speech: ${C.reset} "${reply.speech}"`);
  if (reply.action)  console.log(`${C.green}action: ${C.reset} ${reply.action}`);
  if (reply.note)    console.log(`${C.dim}note:    ${reply.note}${C.reset}`);
  console.log(`${C.dim}skills:  ${reply.skillsUsed.join(", ") || "(none listed)"}${C.reset}`);
  if (reply.unverified.length) console.log(`${C.red}unverified skills: ${reply.unverified.join(", ")}${C.reset}`);
  if (reply.forced) console.log(`${C.yellow}(answered without the detail it asked for)${C.reset}`);
}

/** Open an interview. Shared by the console and the browser so the architect, the defaults and the
 *  transport settings are established the same way whichever one is asking. */
async function newScaffoldSession(idea: string): Promise<ScaffoldSession> {
  const d = await loadDefaults(flag("model") ?? "");
  STREAM = d.stream; DEBUG = d.debug;
  NET.timeoutMs = d.requestTimeout * 1000;
  NET.retries = d.attempts - 1;
  MAX_TOKENS = d.maxTokens;
  return new ScaffoldSession(await buildArchitect(d), d, idea);
}

/** Read a multi-line answer: lines until a blank one. An idea is rarely one sentence, and making
 *  the author compress it into a single readline is making them do the model's job. */
async function readParagraph(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
  console.log(prompt);
  const lines: string[] = [];
  for (;;) {
    const line = await rl.question(lines.length ? `${C.dim}… ${C.reset}` : `${C.dim}> ${C.reset}`);
    if (!line.trim()) { if (lines.length) break; else continue; }
    lines.push(line.trim());
  }
  return lines.join("\n");
}

/** Print a proposal and whatever the engine has to say about it. */
function showSpec(spec: StorySpec, problems: string[], note = "", full = false) {
  console.log(`\n${"─".repeat(60)}\n${renderSpec(spec, full)}\n${"─".repeat(60)}`);
  if (note) console.log(`${C.dim}note: ${note}${C.reset}`);
  for (const p of problems) console.log(`${C.yellow}⚠${C.reset} ${p}`);
}

/** Print whatever a round did. The session decided it; this only says it out loud. */
function showRound(s: ScaffoldSession, r: ScaffoldRound) {
  switch (r.kind) {
    case "failed":
      console.log(`${C.red}That round failed (${r.error}) — nothing changed.${C.reset}`); return;
    case "question":
      console.log(`\n${C.yellow}It needs to know:${C.reset} ${r.ask}`); return;
    case "nothing":
      console.log(`\n${C.yellow}It didn't come back with a story.${C.reset} `
        + `${C.dim}Try saying more about who is in the scene and what is at stake.${C.reset}`); return;
    case "proposal":
      showSpec(s.spec, s.problems, r.note); return;
    case "edits":
      if (!r.applied.length && !r.ignored.length) console.log(`${C.yellow}It changed nothing.${C.reset}`);
      else console.log(`${C.green}changed:${C.reset} ${r.applied.join(", ") || "(nothing)"}`);
      for (const ig of r.ignored) console.log(`${C.yellow}⚠${C.reset} ignored ${ig}`);
      showSpec(s.spec, s.problems, r.note); return;
  }
}

/** Drive `session.accept()` at the console, asking for a folder name whenever the engine refuses to
 *  derive one. Returns the written directory, or "" to go back to refining. */
async function acceptAtConsole(session: ScaffoldSession,
                               rl: ReturnType<typeof createInterface>): Promise<string> {
  for (let folder = "";;) {
    const r = await session.accept(folder);
    if (r.kind === "no_story") { console.log(`${C.dim}Nothing to accept yet.${C.reset}`); return ""; }
    if (r.kind === "needs_folder") {
      // Never overwrite an authored story, and never invent a name when the title yields none.
      console.log(`${C.yellow}${r.reason}${C.reset}`);
      const said = (await rl.question(`${C.dim}folder name (blank to go back): ${C.reset}`)).trim();
      if (!said) return "";
      folder = said;
      continue;
    }
    console.log(`\n${C.green}Written:${C.reset} ${r.dir}/ ${C.dim}(${r.files.join(", ")})${C.reset}`);
    for (const w of r.warnings) console.log(`   ${C.yellow}⚠${C.reset} ${w}`);
    if (r.kind === "unloadable") {
      console.log(`${C.red}It was written, but it does not load: ${r.error}${C.reset}`);
      console.log(`${C.dim}Fix it by hand in ${r.dir}/, or keep refining and accept again.${C.reset}`);
      return "";
    }
    return r.dir;
  }
}

/** `--new`: take an idea, propose a story, refine it until the author accepts, then write it to
 *  `stories/<slug>/` and run it (SPEC-S §4). With `--idea=` and no terminal it prints one proposal
 *  and stops — there is nobody to refine it with. */
async function runScaffoldCli() {
  // `--idea="..."` supplies the idea without a prompt, which is what makes this path runnable from a
  // script or a test. Without one there is typing to do, and that needs a terminal.
  const preset = flag("idea");
  if (!preset && !process.stdin.isTTY) throw new Error("--new needs a terminal, or an --idea=\"...\" to work from.");
  setWhere("building a new story — at the console", false);

  let idea = preset ?? "";
  if (!idea) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    idea = await readParagraph(rl,
      `\n${C.bold}What's the idea?${C.reset} ${C.dim}(as much or as little as you like; blank line when done)${C.reset}`);
    rl.close();
  }
  if (!idea.trim()) { console.log("Nothing to work with."); return; }

  const session = await newScaffoldSession(idea);

  console.log(`${C.dim}\nthinking about it (${session.defaults.models.architect})…${C.reset}`);
  showRound(session, await session.propose());

  // Non-interactive (`--idea=` with no terminal): one proposal, printed, and out.
  if (!process.stdin.isTTY) return;

  const rl2 = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const prompt = session.pendingAsk
        ? `\n${C.dim}your answer (or "q" to abort): ${C.reset}`
        : session.haveStory()
          ? `\n${C.dim}[enter] accept · "?" personas in full · "q" abort · or say what to change${C.reset}\n${C.dim}> ${C.reset}`
          : `\n${C.dim}say more about it, or "q" to abort${C.reset}\n${C.dim}> ${C.reset}`;
      const said = (await rl2.question(prompt)).trim();

      if (said.toLowerCase() === "q") { console.log("Abandoned. Nothing written."); return; }
      if (!said && !session.haveStory()) continue;   // nothing to accept, and silence answers nothing
      if (!said && session.pendingAsk) continue;     // it asked; silence is not an answer
      if (!said) {
        if (session.problems.length) {
          // Accepting over a complaint is allowed — they are judgements about the design, not
          // errors — but it should be a deliberate second keypress, not the same one.
          const sure = (await rl2.question(`${C.yellow}${session.problems.length} thing(s) flagged above. `
            + `Accept anyway? [y/N] ${C.reset}`)).trim().toLowerCase();
          if (sure !== "y") continue;
        }
        const dir = await acceptAtConsole(session, rl2);
        if (!dir) continue;                       // could not settle on a folder; back to refining
        rl2.close();
        const sc = await loadStory(dir);
        STREAM = sc.stream; DEBUG = sc.debug;
        NET.timeoutMs = sc.requestTimeout * 1000;
        NET.retries = sc.attempts - 1;
        MAX_TOKENS = sc.maxTokens;
        return runAndSave(sc, dir);
      }
      if (said === "?") {
        // Don't spend a model call showing nothing.
        if (session.haveStory()) showSpec(session.spec, [], "", true);
        else console.log(`${C.dim}Nothing to show yet.${C.reset}`);
        continue;
      }

      showRound(session, await session.say(said));
    }
  } finally { rl2.close(); }
}

/** Load one story, apply the debug flags, and either write its scene or answer one consult. */
async function runOne(dir: string) {
  const sc = await loadStory(dir);
  STREAM = sc.stream; DEBUG = sc.debug;
  NET.timeoutMs = sc.requestTimeout * 1000;
  NET.retries = sc.attempts - 1;
  MAX_TOKENS = sc.maxTokens;

  // Debug override: cut a run short without editing the story. A non-interactive run then simply
  // stops when the budget is spent, which makes `--steps=3` a cheap smoke test of the whole loop.
  const stepsFlag = flag("steps");
  if (stepsFlag) {
    const n = Number(stepsFlag);
    if (Number.isInteger(n) && n > 0) sc.maxSteps = n;
    else console.warn(`   (--steps=${stepsFlag} is not a whole number — using ${sc.maxSteps})`);
  }

  const who = flag("consult");
  if (who !== undefined) {
    if (!who) throw new Error(`--consult needs a character name, e.g. --consult=${sc.characters[0].name}`);
    return runConsultCli(sc, who);
  }

  return runAndSave(sc, dir);
}

// True when the BROWSER owns the session: `--serve`, and nothing on the command line has already
// decided what to run. The console then prints status and never blocks on stdin — one driver, not
// two racing for the same answer. A non-TTY run is never browser-driven: "no terminal means run once
// and exit" is a guarantee scripts already depend on, and a headless session that parks forever
// waiting for a browser nobody opened would break it.
let BROWSER_DRIVES = false;

/**
 * Park the session until a client chooses — the browser's half of the picker, resolved by
 * `POST /select`. Deliberately has no console fallback and no timeout: in a browser-driven session
 * there is nothing else to fall back TO, and quietly picking a story for you would be worse than
 * waiting. Ctrl-C is the way out.
 */
export function awaitPick(): Promise<string> {
  awaitingPick = true;
  setWhere("choosing a story", false);
  console.log(`\n${C.dim}Waiting for a story to be chosen at ${C.reset}http://localhost:${SERVED_PORT}/`
    + `${C.dim} — Ctrl-C to quit.${C.reset}`);
  return new Promise<string>(r => { pickResolve = r; }).then(picked => {
    setWhere("loading", false);
    return picked;
  });
}

/** Wait for the next story: the browser when it is driving, the console picker otherwise. */
async function pickStory(): Promise<string> {
  if (BROWSER_DRIVES) return awaitPick();
  setWhere("choosing a story", false);
  return chooseStory("");
}

/**
 * A SESSION, not a run. Stopping a scene — or finishing one — returns to the picker rather than
 * killing the process, so abandoning a story costs you the scene and nothing else: the viewer stays
 * up, the models stay loaded, and the next story starts from where you left off.
 *
 * One-shot is preserved exactly where it was already load-bearing: a story named on the command
 * line, `--consult`, and any run with no terminal behave as they always did. A scripted `--steps=3`
 * must still exit on its own.
 */
async function main() {
  if (SERVE) startServer();      // before the picker, so the viewer is up while you are still choosing
  const oneShot = !!STORY_DIR || !process.stdin.isTTY || flag("consult") !== undefined;
  BROWSER_DRIVES = SERVE && !oneShot;

  // `--new` says where this session starts, not who drives it: the interview is still at the console
  // (W4 moves it), and every choice after it belongs to whoever is driving.
  let next: string = CLI.includes("--new") ? NEW_STORY
                   : STORY_DIR ? STORY_DIR
                   : await pickStory();
  for (;;) {
    if (next === NEW_STORY) await runScaffoldCli();
    else await runOne(next);
    if (oneShot) return;
    next = await pickStory();
  }
}

/** Run a loaded story and write its artifacts. Shared by the ordinary path and the scaffolder, so a
 *  story that was just built runs exactly like one that was authored by hand. */
async function runAndSave(sc: StoryConfig, dir: string) {
  console.log(`${C.bold}${dir}${C.reset} ${C.dim}— ${sc.characters.map(c => c.name).join(", ")} `
    + `· ~${sc.scene.length} words · up to ${sc.maxSteps} steps${C.reset}`);

  RUN_META = {
    story: dir, target: sc.scene.length, question: sc.scene.question,
    characters: sc.characters.map(c => ({
      name: c.name,
      skills: c.skills.filter(s => s.source === "story").map(s => s.name),
      lacks: Object.keys(SKILL_CATALOG).filter(g => !c.skills.some(s => canonSkill(s.name) === canonSkill(g))),
    })),
  };
  // A second story in the same session starts from an empty page and a fresh stop signal — without
  // this it would append to the last run's history and refuse to start under a spent abort. After
  // RUN_META, so a viewer re-reading /run on the reset frame gets the story it is about to watch.
  resetLive();
  if (SERVE) startServer();
  setWhere(`writing ${dir}`, true);

  // Outputs land in `<story dir>/out/`, so each story keeps its own and a run is only overwritten by
  // the next run of the SAME story. Both files are written as the run goes: an interrupted run still
  // leaves readable prose and a complete log of how far it got.
  OUT_DIR = joinPath(sc.dir, "out");
  await mkdir(OUT_DIR, { recursive: true });
  const scenePath = joinPath(OUT_DIR, "scene.md");
  const logPath = joinPath(OUT_DIR, "writing-log.jsonl");
  const logStream = createWriteStream(logPath, { flags: "w" });

  const events: RunEvent[] = [];
  const pieces: string[] = [];
  let sceneWrites: Promise<unknown> = Promise.resolve();
  const r = await writeScene(sc, e => {
    events.push(e);
    // One `seq` for the file, the replay history and the live stream, so a viewer that loads a saved
    // log and one watching it happen are numbering the same events.
    logStream.write(JSON.stringify(publish(e)) + "\n");
    if (e.t === "draft" && e.prose) {
      pieces.push(e.prose);
      // Serialized: two overlapping writeFile calls on one path can interleave.
      sceneWrites = sceneWrites.then(() => writeFile(scenePath, pieces.join("\n\n") + "\n", "utf8")).catch(() => {});
    }
  });
  await sceneWrites;
  await new Promise<void>(res => logStream.end(res));
  setWhere(r.stopped ? `stopped ${dir}` : `finished ${dir}`, false);

  console.log(`\n${C.bold}${"=".repeat(60)}${C.reset}`);
  console.log(r.prose.join("\n\n"));
  console.log(`${C.bold}${"=".repeat(60)}${C.reset}`);
  const consults = events.filter(e => e.t === "consult").length;
  const retries  = events.filter(e => e.t === "retry").length;
  const needs    = events.filter(e => e.t === "need").length;
  const flags    = events.filter(e => e.t === "skill_flag").length;
  console.log(`${C.dim}${r.words} words · ${r.steps} steps · ${consults} consult(s) · `
    + `${needs} clarification(s) · ${retries} retry/retries · ${flags} skill flag(s) · `
    + `${r.stopped ? "stopped by request" : r.done ? "scene finished" : "stopped early"}${C.reset}`);
  console.log(`${C.dim}${scenePath}\n${logPath}${C.reset}`);
}

// Importing this module must NEVER start a run or a pre-flight — the tests import it for its pure
// units (the story parser, skill resolution, config validation, extractJson).
const IS_MAIN = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (IS_MAIN) {
  if (PREFLIGHT) {
    runPreflightCli().catch(e => { console.error("\n[preflight error]", e.message); process.exitCode = 1; });
  } else {
    main().catch(e => {
      console.error("\n[story-writer error]", e.message);
      console.error("Check that LM Studio's server is running and the model identifiers are correct.");
      process.exitCode = 1;
    });
  }
}
