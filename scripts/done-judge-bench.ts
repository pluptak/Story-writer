/**
 * DONE-JUDGE BENCH — isolates the done judge from a full scene run: given a question and a page
 * excerpt, does `checkQuestionState` (engine/scene-loop.ts) call it right?
 *
 * Why this exists: PLANS.md item 3 ("A scene has no representation of its own question being
 * answered") needs live calibration reads before `question_state` can gate anything, and every read
 * so far has meant running (or waiting on) a whole 20-50 step doorway chapter to reach one ending.
 * This replays real page excerpts pulled from actual runs — or any hand-written one — against a
 * fresh done-judge call, several times each, without writing a word of prose. It calls
 * `checkQuestionState` itself, not a reimplementation of its retry/parse logic, so a result here is
 * exactly what a live run would have recorded at that point on the page.
 *
 * Seeded (`done-judge-bench-cases.json`) with excerpts from two live doorway/e4b runs: three `open`
 * checkpoints from `07-50-49-951Z` (a granted-extension run that ended in a genuine standoff the
 * judge correctly caught) and the one `resolved` ending on record, from `06-15-52-596Z`. Add a case
 * any time a live run's verdict is worth re-checking, or to probe something no run has produced yet
 * — a false-`resolved` candidate is the one worth the most samples, since that is the failure mode
 * that would make gating on this dangerous (docs/PLANS.md item 3).
 *
 * Usage:
 *   npx tsx scripts/done-judge-bench.ts [--model=<id>] [--think=<off|low|medium|high|default>]
 *     [--samples=N] [--case=<id>] [--story=<dir>] [--out=<path>]
 *
 * Requires a running inference server with the model loaded, same environment as any live run
 * (LLM_PROVIDER / LLM_BASE_URL / LLM_API_KEY — see CLAUDE.md).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as P from "../prompts.ts";
import { Agent } from "../engine/agent.ts";
import { ENGINE } from "../engine/engine-state.ts";
import { checkQuestionState, type QuestionState, type RunEvent } from "../engine/scene-loop.ts";
import { loadStory } from "../engine/story-format.ts";
import { THINK_LEVELS, type ThinkLevel } from "../engine/story-schema.ts";

// Scripted batch use: no progress painting, the simpler non-streaming completion shape.
ENGINE.stream = false;

interface BenchCase {
  id: string;
  question: string;
  prose: string;
  expectedStatus: "open" | "resolved" | "unclear";
  note?: string;
  sourceRun?: string;
  sourceStep?: number;
}

interface SampleResult {
  sample: number;
  state: QuestionState;
  match: boolean;
  /** schema_mismatch / done_judge_failed events the call itself logged, for a "why did this take
   *  two calls" read — never scored, just carried through to the summary. */
  events: RunEvent[];
}

interface CaseResult {
  id: string;
  expectedStatus: BenchCase["expectedStatus"];
  samples: SampleResult[];
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (name: string) => {
    const hit = args.find(a => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  return {
    model: get("model"),
    samples: Number(get("samples") ?? "5"),
    caseId: get("case"),
    story: get("story") ?? "data/stories/doorway",
    out: get("out"),
    think: get("think") as ThinkLevel | undefined,
  };
}

function describeState(state: QuestionState): string {
  if (state.status === "resolved") return `resolved — ${state.evidence}`;
  if (state.status === "open") return `open — ${state.why}`;
  if (state.status === "unavailable") return `unavailable — ${state.why}`;
  return "unread";
}

async function main() {
  const opts = parseArgs();
  const here = dirname(fileURLToPath(import.meta.url));
  const allCases: BenchCase[] = JSON.parse(readFileSync(join(here, "done-judge-bench-cases.json"), "utf8"));
  const cases = opts.caseId ? allCases.filter(c => c.id === opts.caseId) : allCases;
  if (!cases.length) {
    console.error(`no case(s) matched --case=${opts.caseId}. Known ids:\n`
      + allCases.map(c => `  ${c.id}`).join("\n"));
    process.exit(1);
  }
  if (opts.think !== undefined && !(THINK_LEVELS as readonly string[]).includes(opts.think)) {
    console.error(`--think must be one of: ${THINK_LEVELS.join(" ")}`);
    process.exit(1);
  }

  const sc = await loadStory(opts.story);
  const model = opts.model ?? sc.models.writer;
  const think = opts.think ?? sc.thinking.writer;
  // Mirrors engine/scene-loop.ts's newDoneJudge exactly: same name, same system prompt, same
  // temperature (0.3 — classification, not composition, same reasoning as every other judge
  // variant), so a result here is not measuring some other call shape.
  const newDoneJudge = () => {
    const a = new Agent("DONE-JUDGE", model, P.DONE_JUDGE_FORMAT, 0.3);
    a.think = think;
    return a;
  };

  console.log(`model=${model}  think=${think}  samples/case=${opts.samples}  cases=${cases.length}\n`);

  const results: CaseResult[] = [];
  for (const c of cases) {
    console.log(`=== ${c.id} (expect: ${c.expectedStatus}, ${c.prose.split(/\s+/).filter(Boolean).length} words) ===`);
    if (c.note) console.log(`  ${c.note}`);
    const caseResult: CaseResult = { id: c.id, expectedStatus: c.expectedStatus, samples: [] };
    for (let s = 1; s <= opts.samples; s++) {
      const events: RunEvent[] = [];
      let state: QuestionState;
      try {
        state = await checkQuestionState(newDoneJudge, c.question, c.prose, 1, e => events.push(e));
      } catch (e) {
        state = { status: "unavailable", why: `call threw: ${(e as Error).message}` };
      }
      const match = state.status === c.expectedStatus;
      caseResult.samples.push({ sample: s, state, match, events });
      // The one line that actually matters: a resolved verdict on a case expected to be open (or
      // vice versa) is flagged loud, not just marked wrong in the summary table.
      const flag = !match
        ? (state.status === "resolved" ? "  <-- FALSE RESOLVED" : "  <-- mismatch")
        : "";
      console.log(`  sample ${s}: ${describeState(state)}${flag}`);
      for (const e of events) {
        if (e.t === "schema_mismatch") console.log("    (schema mismatch — asked once more)");
        if (e.t === "done_judge_failed") console.log(`    (call failed: ${e.why})`);
      }
    }
    results.push(caseResult);
    console.log();
  }

  const flat = results.flatMap(r => r.samples);
  const matched = flat.filter(s => s.match);
  const falseResolved = flat.filter(s => s.state.status === "resolved" && !s.match);
  console.log("--- summary ---");
  console.log(`samples: ${flat.length}`);
  console.log(`matched expected status: ${matched.length}/${flat.length}`);
  console.log(falseResolved.length
    ? `FALSE RESOLVED: ${falseResolved.length}/${flat.length} — the judge called an unsettled page `
      + `settled. This is the failure mode that would make gating on this dangerous; read every one.`
    : "false resolved: 0 — no case where the judge called an unsettled page settled");
  for (const r of results) {
    const caseMatched = r.samples.filter(s => s.match).length;
    console.log(`  ${r.id}: ${caseMatched}/${r.samples.length}`);
  }

  if (opts.out) {
    writeFileSync(opts.out, JSON.stringify({ model, samplesPerCase: opts.samples, results }, null, 2));
    console.log(`\nraw results written to ${opts.out}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
