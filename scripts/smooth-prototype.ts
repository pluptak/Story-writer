/**
 * SMOOTH-PROTOTYPE — renders a recorded run's structured record into prose ("smoothing pass").
 * A read-only prototype that loads a writing-log.jsonl, assembles the scene's decisions and
 * world events into SmoothItem[], and either prints them (dry run) or feeds them to an agent
 * for composition with the --live flag.
 *
 * Usage:
 *   npx tsx scripts/smooth-prototype.ts --run=<path to run directory> [--live] [--model=<id>]
 *     [--out=<file>]
 *
 * Requires a running inference server if --live is given (see CLAUDE.md).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import * as P from "../prompts.ts";
import { Agent } from "../engine/agent.ts";
import { ENGINE } from "../engine/engine-state.ts";
import { loadStory } from "../engine/story-format.ts";
import { parseBenchmarkArgs } from "./benchmark-args.ts";

// Scripted batch use: no progress painting.
ENGINE.stream = false;

interface WritingLogEntry {
  seq: number;
  t: string;
  character?: string;
  situation?: string;
  speech?: string;
  action?: string;
  thought?: string;
  beat?: string;
  hold?: string;
  step?: number;
  [key: string]: unknown;
}

function parseArgs() {
  const { get, has } = parseBenchmarkArgs(process.argv.slice(2), {
    values: ["run"],
    booleans: ["live"],
  });
  const run = get("run");
  if (!run) {
    console.error("--run=<path to run directory> is required");
    process.exit(1);
  }
  return {
    run,
    live: has("live"),
    model: get("model"),
    out: get("out"),
  };
}

/**
 * Derive the story directory from a run path. A run dir is <storyDir>/out/<id>,
 * so the story dir is two levels up.
 */
function storyDirFromRun(runPath: string): string {
  const abs = resolve(runPath);
  const parent = dirname(abs);
  const storyDir = dirname(parent);
  return storyDir;
}

async function main() {
  const opts = parseArgs();
  const runPath = resolve(opts.run);
  const storyDir = storyDirFromRun(runPath);
  const logPath = join(runPath, "writing-log.jsonl");

  // Load the story to get writerStyle, POV, question, cast, and target.
  const sc = await loadStory(storyDir);
  const scene = sc.scenes[0];
  if (!scene) {
    console.error("Story has no scenes");
    process.exit(1);
  }

  const writerStyle = sc.writerStyle;
  const pov = scene.pov || "";
  const question = scene.question || "";
  const cast = sc.characters.map(c => c.name);
  const targetWords = scene.length ?? 750;

  // Read and parse the writing log.
  const logLines = readFileSync(logPath, "utf8").split("\n");
  const entries: WritingLogEntry[] = [];
  for (const line of logLines) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip unparseable lines.
    }
  }

  // Ordered by the log's own `seq`, carried alongside each item rather than recovered afterwards:
  // matching items back to their entry by content collapses whenever two grants share a character
  // and an action, which a repeated gesture makes likely.
  const seqed: { seq: number; item: P.SmoothItem }[] = [];
  for (const entry of entries) {
    const seq = typeof entry.seq === "number" ? entry.seq : Number.MAX_SAFE_INTEGER;
    if (entry.t === "consult") {
      seqed.push({ seq, item: { kind: "situation", character: entry.character || "", text: entry.situation || "" } });
    } else if (entry.t === "accept") {
      const grant: P.SmoothItem = {
        kind: "grant",
        character: entry.character || "",
        speech: entry.speech || "",
        action: entry.action || "",
      };
      if (typeof entry.thought === "string" && entry.thought.trim()) grant.thought = entry.thought;
      seqed.push({ seq, item: grant });
    } else if (entry.t === "world_beat") {
      seqed.push({ seq, item: { kind: "world", text: entry.beat || "" } });
    }
  }
  seqed.sort((a, b) => a.seq - b.seq);
  const items = seqed.map(s => s.item);

  // Dry run mode (default): print the record and summary.
  const request = P.smoothRequest(items, targetWords);
  const situations = items.filter(i => i.kind === "situation").length;
  const grants = items.filter(i => i.kind === "grant").length;
  const worlds = items.filter(i => i.kind === "world").length;
  const summary = `${situations} situations, ${grants} grants, ${worlds} world events`;

  const output = `${request}\n\n--- ${summary} ---`;

  if (!opts.live) {
    console.log(output);
    return;
  }

  // Live mode: construct an agent and call it.
  const model = opts.model ?? sc.models.writer;
  const think = sc.thinking.writer;
  const agent = new Agent("SMOOTH", model, P.smoothSystem({ style: writerStyle, pov, question, cast }), 0.7);
  agent.think = think;

  // generate(label, site, extra): the label is the console tag, the record rides as a user message.
  const prose = await agent.generate("SMOOTH", "writer.smooth",
    [{ role: "user", content: request }]);

  const finalOutput = opts.out ? prose : `${prose}\n\n--- ${summary} ---`;

  if (opts.out) {
    writeFileSync(opts.out, prose, "utf8");
    console.log(`wrote prose to ${opts.out}`);
  } else {
    console.log(finalOutput);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
