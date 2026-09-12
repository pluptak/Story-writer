/**
 * REVISION BENCHMARK — isolates one task from a full scene run: given an unusable character
 * answer, can the judge itself author a `revised` situation/question that survives the same gate
 * (`reviseConsult`) a first ask goes through?
 *
 * Why this exists: chasing the Free Consult spike's v3 turned up that 0 of 6 judge-requested
 * revisions across nine live doorway runs ever survived `reviseConsult` — every one came back as
 * a menu question, an unchanged situation, or a bare "what do you do?" shrug (docs/PLANS.md,
 * "Judge-conditioned revision may be a task this model cannot do at all", under Measurement
 * owed). This replays those same six real failures against a fresh judge call, several times
 * each, to get an actual pass rate instead of one opportunistic sample per case — and to let
 * --model swap in a different model against the identical cases, which is the cleanest test of
 * whether this is model incapability or something about the full pipeline's context.
 *
 * Note on what "isolated" buys here: the judge is already stateless per attempt in production
 * (`o.newJudge()` builds a fresh Agent with no history for every call) — there is no accumulated
 * scene context to strip away. What this script actually isolates is repeatability (cheap
 * resampling of the same fixed input) and the model, not context contamination.
 *
 * --split runs the same six cases through the engine's two-call --split-judge pipeline instead:
 * a verdict call over VERDICT_JUDGE_FORMAT that names the contradiction and stops, then a repair
 * call handed THAT call's own note as its reason. Same cases, same reviseConsult scoring, so the
 * two modes are directly comparable -- which is the whole point. It is also the one thing
 * scripts/judge-diagnostic.ts could not measure: its repair mode was handed a hand-authored,
 * CORRECT diagnosis, where this one is handed whatever the model itself just said. The revision's
 * survival is scored mechanically; whether the diagnosis behind it was right is not decidable in
 * code, so every retry's note is printed verbatim to be read.
 *
 * Usage:
 *   npx tsx scripts/revision-benchmark.ts [--split] [--model=<id>]
 *     [--think=<off|low|medium|high|default>] [--samples=N] [--case=<id>] [--story=<dir>] [--out=<path>]
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
import { extractJson } from "../engine/json-extract.ts";
import { reviseConsult, parseVerdict, type CannotCast, type ConsultRequest, type ConsultWants } from "../engine/consult.ts";
import { loadStory } from "../engine/story-format.ts";
import { writerCast } from "../engine/scene-loop.ts";
import { THINK_LEVELS, type ThinkLevel } from "../engine/story-schema.ts";

// Scripted batch use: no progress painting, the simpler non-streaming completion shape.
ENGINE.stream = false;

interface BenchCase {
  id: string;
  character: string;
  pov: boolean;
  situation: string;
  question: string;
  wants: string;
  thought: string;
  speech: string;
  action: string;
  note: string;
  forced?: boolean;
  sourceRun?: string;
  sourceSeq?: number;
  originalJudgeNote?: string;
  originalFailure?: string;
}

interface SampleResult {
  sample: number;
  verdict: "accept" | "retry" | null;
  revised?: { situation: string; question: string };
  revisionOk: boolean | null;   // null when verdict was not "retry"
  revisionWhy?: string;
  /** The judge's own stated contradiction. In --split mode this is literally the second call's
   *  input, so a wrong one here is the failure mode the split cannot fix on its own. */
  note?: string;
  raw?: string;                 // only on an unparseable reply or a call failure
}

