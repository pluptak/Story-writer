/** Run control state, chapter validation, and scene lifecycle. */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { loadStory, type CharacterDef } from "../engine/story-format.ts";
import { StoryJson, SceneDef } from "../engine/story-schema.ts";
import { consult, type ConsultEvent, type ConsultRequest } from "../engine/consult.ts";
import { runChapter, writeScene, newCharacterAgent, sceneReach, type RunEvent } from "../engine/scene-loop.ts";
import { Agent, setFitWarning } from "../engine/agent.ts";
import { complete, NET } from "../engine/llm-client.ts";
import { ENGINE } from "../engine/engine-state.ts";
import { WARN } from "../engine/warnings.ts";
import { LIVE, runState, resetLive, storyWriteBlocked, RUN, stopRun, armRun, StoppedError } from "../live.ts";
import { handleRunControl } from "../server/run-control-routes.ts";
import type { ServerHost } from "../server/server.ts";
import { quiet, callRoute, siteFetch, sceneRun } from "./helpers.ts";

// Consult test helpers for stopRun
const REQ: ConsultRequest = { character: "TESTER", situation: "s", question: "q", wants: "" };

// -- STOPPING A RUN --------------------------------------------------------
describe("stopRun", () => {
  it("is idempotent, and armRun makes the next run stoppable again", () => {
    armRun();
    assert.equal(RUN.stopped, false);
    assert.equal(stopRun(), true, "the first stop is the one that takes effect");
    assert.equal(stopRun(), false, "a second click must not be a second stop");
    assert.equal(RUN.abort.signal.aborted, true, "the call in flight is cut, not just the loop");
    armRun();
    assert.equal(RUN.stopped, false);
    assert.equal(RUN.abort.signal.aborted, false, "an AbortController is single-use — a stale one would refuse the next run");
    assert.equal(stopRun(), true);
    armRun();
  });

  it("refuses to start a model call at all, rather than starting one and retrying it", async () => {
    stopRun();
    await assert.rejects(() => complete("none", [{ role: "user", content: "x" }], 0),
                         (e: Error) => e instanceof StoppedError);
    armRun();
  });

  it("propagates out of a consult instead of being repaired or flagged", async () => {
    class Stopping extends Agent {
      constructor() { super("TESTER", "none", "system", 0); }
      async generate(): Promise<string> { throw new StoppedError(); }
    }
    const events: ConsultEvent[] = [];
    await assert.rejects(
      () => consult(new Stopping(), REQ, { clarifications: 2, clarify: async () => "", log: e => events.push(e) }),
      (e: Error) => e instanceof StoppedError);
    assert.deepEqual(events.map(e => e.t), ["consult"], "nothing is recorded as having been answered");
  });
});

describe("LIVE.interactive", () => {
  it("defaults on and rides runState()", () => {
    assert.equal(LIVE.interactive, true);
    assert.equal(runState().interactive, true);
    LIVE.interactive = false;
    assert.equal(runState().interactive, false);
    LIVE.interactive = true;
  });

  it("resetLive() leaves it untouched — a second story keeps what you set it to", () => {
    LIVE.interactive = false;
    resetLive();
    assert.equal(LIVE.interactive, false, "a session preference, not a fact about one run");
    LIVE.interactive = true;
    resetLive();
    assert.equal(LIVE.interactive, true);
  });
});

// -- THE STORY-MUTATION GUARD -----------------------------------------------
describe("storyWriteBlocked", () => {
  afterEach(() => resetLive());

  it("runs first, then the loading window, then nothing", () => {
    assert.equal(storyWriteBlocked(), null);
    LIVE.loading = true;
    assert.equal(storyWriteBlocked(), "a story is loading");
    LIVE.running = true;
    assert.equal(storyWriteBlocked(), "a run is in flight", "a live run outranks the loading window");
    LIVE.loading = false;
    assert.equal(storyWriteBlocked(), "a run is in flight");
  });

  it("rides runState() as `loading`, so SSE clients see the window too", () => {
    resetLive();
    assert.equal(runState().loading, false);
    LIVE.loading = true;
    assert.equal(runState().loading, true);
    assert.equal(runState().picking, false);
  });

  it("resetLive() clears the loading window with the rest of the run's state", () => {
    LIVE.running = false;
    LIVE.loading = true;
    resetLive();
    assert.equal(LIVE.loading, false);
    assert.equal(storyWriteBlocked(), null);
  });
});

