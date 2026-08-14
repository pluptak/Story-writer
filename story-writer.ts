/**
 * STORY WRITER — a writer agent that drafts prose and consults character agents about the choices
 * their characters make. A character answers from its own persona and only what the writer told it;
 * a rejected answer is re-asked of a FRESH instance that never learns it was rejected.
 */

import { readFile, writeFile, readdir, mkdir, rm, stat } from "node:fs/promises";
import { createWriteStream, type WriteStream } from "node:fs";
import { createInterface } from "node:readline/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { isAbsolute, join as joinPath, resolve as resolvePath, relative as relativePath } from "node:path";
import * as P from "./prompts.ts";
import { C } from "./ansi.ts";
import {
  LIVE, RUN, StoppedError, stopRun, armRun, resetLive, runState, setWhere,
  publish, sseWrite, sseClients, liveHistory, type LiveFrame,
} from "./live.ts";
import { startServer, type ServerHost } from "./server.ts";

export { RUN, StoppedError, stopRun, armRun, publish, setWhere, liveHistory };
export type { LiveFrame };

// -- CONFIG ----------------------------------------------------------------
const LMSTUDIO_URL = "http://localhost:1234/v1/chat/completions";
const LMSTUDIO_MODELS_URL = LMSTUDIO_URL.replace(/\/chat\/completions\/?$/, "/models");
let MAX_TOKENS = 2000;
const WINDOW = { cap: 24, keepRecent: 14 };

const CLI = process.argv.slice(2);
const PREFLIGHT = CLI.includes("--preflight");
const SERVE = CLI.includes("--serve");
const PORT = Number(CLI.find(a => a.startsWith("--port="))?.slice(7)) || 8080;
let STORY_DIR = CLI.find(a => !a.startsWith("--")) ?? "";

let OUT_DIR = "";
let LLM_STREAMS: Map<string, WriteStream> = new Map();   // agent name -> this run's open stream
let LLM_FILENAMES: Set<string> = new Set();               // filenames already claimed this run

// Set by the story loader before the loop runs
let STREAM = true;
let DEBUG  = false;

const CHARACTER_PALETTE = [C.cyan, C.yellow, C.green, C.magenta];

// TTY only: carriage returns in a redirected log file are worse than silence.
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

export const THINK_LEVELS = ["off", "low", "medium", "high", "default"] as const;
export type ThinkLevel = (typeof THINK_LEVELS)[number];

function requestBody(model: string, messages: Msg[], temperature: number, stream: boolean, think: ThinkLevel) {
  const body: Record<string, unknown> = { model, messages, temperature, max_tokens: MAX_TOKENS, stream };
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
    if (DEBUG) process.stderr.write(`\n[DEBUG complete] model=${model} len=${text.length} src=${choice?.message?.content ? "content" : "reasoning_content"} raw=${JSON.stringify(text.slice(0, 300))}\n`);
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
    if (!text) throw new LmError(`${model} streamed an empty completion`, undefined, true);
    return text;
  });
}

// -- JSON EXTRACTION -------------------------------------------------------
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

