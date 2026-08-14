/** AGENT — the generic writer/character agent: windowed history, generation, and its LLM log. */
import { createWriteStream } from "node:fs";
import { join as joinPath } from "node:path";
import * as P from "../prompts.ts";
import { C } from "../ansi.ts";
import { sseWrite } from "../live.ts";
import { ENGINE, progress, progressDone } from "./engine-state.ts";
import { slugify } from "./config-util.ts";
import { complete, completeStream, type Msg, type ThinkLevel } from "./llm-client.ts";

const WINDOW = { cap: 24, keepRecent: 14 };

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
    if (!ENGINE.stream) {
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
  if (!ENGINE.outDir || agent.name === "ARCHITECT") return;
  try {
    let stream = ENGINE.llmStreams.get(agent.name);
    if (!stream) {
      const file = llmFilenameFor(agent.name, ENGINE.llmFilenames);
      stream = createWriteStream(joinPath(ENGINE.outDir, "llm", file), { flags: "w" });
      stream.on("error", () => {});   // an async write failure must never crash the run
      ENGINE.llmStreams.set(agent.name, stream);
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
