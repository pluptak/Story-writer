/**
 * JUDGE DIAGNOSTIC — separates two sub-skills a live judge call bundles into one completion, so
 * a wrong verdict and a wrong reason for a right verdict stop being indistinguishable.
 *
 * Why this exists: reading the six real judge-retry cases in scripts/revision-benchmark-cases.json
 * against the doorway cast's actual data (not the judge's own stated reasoning) found two of six
 * retries were flatly, checkably wrong — one retried RIVEN for "no listed skills to bypass a
 * lock" while RIVEN's skills list `lockpicking`; another invoked "CANNOT: sight" for a character
 * whose `restrictions` array is empty. Two more leaked a real sight-only detail but over-
 * generalized the fix to a blanket perception ban. docs/PLANS.md ("Judge diagnostic matrix", under
 * Measurement owed) has the full case-by-case reasoning. This script measures the two bundled
 * sub-skills independently:
 *
 *   A. Cast comprehension  — no character answer at all, just closed yes/no questions against the
 *      story's own skills/restrictions. Ground truth is mechanical: read straight from story.json.
 *   B. Verdict-only classification — situation + answer, asked for {"verdict": ...} alone, no
 *      revision. Scored only on cases with an uncontested ground truth (the two real non-POV
 *      thought-only retries, plus synthetic clearly-fine answers) — NOT the four contested real
 *      cases, whose "correct" verdict is itself disputed per the case-by-case reading above.
 *   C. Repair construction — a known-unusable answer with the reason already given, asked for the
 *      revised fields only, checked through the real reviseConsult gate. Uses hand-authored,
 *      unambiguous cases, not the six real ones (again: contested ground truth).
 *
 * Usage:
 *   npx tsx scripts/judge-diagnostic.ts [--mode=cast|verdict|repair|all] [--model=<id>]
 *     [--think=<off|low|medium|high|default>] [--samples=N] [--story=<dir>] [--out=<path>]
 *
 * Requires a running inference server with the model loaded, same environment as any live run.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as P from "../prompts.ts";
import { Agent } from "../engine/agent.ts";
import { ENGINE } from "../engine/engine-state.ts";
import { extractJson } from "../engine/json-extract.ts";
import { reviseConsult, parseVerdict, type CannotCast, type ConsultRequest, type ConsultWants } from "../engine/consult.ts";
import { loadStory } from "../engine/story-format.ts";
import { writerCast } from "../engine/scene-loop.ts";
import { sameName } from "../engine/config-util.ts";
import { THINK_LEVELS, type ThinkLevel } from "../engine/story-schema.ts";

ENGINE.stream = false;

interface CastQuestion { id: string; question: string; expected: boolean; note?: string }
interface VerdictCase {
  id: string; character: string; pov: boolean; situation: string; question: string; wants: string;
  thought: string; speech: string; action: string; note: string; expectedVerdict: "accept" | "retry"; why: string;
}
interface RepairCase {
  id: string; character: string; pov: boolean; situation: string; question: string; wants: string;
  thought: string; speech: string; action: string; note: string; why: string;
}
interface Cases { castQuestions: CastQuestion[]; verdictCases: VerdictCase[]; repairCases: RepairCase[] }

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (name: string) => {
    const hit = args.find(a => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  const has = (name: string) => args.includes(`--${name}`);
  return {
    mode: (get("mode") ?? "all") as "cast" | "verdict" | "repair" | "all",
    model: get("model"),
    samples: Number(get("samples") ?? "5"),
    story: get("story") ?? "data/stories/doorway",
    think: get("think") as ThinkLevel | undefined,
    out: get("out"),
    // The CANNOT-rendering arms, one flag each so a delta can be attributed to one of them. These
    // set the same ENGINE fields the CLI sets, because the rendering lives in the engine's cast
    // flattening (writerCast / wrapCharacter), not in a prompt argument.
    cannotMeaning: has("cannot-meaning"),
    cannotNone: has("cannot-none"),
    cannotTestimony: has("cannot-testimony"),
  };
}

/** One isolated call, repaired once against `wrongShape` if the first reply carries no `key`.
 *  A transport failure is caught here rather than left to propagate: `agent.generate` has already
 *  spent llm-client.ts's own retry/backoff budget by the time it throws, so a further retry here
 *  would only repeat that. Against a stable local server this never fires; against a rate-limited
 *  hosted endpoint one dropped call would otherwise crash the whole run out from under `main()` --
 *  losing every sample gathered so far in this mode, not just this one, since `--out` is written
 *  only once at the very end. Folded into the same `{ raw }` shape a wrong-shape reply already
 *  takes, so every caller's existing `unparseable(...)`/`REFUSED:` fallback shows it inline with no
 *  new branch anywhere. */