export function topLevelObjects(s: string): Record<string, any>[] {
  const found: Record<string, any>[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{") continue;
    const end = balancedObjectEnd(s, i);
    if (end === -1) continue;
    try {
      const o = JSON.parse(s.slice(i, end));
      if (o && typeof o === "object") { found.push(o); i = end - 1; }
    } catch { }
  }
  return found;
}

const PROSE_KEYS = ["prose", "question", "situation", "need", "speech", "action", "thought",
                    "verdict", "note", "answer", "skills_used", "character"] as const;
const PROSE_ALT = PROSE_KEYS.join("|");

export function extractJson(raw: string): Record<string, any> {
  const stripped = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const afterThink = stripped.includes("</think>")
    ? stripped.slice(stripped.lastIndexOf("</think>") + 8).trim()
    : stripped;

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

export function salvageProse(raw: string): string {
  const m = raw.match(/"?prose"?\s*:\s*"/);
  if (!m) return "";
  let out = "", esc = false;
  for (let i = m.index! + m[0].length; i < raw.length; i++) {
    const c = raw[i];
    if (esc) { out += c === "n" ? "\n" : c === "t" ? "\t" : c; esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') break;
    out += c;
  }
  const end = Math.max(out.lastIndexOf("."), out.lastIndexOf("?"), out.lastIndexOf("!"));
  return end < 0 ? "" : out.slice(0, end + 1).trim();
}

// -- CONFIG VALIDATION -----------------------------------------------------
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
export class Agent {
  history: Msg[] = [];
  digest = "";                    // rolling summary of trimmed-off older history
  think: ThinkLevel = "low";      // config `thinking` / `thinking_<role>`
  constructor(public name: string, public model: string, public system: string,
              public temperature = 0.85, public maxMessages = WINDOW.cap) {}
  hear(c: string) { this.history.push({ role: "user", content: c }); }
  said(c: string) { this.history.push({ role: "assistant", content: c }); }

  // Same persona and model, EMPTY history: a re-asked character never learns it was rejected.
  fork(): Agent {
    const a = new Agent(this.name, this.model, this.system, this.temperature, this.maxMessages);
    a.think = this.think;
    return a;
  }

  // The trailing assistant prefix "{" forces the model to continue inside JSON.
  buildMessages(extra: Msg[] = []): Msg[] {
    const head: Msg[] = [{ role: "system", content: this.system }];
    if (this.digest) head.push({ role: "user", content: P.digestHeader(this.digest) });
    return [...head, ...this.history, ...extra, { role: "assistant", content: "{" }];
  }

  async generate(label: string, extra: Msg[] = []): Promise<string> {
    const msgs = this.buildMessages(extra);
    const ts = new Date().toISOString();
    const prepend = "{";
    if (!STREAM) {
      const raw = await complete(this.model, msgs, this.temperature, this.think);
      writeLlmRecord(this, ts, msgs, raw);
      return prepend + raw;
    }
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
    writeLlmRecord(this, ts, msgs, rest);
    return prepend + rest;
  }
}

// -- LLM INTERACTION LOG -----------------------------------------------------
export function llmFilenameFor(name: string, used: Set<string>): string {
  const base = slugify(name) || "agent";
  let f = `${base}.jsonl`, n = 2;
  while (used.has(f)) f = `${base}-${n++}.jsonl`;
  used.add(f);
  return f;
}

export function llmLogEntry(agent: { name: string; model: string }, ts: string, prompt: Msg[], response: string) {
  return { ts, role: agent.name === "WRITER" ? "writer" : "character", agent: agent.name, model: agent.model, prompt, response };
}

function writeLlmRecord(agent: Agent, ts: string, prompt: Msg[], response: string) {
  if (!OUT_DIR || agent.name === "ARCHITECT") return;
  try {
    let stream = LLM_STREAMS.get(agent.name);
    if (!stream) {
      const file = llmFilenameFor(agent.name, LLM_FILENAMES);
      stream = createWriteStream(joinPath(OUT_DIR, "llm", file), { flags: "w" });
      stream.on("error", () => {});   // an async write failure must never crash the run
      LLM_STREAMS.set(agent.name, stream);
    }
    stream.write(JSON.stringify(llmLogEntry(agent, ts, prompt, response)) + "\n");
  } catch { }
}

// -- HISTORY WINDOWING -----------------------------------------------------
export async function trimHistory(agent: Agent, summarizerModel: string, summarizerThink: ThinkLevel = "low") {
  if (agent.history.length <= agent.maxMessages) return;
  const overflowCount = agent.history.length - WINDOW.keepRecent;
  const overflow = agent.history.slice(0, overflowCount);
  const recent = agent.history.slice(overflowCount);
  const text = overflow.map(m => `${m.role === "assistant" ? agent.name : "input"}: ${m.content}`).join("\n");
  try {
    agent.digest = await complete(summarizerModel, [
      { role: "system", content: P.SUMMARIZER_SYSTEM },
      { role: "user", content: P.summarizePrompt(agent.name, agent.digest, text) },
    ], 0.3, summarizerThink);
    agent.history = recent;
  } catch (e) {
    console.warn(`   (digest skipped for ${agent.name}: ${(e as Error).message})`);
  }
}

// -- SKILL CATALOG ---------------------------------------------------------
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

// `Lock Picking` and `lockpicking` are one skill; the authored spelling is what the character sees.
const canonSkill = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, "");

// A story may write `name :: what it means`; the meaning is optional, the name is not.
export function splitMeaning(raw: string): { text: string; meaning: string } {
  const i = raw.indexOf("::");
  if (i < 0) return { text: raw.trim(), meaning: "" };
  return { text: raw.slice(0, i).trim(), meaning: raw.slice(i + 2).trim() };
}

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
    if (h3 && section === "characters") {
      character = { name: h3[1].trim() };
      characters.push(character);
      continue;
    }
    if (h2) { section = h2[1].trim().toLowerCase(); character = null; continue; }
    if (line.startsWith("#")) continue;

    if (section === "premise") {
      premise += (premise ? "\n" : "") + line.trim();
      continue;
    }

    const kvm = line.match(/^(\w[\w\s]*?)\s*:\s*(.+)/);
    if (!kvm) continue;
    const key = kvm[1].trim().toLowerCase();
    const val = kvm[2].trim();
    // Character fields are free-text prose; only structured sections lose a trailing "# comment".
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
  goal: string;         // what they want tonight — theirs alone to weigh progress against
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
  maxProseWords: number;           // ceiling on ONE draft's prose — the scene's pacing dial
  stream: boolean;
  debug: boolean;
  thinking: { writer: ThinkLevel; character: ThinkLevel; summary: ThinkLevel };
  requestTimeout: number;          // seconds before a model call is abandoned and retried
  attempts: number;                // TOTAL tries per model call (1 = never retry)
  maxTokens: number;
  models: { default: string; writer: string; summary: string };
  characters: CharacterDef[];
}

// Story dirs resolve against THIS FILE's folder, not the cwd, so a run behaves the same anywhere.
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const resolveStoryDir = (dir: string) => (isAbsolute(dir) ? dir : resolvePath(ROOT, dir));

export async function loadStory(dir: string, modelOverride?: string): Promise<StoryConfig> {
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
  const requestTimeout = num(kv, "config.request_timeout", 120);   // seconds
  const attempts       = num(kv, "config.attempts", 3);
  const maxTokens      = num(kv, "config.max_tokens", 2000);
  const retries        = num(kv, "config.retries", 2);
  const clarifications = num(kv, "config.clarifications", 2);
  const maxSteps       = num(kv, "config.max_steps", 24);
  const maxProseWords  = num(kv, "config.max_prose_words", 140);
  const stream         = bool(kv, "config.stream", true);
  const debug          = bool(kv, "config.debug", false);

  const defaultModel = modelOverride || kv["models.default"] || "qwen3.6-35b-a3b";
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

  // Declared-but-unreadable is a hard failure, as every file reference is; undeclared is fine.
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
      goal: (c.goal ?? "").trim(),
      skills: resolveSkills(name, c.skills ?? "", c.lacks ?? ""),
    });
  }

  if (scene.pov && !characters.some(c => c.name.toLowerCase() === scene.pov.trim().toLowerCase()))
    console.warn(`   (## Scene pov: "${scene.pov}" is not one of the characters — ignored)`);

  return {
    dir: base, premise, scene, writerStyle,
    retries, clarifications, maxSteps, maxProseWords, stream, debug, thinking,
    requestTimeout, attempts, maxTokens, models, characters,
  };
}