// -- CHAPTER VALIDATION ----
describe("runChapter validation", () => {
  it("rejects a chapter number below 1, naming the valid range", async () => {
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
    await assert.rejects(() => runChapter(sc, 0, () => {}),
                         (e: Error) => {
                           assert.match(e.message, /1\.\.1/);
                           return true;
                         });
  });

  it("rejects a chapter number above the scene count", async () => {
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
    await assert.rejects(() => runChapter(sc, 2, () => {}),
                         (e: Error) => {
                           assert.match(e.message, /1\.\.1/);
                           return true;
                         });
  });

  it("rejects a non-integer chapter number", async () => {
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
    await assert.rejects(() => runChapter(sc, 1.5, () => {}),
                         (e: Error) => {
                           assert.match(e.message, /integer/);
                           return true;
                         });
  });
});

describe("per-scene writer overrides", () => {
  it("wins over story-wide writer settings without making an LLM call", async () => {
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
    const sd = { ...sc.scenes[0], writerModel: "scene-model", writerThink: "high" as const };

    armRun();
    stopRun();
    try {
      await writeScene(sceneRun(sc, { scene: sd, writerModel: "story-model", maxSteps: 1 }));

      assert.equal(LIVE.writer?.model, "scene-model");
      assert.equal(LIVE.writer?.think, "high");
    } finally {
      armRun();
      resetLive();
    }
  });

  it("falls back to story-wide writer settings when overrides are absent", async () => {
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));

    armRun();
    stopRun();
    try {
      await writeScene(sceneRun(sc, {
        scene: sc.scenes[0], writerModel: "story-model", maxSteps: 1,
        thinking: { writer: "medium", summary: sc.thinking.summary },
      }));

      assert.equal(LIVE.writer?.model, "story-model");
      assert.equal(LIVE.writer?.think, "medium");
    } finally {
      armRun();
      resetLive();
    }
  });
});

// -- PAUSE/RESUME HANDSHAKE (loop↔route promise coordination) ---------------
describe("pause/resume handshake", () => {
  /** A waiter that is never released would hang the whole suite; fail it instead. Clearing the
   *  timer matters: an uncleared one keeps the loop alive its full second after the test. */
  function releasedWithin<T>(p: Promise<T>, ifNot: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const guard = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(ifNot)), 1000);
    });
    return Promise.race([p, guard]).finally(() => clearTimeout(timer));
  }

  it("/resume resolves the paused waiter and clears state", async () => {
    resetLive();
    LIVE.running = true;
    LIVE.paused = true;
    armRun();

    let pauseResolvedFlag = false;
    const pauseWaiter = new Promise<void>(res => {
      LIVE.pauseResolve = res;
    }).then(() => { pauseResolvedFlag = true; });

    // Call /resume — should call pauseResolve() to wake the loop
    const host = {
      availableModelIds: async () => ["test-model"],
    } as unknown as ServerHost;
    const r = await callRoute(handleRunControl, "/resume", {}, host);
    assert.equal(r.code, 200);

    await releasedWithin(pauseWaiter, "Pause waiter did not resolve within 1s");

    assert.equal(pauseResolvedFlag, true, "paused waiter must have resolved");
    assert.equal(LIVE.paused, false, "/resume clears paused");
    assert.equal(LIVE.pausing, false, "/resume clears pausing");
    assert.equal(LIVE.pauseResolve, null, "/resume clears pauseResolve");
    resetLive(); LIVE.running = false;
  });

  it("/stop releases a paused waiter to prevent deadlock", async () => {
    resetLive();
    LIVE.running = true;
    LIVE.paused = true;
    armRun();

    let pauseResolvedFlag = false;
    const pauseWaiter = new Promise<void>(res => {
      LIVE.pauseResolve = res;
    }).then(() => { pauseResolvedFlag = true; });

    // Call /stop — must release the paused loop or it will hang forever
    const host = {
      availableModelIds: async () => ["test-model"],
    } as unknown as ServerHost;
    const r = await callRoute(handleRunControl, "/stop", {}, host);
    assert.equal(r.code, 200);

    await releasedWithin(pauseWaiter, "Stop did not release paused waiter — deadlock risk");

    assert.equal(pauseResolvedFlag, true, "stop must release paused waiter to prevent deadlock");
    resetLive(); LIVE.running = false;
  });

  it("resetLive clears all pause state", () => {
    LIVE.pausing = true;
    LIVE.paused = true;
    LIVE.pauseResolve = () => {};
    resetLive();
    assert.equal(LIVE.pausing, false);
    assert.equal(LIVE.paused, false);
    assert.equal(LIVE.pauseResolve, null);
  });
});