async function callOnce(
  system: string, model: string, think: Agent["think"], payload: string,
  key: string, wrongShape: string,
): Promise<Record<string, any> | { raw: string }> {
  const agent = new Agent("JUDGE", model, system, 0.3);
  agent.think = think;
  const extra = [{ role: "user" as const, content: payload }];
  try {
    for (let tries = 0; ; tries++) {
      const raw = await agent.generate("JUDGE", "bench.judge-diagnostic", extra);
      const reply = extractJson(raw);
      if (key in reply || tries) return key in reply ? reply : { raw: raw.slice(0, 200) };
      extra.push({ role: "assistant", content: raw.trim() }, { role: "user", content: wrongShape });
    }
  } catch (e) {
    return { raw: `ERROR: ${(e as Error).message}` };
  }
}

async function runCastMode(model: string, think: ThinkLevel, samples: number, cast: ReturnType<typeof writerCast>, cases: CastQuestion[]) {
  const system = P.castQuizSystem(cast);
  console.log(`\n=== A. cast comprehension (${cases.length} questions x ${samples} samples) ===`);
  let correct = 0, total = 0;
  for (const c of cases) {
    const payload = P.castQuizRequest(c.question);
    const outcomes: string[] = [];
    for (let s = 1; s <= samples; s++) {
      total++;
      const out = await callOnce(system, model, think, payload, "answer", P.CAST_QUIZ_ONLY);
      const got = "answer" in out ? out.answer === true : null;
      if (got === c.expected) correct++;
      outcomes.push("answer" in out ? String(got) : `unparseable(${(out as any).raw})`);
    }
    console.log(`  ${c.id} [expect ${c.expected}]${c.note ? ` -- ${c.note}` : ""}: ${outcomes.join(", ")}`);
  }
  console.log(`  score: ${correct}/${total}`);
  return { correct, total };
}

async function runVerdictMode(model: string, think: ThinkLevel, samples: number, cast: ReturnType<typeof writerCast>, cases: VerdictCase[]) {
  const system = P.judgeSystem(cast);
  console.log(`\n=== B. verdict-only classification (${cases.length} cases x ${samples} samples, uncontested ground truth only) ===`);
  let correct = 0, total = 0;
  for (const c of cases) {
    const flags = P.answerFlags({ forced: false });
    // The cast entry's `cannot` is already the arm-rendered display list, so arm D shows the judge
    // the same CANNOT wording arms B/C put in the cast block, restated beside the answer.
    const own = cast.find(e => sameName(e.name, c.character))?.cannot ?? [];
    const payload = P.judgeRequest({
      name: c.character, situation: c.situation, question: c.question,
      thought: c.thought, speech: c.speech, action: c.action, note: c.note, flags, pov: c.pov,
      ...(ENGINE.cannotTestimony ? { limits: own } : {}),
    }) + `\n\n[REPLY WITH VERDICT ONLY -- no "revised" field is needed for this question.]`;
    const outcomes: string[] = [];
    for (let s = 1; s <= samples; s++) {
      total++;
      const out = await callOnce(system, model, think, payload, "verdict", P.VERDICT_ONLY);
      const verdict = "verdict" in out ? parseVerdict(out) : null;
      if (verdict === c.expectedVerdict) correct++;
      outcomes.push(verdict ?? `unparseable(${(out as any).raw ?? ""})`);
    }
    console.log(`  ${c.id} [expect ${c.expectedVerdict}] (${c.why}): ${outcomes.join(", ")}`);
  }
  console.log(`  score: ${correct}/${total}`);
  return { correct, total };
}