interface CaseResult {
  id: string;
  originalFailure?: string;
  samples: SampleResult[];
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (name: string) => {
    const hit = args.find(a => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  return {
    // The engine's --split-judge, as a benchmark mode: same cases, same scoring, two calls.
    split: args.includes("--split"),
    model: get("model"),
    samples: Number(get("samples") ?? "5"),
    caseId: get("case"),
    story: get("story") ?? "data/stories/doorway",
    out: get("out"),
    // Override for the story's own thinking.writer level (default "low") — LM Studio forwards
    // this as reasoning_effort on the wire (engine/llm-client.ts:82); a hybrid-thinking model
    // (Qwen3, ...) may default to reasoning ON and "low" may suppress more of it than that
    // model's own default would, which is a confound worth ruling out per-model, not assumed.
    think: get("think") as ThinkLevel | undefined,
  };
}

/** One isolated call, mirroring judge-gate.ts's own schema-repair loop: a reply that does not carry
 *  the key being asked for is asked once more against `wrongShape` before giving up on it. */
async function callOnce(
  system: string, model: string, think: Agent["think"], payload: string,
  ok: (reply: Record<string, any>) => boolean, wrongShape: string,
): Promise<{ reply: Record<string, any>; raw: string }> {
  const agent = new Agent("JUDGE", model, system, 0.3);
  agent.think = think;
  const extra = [{ role: "user" as const, content: payload }];
  for (let tries = 0; ; tries++) {
    const raw = await agent.generate("JUDGE", "bench.judge", extra);
    const reply = extractJson(raw);
    if (ok(reply) || tries) return { reply, raw };
    extra.push({ role: "assistant", content: raw.trim() }, { role: "user", content: wrongShape });
  }
}

/** What the mode changes, in one place: which system prompt the verdict call runs under, which
 *  wrong-shape nudge it is corrected with, and where the revision comes from afterwards. */
interface Mode {
  split: boolean;
  verdictSystem: string;
  repairSystem: string;
  cast: CannotCast;
}

/** One sample end to end: verdict, then — on a retry — the revision, from whichever path the mode
 *  says. Returns the revision as the raw object so both modes score through the identical gate. */
async function runSample(
  m: Mode, c: BenchCase, model: string, think: Agent["think"], sample: number,
): Promise<SampleResult> {
  // Identical in both modes, deliberately: judge-gate.ts sends exactly this payload either way, and
  // the split's verdict call is already told it authors no revision by its own system prompt. The
  // diagnostic needed a "verdict only" suffix because it ran over the full judgeSystem; adding one
  // here would measure a prompt the engine never sends and quietly break the comparison.
  const verdictPayload = P.judgeRequest({
    name: c.character, situation: c.situation, question: c.question,
    thought: c.thought, speech: c.speech, action: c.action, note: c.note,
    flags: P.answerFlags({ forced: c.forced ?? false }), pov: c.pov,
  });

  const out = await callOnce(m.verdictSystem, model, think, verdictPayload,
    r => !!parseVerdict(r), m.split ? P.VERDICT_NOTE_ONLY : P.VERDICT_ONLY);
  const verdict = parseVerdict(out.reply);
  if (verdict === "accept") return { sample, verdict, revisionOk: null };
  if (verdict !== "retry") return { sample, verdict: null, revisionOk: null, raw: out.raw.slice(0, 200) };

  const note = String(out.reply.note ?? "").trim();
  let rev: Record<string, unknown> = {};
  if (!m.split) {
    rev = (out.reply.revised && typeof out.reply.revised === "object")
      ? out.reply.revised as Record<string, unknown> : {};
  } else if (!note) {
    // The split's second call has nothing but the first call's diagnosis to work from, so a retry
    // that named no contradiction cannot produce a revision at all. The engine treats this the same
    // way (repair_failed, answer kept) -- scored here as the refused revision it becomes.
    return { sample, verdict, revisionOk: false, note,
             revisionWhy: "the verdict named no contradiction for the repair call to work from",
             revised: { situation: "", question: "" } };
  } else {
    const repair = await callOnce(m.repairSystem, model, think, P.repairOnlyRequest({
      name: c.character, situation: c.situation, question: c.question,
      thought: c.thought, speech: c.speech, action: c.action, note: c.note, pov: c.pov, why: note,
    }), r => typeof r.situation === "string", P.REPAIR_SHAPE_ONLY);
    if (typeof repair.reply.situation === "string") rev = repair.reply;
  }

  const req: ConsultRequest = {
    character: c.character, situation: c.situation, question: c.question,
    wants: c.wants as ConsultWants | "",
  };
  const revision = reviseConsult(req, rev, m.cast);
  return {
    sample, verdict, revisionOk: revision.ok, note,
    revised: { situation: String(rev.situation ?? ""), question: String(rev.question ?? "") },
    revisionWhy: revision.ok ? undefined : revision.why,
  };
}

async function main() {
  const opts = parseArgs();
  const here = dirname(fileURLToPath(import.meta.url));
  const allCases: BenchCase[] = JSON.parse(readFileSync(join(here, "revision-benchmark-cases.json"), "utf8"));
  const cases = opts.caseId ? allCases.filter(c => c.id === opts.caseId) : allCases;
  if (!cases.length) {
    console.error(`no case(s) matched --case=${opts.caseId}. Known ids:\n` + allCases.map(c => `  ${c.id}`).join("\n"));
    process.exit(1);
  }
  if (opts.think !== undefined && !(THINK_LEVELS as readonly string[]).includes(opts.think)) {
    console.error(`--think must be one of: ${THINK_LEVELS.join(" ")}`);
    process.exit(1);
  }

  const sc = await loadStory(opts.story);
  const cast = writerCast(sc.characters, []);
  const cannotCast: CannotCast = sc.characters.map(c => ({ name: c.name, cannot: c.limits }));
  const model = opts.model ?? sc.models.writer;
  const think = opts.think ?? sc.thinking.writer;
  const mode: Mode = {
    split: opts.split,
    verdictSystem: opts.split ? P.verdictJudgeSystem(cast) : P.judgeSystem(cast),
    repairSystem: P.repairOnlySystem(cast),
    cast: cannotCast,
  };

  console.log(`model=${model}  think=${think}  samples/case=${opts.samples}  cases=${cases.length}  `
    + `mode=${opts.split ? "split (two calls)" : "single call"}\n`);

  const results: CaseResult[] = [];
  for (const c of cases) {
    console.log(`=== ${c.id} (${c.character}${c.pov ? ", POV" : ""}) ===`);
    if (c.originalFailure) console.log(`  original failure: ${c.originalFailure}`);
    const caseResult: CaseResult = { id: c.id, originalFailure: c.originalFailure, samples: [] };
    for (let s = 1; s <= opts.samples; s++) {
      let sr: SampleResult;
      try {
        sr = await runSample(mode, c, model, think, s);
      } catch (e) {
        sr = { sample: s, verdict: null, revisionOk: null, raw: `call failed: ${(e as Error).message}` };
      }
      caseResult.samples.push(sr);
      console.log(`  sample ${s}: ${describeSample(sr)}`);
      // Whether the revision was any GOOD turns on whether the reason behind it was right, and no
      // gate decides that -- so the reason is printed to be read, not scored.
      if (sr.note) console.log(`    note: ${sr.note}`);
    }
    results.push(caseResult);
    console.log();
  }

  const flat = results.flatMap(r => r.samples);
  const retried = flat.filter(s => s.verdict === "retry");
  const revisionOk = retried.filter(s => s.revisionOk);
  console.log("--- summary ---");
  console.log(`mode: ${opts.split ? "split (verdict call + repair call)" : "single call"}`);
  console.log(`samples: ${flat.length}`);
  console.log(`recognized the issue (verdict=retry): ${retried.length}/${flat.length}`);
  // A model that never retries has no revisions to score -- the old `|| 1` printed that as "0/1",
  // which reads as one retry that failed rather than none attempted.
  console.log(retried.length
    ? `revision survived reviseConsult: ${revisionOk.length}/${retried.length} of retries, `
      + `${revisionOk.length}/${flat.length} of all samples`
    : `revision survived reviseConsult: no retries were issued, so none were scored `
      + `(0/${flat.length} of all samples)`);

  if (opts.out) {
    writeFileSync(opts.out, JSON.stringify(
      { model, split: opts.split, samplesPerCase: opts.samples, results }, null, 2));
    console.log(`\nraw results written to ${opts.out}`);
  }
}

function describeSample(sr: SampleResult): string {
  if (sr.verdict === "retry") {
    return sr.revisionOk
      ? `retry -> OK: "${sr.revised!.situation.slice(0, 70)}${sr.revised!.situation.length > 70 ? "..." : ""}"`
      : `retry -> REFUSED: ${sr.revisionWhy!.split(". ")[0]}`;
  }
  if (sr.verdict === "accept") return "accept (did not flag the issue at all)";
  return `unparseable/failed: ${sr.raw}`;
}

main().catch(e => { console.error(e); process.exit(1); });