// -- SCENE REACH --------------------------------------------------------------
describe("sceneReach", () => {
  const reachDef = (limits: string[]): CharacterDef => ({
    name: "MERRITT", model: "", persona: "", knows: "", goal: "", belief: "", impulse: "",
    voice: [], origin: "", skills: [], limits,
  });
  const grant = ["cameras :: reading the fire panel's fault codes"];

  it("resolves a grant keyed with the character's exact name", () => {
    const sd = SceneDef.parse({ reach: { MERRITT: grant } });
    assert.deepEqual(sceneReach(sd, reachDef([])).map(s => s.name), ["cameras"]);
  });

  it("resolves a mis-cased grant key — reach behaves like roster and pov", () => {
    const sd = SceneDef.parse({ reach: { merritt: grant } });
    assert.deepEqual(sceneReach(sd, reachDef([])).map(s => s.name), ["cameras"]);
  });

  it("returns no grant when the key matches nobody", () => {
    const sd = SceneDef.parse({ reach: { NOBODY: grant } });
    assert.deepEqual(sceneReach(sd, reachDef([])), []);
  });

  it("keeps a grant beside a restriction naming a different capability (I2)", () => {
    // sight is not cameras: the blind character's scene-scoped grant survives the restriction.
    const sd = SceneDef.parse({ reach: { merritt: grant } });
    assert.deepEqual(sceneReach(sd, reachDef(["sight"])).map(s => s.name), ["cameras"]);
  });

  it("says nothing about a loaded character's own skills — it is called twice per chapter", async () => {
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
    const sd = SceneDef.parse({ reach: { MERRITT: grant } });
    const said: string[] = [];
    const prev = WARN.sink;
    WARN.sink = (m: string) => { said.push(m); };
    try {
      for (const def of sc.characters) sceneReach(sd, def);
    } finally { WARN.sink = prev; }
    assert.deepEqual(said, [], "resolved skills are not a story redeclaring anything");
  });

  it("returns the same reach grant names with and without a bible", () => {
    const sd = SceneDef.parse({ reach: { MERRITT: grant } });
    const def = reachDef([]);
    const testBible = (name: string) => name.toLowerCase() === "cameras" ? "a camera" : undefined;

    const withoutBible = sceneReach(sd, def);
    const withBible = sceneReach(sd, def, { bible: testBible });

    assert.deepEqual(
      withoutBible.map(s => s.name),
      withBible.map(s => s.name),
      "reach grant names must not change based on the bible"
    );
  });

  it("includes warnings about a restriction naming an unknown skill, but not with a bible", async () => {
    const sd = SceneDef.parse({ reach: {} });
    const defWithBibleRestriction = reachDef(["telepathy"]);

    // Without a bible, the restriction on an unknown skill should warn
    const warningsWithout: string[] = [];
    const prevSink = WARN.sink;
    WARN.sink = (m: string) => { warningsWithout.push(m); };
    try {
      sceneReach(sd, defWithBibleRestriction);
    } finally { WARN.sink = prevSink; }

    const testBible = (name: string) => name.toLowerCase() === "telepathy" ? "read minds" : undefined;

    // With a bible that knows it, there should be no warnings
    const warningsWith: string[] = [];
    WARN.sink = (m: string) => { warningsWith.push(m); };
    try {
      sceneReach(sd, defWithBibleRestriction, { bible: testBible });
    } finally { WARN.sink = prevSink; }

    assert.ok(warningsWithout.some(w => w.includes("telepathy")),
              "must warn about unknown restriction when no bible is given");
    assert.equal(warningsWith.length, 0,
                 "must not warn about a restriction when the bible knows it");
  });
});