// -- DISCOVERY -------------------------------------------------------------
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

export const NEW_STORY = "\0new";
export async function chooseStory(arg: string): Promise<string> {
  if (arg) return arg;
  const choices = await discoverStories();
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

export async function selectableStory(dir: string): Promise<string | null> {
  const want = String(dir ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!want) return null;
  const choices = await discoverStories();
  return choices.find(c => c === want || c === `stories/${want}`) ?? null;
}

const BUILTIN_MODEL = "qwen3.6-35b-a3b";
export interface Defaults {
  models: { default: string; architect: string };
  thinking: { architect: ThinkLevel };
  requestTimeout: number; attempts: number; maxTokens: number; stream: boolean; debug: boolean;
}
export async function loadDefaults(override = ""): Promise<Defaults> {
  let kv: Record<string, string> = {};
  try { kv = parseStoryMd(await readFile(joinPath(ROOT, "defaults.md"), "utf8")).kv; } catch { }
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
export interface StorySpec {
  title: string;
  premise: string;
  scene: { place: string; question: string; pov: string; length: number };
  writerStyle: string;
  characters: Array<{ name: string; persona: string; knows: string; goal: string; skills: string[]; lacks: string[] }>;
}

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean)
  : typeof v === "string" ? v.split("|").map(s => s.trim()).filter(Boolean)
  : [];

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
      // A `lacks:` outside the catalog removes nothing — the silent opposite of what was asked for.
      const ok = Object.keys(SKILL_CATALOG).some(g => canonSkill(g) === canonSkill(splitMeaning(l).text));
      if (!ok) problems.push(`${name} "lacks: ${l}" — not a general skill, so it would remove nothing`);
      return ok;
    });
    characters.push({
      name, persona: String(c?.persona ?? "").trim(), knows: String(c?.knows ?? "").trim(),
      goal: String(c?.goal ?? "").trim(), skills: asStrings(c?.skills), lacks,
    });
    if (!c?.persona) problems.push(`${name} has no persona`);
    // The engine renders those fields itself, so a persona restating them contradicts the skill
    // list inside the character's own prompt.
    else if (/\b(LACKS|KNOWS|SKILLS|GOAL)\s*:/.test(String(c.persona)))
      problems.push(`${name}'s persona restates knows/goal/skills/lacks — the engine renders those, and the persona will contradict them`);
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
  if (characters.length > 1 && !characters.some(c => c.lacks.length))
    problems.push("nobody lacks anything — no perceptual asymmetry for the consult to bite on");
  return { spec, problems };
}

export function applyEdits(spec: StorySpec, raw: any): {
  spec: StorySpec; applied: string[]; ignored: string[]; problems: string[];
} {
  const applied: string[] = [], ignored: string[] = [];
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

    const cm = field.match(/^characters\.(.+)\.(persona|knows|goal|skills|lacks)$/);
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

export const DIRECT_FIELDS = ["scene.length"] as const;
export const MIN_SCENE_WORDS = 100, MAX_SCENE_WORDS = 10000;
export function directEdit(spec: StorySpec, field: string, value: unknown):
  { ok: false; reason: string } | { ok: true; spec: StorySpec; applied: string[]; problems: string[] } {
  if (!(DIRECT_FIELDS as readonly string[]).includes(field))
    return { ok: false, reason: `"${field}" is the architect's to change — say what you want instead` };
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < MIN_SCENE_WORDS || n > MAX_SCENE_WORDS)
    return { ok: false, reason: `a scene is ${MIN_SCENE_WORDS}–${MAX_SCENE_WORDS} words` };
  const e = applyEdits(spec, { edits: [{ field, value: n }] });
  return { ok: true, spec: e.spec, applied: e.applied, problems: e.problems };
}

export function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

export function renderStory(spec: StorySpec, models: { default: string }): Record<string, string> {
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
      c.goal  ? `goal: ${oneLine(c.goal)}` : "",
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
async function architectExample(): Promise<string> {
  try {
    const md = await readFile(joinPath(ROOT, "stories/doorway/story.md"), "utf8");
    const persona = await readFile(joinPath(ROOT, "stories/doorway/riven.md"), "utf8");
    return P.workedExample(md, persona);
  } catch { return ""; }
}

export async function buildArchitect(d: Defaults): Promise<Agent> {
  const system = P.architectSystem(SKILL_CATALOG, await architectExample());
  const a = new Agent("ARCHITECT", d.models.architect, system, 0.9);
  a.think = d.thinking.architect;
  return a;
}

/** Never raw JSON — the round asks for a judgement about people, which JSON is the wrong shape for. */
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
    if (c.goal)          lines.push(`  ${C.dim}wants:${C.reset}    ${c.goal}`);
    lines.push(full ? `\n${c.persona}\n` : `  ${C.dim}${c.persona.replace(/\s+/g, " ").slice(0, 140)}…${C.reset}`);
    return lines.join("\n");
  }).join("\n");
  return head + cast + (spec.writerStyle && full ? `\n\n${C.bold}House style${C.reset}\n${spec.writerStyle}\n` : "");
}

