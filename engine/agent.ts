/** AGENT — the generic writer/character agent: windowed history, generation, and its LLM log. */
import { createWriteStream } from "node:fs";
import { join as joinPath } from "node:path";
import * as P from "../prompts.ts";
import { C } from "../ansi.ts";
import { LIVE, sseWrite } from "../live.ts";
import { ENGINE, progress, progressDone } from "./engine-state.ts";
import { warn } from "./warnings.ts";
import { slugify } from "./config-util.ts";
import { complete, completeStream, type Msg, type CompletionUsage } from "./llm-client.ts";
import type { ThinkLevel } from "./story-schema.ts";

const WINDOW = { cap: 24, keepRecent: 14 };

export class Agent {
  history: Msg[] = [];
  digest = "";                    // rolling summary of trimmed-off older history
  think: ThinkLevel = "low";      // config `thinking` / `thinking_<role>`
  constructor(public name: string, public model: string, public system: string,
              public temperature = 0.85) {}
  hear(c: string) { this.history.push({ role: "user", content: c }); }
  said(c: string) { this.history.push({ role: "assistant", content: c }); }

  // Back to the first `n` messages: how a caller unwinds history it added on speculation,
  // when the thing it speculated on did not happen.
  rewind(n: number) { if (n < this.history.length) this.history.length = Math.max(0, n); }

  // The state immediately before the attempt being retried: same persona, model and history, on its
  // own copy. `consult()` never writes to `agent.history` — only an accepted answer is folded in by
  // the caller — so this history holds every earlier accepted interaction and nothing of the rejected
  // attempt. The fresh instance still never learns it was rejected; it just no longer forgets the
  // promise it made two consults ago.
  fork(): Agent {
    const a = new Agent(this.name, this.model, this.system, this.temperature);
    a.think = this.think;
    a.history = this.history.map(m => ({ ...m }));
    a.digest = this.digest;
    return a;
  }

  // The trailing assistant prefix "{" forces the model to continue inside JSON.
  buildMessages(extra: Msg[] = []): Msg[] {
    const head: Msg[] = [{ role: "system", content: this.system }];
    if (this.digest) head.push({ role: "user", content: P.digestHeader(this.digest) });
    return [...head, ...this.history, ...extra, { role: "assistant", content: "{" }];
  }

  /** Early warning before the call goes out: when this prompt plus its reply reserve does not fit
   *  the context the model is actually loaded with, say so once per model — the overflow itself
   *  would otherwise surface only later, as mysterious empty completions. */
  private async warnIfContextTight(msgs: Msg[]) {
    if (!fitWarning || ENGINE.fitWarned.has(this.model)) return;
    const fit = await fitWarning(this.model, msgs);
    if (!fit) return;
    ENGINE.fitWarned.add(this.model);
    warn(`   ${C.yellow}⚠${C.reset} ${fit.message}`);
    LIVE.log?.({ t: "context_risk", model: this.model, needs: fit.needs, has: fit.has });
  }

  /** `site` is the engine's stable name for THIS call site — `writer.draft`, `judge.answer` — in the
   *  GUI's `<area>.<component>` shape. It never reaches the model (llm-client sends it as a header)
   *  and it never varies with the prompt, so a recorded run can be replayed by matching call sites
   *  rather than prompt text. It is required because a call that does not name itself is invisible
   *  to that matching, and the one place that would notice is a replay months later. `label` stays
   *  what the console prints, which is coloured and, for a character, their own name. */
  async generate(label: string, site: string, extra: Msg[] = []): Promise<string> {
    const msgs = this.buildMessages(extra);
    const ts = new Date().toISOString();
    const prepend = "{";
    const started = Date.now();
    await this.warnIfContextTight(msgs);
    if (!ENGINE.stream) {
      const { text: raw, usage, reasoning, finishReason, reasoningOnly, brokenOff } =
        await complete(this.model, msgs, this.temperature, this.think, { site, agent: this.name });
      const durationMs = Date.now() - started;
      writeLlmRecord(this, ts, msgs, raw, durationMs, usage,
                     { reasoning, finishReason, reasoningOnly, brokenOff }, site);
      emitStats(this.name, this.model, durationMs, usage);
      return prepend + raw;
    }
    let chars = 0, lastPaint = 0;
    const paint = () => {
      const secs = Math.round((Date.now() - started) / 1000);
      progress(`${label} ${C.dim}composing… ${String(secs).padStart(2)}s · ${chars} chars${C.reset}`);
      sseWrite({ t: "composing", who: this.name, secs, chars });
    };
    paint();
    const { text: rest, usage, reasoning, finishReason, reasoningOnly, brokenOff } =
      await completeStream(this.model, msgs, this.temperature, d => {
        chars += d.length;
        if (Date.now() - lastPaint > 250) { lastPaint = Date.now(); paint(); }
      }, this.think, { site, agent: this.name });
    const durationMs = Date.now() - started;
    progressDone();
    sseWrite({ t: "idle" });
    writeLlmRecord(this, ts, msgs, rest, durationMs, usage,
                   { reasoning, finishReason, reasoningOnly, brokenOff }, site);
    emitStats(this.name, this.model, durationMs, usage);
    return prepend + rest;
  }
}

// -- CONTEXT-FIT EARLY WARNING ----------------------------------------------
/** Wired by the composition root (agent.ts must not depend on preflight.ts — the same reason
 *  json-extract takes a debug sink). Given the model and the messages about to be sent, returns
 *  what to warn with, or null when nothing is known about the model or the prompt fits. */
let fitWarning: ((model: string, msgs: Msg[]) =>
  Promise<{ message: string; needs: number; has: number } | null>) | null = null;
