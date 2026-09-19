/**
 * SITUATION-COVERAGE MEASUREMENT — does a re-consult's situation already carry what
 * happened since the character was last asked?
 *
 * Replays `tests/fixtures/recorded-run` (fixed model replies, so the emitted situations are
 * deterministic) with event capture, maps the run events onto `engine/lint/situation-coverage.ts`,
 * and prints the coverage report. No inference server needed — the fixture carries every reply.
 *
 * Usage:
 *   npx tsx scripts/measure-situation-coverage.ts
 *
 * The pre-registered decision rule (docs/PLANS.md, Open design questions): if ≥ 70% of stale,
 * answered re-consults are covered, pursue Block B′ enforcement (`consult.since`); below that,
 * the channel is shown inadequate and Block C′ (batched digest) is justified.
 */
import { readFileSync } from "node:fs";

import { loadStory } from "../engine/story-format.ts";
import { runChapter, type RunEvent } from "../engine/scene-loop.ts";
import { scoreCoverage, type CoverageEvent } from "../engine/lint/situation-coverage.ts";
import { ENGINE } from "../engine/engine-state.ts";
import { armRun, resetLive } from "../live.ts";
import { quiet, replayFetch } from "../tests/helpers.ts";

const FIXTURE = "tests/fixtures/recorded-run";

function toCoverage(e: RunEvent): CoverageEvent | null {
  switch (e.t) {
    case "consult": return { t: "consult", character: e.character, situation: e.situation, attempt: e.attempt };
    case "accept": return { t: "accept", character: e.character, speech: e.speech, action: e.action };
    case "draft": return { t: "draft", prose: e.prose };
    case "world_beat": return { t: "world_beat", beat: e.beat };
    default: return null;   // fan-out reactions, judge verdicts, lint flags: not this channel
  }
}

const SOURCE = JSON.parse(readFileSync(`${FIXTURE}/source.json`, "utf8")) as { effectiveSteps: number };

const origFetch = globalThis.fetch;
const origStream = ENGINE.stream;
const origEcho = ENGINE.echoConsole;
try {
  ENGINE.stream = false;
  ENGINE.echoConsole = false;
  const sc = await quiet(() => loadStory(FIXTURE));
  sc.maxSteps = SOURCE.effectiveSteps;
  const replay = replayFetch(FIXTURE, { "summary.digest": { text: "" } });
  globalThis.fetch = replay.fetchMock;
  armRun();
  const events: RunEvent[] = [];
  await quiet(() => runChapter(sc, 1, e => { events.push(e); }));

  const coverage = events.map(toCoverage).filter((e): e is CoverageEvent => e !== null);
  const verdicts = scoreCoverage(coverage);
  const stale = verdicts.filter(v => v.piecesSince >= 1);
  const denom = stale.filter(v => v.answeredSince);
  const covered = denom.filter(v => v.covered);

  console.log(`re-consults scored: ${verdicts.length} (${stale.length} stale, ${denom.length} stale + answered)`);
  console.log(`covered: ${covered.length}/${denom.length}` +
    (denom.length ? ` = ${Math.round(100 * covered.length / denom.length)}% (rule: ≥70% → B′, below → C′)` : ""));
  for (const v of stale) {
    const flag = !v.answeredSince ? "excluded (unanswered)" : v.covered ? "covered" : "MISS";
    console.log(`- ${v.character} +${v.piecesSince}pc loose=${v.looseScore.toFixed(2)} ${flag}`);
    console.log(`    situation: ${v.situation.slice(0, 220)}`);
    for (const it of v.items.filter(x => !x.covered)) {
      console.log(`    uncovered ${it.kind}${it.character ? ` (${it.character})` : ""} [${it.score.toFixed(2)}]: ${it.text.slice(0, 120)}`);
    }
  }
} finally {
  globalThis.fetch = origFetch;
  ENGINE.stream = origStream;
  ENGINE.echoConsole = origEcho;
  resetLive();
  armRun();
}
