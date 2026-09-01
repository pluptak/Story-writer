/**
 * Turn a real run's transcripts into the committed replay fixture.
 *
 *   node scripts/make-replay-fixture.mjs stories/doorway/out/<run-id>
 *
 * Writes tests/fixtures/recorded-run/: the story.json the run used, its scene.md, and calls.jsonl —
 * one `{agent, site, response}` per model call, in each agent's own order.
 *
 * The prompts are deliberately dropped. Replay is keyed on (agent, site), never on prompt text, and
 * the prompts are 97% of the bytes (1272KB against 30KB of responses in the first such run). Keeping
 * them would commit a megabyte that nothing reads and that every prompt edit would invalidate.
 *
 * Re-run this when a change legitimately alters which calls the engine makes; the replay test fails
 * loudly rather than quietly when the recording no longer covers the run.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const runDir = process.argv[2];
if (!runDir) {
  console.error("usage: node scripts/make-replay-fixture.mjs <run-dir>");
  process.exit(1);
}
const llmDir = join(runDir, "llm");
if (!existsSync(llmDir)) {
  console.error(`no llm/ under ${runDir} — is that a run directory?`);
  process.exit(1);
}

// The story the run was written from; manifest.json names it.
const manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"));
const storyJson = join(manifest.story, "story.json");
if (!existsSync(storyJson)) {
  console.error(`the run names story ${manifest.story}, but ${storyJson} is not there`);
  process.exit(1);
}

const out = resolve("tests/fixtures/recorded-run");
mkdirSync(out, { recursive: true });

const lines = [];
let unnamed = 0;
for (const file of readdirSync(llmDir).sort()) {
  if (!file.endsWith(".jsonl")) continue;
  for (const raw of readFileSync(join(llmDir, file), "utf8").split("\n")) {
    if (!raw.trim()) continue;
    const rec = JSON.parse(raw);
    if (!rec.site) { unnamed++; continue; }
    lines.push(JSON.stringify({ agent: rec.agent, site: rec.site, response: rec.response }));
  }
}

if (unnamed) {
  console.error(`${unnamed} record(s) carry no call site — this run predates them. Re-record.`);
  process.exit(1);
}

// A run holds decisions its transcripts never see. The step budget is the one that bites: when a
// scene outlives `maxSteps`, `askMoreSteps()` ASKS — a viewer or a terminal answers, and the grant
// lands in the writing log, not in any transcript. Replaying with the story's own `maxSteps` would
// stop where the live run was extended, so the fixture carries the budget the run actually had.
const wlog = readFileSync(join(runDir, "writing-log.jsonl"), "utf8")
  .split("\n").filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);
const budgets = wlog.filter(e => e.t === "budget");
const sceneEnd = wlog.find(e => e.t === "scene_end");
const effectiveSteps = budgets.length ? budgets[budgets.length - 1].budget
                                      : JSON.parse(readFileSync(storyJson, "utf8")).config?.maxSteps ?? null;

writeFileSync(join(out, "calls.jsonl"), lines.join("\n") + "\n", "utf8");
copyFileSync(storyJson, join(out, "story.json"));
copyFileSync(join(runDir, "scene.md"), join(out, "scene.md"));
writeFileSync(join(out, "source.json"), JSON.stringify({
  run: manifest.run, story: manifest.story, chapter: manifest.chapter,
  engine: manifest.engine, git: manifest.git, models: manifest.models,
  /** The step budget the live run ended up with, after any interactive grant. */
  effectiveSteps,
  budgetGrants: budgets.map(b => ({ added: b.added, budget: b.budget })),
  /** What the live run produced, for the replay to be measured against. */
  outcome: sceneEnd ? { steps: sceneEnd.steps, words: sceneEnd.words, done: sceneEnd.done } : null,
}, null, 2) + "\n", "utf8");

const bySite = {};
for (const l of lines) { const o = JSON.parse(l); const k = `${o.agent}|${o.site}`; bySite[k] = (bySite[k] ?? 0) + 1; }
console.log(`${lines.length} calls -> tests/fixtures/recorded-run/calls.jsonl`);
for (const k of Object.keys(bySite).sort()) console.log(`  ${k.padEnd(34)} ${bySite[k]}`);