async function runRepairMode(model: string, think: ThinkLevel, samples: number, cast: ReturnType<typeof writerCast>, cannotCast: CannotCast, cases: RepairCase[]) {
  const system = P.repairOnlySystem(cast);
  console.log(`\n=== C. repair construction (${cases.length} cases x ${samples} samples, contradiction already given) ===`);
  let ok = 0, total = 0;
  for (const c of cases) {
    const req: ConsultRequest = { character: c.character, situation: c.situation, question: c.question, wants: c.wants as ConsultWants | "" };
    const payload = P.repairOnlyRequest({
      name: c.character, situation: c.situation, question: c.question,
      thought: c.thought, speech: c.speech, action: c.action, note: c.note, pov: c.pov, why: c.why,
    });
    const outcomes: string[] = [];
    for (let s = 1; s <= samples; s++) {
      total++;
      const out = await callOnce(system, model, think, payload, "situation", P.REPAIR_SHAPE_ONLY);
      if (!("situation" in out)) { outcomes.push(`unparseable(${(out as any).raw})`); continue; }
      const revision = reviseConsult(req, out, cannotCast);
      if (revision.ok) { ok++; outcomes.push(`OK: "${revision.req.situation.slice(0, 60)}..."`); }
      else outcomes.push(`REFUSED: ${revision.why.split(". ")[0]}`);
    }
    console.log(`  ${c.id} (${c.why}):`);
    for (const o of outcomes) console.log(`    ${o}`);
  }
  console.log(`  score: ${ok}/${total}`);
  return { ok, total };
}

async function main() {
  const opts = parseArgs();
  const here = dirname(fileURLToPath(import.meta.url));
  const cases: Cases = JSON.parse(readFileSync(join(here, "judge-diagnostic-cases.json"), "utf8"));
  if (opts.think !== undefined && !(THINK_LEVELS as readonly string[]).includes(opts.think)) {
    console.error(`--think must be one of: ${THINK_LEVELS.join(" ")}`);
    process.exit(1);
  }

  // Set before writerCast: the arms act on the engine's cast flattening, not on a prompt argument,
  // so they have to be in place by the time the cast is built. `cannotCast` below is deliberately
  // built from `c.limits` and never from the display list -- that one is the matching key (I2).
  ENGINE.cannotMeaning = opts.cannotMeaning;
  ENGINE.cannotNone = opts.cannotNone;
  ENGINE.cannotTestimony = opts.cannotTestimony;

  const sc = await loadStory(opts.story);
  const cast = writerCast(sc.characters, []);
  const cannotCast: CannotCast = sc.characters.map(c => ({ name: c.name, cannot: c.limits }));
  const model = opts.model ?? sc.models.writer;
  const think = opts.think ?? sc.thinking.writer;

  // The arms are named in the header, so a captured run's output says which condition produced it.
  const arms = [opts.cannotMeaning && "cannot-meaning", opts.cannotNone && "cannot-none",
                opts.cannotTestimony && "cannot-testimony"].filter(Boolean);
  console.log(`model=${model}  think=${think}  samples/case=${opts.samples}  mode=${opts.mode}`
    + `  arms=${arms.length ? arms.join("+") : "none (baseline)"}`);

  const results: Record<string, unknown> = {};
  if (opts.mode === "cast" || opts.mode === "all")
    results.cast = await runCastMode(model, think, opts.samples, cast, cases.castQuestions);
  if (opts.mode === "verdict" || opts.mode === "all")
    results.verdict = await runVerdictMode(model, think, opts.samples, cast, cases.verdictCases);
  if (opts.mode === "repair" || opts.mode === "all")
    results.repair = await runRepairMode(model, think, opts.samples, cast, cannotCast, cases.repairCases);

  console.log(`\n--- summary ---`);
  console.log(JSON.stringify(results, null, 2));

  if (opts.out) {
    writeFileSync(opts.out, JSON.stringify({ model, think, samplesPerCase: opts.samples,
      arms: { cannotMeaning: opts.cannotMeaning, cannotNone: opts.cannotNone, cannotTestimony: opts.cannotTestimony },
      results }, null, 2));
    console.log(`\nraw results written to ${opts.out}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