export function specView(spec: StorySpec) {
  return {
    title: spec.title, premise: spec.premise, scene: spec.scene, writerStyle: spec.writerStyle,
    characters: spec.characters.map(c => ({
      name: c.name, persona: c.persona, knows: c.knows, goal: c.goal,
      skills: c.skills.map(s => splitMeaning(s)),
      lacks: c.lacks,
    })),
  };
}

// -- SCAFFOLD SESSION ------------------------------------------------------

export type ScaffoldRound =
  | { kind: "proposal"; note: string }
  | { kind: "edits"; applied: string[]; ignored: string[]; note: string }
  | { kind: "question"; ask: string }
  | { kind: "nothing"; why: string }
  | { kind: "failed"; error: string };

export type ScaffoldAccept =
  | { kind: "written"; dir: string; files: string[]; warnings: string[] }
  | { kind: "unloadable"; dir: string; files: string[]; error: string; warnings: string[] }
  | { kind: "needs_folder"; reason: string }
  | { kind: "no_story" };

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

  constructor(public architect: Agent, public defaults: Defaults, public idea: string,
              public storiesDir: string = joinPath(ROOT, "stories")) {}

  haveStory(): boolean { return this.spec.characters.length > 0; }

  request(userText: string): string {
    if (!userText) return P.architectIdea(this.idea);
    if (this.haveStory())
      return P.architectChange(userText,
        JSON.stringify({ ...this.spec, writer_style: this.spec.writerStyle }, null, 1));
    return P.architectMore(userText, this.idea, this.asks >= ScaffoldSession.MAX_ASKS);
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

  async propose(): Promise<ScaffoldRound> {
    const r = await this.round("");
    return "error" in r ? { kind: "failed", error: r.error } : this.takeProposal(r.out);
  }

  async say(text: string): Promise<ScaffoldRound> {
    const wasPatch = this.haveStory();
    const r = await this.round(text);
    if ("error" in r) return { kind: "failed", error: r.error };
    if (!wasPatch) return this.takeProposal(r.out);

    const back = String(r.out.ask ?? "").trim();
    if (back && !r.out.edits) { this.pendingAsk = back; return { kind: "question", ask: back }; }

    const e = applyEdits(this.spec, r.out);
    this.spec = e.spec; this.problems = e.problems;
    this.pendingAsk = "";     
    return { kind: "edits", applied: e.applied, ignored: e.ignored, note: withAsk(r.out) };
  }

  private label(abs: string): string {
    const rel = relativePath(ROOT, abs).replace(/\\/g, "/");
    return rel && !rel.startsWith("..") ? rel : abs;
  }

  async accept(folderName = ""): Promise<ScaffoldAccept> {
    if (!this.haveStory()) return { kind: "no_story" };
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
let preflightChain: Promise<unknown> = Promise.resolve();
export interface PreflightResult {
  ok: boolean; error?: string; warnings: string[];
  summary?: {
    premise: string;
    characters: { name: string; skills: number; added: string[]; lacking: string[] }[];
    scene: { place: string; question: string; pov: string; length: number };
    maxSteps: number; retries: number; clarifications: number; maxProseWords: number;
    models: { default: string; writer: string; summary: string };
    modelCheck: "ok" | "missing" | "unreachable";
    missingModels: string[];
  };
}

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
          maxProseWords: sc.maxProseWords,
          models: sc.models, modelCheck, missingModels,
        },
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message, warnings };
    } finally { console.warn = origWarn; }
  });
  preflightChain = task.catch(() => {});   // the chain must survive a check that throws
  return task;
}

export interface StoryCard {
  dir: string; name: string; ok: boolean; error?: string; warnings: string[];
  premise?: string;
  scene?: { place: string; question: string; pov: string; length: number };
  characters?: { name: string; can: string[]; cannot: string[] }[];
  maxSteps?: number;
  runs: RunSummary[];
}

export interface RunSummary {
  id: string; mtimeMs: number;
  steps?: number; words?: number; done?: boolean; stopped?: boolean;
}
export async function retainedRuns(storyDir: string): Promise<RunSummary[]> {
  const ids = await runDirs(storyDir);
  const out: RunSummary[] = [];
  for (const id of ids) {
    const runPath = joinPath(storyDir, "out", id);
    let mtimeMs: number;
    try { mtimeMs = (await stat(runPath)).mtimeMs; } catch { continue; }
    const summary: RunSummary = { id, mtimeMs };
    try {
      const lines = (await readFile(joinPath(runPath, "writing-log.jsonl"), "utf8")).trim().split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const ev = JSON.parse(lines[i]);
        if (ev.t === "scene_end") {
          summary.steps = ev.steps; summary.words = ev.words; summary.done = ev.done; summary.stopped = ev.stopped;
          break;
        }
      }
    } catch { }
    out.push(summary);
  }
  return out.reverse();   // newest first
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
      runs: await retainedRuns(resolveStoryDir(dir)),
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
        + ` · ≤${s.maxProseWords} words/piece`
        + (s.scene.pov ? ` · pov ${s.scene.pov}` : "")
        + ` · ~${s.scene.length} words · models ${s.modelCheck}`);
    }
    for (const w of r.warnings) console.log(`   ${C.yellow}⚠${C.reset} ${w.trim()}`);
    if (r.ok && !r.warnings.length) console.log(`   ${C.dim}no warnings${C.reset}`);
  }
  if (failed) process.exitCode = 1;
}

