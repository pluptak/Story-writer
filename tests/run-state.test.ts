/** The live session state the loop and the server share. */
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
      loadedModelIds: async () => ["test-model"],
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
      loadedModelIds: async () => ["test-model"],
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
    voice: [], skills: [], limits,
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
    const withBible = sceneReach(sd, def, testBible);

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
      sceneReach(sd, defWithBibleRestriction, testBible);
    } finally { WARN.sink = prevSink; }

    assert.ok(warningsWithout.some(w => w.includes("telepathy")),
              "must warn about unknown restriction when no bible is given");
    assert.equal(warningsWith.length, 0,
                 "must not warn about a restriction when the bible knows it");
  });
});

// -- RETRY CEILING ----------------------------------------------------------
describe("retry ceiling", () => {
  it("parses maxCharacterRetries from story.json and passes through to writeScene", async () => {
    const raw = {
      title: "ceiling-test",
      premise: "A test.",
      scenes: [{ place: "room", question: "What now?" }],
      characters: [{ name: "RIVEN", persona: "tester" }],
      config: { maxCharacterRetries: 3 },
    };
    const parsed = StoryJson.parse(raw);
    assert.equal(parsed.config.maxCharacterRetries, 3);

    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
    assert.equal(sc.maxCharacterRetries, undefined); // the existing story has no ceiling
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

// -- THE WORLD TIMELINE -------------------------------------------------------
describe("the world timeline in the loop", () => {
  const sc0 = () => quiet(() => loadStory("tests/fixtures/doorway"));

  /** Writer sites share one reply queue; the narration lint and the done judge get fixed clean
   *  verdicts. Same routing shape the narration-lint fixtures use. */
  function scriptedFetch(writerReplies: Record<string, unknown>[]) {
    let writerCall = 0;
    const nextWriter = () => writerReplies[writerCall++];
    const { fetchMock } = siteFetch({
      "judge.narration": { ok: true },
      "judge.done": { ok: true },
      "writer.draft": nextWriter,
      "writer.redraft": nextWriter,
    });
    return fetchMock;
  }

  it("holds the beat before its trigger, fires it at the trigger as already true, and implants its memories into present characters", async () => {
    const sc = await sc0();
    const sd = { ...sc.scenes[0], length: 40, roster: [] };
    const hold = "the fault alarm sounding";
    const firedText = "the fault alarm sounds";
    const rivenMem = "the wing is insured on occupancy, and her name is on the policy";
    const timeline = [{
      chapter: 1, hold, fired: firedText, at: 0.5,
      memories: { RIVEN: rivenMem, NOBODY: "keyed to nobody — never implanted" },
      state: "pending" as const,
    }];
    const events: RunEvent[] = [];
    const log = (e: RunEvent) => events.push(e);
    const agents = new Map(sc.characters.map(c => [c.name.toLowerCase(), newCharacterAgent(c, sd.place, "low" as const)]));

    const origFetch = globalThis.fetch;
    const origStream = ENGINE.stream;
    ENGINE.stream = false;
    globalThis.fetch = scriptedFetch([
      { prose: "word ".repeat(25).trim(), scene_done: false },   // words 0 -> hold
      { prose: "another piece", scene_done: true },              // words 25 >= 20 -> fires
    ]);
    armRun();
    try {
      const r = await writeScene({
        scene: sd, chapter: 1, characters: sc.characters, agents: agents,
        premise: sc.premise, writerStyle: sc.writerStyle,
        writerModel: sc.models.writer, summaryModel: sc.models.summary,
        thinking: { writer: "low", summary: sc.thinking.summary },
        maxSteps: 10, maxProseWords: sc.maxProseWords,
        retries: sc.retries, clarifications: sc.clarifications,
        dir: sc.dir, log, timeline,
      });

      assert.equal(r.done, true);

      const beats = events.filter(e => e.t === "world_beat") as any[];
      assert.equal(beats.length, 1, "fires once");
      assert.equal(beats[0].beat, firedText);
      assert.equal(beats[0].hold, hold, "the event records the held form it stood down");
      assert.equal(beats[0].step, 2);

      const memories = events.filter(e => e.t === "memory_surfaced") as any[];
      assert.deepEqual(memories.map(m => m.character), ["RIVEN"],
        "implanted for the one present character the beat names; NOBODY is skipped quietly");

      const riven = agents.get("riven")!;
      assert.match(riven.system, /WHAT YOU ALSO KNOW, NOW THAT IT BEARS ON THE MOMENT: /);
      assert.ok(riven.system.includes(rivenMem), "the memory rides in system, where trimming cannot summarize it away");
      const markers = riven.history.filter(m => m.content.includes("[YOU REMEMBER]"));
      assert.equal(markers.length, 1, "one trimmable marker of the moment, not a memory in history");

      const instructions = LIVE.writer!.history.filter(m => m.role === "user" && m.content.startsWith("[WRITE]"));
      assert.match(instructions[0].content, /\[HOLD\] the fault alarm sounding -- that has NOT happened/);
      assert.doesNotMatch(instructions[0].content, /\[WORLD\]/);
      assert.match(instructions[1].content, /\[WORLD\] the fault alarm sounds That has happened/);
      assert.doesNotMatch(instructions[1].content, /\[HOLD\]/, "the hold stands down the moment the beat fires");
    } finally {
      globalThis.fetch = origFetch;
      ENGINE.stream = origStream;
      armRun();
      resetLive();
    }
  });

  it("records a beat whose trigger the scene never reached, and says nothing about other chapters", async () => {
    // The scene closes at 3 words against a 40-word target, so a beat set at 0.9 never fires. Only
    // a firing leaves a mark otherwise, so silence would read exactly like a beat that had landed.
    const { events } = await runWith(
      [{ ...beatAt(0.9), fired: "the roof gives way" },
       { chapter: 2, hold: "h2", fired: "a beat for the next chapter", at: 0, memories: {}, state: "pending" as const },
       { chapter: 1, hold: "h3", fired: "a beat nobody wants", at: 0.9, memories: {}, state: "void" as const }],
      [{ prose: "a quiet piece", scene_done: true }]);

    const stranded = events.filter(e => e.t === "beat_stranded") as any[];
    assert.equal(stranded.length, 1, "this chapter's unfired beat only — not chapter 2's, not a void one");
    assert.equal(stranded[0].beat, "the roof gives way");
    assert.equal(stranded[0].at, 0.9);
    assert.ok(!events.some(e => e.t === "world_beat"), "and nothing fired");
  });

  it("records nothing stranded when the beat fired", async () => {
    const { events } = await runWith([beatAt(0)], [{ prose: "a quiet piece", scene_done: true }]);
    assert.ok(events.some(e => e.t === "world_beat"));
    assert.ok(!events.some(e => e.t === "beat_stranded"));
  });

  it("does nothing at all — no hold, no events — for beats aimed at another chapter", async () => {
    const sc = await sc0();
    const sd = { ...sc.scenes[0], length: 40, roster: [] };
    const events: RunEvent[] = [];
    const log = (e: RunEvent) => events.push(e);
    const timeline = [{
      chapter: 2, hold: "held elsewhere", fired: "fired elsewhere", at: 0,
      memories: { RIVEN: "never" }, state: "pending" as const,
    }];

    const origFetch = globalThis.fetch;
    const origStream = ENGINE.stream;
    ENGINE.stream = false;
    globalThis.fetch = scriptedFetch([{ prose: "a quiet piece", scene_done: true }]);
    armRun();
    try {
      await writeScene({
        scene: sd, chapter: 1, characters: sc.characters, agents: new Map(),
        premise: sc.premise, writerStyle: sc.writerStyle,
        writerModel: sc.models.writer, summaryModel: sc.models.summary,
        thinking: { writer: "low", summary: sc.thinking.summary },
        maxSteps: 10, maxProseWords: sc.maxProseWords,
        retries: sc.retries, clarifications: sc.clarifications,
        dir: sc.dir, log, timeline,
      });
      assert.ok(!events.some(e => e.t === "world_beat" || e.t === "memory_surfaced"));
      const instructions = LIVE.writer!.history.filter(m => m.role === "user" && m.content.startsWith("[WRITE]"));
      assert.ok(instructions.every(i => !i.content.includes("[HOLD]") && !i.content.includes("[WORLD]")));
    } finally {
      globalThis.fetch = origFetch;
      ENGINE.stream = origStream;
      armRun();
      resetLive();
    }
  });

  const filler = "word ".repeat(25).trim();
  const beatAt = (at: number) => ({
    chapter: 1, hold: "the fault alarm sounding", fired: "the fault alarm sounds", at,
    memories: {}, state: "pending" as const,
  });
  const runWith = async (
    timeline: { chapter: number; hold: string; fired: string; at: number; memories: Record<string, string>; state: "pending" | "fired" | "void" }[],
    replies: Record<string, unknown>[],
  ) => {
    const sc = await sc0();
    const sd = { ...sc.scenes[0], length: 40, roster: [] };
    const events: RunEvent[] = [];
    const log = (e: RunEvent) => events.push(e);
    const origFetch = globalThis.fetch;
    const origStream = ENGINE.stream;
    ENGINE.stream = false;
    globalThis.fetch = scriptedFetch(replies);
    armRun();
    try {
      const r = await writeScene({
        scene: sd, chapter: 1, characters: sc.characters, agents: new Map(),
        premise: sc.premise, writerStyle: sc.writerStyle,
        writerModel: sc.models.writer, summaryModel: sc.models.summary,
        thinking: { writer: "low", summary: sc.thinking.summary },
        maxSteps: 10, maxProseWords: sc.maxProseWords,
        retries: sc.retries, clarifications: sc.clarifications,
        dir: sc.dir, log, timeline,
      });
      const instructions = LIVE.writer!.history.filter(m => m.role === "user" && m.content.startsWith("[WRITE]"))
        .map(m => m.content as string);
      return { r, events, instructions };
    } finally {
      globalThis.fetch = origFetch;
      ENGINE.stream = origStream;
      armRun();
      resetLive();
    }
  };

});

// -- THE NARRATION LINT -------------------------------------------------------
describe("the narration lint", () => {
  const sc0 = () => quiet(() => loadStory("tests/fixtures/doorway"));

  /** Routes a mocked completion by the call site that asked for it. The writer's own `[WRITE]` loop
   *  and the lint's stateless check share one fetch mock, so call order alone cannot tell them apart
   *  once a redraft happens — the site header can. `writerReplies` is ONE queue across both writer
   *  sites: a redraft consumes the reply after the draft it replaces, which is the shape these
   *  fixtures are written against. */
  function scriptedFetch(opts: {
    writerReplies: Record<string, unknown>[];
    lintReplies?: Record<string, unknown>[];
    lintFails?: boolean;
  }) {
    let writerCall = 0, lintCall = 0;
    const nextWriter = () => opts.writerReplies[writerCall++];
    const { fetchMock } = siteFetch({
      "judge.narration": () => {
        if (opts.lintFails) { lintCall++; throw new Error("simulated lint outage"); }
        return opts.lintReplies![lintCall++];
      },
      "judge.done": { ok: true },
      "writer.draft": nextWriter,
      "writer.redraft": nextWriter,
    });
    return { fetchMock, calls: () => ({ writerCall, lintCall }) };
  }

  it("redrafts once when the writer invents a line for someone not consulted, and keeps the redraft", async () => {
    const sc = await sc0();
    const events: RunEvent[] = [];
    const log = (e: RunEvent) => events.push(e);

    const flaggedProse = `Riven reaches for the door. "Not tonight," Merritt says, without looking up.`;
    const cleanProse = `Riven reaches for the door and waits, listening for Merritt's crate to creak.`;
    const { fetchMock, calls } = scriptedFetch({
      writerReplies: [
        { prose: flaggedProse, scene_done: false },
        { prose: cleanProse, scene_done: true },
      ],
      // An invented line is a quotation against an empty ledger, so the mechanical check catches it.
      // The LLM half runs beside it, not behind it, so both drafts get a reply.
      lintReplies: [{ ok: true }, { ok: true }],
    });

    const origFetch = globalThis.fetch;
    const origStream = ENGINE.stream;
    ENGINE.stream = false;
    globalThis.fetch = fetchMock;

    armRun();
    try {
      const r = await writeScene(sceneRun(sc, { scene: sc.scenes[0], log }));

      assert.equal(r.done, true);
      assert.deepEqual(r.prose, [cleanProse], "the redraft is what's on the page, not the flagged draft");

      const flags = events.filter(e => e.t === "narration_flag") as any[];
      assert.equal(flags.length, 1, "flagged once, then passed clean");
      assert.equal(flags[0].retried, false);
      // Both mechanical findings arrive in the ONE message the single redraft gets. Why this fixture
      // matters: the piece carries an invented line AND shows a character who cannot see "looking
      // up", and under the old short-circuit the second was never reported at all.
      assert.match(flags[0].why, /unmatched quotation: "Not tonight,"/);
      assert.match(flags[0].why, /CANNOT sight/);

      // The quotation finding renders once — through the joined narration_flag why above. There is
      // no separate quotation event: it reached no reader that the flag did not.
      const drafts = events.filter(e => e.t === "draft") as any[];
      assert.equal(drafts.length, 1, "the flagged draft never got its own draft event");
      assert.equal(drafts[0].prose, cleanProse);

      assert.deepEqual(calls(), { writerCall: 2, lintCall: 2 },
        "the LLM half now runs beside the quotation check, not behind it");
    } finally {
      globalThis.fetch = origFetch;
      ENGINE.stream = origStream;
      armRun();
      resetLive();
    }
  });

  it("accepts the piece anyway when the redraft is flagged too — the lint warns, it never blocks", async () => {
    const sc = await sc0();
    const events: RunEvent[] = [];
    const log = (e: RunEvent) => events.push(e);

    const firstProse = `Riven reaches for the door. "Not tonight," Merritt says, without looking up.`;
    const redraftProse = `Riven reaches for the door. Merritt already knows, and says so.`;
    const { fetchMock, calls } = scriptedFetch({
      writerReplies: [
        { prose: firstProse, scene_done: false },
        { prose: redraftProse, scene_done: true },
      ],
      // The first draft's quotation is caught mechanically and the LLM half runs beside it; the
      // redraft has no quotation, and the LLM lint flags it anyway.
      lintReplies: [{ ok: true }, { ok: false, why: "MERRITT was given a line nobody asked for, again." }],
    });

    const origFetch = globalThis.fetch;
    const origStream = ENGINE.stream;
    ENGINE.stream = false;
    globalThis.fetch = fetchMock;

    armRun();
    try {
      const r = await writeScene(sceneRun(sc, { scene: sc.scenes[0], log }));

      assert.equal(r.done, true, "a scene that keeps failing the lint still finishes, never blocked");
      assert.deepEqual(r.prose, [redraftProse], "the still-flagged redraft is accepted, not discarded");

      const flags = events.filter(e => e.t === "narration_flag") as any[];
      assert.equal(flags.length, 2);
      assert.equal(flags[0].retried, false);
      assert.match(flags[0].why, /unmatched quotation/, "the first flag came from the mechanical check");
      assert.equal(flags[1].retried, true, "the second flag is reported as the spent retry");
      assert.match(flags[1].why, /again/, "the second came from the LLM lint");

      const drafts = events.filter(e => e.t === "draft") as any[];
      assert.equal(drafts.length, 1);
      assert.equal(drafts[0].prose, redraftProse);

      assert.deepEqual(calls(), { writerCall: 2, lintCall: 2 },
                       "one redraft only, whichever of the two checks does the flagging — and the LLM "
                       + "half is asked on both pieces, since it no longer sits behind the quotation check");
    } finally {
      globalThis.fetch = origFetch;
      ENGINE.stream = origStream;
      armRun();
      resetLive();
    }
  });

  it("accepts the writer's draft unmodified when the lint call itself fails", async () => {
    const sc = await sc0();
    const events: RunEvent[] = [];
    const log = (e: RunEvent) => events.push(e);

    const prose = `Riven crosses the corridor and tries the door.`;
    const { fetchMock, calls } = scriptedFetch({
      writerReplies: [{ prose, scene_done: true }],
      lintFails: true,
    });

    const origFetch = globalThis.fetch;
    const origStream = ENGINE.stream;
    const origRetries = NET.retries;
    ENGINE.stream = false;
    NET.retries = 0;   // don't let the lint's own retry/backoff slow this down
    globalThis.fetch = fetchMock;

    armRun();
    try {
      const r = await writeScene(sceneRun(sc, { scene: sc.scenes[0], log }));

      assert.equal(r.done, true);
      assert.deepEqual(r.prose, [prose], "the writer's only draft is accepted as-is");
      assert.ok(!events.some(e => e.t === "narration_flag"), "a lint that never answers is never a flag");
      const lintFailed = events.find(e => e.t === "lint_failed") as any;
      assert.ok(lintFailed, "the outage itself is still recorded");
      assert.match(lintFailed.why, /simulated lint outage/);

      const drafts = events.filter(e => e.t === "draft") as any[];
      assert.equal(drafts.length, 1);

      assert.equal(calls().writerCall, 1, "the lint's own failure never costs a redraft");
    } finally {
      globalThis.fetch = origFetch;
      ENGINE.stream = origStream;
      NET.retries = origRetries;
      armRun();
      resetLive();
    }
  });

  /** The lint against a scripted set of replies, returning what the run recorded. */
  async function lintRun(lintReplies: Record<string, unknown>[]) {
    const sc = await sc0();
    const events: RunEvent[] = [];
    const prose = `Riven crosses the corridor and tries the door.`;
    const redraft = `Riven crosses the corridor and puts a hand on the door.`;
    const { fetchMock, calls } = scriptedFetch({
      writerReplies: [{ prose, scene_done: true }, { prose: redraft, scene_done: true }],
      lintReplies,
    });
    const origFetch = globalThis.fetch;
    const origStream = ENGINE.stream;
    ENGINE.stream = false;
    globalThis.fetch = fetchMock;
    armRun();
    try {
      const r = await writeScene(sceneRun(sc, { scene: sc.scenes[0], log: e => events.push(e) }));
      return { r, events, calls: calls(), prose, redraft };
    } finally {
      globalThis.fetch = origFetch;
      ENGINE.stream = origStream;
      armRun();
      resetLive();
    }
  }

  // A reply with no verdict is not a pass. `{}` and `{"ok":"maybe"}` used to clear a piece
  // silently — a check reported without ever being made.
  it("asks again when the lint replies in a shape that carries no verdict", async () => {
    const { r, events, calls, redraft } = await lintRun(
      [{}, { ok: false, why: "MERRITT was given a line." }, { ok: true }]);

    assert.equal(calls.lintCall, 3, "the non-verdict was asked again rather than read as a pass, "
      + "and the redraft was checked in its turn");
    const mismatch = events.find(e => e.t === "schema_mismatch") as any;
    assert.ok(mismatch, "and the shape it came back in is on the record");
    assert.equal(mismatch.call, "lint");
    assert.ok(events.some(e => e.t === "narration_flag"), "the verdict on the second ask is the verdict");
    assert.equal(calls.writerCall, 2, "which sent the writer back for its one redraft");
    assert.deepEqual(r.prose, [redraft], "the redraft is what reached the page");
  });

  it("accepts the piece when two asks running carry no verdict, and says which happened", async () => {
    const { r, events, calls, prose } = await lintRun([{}, { ok: "maybe" }]);

    assert.equal(calls.lintCall, 2, "asked twice, then it is done asking");
    assert.equal(calls.writerCall, 1, "no redraft — there was never a flag to redraft against");
    assert.deepEqual(r.prose, [prose], "the piece goes to the page, exactly as on an outage");
    assert.ok(!events.some(e => e.t === "narration_flag"), "an unanswered lint is not a flag");
    assert.ok(!events.some(e => e.t === "lint_failed"), "and it is not an outage either");
    assert.equal(events.filter(e => e.t === "schema_mismatch").length, 1,
      "one record of the shape problem is what distinguishes it from a clean pass");
  });
});

// -- THE REPEAT GUARD ---------------------------------------------------------
// A piece that opens by re-emitting the page's tail is stripped back to its new text before the
// append (engine/repeat-lint.ts) — the doorway run appended a verbatim repeat of its opening
// paragraph and then one new sentence, so the scene opened with the paragraph twice.
describe("the repeat guard", () => {
  const P = "The fault alarm kept ringing over the empty wing while the cold worked through every "
          + "seam. Hale stood with the ledger under his arm and did not move.";

  async function runRepeat(opts: { writerReplies: Record<string, unknown>[] }) {
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
    const events: RunEvent[] = [];
    let writerCall = 0;
    const nextWriter = () => opts.writerReplies[writerCall++];
    const { fetchMock } = siteFetch({
      "judge.narration": { ok: true },
      "judge.done": { ok: true },
      "writer.draft": nextWriter,
      "writer.redraft": nextWriter,
    });

    const origFetch = globalThis.fetch;
    const origStream = ENGINE.stream;
    ENGINE.stream = false;
    globalThis.fetch = fetchMock;

    armRun();
    try {
      const r = await quiet(() => writeScene({
        scene: sc.scenes[0], chapter: 1, characters: sc.characters, agents: new Map(),
        premise: sc.premise, writerStyle: sc.writerStyle,
        writerModel: sc.models.writer, summaryModel: sc.models.summary,
        thinking: { writer: "low", summary: sc.thinking.summary },
        maxSteps: 10, maxProseWords: sc.maxProseWords,
        retries: sc.retries, clarifications: sc.clarifications,
        dir: sc.dir, log: (e: RunEvent) => events.push(e),
      }));
      // LIVE.writer is captured before the finally's resetLive() clears it.
      return { r, events, writer: LIVE.writer };
    } finally {
      globalThis.fetch = origFetch;
      ENGINE.stream = origStream;
      armRun();
      resetLive();
    }
  }

  it("strips a piece that re-emits the tail verbatim and appends only the new sentence", async () => {
    const { r, events, writer } = await runRepeat({
      writerReplies: [
        { prose: P, scene_done: false },
        { prose: P + " Then the corridor lights died.", scene_done: true },
      ],
    });

    assert.deepEqual(r.prose, [P, "Then the corridor lights died."],
      "the paragraph is on the page once, and the new sentence after it");
    const strips = events.filter(e => e.t === "repeat_strip") as any[];
    assert.equal(strips.length, 1);
    assert.equal(strips[0].whole, false, "the piece had a new sentence, and it survived");
    assert.ok(strips[0].chars > 0 && strips[0].words > 0);
    // The writer's own history records what was accepted, not what was attempted — its next draft
    // reads a page that carries the paragraph once.
    const heard = (writer?.history ?? []).map(m => String(m.content)).join("\n");
    assert.ok(!heard.includes("did not move. Then the corridor lights died."),
      "the unstripped repeat never entered the writer's history");
    assert.match(heard, /"prose":"Then the corridor lights died\."/);
  });

  it("counts a wholly-repeated piece as a turn that wrote nothing", async () => {
    const { r, events } = await runRepeat({
      writerReplies: [
        { prose: P, scene_done: false },
        { prose: P, scene_done: false },   // wholly repeated: nothing new
        { prose: "Then the corridor lights died.", scene_done: true },
      ],
    });

    const strips = events.filter(e => e.t === "repeat_strip") as any[];
    assert.equal(strips.length, 1);
    assert.equal(strips[0].whole, true, "the entire piece was already on the page");
    assert.deepEqual(r.prose, [P, "Then the corridor lights died."],
      "the repeated draft never reached the page");
    const drafts = events.filter(e => e.t === "draft") as any[];
    assert.equal(drafts.filter(d => d.prose).length, 2,
      "two pieces of prose were written, not three");
    assert.equal(r.done, true);
  });

  it("leaves an ordinary continuation untouched", async () => {
    const second = "The corridor lights died all the same, and Hale counted the seconds.";
    const { r, events } = await runRepeat({
      writerReplies: [
        { prose: P, scene_done: false },
        { prose: second, scene_done: true },
      ],
    });

    assert.deepEqual(r.prose, [P, second]);
    assert.ok(!events.some(e => e.t === "repeat_strip"), "no strip event on a clean continuation");
  });
});

// -- THE JUDGE ----------------------------------------------------------
describe("the judge", () => {
  it("accepts the answer unjudged and logs judge_failed when the judge call itself fails", async () => {
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
    const events: RunEvent[] = [];
    const log = (e: RunEvent) => events.push(e);

    const agents = new Map(sc.characters.map(def =>
      [def.name.toLowerCase(), newCharacterAgent(def, sc.scenes[0].place, sc.thinking.character)]));

    const draft = {
      prose: "Riven turns to Merritt at the door.",
      consult: {
        character: "MERRITT",
        situation: "Riven turns to face them, asking plainly what they mean to do about the door.",
        question: "Do you open the door?",
        wants: "decision",
      },
      scene_done: true,
    };

    const { fetchMock } = siteFetch({
      "judge.answer": () => { throw new Error("simulated judge outage"); },
      "judge.narration": { ok: true },
      "judge.done": { ok: true },
      "writer.draft": draft,
      // MERRITT's own agent, asked for a decision
      "character.consult": { speech: "I open it." },
    });

    const origFetch = globalThis.fetch;
    const origStream = ENGINE.stream;
    const origRetries = NET.retries;
    ENGINE.stream = false;
    NET.retries = 0;   // don't let the judge's own retry/backoff slow this down
    globalThis.fetch = fetchMock;

    armRun();
    try {
      const r = await writeScene(sceneRun(sc, { scene: sc.scenes[0], agents, log }));

      assert.equal(r.done, true);

      const failed = events.find(e => e.t === "judge_failed") as any;
      assert.ok(failed, "judge_failed was logged");
      assert.equal(failed.character, "MERRITT");
      assert.match(failed.why, /simulated judge outage/);

      const judged = events.find(e => e.t === "judge") as any;
      assert.equal(judged.verdict, "accept", "a failed judge call still defaults to accept");

      const accepted = events.find(e => e.t === "accept") as any;
      assert.ok(accepted, "MERRITT's answer reached the page despite the judge outage");
      assert.equal(accepted.speech, "I open it.");
    } finally {
      globalThis.fetch = origFetch;
      ENGINE.stream = origStream;
      NET.retries = origRetries;
      armRun();
      resetLive();
    }
  });
});

// -- THE CONTEXT-FIT WARNING -----------------------------------------------
describe("the context-fit warning", () => {
  it("fires once per model before the call, warns, and logs context_risk", async () => {
    const origFetch = globalThis.fetch;
    const origStream = ENGINE.stream;
    const origLog = LIVE.log;
    const origSink = WARN.sink;
    ENGINE.fitWarned = new Set();

    setFitWarning(async model => ({ message: `${model} is loaded with 4096 tokens and this call needs about 9000`,
                                    needs: 9000, has: 4096 }));
    ENGINE.stream = false;
    globalThis.fetch = async () => new Response(
      JSON.stringify({ choices: [{ message: { content: "hello" } }] })) as any;
    const warned: string[] = [];
    WARN.sink = (...a: unknown[]) => { warned.push(a.map(String).join(" ")); };
    const events: RunEvent[] = [];
    LIVE.log = e => events.push(e);

    armRun();
    try {
      const agent = new Agent("TESTER", "tight-model", "sys", 0);
      await agent.generate("t", "test.probe");
      await agent.generate("t", "test.probe");
      await agent.generate("t", "test.probe");

      assert.equal(warned.filter(w => w.includes("is loaded with 4096")).length, 1,
        "the same model is warned about exactly once");
      assert.deepEqual(events.map(e => e.t), ["context_risk"]);
      const risk = events[0] as any;
      assert.equal(risk.model, "tight-model");
      assert.equal(risk.needs, 9000);
      assert.equal(risk.has, 4096);

      // A different model is not covered by the first one's warning.
      const other = new Agent("OTHER", "roomy-model", "sys", 0);
      await other.generate("t", "test.probe");
      assert.deepEqual(events.map(e => e.t), ["context_risk", "context_risk"]);
    } finally {
      setFitWarning(null);
      globalThis.fetch = origFetch;
      ENGINE.stream = origStream;
      LIVE.log = origLog;
      WARN.sink = origSink;
      armRun();
    }
  });
});

// -- AN ANSWER STILL OWED THE PAGE -------------------------------------------
// An accept only puts the answer in the writer's history. Only a writing turn after it can put it
// in the chapter, and both tests here are about whether the loop takes one.
describe("an answer still owed the page", () => {
  /** Routes a mocked completion by which system prompt asked for it: the writer's `[WRITE]` loop,
   *  the stateless lint, the stateless judge, and the consulted character each get their own. */
  function consultFetch(opts: {
    writerReplies: Record<string, unknown>[];
    characterReplies: Record<string, unknown>[];
    lintPayloads?: string[];
    doneReplies?: Record<string, unknown>[];
  }) {
    let writerCall = 0, characterCall = 0, doneCall = 0;
    const nextWriter = () => opts.writerReplies[writerCall++];
    const { fetchMock } = siteFetch({
      "judge.narration": ({ body }) => {
        opts.lintPayloads?.push(String(body.messages?.find((m: any) => m.role === "user")?.content ?? ""));
        return { ok: true };
      },
      "judge.answer": { verdict: "accept" },
      // Promotes nothing, which is what these fixtures got before: under prompt-substring routing
      // the batch judge matched no branch and fell through to the writer's, so it was handed a prose
      // draft (and quietly ate a writerReplies entry) until it failed to parse one. Same outcome —
      // no deeds promoted — now said outright.
      "judge.batch": { verdicts: [] },
      "judge.done": () => {
        const d = opts.doneReplies;
        return d ? d[Math.min(doneCall++, d.length - 1)] : (doneCall++, { ok: true });
      },
      "character.consult": () => opts.characterReplies[characterCall++],
      "writer.draft": nextWriter,
      "writer.redraft": nextWriter,
    });
    return { fetchMock, calls: () => ({ writerCall, characterCall, doneCall }) };
  }

  const ASK = {
    character: "MERRITT",
    situation: "Riven has the package under one arm and a hand flat on the service door.",
    question: "Do you let them through?",
    wants: "decision",
  };

  async function runIt(opts: {
    writerReplies: Record<string, unknown>[];
    maxSteps: number;
    characterReplies?: Record<string, unknown>[];
    lintPayloads?: string[];
    doneReplies?: Record<string, unknown>[];
  }) {
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
    const events: RunEvent[] = [];
    const agents = new Map(sc.characters.map(c =>
      [c.name.toLowerCase(), newCharacterAgent(c, sc.scenes[0].place, "low")] as const));
    const { fetchMock, calls } = consultFetch({
      writerReplies: opts.writerReplies,
      characterReplies: opts.characterReplies ?? [{ speech: "No.", action: "stands up off the crate" }],
      lintPayloads: opts.lintPayloads,
      doneReplies: opts.doneReplies,
    });

    const origFetch = globalThis.fetch;
    const origStream = ENGINE.stream;
    ENGINE.stream = false;
    globalThis.fetch = fetchMock;

    armRun();
    try {
      const r = await quiet(() => writeScene(sceneRun(sc, {
        scene: sc.scenes[0], agents, maxSteps: opts.maxSteps, log: e => events.push(e),
      })));
      // LIVE.writer is captured before the finally's resetLive() clears it.
      return { r, events, calls: calls(), agents, sc, writer: LIVE.writer };
    } finally {
      globalThis.fetch = origFetch;
      ENGINE.stream = origStream;
      armRun();
      resetLive();
    }
  }

  it("holds the scene open for a real writing turn when done is declared with a consult open", async () => {
    const first = "Riven's palm finds the door and stays there.";
    const second = `Merritt stands up off the crate. "No," they say.`;
    const { r, events, calls } = await runIt({
      maxSteps: 10,
      writerReplies: [
        { prose: first, consult: ASK, scene_done: true },
        { prose: second, scene_done: true },
      ],
    });

    assert.equal(calls.characterCall, 1, "MERRITT was asked");
    assert.ok(events.some(e => e.t === "accept"), "and the answer was accepted");
    assert.ok(events.some(e => e.t === "done_deferred"), "the scene was held open");
    assert.equal(calls.writerCall, 2, "the held-open turn actually happened");
    assert.deepEqual(r.prose, [first, second], "the answer reached the page");
    assert.ok(!events.some(e => e.t === "answer_unwritten"), "nothing was left owed");
    assert.equal(r.done, true, "and the scene closed after that one extra turn");
  });

  it("records an ending that left the question unanswered, and lets it stand anyway", async () => {
    // The verdict is a measurement, not a gate. It held the scene open once: told the question was
    // unanswered, the writer wrote more of the same deadlock and never declared done again, which
    // cost the scene its ending. A refusal names a lever the writer does not hold.
    const only = "Riven's palm finds the door and stays there.";
    const { r, events, calls, writer } = await runIt({
      maxSteps: 10,
      writerReplies: [{ prose: only, scene_done: true }],
      doneReplies: [{ ok: false, why: "neither of them has moved off the door" }],
    });

    const flagged = events.find(e => e.t === "done_flagged") as any;
    assert.ok(flagged, "the run record carries the verdict");
    assert.equal(flagged.why, "neither of them has moved off the door");
    assert.equal(calls.writerCall, 1, "the writer was not given another turn");
    assert.equal(r.done, true, "and the ending stood");
    assert.ok(!writer!.history.some(m => String(m.content).includes("NOT DONE")),
      "the writer was never told, because there is nothing it could do about it");
  });

  it("says nothing when the page did answer its question", async () => {
    const { events, calls } = await runIt({
      maxSteps: 10,
      writerReplies: [{ prose: "Merritt steps back and lets the door swing wide.", scene_done: true }],
      doneReplies: [{ ok: true }],
    });

    assert.equal(calls.doneCall, 1, "the ending was put to the judge");
    assert.ok(!events.some(e => e.t === "done_flagged"));
  });

  it("records nothing when the judge answers in no shape at all", async () => {
    const { r, events, calls } = await runIt({
      maxSteps: 10,
      writerReplies: [{ prose: "Riven's palm finds the door.", scene_done: true }],
      doneReplies: [{ musing: "hard to say" }],
    });

    assert.equal(calls.doneCall, 2, "asked once more for a verdict");
    assert.ok(events.some(e => e.t === "schema_mismatch" && (e as any).call === "done"),
      "and the record says no verdict was ever given");
    assert.ok(!events.some(e => e.t === "done_flagged"), "a check nobody made is not a verdict");
    assert.equal(r.done, true);
  });

  it("says so when the scene ends anyway with the answer never written in", async () => {
    // One step of budget and interactive off: the held-open turn is asked for and cannot be taken.
    const { r, events, calls } = await runIt({
      maxSteps: 1,
      writerReplies: [{ prose: "Riven's palm finds the door.", consult: ASK, scene_done: true }],
    });

    assert.equal(calls.writerCall, 1, "the budget ran out before the writer could write it in");
    assert.ok(events.some(e => e.t === "done_deferred"));
    const unwritten = events.find(e => e.t === "answer_unwritten") as any;
    assert.ok(unwritten, "the run record says the answer never landed");
    assert.deepEqual(unwritten.characters, ["MERRITT"]);
    assert.equal(unwritten.stopped, false);
    assert.equal(r.prose.length, 1, "and the chapter is the one beat written before the answer");
  });

  it("clears the debt on the next beat, so an ordinary consult never reports one", async () => {
    const { events } = await runIt({
      maxSteps: 10,
      writerReplies: [
        { prose: "Riven's palm finds the door.", consult: ASK, scene_done: false },
        { prose: `Merritt stands. "No."`, scene_done: true },
      ],
    });

    assert.ok(events.some(e => e.t === "accept"));
    assert.ok(!events.some(e => e.t === "done_deferred"), "done was never declared early");
    assert.ok(!events.some(e => e.t === "answer_unwritten"), "the next beat paid the debt");
  });

  it("echoes the accepted answer to the console by default (the suppression test's control)", async () => {
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try {
      await runIt({
        maxSteps: 10,
        writerReplies: [
          { prose: "Riven's palm finds the door.", consult: ASK, scene_done: false },
          { prose: `Merritt stands. "No."`, scene_done: true },
        ],
      });
    } finally { console.log = origLog; }
    assert.ok(lines.some(l => l.includes("→")), "the character's answer prints");
    assert.ok(lines.some(l => l.includes("Riven's palm finds the door")), "so does the prose");
  });

  it("with echoCast off, the characters' answers leave the console while the prose stays", async () => {
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    let out: Awaited<ReturnType<typeof runIt>>;
    try {
      ENGINE.echoCast = false;
      out = await runIt({
        maxSteps: 10,
        writerReplies: [
          { prose: "Riven's palm finds the door.", consult: ASK, scene_done: false },
          { prose: `Merritt stands. "No."`, scene_done: true },
        ],
      });
    } finally {
      console.log = origLog;
      ENGINE.echoCast = true;
    }
    assert.ok(out.events.some(e => e.t === "accept"), "the consult was still accepted");
    assert.ok(lines.some(l => l.includes("Riven's palm finds the door")), "the prose echo stays");
    assert.ok(!lines.some(l => l.includes("→")), "no consult answer line");
    assert.ok(!lines.some(l => l.includes("acts:")), "no promoted-action line");
    assert.ok(!lines.some(l => l.includes("reacts:")), "no reaction line");
  });

  it("refuses an exit carried on a reply that wrote nothing", async () => {
    const { r, events, calls } = await runIt({
      maxSteps: 10,
      writerReplies: [
        { prose: "", exit: "MERRITT", scene_done: false },
        { prose: "Merritt is still on the crate.", scene_done: true },
      ],
    });

    const refused = events.find(e => e.t === "exit_refused") as any;
    assert.ok(refused, "the prose-less exit was refused");
    assert.equal(refused.character, "MERRITT");
    assert.ok(!events.some(e => e.t === "exit"), "nobody actually left the cast");
    assert.equal(calls.writerCall, 2, "the writer was sent back to write");
    assert.equal(r.done, true);
  });

  it("a POV exit on a prose-less reply does not end the chapter", async () => {
    const { r, events } = await runIt({
      maxSteps: 10,
      writerReplies: [
        { prose: "", exit: "RIVEN", scene_done: false },   // RIVEN is scenes[0].pov in the fixture
        { prose: "Riven never left the corridor.", scene_done: true },
      ],
    });

    assert.ok(events.some(e => e.t === "exit_refused"), "the exit was refused");
    assert.ok(!events.some(e => e.t === "exit"), "no exit — not even the POV's — took effect");
    assert.equal(r.done, true, "the chapter closed on the explicit done, not a refused POV exit");
    assert.equal(r.prose.length, 1);
  });

  it("refuses a scene_done with nothing written — once", async () => {
    const { r, calls } = await runIt({
      maxSteps: 10,
      writerReplies: [
        { prose: "", scene_done: true },
        { prose: "", scene_done: true },   // insisted: honored
      ],
    });

    assert.equal(calls.writerCall, 2, "the first blank done did not close the scene");
    assert.deepEqual(r.prose, [], "nothing was ever written");
    assert.equal(r.done, true, "the second blank done was honored — the save step is the backstop");
  });

  it("closes a held-open turn that comes back blank, rather than holding it a second time", async () => {
    // The deferral promises exactly one more turn, whatever it makes. A blank reply on that turn
    // must not be read as a fresh blank scene_done and held again.
    const { r, events, calls } = await runIt({
      maxSteps: 10,
      writerReplies: [
        { prose: "", consult: ASK, scene_done: true },   // asks and declares done in one breath
        { prose: "", scene_done: true },                 // the held-open turn writes nothing
      ],
    });

    assert.ok(events.some(e => e.t === "done_deferred"), "the turn was held open once");
    assert.equal(calls.writerCall, 2, "and closed after it — not held a second time");
    assert.equal(r.done, true);
    const unwritten = events.find(e => e.t === "answer_unwritten") as any;
    assert.ok(unwritten, "the answer never reached the page, and the record says so");
    assert.deepEqual(unwritten.characters, ["MERRITT"]);
  });

  it("holds the scene open past the hard cap when an answer is still owed", async () => {
    // A beat well past twice the 700-word target arms the hard cap for the NEXT turn; that turn
    // opens a consult instead of declaring done, and the answer must still get its writing turn.
    const longBeat = "The lamp buzzed above the service door while the cold worked through every seam. ".repeat(110);
    const final = `Merritt stands up off the crate. "No," they say.`;
    const { r, events, calls } = await runIt({
      maxSteps: 10,
      writerReplies: [
        { prose: longBeat, consult: ASK, scene_done: false },
        { prose: "", consult: ASK, scene_done: false },   // at length, asks again anyway
        { prose: final, scene_done: false },
      ],
    });

    assert.ok(events.some(e => e.t === "accept"), "the second consult was answered");
    assert.ok(events.some(e => e.t === "done_deferred"), "the hard-cap close was deferred");
    assert.equal(calls.writerCall, 3, "the held-open writing turn actually happened");
    assert.equal(r.prose[r.prose.length - 1], final, "the answer reached the page");
    assert.ok(!events.some(e => e.t === "answer_unwritten"), "nothing left owed");
    assert.equal(r.done, true, "and the scene closed after that one extra turn");
  });

  // -- REACTION FAN-OUTS --------------------------------------------------------
  const CRASH = {
    reactors: [{ name: "MERRITT" }],
    situation: "The service door explodes inward off its hinges, sending wood and dust across the floor towards you.",
    question: "What does that land on you as?",
  };

  it("consults a duplicated reactor exactly once", async () => {
    const { events, calls } = await runIt({
      maxSteps: 10,
      writerReplies: [
        { prose: "The crash echoes down the corridor.", consult: { ...CRASH,
            reactors: [{ name: "MERRITT" }, { name: "merritt" }] }, scene_done: false },
        { prose: "Merritt's head turns toward the sound.", scene_done: true },
      ],
    });

    assert.equal(calls.characterCall, 1, "one name, one isolated consult — however it was spelled");
    const fanouts = events.filter((e: RunEvent) => e.t === "reaction_fanout") as any[];
    assert.equal(fanouts.length, 1);
    assert.deepEqual(fanouts[0].reactors, ["MERRITT"]);
  });

  it("carries a reactor's speech to the writer's bundle and the ledger", async () => {
    const { events, writer } = await runIt({
      maxSteps: 10,
      writerReplies: [
        { prose: "The crash echoes down the corridor.", consult: CRASH, scene_done: false },
        { prose: `Merritt's head turns. "Who's there?" they say into the dark.`, scene_done: true },
      ],
    });

    const reaction = events.find(e => e.t === "reaction") as any;
    assert.ok(reaction, "the reaction was collected");
    assert.equal(reaction.speech, "No.", "what the character actually said is on the record");
    assert.match((writer?.history ?? []).map(m => String(m.content)).join("\n"), /says: "No\."/,
      "the writer was handed the exact line to render");
  });

  it("says so plainly when every reactor answered from an inside the scene is not written from",
    async () => {
      // MERRITT is not the POV, so a thought with nothing said and nothing done leaves the bundle
      // empty. Silence would read as an unanswered fan-out and get the same beat asked again.
      // Asked twice: the first thought-only reply buys one repair asking them to let it surface,
      // and this reactor does not take it. The second reply is what the bundle gets.
      const { events, writer } = await runIt({
        maxSteps: 10,
        characterReplies: [
          { thought: "Wood. That is the service door, not the gate." },
          { thought: "Wood. That is the service door, not the gate." },
        ],
        writerReplies: [
          { prose: "The crash echoes down the corridor.", consult: CRASH, scene_done: false },
          { prose: "Dust keeps coming down in the dark.", scene_done: true },
        ],
      });

      const heard = (writer?.history ?? []).map(m => String(m.content)).join("\n");
      assert.ok(events.some(e => e.t === "reaction"), "the reaction was collected for the record");
      assert.ok(!heard.includes("THE OTHERS REACT"), "no bundle was handed over");
      assert.ok(!heard.includes("That is the service door"), "and the thought stayed with them");
      assert.match(heard, /\[NOTHING TO WRITE\] MERRITT/, "the writer was told, not left guessing");
    });

  it("names the repetition when the writer re-sends an ask the gate already refused", async () => {
    // Seen five times in one scene: the refusal says what is wrong, the writer sends the identical
    // string back, and each round costs a step. The second one is told it is a repeat.
    const thin = { ...CRASH, situation: "Something falls over." };
    const { events, writer } = await runIt({
      maxSteps: 10,
      writerReplies: [
        { prose: "The crash echoes down the corridor.", consult: thin, scene_done: false },
        { prose: "Dust drifts in the dark.", consult: thin, scene_done: false },
        { prose: "Nothing moves.", scene_done: true },
      ],
    });

    assert.equal(events.filter(e => e.t === "bad_consult").length, 2, "both were refused");
    const heard = (writer?.history ?? []).map(m => String(m.content)).join("\n");
    assert.match(heard, /\[CONSULT NOT SENT\]/, "the first refusal is the ordinary one");
    assert.match(heard, /AND YOU HAVE SENT IT BEFORE/, "the second names the repetition");
    assert.match(heard, /refused once already/);
  });

  it("counts a fan-out whose every reactor was skipped as an empty turn", async () => {
    const ghost = { prose: "", consult: { ...CRASH, reactors: [{ name: "GHOST" }] }, scene_done: false };
    const { r, events } = await runIt({
      maxSteps: 10,
      writerReplies: [ghost, ghost, ghost],
    });

    assert.equal(events.filter(e => e.t === "fanout_skip").length, 3, "nobody was reachable");
    assert.ok(!events.some(e => e.t === "reaction"), "no reaction ever came back");
    assert.equal(r.done, false, "three empty turns stop the scene instead of pretending it moved");
    assert.deepEqual(r.prose, []);
  });

  it("the POV character's thought-only answer lands as felt evidence, never as a bare name",
    async () => {
      // The live failure this pins: reaction-shaped single consults answered from the inside used
      // to push empty granted entries — bare names the lint could not read as authorization.
      // RIVEN is the scene's POV, so rendering what it lands on them as is the writer's job.
      const POV_REACT = {
        character: "RIVEN",
        situation: "The lock has given way under your hands and the door stands open on the dark.",
        question: "What does the give of it land on you as, this early?",
        wants: "reaction",
      };
      const lintPayloads: string[] = [];
      const { events } = await runIt({
        maxSteps: 10,
        lintPayloads,
        characterReplies: [{ thought: "Too easy. That is the part I do not like." }],
        writerReplies: [
          { prose: "Riven crouches by the door.", consult: POV_REACT, scene_done: false },
          { prose: "The dark past the doorway does not move.", scene_done: true },
        ],
      });

      assert.ok(events.some(e => e.t === "accept"), "the thought-only answer was accepted");
      const withLedger = lintPayloads.find(p => p.includes("ALREADY GRANTED") && !p.includes("(nobody yet)"));
      assert.ok(withLedger, "the lint saw a populated ledger");
      assert.match(withLedger!, /RIVEN -- felt: Too easy/,
        "the interiority the writer was handed is on the record as authorization");
      assert.ok(!/^RIVEN\s*$/m.test(withLedger!), "no bare-name entries");
    });

  it("gives a non-POV reaction one chance to surface, and takes it when it does", async () => {
    // The hole this closes: "reaction" (not a deliberate act, not spoken words) is right for the
    // POV character and unanswerable for anyone else, so the ask was spent for nothing. Now a
    // thought-only reply buys a repair, and a reaction that reaches the outside is an answer.
    const REACT = { ...ASK, wants: "reaction" };
    const { events, writer, calls } = await runIt({
      maxSteps: 10,
      characterReplies: [
        { thought: "The lock has been sticking for a month; who is this?" },
        { thought: "Who is this?", action: "goes still on the crate, head turned to the door" },
      ],
      writerReplies: [
        { prose: "Riven crouches by the door.", consult: REACT, scene_done: false },
        { prose: "On the crate, Merritt goes still.", scene_done: true },
      ],
    });

    assert.equal(calls.characterCall, 2, "asked once more rather than discarded");
    const accept = events.find(e => e.t === "accept") as any;
    assert.ok(accept, "the surfaced reaction was accepted");
    assert.match(accept.action, /goes still on the crate/);
    const heard = (writer?.history ?? []).map(m => String(m.content)).join("\n");
    assert.match(heard, /goes still on the crate/, "the writer got the outward half");
    assert.ok(!heard.includes("Who is this?"), "and still none of the inward half");
  });

  it("a non-POV character's thought-only answer never reaches the writer at all", async () => {
    // MERRITT is not the POV. What the moment lands on them as is theirs; handing it to the writer
    // would only authorize narrating an inner life nobody gave it. With nothing said and nothing
    // done, the answer arrives as nothing — no answer, not an accepted empty one.
    const REACT = { ...ASK, wants: "reaction" };
    const lintPayloads: string[] = [];
    const thoughtOnly = { thought: "The lock has been sticking for a month; who is this?" };
    const { events, writer, calls } = await runIt({
      maxSteps: 10,
      lintPayloads,
      // Asked once more to let it surface, and it does not — so the answer is the one that stands.
      characterReplies: [thoughtOnly, thoughtOnly],
      writerReplies: [
        { prose: "Riven crouches by the door.", consult: REACT, scene_done: false },
        { prose: "Merritt's head tilts toward the sound.", scene_done: true },
      ],
    });

    assert.equal(calls.characterCall, 2, "the repair asked them to let it reach the outside");
    assert.ok(!events.some(e => e.t === "accept"), "nothing was accepted");
    const heard = (writer?.history ?? []).map(m => String(m.content)).join("\n");
    assert.ok(!heard.includes("The lock has been sticking"), "the thought never reached the writer");
    assert.match(heard, /\[NO ANSWER\] MERRITT/, "the writer was told nobody answered");
    // The run record still carries it: the withholding is about the writer's desk, not the reader's view.
    const answered = events.find(e => e.t === "answer") as any;
    assert.match(answered?.thought ?? "", /sticking for a month/);
    assert.ok(!lintPayloads.some(p => /MERRITT -- felt:/.test(p)), "and it granted nothing");
  });
});

// -- A CLARIFICATION ON AN ATTEMPT THAT WAS THROWN AWAY -----------------------
// The rule: only the accepted answer enters history. A clarification is part of an answer — the
// character asked for a fact and got one — so if that answer is rejected, the fact was settled for
// an instance that no longer exists. The retry never heard it, so neither may the writer.
describe("a clarification on a rejected attempt", () => {
  it("reaches neither the writer nor the clarifier, while the accepted attempt's does", async () => {
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
    const events: RunEvent[] = [];
    const agents = new Map(sc.characters.map(c =>
      [c.name.toLowerCase(), newCharacterAgent(c, sc.scenes[0].place, "low")] as const));

    const writerReplies: Record<string, unknown>[] = [
      { prose: "Riven's palm finds the door.",
        consult: {
          character: "MERRITT",
          situation: "Riven has the package under one arm and a hand flat on the service door.",
          question: "Do you let them through?",
          wants: "decision",
        },
        scene_done: false },
      { prose: `Merritt stands. "No."`, scene_done: true },
    ];
    // Attempt one asks about the bolt and is rejected; the fork asks about the lamp and is taken.
    const characterReplies: Record<string, unknown>[] = [
      { need: "Is the door bolted from the inside?" },
      { speech: "It's bolted anyway.", action: "sits back down" },
      { need: "How far off is the lamp?" },
      { speech: "No.", action: "stands up off the crate" },
    ];
    const clarifierReplies = [{ answer: "Bolted, top and bottom." }, { answer: "Ten feet, behind them." }];
    // A revision must move the situation to be sendable at all: the character is shown the
    // situation and not the question, so a re-ask from the same one is the identical message.
    const judgeReplies = [
      { verdict: "retry", revised: {
          situation: "The door has stopped rattling and someone is breathing on the other side of it.",
          question: "Do you stand up to let them pass?", wants: "decision" } },
      { verdict: "accept" },
    ];

    let writerCall = 0, characterCall = 0, clarifierCall = 0, judgeCall = 0;
    const clarifierPrompts: string[][] = [];
    const origFetch = globalThis.fetch;
    const origStream = ENGINE.stream;
    ENGINE.stream = false;
    const nextWriter = () => writerReplies[Math.min(writerCall++, 1)];
    globalThis.fetch = siteFetch({
      "judge.narration": { ok: true },
      "judge.answer": () => judgeReplies[Math.min(judgeCall++, 1)],
      "judge.done": { ok: true },
      "clarifier.answer": ({ messages }) => {
        clarifierPrompts.push(messages);
        return clarifierReplies[Math.min(clarifierCall++, 1)];
      },
      "character.consult": () => characterReplies[characterCall++],
      "writer.ask": nextWriter,
      "writer.draft": nextWriter,
      "writer.redraft": nextWriter,
    }).fetchMock;

    armRun();
    try {
      await quiet(() => writeScene(sceneRun(sc, {
        scene: sc.scenes[0], agents, log: e => events.push(e),
      })));

      assert.equal(clarifierCall, 2, "both attempts asked the author for a fact");
      assert.ok(events.some(e => e.t === "retry"), "the first answer was rejected");
      assert.ok(events.some(e => e.t === "accept"), "the second was taken");

      const writerHistory = (LIVE.writer?.history ?? []).map(m => m.content).join("\n");
      assert.ok(writerHistory.includes("Ten feet"),
        "the accepted attempt's clarification is canon for the writer");
      assert.ok(!writerHistory.includes("Bolted, top and bottom"),
        "the rejected attempt's invented fact never reached the writer");
      assert.ok(!writerHistory.includes("Is the door bolted from the inside?"),
        "nor the question that drew it");

      // The clarifier is rewound with the attempt: its second call carries no trace of the first.
      const second = clarifierPrompts[1].join("\n");
      assert.ok(second.includes("How far off is the lamp?"), "the second call is the lamp question");
      assert.ok(!second.includes("Bolted, top and bottom"),
        "the clarifier is not holding itself to a fact it settled for a discarded character");
    } finally {
      globalThis.fetch = origFetch;
      ENGINE.stream = origStream;
      armRun();
      resetLive();
    }
  });
});

// -- WHAT THE LINT IS SHOWN AS EVIDENCE --------------------------------------
describe("a deed promoted in the same reply that renders it", () => {
  it("is in evidence when the lint checks that piece, not one beat later", async () => {
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
    const events: RunEvent[] = [];
    const agents = new Map(sc.characters.map(c =>
      [c.name.toLowerCase(), newCharacterAgent(c, sc.scenes[0].place, "low")] as const));

    const deed = "gets up off the crate";
    const writerReplies: Record<string, unknown>[] = [
      { prose: "Something goes over in the dark by the bins.",
        consult: {
          reactors: [{ name: "MERRITT" }],
          situation: "A bin goes over somewhere back down the corridor behind you, well out of sight.",
          question: "What does that land on you as?",
        },
        scene_done: false },
      // The writer takes the volunteered deed and writes it in the same breath.
      { prose: `Merritt ${deed}, slow about it.`, promote: "MERRITT", scene_done: true },
    ];

    let writerCall = 0;
    const lintRequests: string[] = [];
    const origFetch = globalThis.fetch;
    const origStream = ENGINE.stream;
    ENGINE.stream = false;
    const nextWriter = () => writerReplies[Math.min(writerCall++, 1)];
    globalThis.fetch = siteFetch({
      "judge.narration": ({ messages }) => {
        lintRequests.push(messages.join("\n"));
        return { ok: true };
      },
      "judge.done": { ok: true },
      "judge.batch": { verdicts: [{ name: "MERRITT", promotable: true }] },
      "character.consult": { thought: "Someone is out there.", action: deed },
      "writer.ask": nextWriter,
      "writer.draft": nextWriter,
      "writer.redraft": nextWriter,
    }).fetchMock;

    armRun();
    try {
      await quiet(() => writeScene(sceneRun(sc, {
        scene: sc.scenes[0], agents, log: e => events.push(e),
      })));

      const promoted = events.find(e => e.t === "promote") as any;
      assert.ok(promoted, "the deed was promoted");
      assert.equal(promoted.action, deed);

      assert.equal(lintRequests.length, 2, "both pieces were linted");
      // The prose itself contains the deed, so the granted line is what has to be matched.
      assert.ok(lintRequests[1].includes(`MERRITT -- did: ${deed}`),
        "the lint saw the promoted deed as granted while checking the piece that renders it");
      assert.ok(!events.some(e => e.t === "narration_flag"), "so there was nothing to flag");
    } finally {
      globalThis.fetch = origFetch;
      ENGINE.stream = origStream;
      armRun();
      resetLive();
    }
  });
});