/** The composition root's hook: give Agent.generate its context-fit checker (null unwires it). */
export function setFitWarning(
  fn: ((model: string, msgs: Msg[]) => Promise<{ message: string; needs: number; has: number } | null>) | null,
) { fitWarning = fn; }

// -- LLM INTERACTION LOG -----------------------------------------------------
/** A unique llm-log filename for an agent name within this run, suffixing -2, -3, ... on collisions. */
export function llmFilenameFor(name: string, used: Set<string>): string {
  const base = slugify(name) || "agent";
  let f = `${base}.jsonl`, n = 2;
  while (used.has(f)) f = `${base}-${n++}.jsonl`;
  used.add(f);
  return f;
}

/** Author-side agent names get their own role in the log; everyone else is a character. */
const ROLES: Record<string, string> = {
  "WRITER": "writer",
  "JUDGE": "judge",
  "BATCH-JUDGE": "batch-judge",
  "NARRATION-JUDGE": "narration-judge",
  "CLARIFIER": "clarifier",
};

/** One JSONL record for an agent/model exchange; author-side names get their own role, everyone else is a character.
 *  `finish_reason` is always present (null when the server did not say); `reasoning` appears only when the
 *  chain-of-thought arrived as a separate field, `reasoningOnly: true` only when the whole reply did. */
export function llmLogEntry(agent: { name: string; model: string }, ts: string, prompt: Msg[], response: string,
                            durationMs: number, usage: CompletionUsage | null, meta: ReplyMeta = {},
                            site?: string) {
  return {
    ts, role: ROLES[agent.name] ?? "character", agent: agent.name, model: agent.model,
    // Omitted rather than null when absent, so records written before call sites were named stay
    // byte-identical and a reader can tell "not recorded" from "recorded as nothing".
    ...(site ? { site } : {}),
    prompt, response, durationMs, usage,
    finish_reason: meta.finishReason ?? null,
    ...(meta.reasoning ? { reasoning: meta.reasoning } : {}),
    ...(meta.reasoningOnly ? { reasoningOnly: true } : {}),
    ...(meta.brokenOff ? { broken_off: true } : {}),
  };
}

/** Push a per-call stats frame to live viewers. Token counts are null when the server did not report usage. */
function emitStats(who: string, model: string, durationMs: number, usage: CompletionUsage | null) {
  sseWrite({
    t: "agent_stats", who, model, durationMs,
    promptTokens: usage?.promptTokens ?? null,
    completionTokens: usage?.completionTokens ?? null,
  });
}

/** What the transport learned about a reply beyond its text: the chain-of-thought when it arrived
 *  as a separate field, the server's finish reason, and whether the whole reply came through the
 *  reasoning channel. Everything optional — absent means "the server said nothing". */
export interface ReplyMeta {
  reasoning?: string | null;
  finishReason?: string | null;
  reasoningOnly?: boolean;
  brokenOff?: boolean;
}

/** Push a record for one agent/model exchange to its transcript stream. A stream that fails warns
 *  once and is abandoned for the rest of the run — the run itself must never crash on logging. */
export function writeLlmRecord(agent: Agent, ts: string, prompt: Msg[], response: string,
                               durationMs: number, usage: CompletionUsage | null, meta: ReplyMeta = {},
                               site?: string) {
  if (!ENGINE.outDir || agent.name === "ARCHITECT" || ENGINE.llmDead.has(agent.name)) return;
  try {
    let stream = ENGINE.llmStreams.get(agent.name);
    if (!stream) {
      const file = llmFilenameFor(agent.name, ENGINE.llmFilenames);
      stream = createWriteStream(joinPath(ENGINE.outDir, "llm", file), { flags: "w" });
      stream.on("error", e => killLlmLog(agent.name, e));   // async write failure must never crash the run
      ENGINE.llmStreams.set(agent.name, stream);
    }
    stream.write(JSON.stringify(llmLogEntry(agent, ts, prompt, response, durationMs, usage, meta, site)) + "\n");
  } catch (e) {
    killLlmLog(agent.name, e as Error);
  }
}

/** Warn once about an agent's transcript stream dying; later records for that agent are dropped. */
function killLlmLog(name: string, e: Error) {
  if (ENGINE.llmDead.has(name)) return;
  ENGINE.llmDead.add(name);
  warn(`   (LLM transcript for ${name} stopped being written: ${e.message} — later records are dropped, the run continues)`);
}

// -- HISTORY WINDOWING -----------------------------------------------------
/** Fold history beyond the window into a rolling digest; the digest itself feeds the next prompt. */
export async function trimHistory(agent: Agent, summarizerModel: string, summarizerThink: ThinkLevel = "low") {
  if (agent.history.length <= WINDOW.cap) return;
  const overflowCount = agent.history.length - WINDOW.keepRecent;
  const overflow = agent.history.slice(0, overflowCount);
  const recent = agent.history.slice(overflowCount);
  const text = overflow.map(m => `${m.role === "assistant" ? agent.name : "input"}: ${m.content}`).join("\n");
  try {
    // Named like the rest even though nothing logs it: this call goes through `complete` directly
    // rather than an Agent, so it lands in no transcript — the header is the only thing that makes
    // a history fold visible to a fake or a replay on the wire.
    agent.digest = (await complete(summarizerModel, [
      { role: "system", content: P.SUMMARIZER_SYSTEM },
      { role: "user", content: P.summarizePrompt(agent.name, agent.digest, text) },
    ], 0.3, summarizerThink, { site: "summary.digest", agent: agent.name })).text;
    agent.history = recent;
  } catch (e) {
    warn(`   (digest skipped for ${agent.name}: ${(e as Error).message})`);
  }
}