// -- CHARACTER AGENT -------------------------------------------------------
export function wrapCharacter(def: CharacterDef, place: string): string {
  return P.characterSystem({
    persona: def.persona, place, skills: def.skills, knows: def.knows, goal: def.goal,
  });
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
  situation: string;    
  question: string;     
  wants: ConsultWants | "";  
}

// -- WHAT A CONSULT MUST CONTAIN TO BE WORTH SENDING -----------------------
export const CONSULT_WANTS = ["speech", "action", "decision", "reaction"] as const;
export type ConsultWants = (typeof CONSULT_WANTS)[number];

const WANTS_HINTS: [RegExp, ConsultWants][] = [
  [/\b(speech|speak|say|says|said|tell|tells|reply|replies|answer|answers|word|words|aloud)\b/i, "speech"],
  [/\b(decision|decide|decides|choose|chooses|choice|whether|refuse|refuses|agree|agrees|allow)\b/i, "decision"],
  [/\b(reaction|react|reacts|respond|responds)\b/i, "reaction"],
  [/\b(action|act|acts|do|does|doing|move|moves)\b/i, "action"],
];

/** Canonicalize the writer's `wants` to one of the four, or null when it carries no shape. */
export function canonWants(raw: unknown): ConsultWants | null {
  const v = String(raw ?? "").trim();
  if (!v) return null;
  const exact = CONSULT_WANTS.find(w => w === v.toLowerCase());
  if (exact) return exact;
  for (const [re, w] of WANTS_HINTS) if (re.test(v)) return w;
  return null;
}

const DEGENERATE_QUESTIONS = [
  /^what (do|does|will|would|should|is|are)\s+\S+(\s+\S+)?\s+(do|doing|going to do)\b/i,
  /^what happens?\b/i,
  /^what next\b/i,
  /^(your|their|his|her)\s+(move|turn|call)\b/i,
];

const MIN_SITUATION_WORDS = 5;

export type ConsultCheck = { ok: true; req: ConsultRequest } | { ok: false; why: string };

export function normalizeConsult(raw: {
  character: string; situation?: unknown; question?: unknown; wants?: unknown;
}): ConsultCheck {
  const character = String(raw.character ?? "").trim();
  const situation = String(raw.situation ?? "").trim();
  const question  = String(raw.question ?? "").trim();
  const words = situation.split(/\s+/).filter(Boolean).length;

  if (!situation)
    return { ok: false, why: P.badConsult.emptySituation(character) };
  if (words < MIN_SITUATION_WORDS)
    return { ok: false, why: P.badConsult.shortSituation(character, words) };
  if (!question)
    return { ok: false, why: P.badConsult.noQuestion(character) };
  if (DEGENERATE_QUESTIONS.some(re => re.test(question)))
    return { ok: false, why: P.badConsult.degenerate(question) };

  const wants = canonWants(raw.wants);
  if (!wants)
    return { ok: false, why: P.badConsult.badWants(CONSULT_WANTS, String(raw.wants ?? "")) };

  return { ok: true, req: { character, situation, question, wants } };
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

export type Clarifier = (question: string, req: ConsultRequest) => Promise<string>;

const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean)
  : typeof v === "string" ? v.split(/[,;|]/).map(s => s.trim()).filter(Boolean)
  : [];

export async function consult(
  agent: Agent, req: ConsultRequest, skills: Skill[],
  opts: { clarifications: number; clarify: Clarifier; attempt?: number; log?: (e: ConsultEvent) => void },
): Promise<ConsultReply> {
  const log = opts.log ?? (() => {});
  const have = new Map(skills.map(s => [canonSkill(s.name), s.name]));
  const extra: Msg[] = [{ role: "user", content: P.askBlock(req) }];
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
                   { role: "user", content: P.authorAnswers(answer) });
        continue;
      }
      // An author who has stopped answering is a fact about the situation, not a reason to stall.
      if (!forced) {
        forced = true;
        log({ t: "forced", character: req.character });
        extra.push({ role: "assistant", content: JSON.stringify({ need }) },
                   { role: "user", content: P.AUTHOR_DONE_ANSWERING });
        continue;
      }
      if (!repaired) {
        repaired = true;
        log({ t: "repair", character: req.character, why: "asked again after being told no more detail is coming" });
        extra.push({ role: "assistant", content: JSON.stringify({ need }) },
                   { role: "user", content: P.ANSWER_NOW });
        continue;
      }
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
    const why = !thought && !speech && !action ? "returned nothing usable"
              : unknown.length ? `used ${unknown.map(s => `"${s}"`).join(", ")}`
              : "";
    if (why && !repaired) {
      repaired = true;
      log({ t: "repair", character: req.character, why });
      extra.push({ role: "assistant", content: raw.trim() },
                 { role: "user", content: unknown.length
                   ? P.skillCheck(unknown, [...have.values()])
                   : P.EMPTY_REPLY });
      continue;
    }

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
export function wrapWriter(sc: StoryConfig): string {
  const general = Object.keys(SKILL_CATALOG);
  return P.writerSystem({
    premise: sc.premise,
    scene: sc.scene,
    cast: sc.characters.map(c => ({
      name: c.name,
      can: c.skills.map(s => s.name),
      cannot: general.filter(g => !c.skills.some(s => canonSkill(s.name) === canonSkill(g))),
    })),
    style: sc.writerStyle,
  });
}

