/** AGENT — the generic writer/character agent: windowed history, generation, and its LLM log. */
import { createWriteStream } from "node:fs";
import { join as joinPath } from "node:path";
import * as P from "../prompts.ts";
import { C } from "../ansi.ts";
import { sseWrite } from "../live.ts";
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

  // Same persona and model, EMPTY history: a re-asked character never learns it was rejected.
  fork(): Agent {
    const a = new Agent(this.name, this.model, this.system, this.temperature);
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
    const started = Date.now();
    if (!ENGINE.stream) {
      const { text: raw, usage } = await complete(this.model, msgs, this.temperature, this.think);
      const durationMs = Date.now() - started;
      writeLlmRecord(this, ts, msgs, raw, durationMs, usage);
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
    const { text: rest, usage } = await completeStream(this.model, msgs, this.temperature, d => {
      chars += d.length;
      if (Date.now() - lastPaint > 250) { lastPaint = Date.now(); paint(); }
    }, this.think);
    const durationMs = Date.now() - started;
    progressDone();
    sseWrite({ t: "idle" });
    writeLlmRecord(this, ts, msgs, rest, durationMs, usage);
    emitStats(this.name, this.model, durationMs, usage);
    return prepend + rest;
  }
}

// -- LLM INTERACTION LOG -----------------------------------------------------
/** A unique llm-log filename for an agent name within this run, suffixing -2, -3, ... on collisions. */
export function llmFilenameFor(name: string, used: Set<string>): string {
  const base = slugify(name) || "agent";
  let f = `${base}.jsonl`, n = 2;
  while (used.has(f)) f = `${base}-${n++}.jsonl`;
  used.add(f);
  return f;
}

/** One JSONL record for an agent/model exchange; author-side names get their own role, everyone else is a character. */
const ROLES: Record<string, string> = {
  "WRITER": "writer",
  "JUDGE": "judge",
  "BATCH-JUDGE": "batch-judge",
  "NARRATION-JUDGE": "narration-judge",
  "CLARIFIER": "clarifier",
};

export function llmLogEntry(agent: { name: string; model: string }, ts: string, prompt: Msg[], response: string,
                            durationMs: number, usage: CompletionUsage | null) {
  return {
    ts, role: ROLES[agent.name] ?? "character", agent: agent.name, model: agent.model,
    prompt, response, durationMs, usage,
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

/** Push a record for one agent/model exchange to its transcript stream. A stream that fails warns
 *  once and is abandoned for the rest of the run — the run itself must never crash on logging. */
export function writeLlmRecord(agent: Agent, ts: string, prompt: Msg[], response: string,
                               durationMs: number, usage: CompletionUsage | null) {
  if (!ENGINE.outDir || agent.name === "ARCHITECT" || ENGINE.llmDead.has(agent.name)) return;
  try {
    let stream = ENGINE.llmStreams.get(agent.name);
    if (!stream) {
      const file = llmFilenameFor(agent.name, ENGINE.llmFilenames);
      stream = createWriteStream(joinPath(ENGINE.outDir, "llm", file), { flags: "w" });
      stream.on("error", e => killLlmLog(agent.name, e));   // async write failure must never crash the run
      ENGINE.llmStreams.set(agent.name, stream);
    }
    stream.write(JSON.stringify(llmLogEntry(agent, ts, prompt, response, durationMs, usage)) + "\n");
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
    agent.digest = (await complete(summarizerModel, [
      { role: "system", content: P.SUMMARIZER_SYSTEM },
      { role: "user", content: P.summarizePrompt(agent.name, agent.digest, text) },
    ], 0.3, summarizerThink)).text;
    agent.history = recent;
  } catch (e) {
    warn(`   (digest skipped for ${agent.name}: ${(e as Error).message})`);
  }
}
