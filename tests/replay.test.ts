/**
 * Replaying a real recorded chapter.
 *
 * Every other test in this suite feeds the engine replies someone wrote by hand: well-formed JSON,
 * one behaviour per fixture. This one feeds it what a model actually sent across a whole chapter —
 * 122 calls, with retries, redrafts, a repair and a clarification among them — and checks the same
 * prose comes back out. It is the only test that drives `runChapter` end to end.
 *
 * When it fails, it is saying the engine no longer walks a recorded run the way it did. That is
 * sometimes exactly the point of a change; then re-record with `scripts/make-replay-fixture.mjs` and
 * commit the new fixture alongside it, so the diff shows what moved.
 *
 * Two things a recording cannot carry, both supplied here rather than papered over:
 *  - `summary.digest`, because `trimHistory` calls the transport outside any `Agent` and so is
 *    written to no transcript. Its content steers no branch — every reply is fixed either way.
 *  - the step budget, because when a scene outlives `maxSteps` the engine ASKS, and a viewer or a
 *    terminal answers. That grant lives in the writing log; `source.json` carries it as
 *    `effectiveSteps`, and without it the replay stops where the live run was extended.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadStory } from "../engine/story-format.ts";
import { runChapter } from "../engine/scene-loop.ts";
import { ENGINE } from "../engine/engine-state.ts";
import { armRun, resetLive } from "../live.ts";
import { quiet, replayFetch } from "./helpers.ts";

const FIXTURE = "tests/fixtures/recorded-run";
const SOURCE = JSON.parse(readFileSync(`${FIXTURE}/source.json`, "utf8")) as {
  effectiveSteps: number;
  outcome: { steps: number; words: number; done: boolean };
};

/** The recorded run's own conditions: its granted step budget, and a stand-in for the one call no
 *  transcript holds. */
async function replayedChapter() {
  const sc = await quiet(() => loadStory(FIXTURE));
  sc.maxSteps = SOURCE.effectiveSteps;
  const replay = replayFetch(FIXTURE, { "summary.digest": { text: "" } });
  globalThis.fetch = replay.fetchMock;
  armRun();
  const r = await quiet(() => runChapter(sc, 1, () => {}));
  return { r, replay };
}

describe("replaying a recorded chapter", () => {
  const origFetch = globalThis.fetch;
  const origStream = ENGINE.stream;

  before(() => { ENGINE.stream = false; });
  after(() => { globalThis.fetch = origFetch; ENGINE.stream = origStream; resetLive(); armRun(); });

  it("writes the same scene the recording was taken from", async () => {
    const { r, replay } = await replayedChapter();

    assert.equal(r.prose.join("\n\n").trim(), readFileSync(`${FIXTURE}/scene.md`, "utf8").trim(),
      "the replayed chapter is word-for-word the recorded one");
    assert.equal(r.done, SOURCE.outcome.done, "the recorded run finished, so the replay must too");
    assert.equal(r.steps, SOURCE.outcome.steps);
    assert.equal(r.words, SOURCE.outcome.words);
    assert.deepEqual(replay.unused(), {},
      "every recorded call was asked for — leftovers mean the engine stopped taking a path it used to");
  });

  it("consumes each agent's calls in its own order, characters kept apart", async () => {
    const { replay } = await replayedChapter();

    // The pair is the key: both characters answer at `character.consult` and are told apart by name
    // alone. Were that ever to collapse to the site, one of these would eat the other's replies.
    assert.equal(replay.used("MERRITT|character.consult"), 23);
    assert.equal(replay.used("RIVEN|character.consult"), 10);
    // The writer's two sites share one transcript and interleave — 23 drafts against 9 redrafts — so
    // order alone would hand a redraft's reply to a draft. Per-queue keeps them straight.
    assert.equal(replay.used("WRITER|writer.draft"), 23);
    assert.equal(replay.used("WRITER|writer.redraft"), 9);
    assert.equal(replay.total(), 122);
  });
});