// -- SCENE LOOP ------------------------------------------------------------
export type RunEvent =
  | ConsultEvent
  | { t: "scene_start"; story: string; characters: string[]; target: number }
  | { t: "draft"; step: number; prose: string; words: number; consulting: string; salvaged: boolean }
  | { t: "bad_consult"; character: string; why: string }
  | { t: "judge"; character: string; verdict: string; note: string; attempt: number }
  | { t: "accept"; character: string; attempt: number; speech: string; action: string }
  | { t: "retry"; character: string; attempt: number; situation: string; question: string }
  | { t: "budget"; added: number; budget: number }
  | { t: "reader_ask"; step: number; framing: string; options: string[] }
  | { t: "reader_answer"; answer: string }
  | { t: "model_changed"; model: string }
  | { t: "scene_end"; steps: number; words: number; done: boolean; stopped: boolean };


async function askMoreSteps(steps: number, budget: number): Promise<number> {
  if (RUN.stopped) return 0;
  if (!LIVE.interactive) {
    console.log(`\n${C.yellow}Step budget (${budget}) spent and the scene is not finished. `
      + `Stopping — interactive is off.${C.reset}`);
    return 0;
  }
  if (sseClients.size) {
    LIVE.awaitingContinue = { steps, budget };
    progressDone();
    console.log(`\n${C.yellow}Budget spent — waiting on the viewer.${C.reset}`);
    sseWrite({ t: "continue_prompt", steps, budget, suggested: 8 });
    return new Promise<number>(resolve => { LIVE.continueResolve = resolve; });
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

const OVERRUN_SLACK = 1.5;

const NEGLECT_GAP = 3;

export function neglectedCast(cast: string[], lastAsked: Map<string, number>, step: number, gap: number): string[] {
  if (step < gap) return [];
  return cast.filter(name => {
    const last = lastAsked.get(name.toLowerCase());
    return last === undefined || step - last >= gap;
  });
}

export async function writeScene(sc: StoryConfig, log: (e: RunEvent) => void) {
  const writer = new Agent("WRITER", sc.models.writer, wrapWriter(sc), 0.8);
  writer.think = sc.thinking.writer;
  const agents = buildCharacterAgents(sc);
  const defOf = (name: string) => sc.characters.find(c => c.name.toLowerCase() === name.trim().toLowerCase());
  LIVE.writer = writer; LIVE.agents = agents; LIVE.log = log;

  const pieces: string[] = [];
  const wordCount = () => pieces.join(" ").split(/\s+/).filter(Boolean).length;
  const lastAsked = new Map<string, number>();
  let steps = 0, budget = sc.maxSteps, done = false, empties = 0;
  let overran = 0;

  log({ t: "scene_start", story: sc.dir, characters: sc.characters.map(c => c.name), target: sc.scene.length });

  while (!done) {
    if (RUN.stopped) break;

    if (LIVE.pausing) {
      LIVE.paused = true;
      sseWrite(runState());
      await new Promise<void>(res => { LIVE.pauseResolve = res; });
      if (RUN.stopped) break;
      continue;
    }

    if (steps >= budget) {
      const extra = await askMoreSteps(steps, budget);
      if (!extra) break;
      budget += extra;
      log({ t: "budget", added: extra, budget });
    }

    if (LIVE.readerArmed && LIVE.interactive && sseClients.size) {
      LIVE.readerArmed = false;
      sseWrite(runState());
      writer.hear(P.askReader(wordCount()));
      let askRaw = "";
      try {
        askRaw = await writer.generate(`${C.magenta}WRITER${C.reset}`);
      } catch (e) {
        if (e instanceof StoppedError || RUN.stopped) break;
        console.log(`\n${C.red}Reader-consult call failed (${(e as Error).message}) — `
          + `writing normally instead.${C.reset}`);
      }
      if (askRaw) {
        steps++;
        const ask = extractJson(askRaw);
        const framing = String(ask.framing ?? "").trim();
        const options = Array.isArray(ask.options)
          ? ask.options.map((o: unknown) => String(o).trim()).filter(Boolean).slice(0, 3) : [];
        writer.said(JSON.stringify({ framing, options }));
        log({ t: "reader_ask", step: steps, framing, options });
        console.log(`\n${C.cyan}(waiting on the reader — ${options.length} direction(s) offered)${C.reset}`);

        const answer = await new Promise<string>(resolve => { LIVE.readerResolve = resolve; });
        if (RUN.stopped) break;
        if (answer) {
          log({ t: "reader_answer", answer });
          writer.hear(P.readerChose(answer));
        }
      }
      continue;
    }

    const words = wordCount();
    const neglected = neglectedCast(sc.characters.map(c => c.name), lastAsked, steps, NEGLECT_GAP);
    writer.hear(P.writeInstruction({
      words, target: sc.scene.length, maxProseWords: sc.maxProseWords, overran, neglected,
    }));
    let draftRaw: string;
    try {
      draftRaw = await writer.generate(`${C.magenta}WRITER${C.reset}`);
    } catch (e) {
      if (e instanceof StoppedError || RUN.stopped) break;
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

    const proseWords = prose ? prose.split(/\s+/).filter(Boolean).length : 0;
    overran = proseWords > sc.maxProseWords * OVERRUN_SLACK ? proseWords : 0;
    if (prose) pieces.push(prose);
    writer.said(JSON.stringify({ prose, ...(who ? { consult: { character: who } } : {}), scene_done: sceneDone }));
    log({ t: "draft", step: steps, prose, words: wordCount(), consulting: who, salvaged });
    if (prose && !SERVE) console.log(`\n${prose}\n`);

    // -- CONSULT (with accept / retry)
    let asked = false;                   // did anyone actually get consulted this step?
    if (who) {
      const def = defOf(who);
      const persistent = agents.get(who.toLowerCase());
      const check = def ? normalizeConsult({ ...c!, character: def.name }) : null;
      if (!def || !persistent) {
        writer.hear(P.noSuchCharacter(who, sc.characters.map(x => x.name)));
      } else if (!check!.ok) {
        log({ t: "bad_consult", character: def.name, why: check!.why });
        console.log(`${C.yellow}(not sent to ${def.name} — ${check!.why.split(". ")[0]}.)${C.reset}`);
        writer.hear(P.consultNotSent(check!.why, def.name));
      } else {
        asked = true;
        let req: ConsultRequest = check!.req;
        let reply: ConsultReply | null = null;
        let usedAttempt = 1;
        let failed = "";

        for (let attempt = 1; ; attempt++) {
          usedAttempt = attempt;
          const agent = attempt === 1 ? persistent : persistent.fork();
          try {
            reply = await consult(agent, req, def.skills, {
              clarifications: sc.clarifications, attempt, log,
              clarify: async (q, r) => {
                let a = "";
                try {
                  const raw = await writer.generate(`${C.magenta}WRITER${C.reset}`, [{
                    role: "user", content: P.clarifyRequest(r.character, q, r.situation),
                  }]);
                  a = String(extractJson(raw).answer ?? "").trim();
                } catch (e) {
                  console.log(`${C.red}(clarification call failed: ${(e as Error).message})${C.reset}`);
                  return "";     // consult turns this into "(no answer)" and the character answers anyway
                }
                writer.hear(P.characterAsks(r.character, q));
                writer.said(JSON.stringify({ answer: a }));
                return a;
              },
            });
          } catch (e) {
            failed = (e as Error).message;
            break;
          }

          const flags = P.answerFlags(reply);
          let j: Record<string, any> = {};
          try {
            const judgeRaw = await writer.generate(`${C.magenta}WRITER${C.reset}`, [{
              role: "user",
              content: P.judgeRequest({
                name: def.name, question: req.question, thought: reply.thought,
                speech: reply.speech, action: reply.action, note: reply.note, flags,
              }),
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
            wants: canonWants(rev.wants) ?? req.wants,
          };
          console.log(`${C.yellow}retry ${attempt}/${sc.retries} — ${def.name}${C.reset}${note ? ` ${C.dim}(${note})${C.reset}` : ""}`);
          log({ t: "retry", character: def.name, attempt, situation: req.situation, question: req.question });
        }

        if (RUN.stopped) break;

        const stalled = !!reply && !reply.thought && !reply.speech && !reply.action;
        if (failed || !reply || stalled) {
          const why = failed || (stalled ? reply!.note || "did not answer" : "no reply");
          console.log(`${C.red}${def.name}: ${why}.${C.reset}`);
          writer.hear(P.noAnswer(def.name, why));
        } else {
          persistent.hear(P.askBlock(req) + P.clarificationTrail(reply.clarifications));
          persistent.said(JSON.stringify({ thought: reply.thought, speech: reply.speech, action: reply.action }));
          writer.hear(P.characterAnswered(def.name, P.answerBody(reply)));
          lastAsked.set(def.name.toLowerCase(), steps);
          log({ t: "accept", character: def.name, attempt: usedAttempt, speech: reply.speech, action: reply.action });
          if (!SERVE) console.log(`${C.cyan}${def.name}${C.reset} ${C.dim}→${C.reset} `
            + (reply.speech ? `"${reply.speech}" ` : "") + (reply.action ? `${C.dim}${reply.action}${C.reset}` : ""));
        }
      }
    }

    if (!prose && !asked) {
      if (++empties >= 3) { console.log(`${C.red}Writer wrote nothing and asked nobody, three times — stopping.${C.reset}`); break; }
    } else empties = 0;

    if (sceneDone) done = true;
    if (RUN.stopped) break;              // don't spend summary calls on a run that is over
    await trimHistory(writer, sc.models.summary, sc.thinking.summary);
    for (const a of agents.values()) await trimHistory(a, sc.models.summary, sc.thinking.summary);
  }

  log({ t: "scene_end", steps, words: wordCount(), done, stopped: RUN.stopped });
  LIVE.writer = null; LIVE.agents = null; LIVE.log = null;
  return { prose: pieces, steps, words: wordCount(), done, stopped: RUN.stopped };
}

// -- ENTRY POINT -----------------------------------------------------------
const flag = (name: string): string | undefined => {
  const hit = CLI.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (hit === undefined) return undefined;
  const eq = hit.indexOf("=");
  return eq < 0 ? "" : hit.slice(eq + 1);
};

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
  const wants     = canonWants(flag("wants")) ?? "";
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

async function newScaffoldSession(idea: string, model = ""): Promise<ScaffoldSession> {
  const d = await loadDefaults(model || flag("model") || "");
  STREAM = d.stream; DEBUG = d.debug;
  NET.timeoutMs = d.requestTimeout * 1000;
  NET.retries = d.attempts - 1;
  MAX_TOKENS = d.maxTokens;
  return new ScaffoldSession(await buildArchitect(d), d, idea);
}

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

async function runScaffoldCli() {
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
          const sure = (await rl2.question(`${C.yellow}${session.problems.length} thing(s) flagged above. `
            + `Accept anyway? [y/N] ${C.reset}`)).trim().toLowerCase();
          if (sure !== "y") continue;
        }
        const dir = await acceptAtConsole(session, rl2);
        if (!dir) continue;                       // could not settle on a folder; back to refining
        rl2.close();
        const sc = await loadStory(dir, LIVE.modelOverride ?? undefined);
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
  const sc = await loadStory(dir, LIVE.modelOverride ?? undefined);
  STREAM = sc.stream; DEBUG = sc.debug;
  NET.timeoutMs = sc.requestTimeout * 1000;
  NET.retries = sc.attempts - 1;
  MAX_TOKENS = sc.maxTokens;

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

let BROWSER_DRIVES = false;

export function awaitPick(): Promise<string> {
  LIVE.awaitingPick = true;
  setWhere("choosing a story", false);
  console.log(`\n${C.dim}Waiting for a story to be chosen at ${C.reset}http://localhost:${LIVE.port}/`
    + `${C.dim} — Ctrl-C to quit.${C.reset}`);
  return new Promise<string>(r => { LIVE.pickResolve = r; }).then(picked => {
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

const HOST: ServerHost = {
  storyCards, selectableStory, resolveStoryDir, runDirs, loadedModelIds,
  newScaffoldSession, directEdit, specView,
  architectModel: async () => (await loadDefaults(flag("model") ?? "")).models.architect,
  outDir: () => OUT_DIR,
};
const serve = () => startServer(PORT, HOST);

async function main() {
  if (SERVE) serve();            // before the picker, so the viewer is up while you are still choosing
  const oneShot = !!STORY_DIR || !process.stdin.isTTY || flag("consult") !== undefined;
  BROWSER_DRIVES = SERVE && !oneShot;

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

export const MAX_RUNS = 3;

export async function runDirs(storyDir: string): Promise<string[]> {
  try {
    const ents = await readdir(joinPath(storyDir, "out"), { withFileTypes: true });
    return ents.filter(e => e.isDirectory()).map(e => e.name).sort();
  } catch { return []; }
}

async function runAndSave(sc: StoryConfig, dir: string) {
  console.log(`${C.bold}${dir}${C.reset} ${C.dim}— ${sc.characters.map(c => c.name).join(", ")} `
    + `· ~${sc.scene.length} words · up to ${sc.maxSteps} steps${C.reset}`);

  LIVE.meta = {
    story: dir, target: sc.scene.length, question: sc.scene.question,
    characters: sc.characters.map(c => ({
      name: c.name,
      skills: c.skills.filter(s => s.source === "story").map(s => s.name),
      lacks: Object.keys(SKILL_CATALOG).filter(g => !c.skills.some(s => canonSkill(s.name) === canonSkill(g))),
    })),
  };
  resetLive();
  if (SERVE) serve();
  setWhere(`writing ${dir}`, true);

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  OUT_DIR = joinPath(sc.dir, "out", runId);
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(joinPath(OUT_DIR, "llm"), { recursive: true });
  LLM_STREAMS = new Map();
  LLM_FILENAMES = new Set();
  const scenePath = joinPath(OUT_DIR, "scene.md");
  const logPath = joinPath(OUT_DIR, "writing-log.jsonl");
  const logStream = createWriteStream(logPath, { flags: "w" });

  const events: RunEvent[] = [];
  const pieces: string[] = [];
  let sceneWrites: Promise<unknown> = Promise.resolve();
  const r = await writeScene(sc, e => {
    events.push(e);
    logStream.write(JSON.stringify(publish(e)) + "\n");
    if (e.t === "draft" && e.prose) {
      pieces.push(e.prose);
      sceneWrites = sceneWrites.then(() => writeFile(scenePath, pieces.join("\n\n") + "\n", "utf8")).catch(() => {});
    }
  });
  await sceneWrites;
  await new Promise<void>(res => logStream.end(res));
  await Promise.all([...LLM_STREAMS.values()].map(s => new Promise<void>(res => s.end(res))));

  // Rotate: keep only the last MAX_RUNS folders, including the one just written.
  const kept = await runDirs(sc.dir);
  for (const stale of kept.slice(0, Math.max(0, kept.length - MAX_RUNS))) {
    await rm(joinPath(sc.dir, "out", stale), { recursive: true, force: true }).catch(() => {});
  }

  setWhere(r.stopped ? `stopped ${dir}` : `finished ${dir}`, false);

  if (!SERVE) {
    console.log(`\n${C.bold}${"=".repeat(60)}${C.reset}`);
    console.log(r.prose.join("\n\n"));
    console.log(`${C.bold}${"=".repeat(60)}${C.reset}`);
  }
  const consults = events.filter(e => e.t === "consult").length;
  const retries  = events.filter(e => e.t === "retry").length;
  const needs    = events.filter(e => e.t === "need").length;
  const flags    = events.filter(e => e.t === "skill_flag").length;
  console.log(`${C.dim}${r.words} words · ${r.steps} steps · ${consults} consult(s) · `
    + `${needs} clarification(s) · ${retries} retry/retries · ${flags} skill flag(s) · `
    + `${r.stopped ? "stopped by request" : r.done ? "scene finished" : "stopped early"}${C.reset}`);
  console.log(`${C.dim}${scenePath}\n${logPath}${C.reset}`);
}

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