// -- RETRY CEILING ----------------------------------------------------------
describe("retry ceiling", () => {
  it("parses maxCharacterRetries from story.json config", () => {
    const raw = {
      title: "ceiling-test",
      premise: "A test.",
      scenes: [{ place: "room", question: "What now?" }],
      characters: [{ name: "RIVEN", persona: "tester" }],
      config: { maxCharacterRetries: 3 },
    };
    const parsed = StoryJson.parse(raw);
    assert.equal(parsed.config.maxCharacterRetries, 3);
  });

  it("parses per-character maxRetries from story.json", () => {
    const raw = {
      title: "per-char-test",
      premise: "A test.",
      scenes: [{ place: "room", question: "What now?" }],
      characters: [{ name: "RIVEN", persona: "tester", maxRetries: 1 }],
    };
    const parsed = StoryJson.parse(raw);
    assert.equal(parsed.characters[0].maxRetries, 1);
  });

  it("retryCounts is scoped to one writeScene call and retries survive a stopped run", async () => {
    // Stopping the run before calling writeScene means the writer never generates, so no retries
    // happen. This checks the plumbing: the parameter reaches writeScene without error, and no
    // retries are recorded.
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
    const events: RunEvent[] = [];
    const log = (e: RunEvent) => events.push(e);

    armRun();
    stopRun();
    try {
      await writeScene(sceneRun(sc, {
        scene: sc.scenes[0], maxSteps: 1, log, maxCharacterRetries: 5,
      }));
      const se = events.find(e => e.t === "scene_end") as any;
      assert.ok(se, "scene_end was logged");
      assert.deepEqual(se.retries, {}, "no retries happened because the run was stopped");
    } finally {
      armRun();
      resetLive();
    }
  });
});

// -- LENGTH HARD CAP ---------------------------------------------------------
describe("a scene that never ends", () => {
  it("is forced closed at twice its target length, however many times the writer says scene_done: false", async () => {
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
    const sd = { ...sc.scenes[0], length: 40, roster: [] };
    const events: RunEvent[] = [];
    const log = (e: RunEvent) => events.push(e);

    const origFetch = globalThis.fetch;
    const origStream = ENGINE.stream;
    ENGINE.stream = false;   // the non-streaming completion is the simpler shape to script
    // Distinct beats, cycled: the repeat guard strips a piece that re-emits the page's tail, so a
    // writer that sends the identical prose every turn never accumulates words and the hard cap
    // could never fire. Four beats against a two-piece tail window means no piece ever repeats
    // what the page just ended with.
    const beats = [
      "The corridor lights stutter and the cold finds its way through every seam.",
      "Somewhere below, a door slams and the pipes answer with a knock.",
      "Hale counts the seconds between the alarm's pulses and does not like the number.",
      "The ledger under his arm has grown heavy as a paving stone.",
    ];
    let beat = 0;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        prose: beats[beat++ % beats.length], scene_done: false }) } }],
    }))) as any;

    armRun();
    try {
      const r = await writeScene(sceneRun(sc, { scene: sd, maxSteps: 30, log }));

      assert.equal(r.done, true, "the scene closes even though the writer never sent scene_done: true");
      assert.ok(r.words >= 80, "closed at or past twice the 40-word target");
      assert.ok(r.steps < 30, "closed well under the step budget — length, not steps, ended it");
      const forced = events.find(e => e.t === "forced_end") as any;
      assert.ok(forced, "forced_end was logged");
      assert.equal(forced.target, 40);
      assert.ok(!events.some(e => e.t === "budget"), "never hit the step-budget path");
    } finally {
      globalThis.fetch = origFetch;
      ENGINE.stream = origStream;
      armRun();
      resetLive();
    }
  });
});
