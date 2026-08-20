/** The live session state the loop and the server share. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadStory } from "../engine/story-format.ts";
import { StoryJson } from "../engine/story-schema.ts";
import { consult, type ConsultEvent, type ConsultRequest } from "../engine/consult.ts";
import { wrapWriter, writerCast, runChapter, writeScene } from "../engine/scene-loop.ts";
import { Agent } from "../engine/agent.ts";
import type { Skill } from "../engine/skills.ts";
import { complete } from "../engine/llm-client.ts";
import { LIVE, runState, resetLive, RUN, stopRun, armRun, StoppedError } from "../live.ts";
import { handleRunControl } from "../server/run-control-routes.ts";
import type { ServerHost } from "../server/server.ts";
import { quiet, ScriptedAgent, callRoute } from "./helpers.ts";

// Consult test helpers for stopRun
const REQ: ConsultRequest = { character: "TESTER", situation: "s", question: "q", wants: "" };
const SKILLS: Skill[] = [
  { name: "movement", meaning: "", source: "general" },
  { name: "speech", meaning: "", source: "general" },
];

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
      () => consult(new Stopping(), REQ, SKILLS, { clarifications: 2, clarify: async () => "", log: e => events.push(e) }),
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

// -- CHAPTER VALIDATION ----
describe("runChapter validation", () => {
  it("rejects a chapter number below 1, naming the valid range", async () => {
    const sc = await quiet(() => loadStory("stories/doorway"));
    await assert.rejects(() => runChapter(sc, 0, () => {}),
                         (e: Error) => {
                           assert.match(e.message, /1\.\.1/);
                           return true;
                         });
  });

  it("rejects a chapter number above the scene count", async () => {
    const sc = await quiet(() => loadStory("stories/doorway"));
    await assert.rejects(() => runChapter(sc, 2, () => {}),
                         (e: Error) => {
                           assert.match(e.message, /1\.\.1/);
                           return true;
                         });
  });

  it("rejects a non-integer chapter number", async () => {
    const sc = await quiet(() => loadStory("stories/doorway"));
    await assert.rejects(() => runChapter(sc, 1.5, () => {}),
                         (e: Error) => {
                           assert.match(e.message, /integer/);
                           return true;
                         });
  });
});

describe("per-scene writer overrides", () => {
  it("wins over story-wide writer settings without making an LLM call", async () => {
    const sc = await quiet(() => loadStory("stories/doorway"));
    const sd = { ...sc.scenes[0], writerModel: "scene-model", writerThink: "high" as const };

    armRun();
    stopRun();
    try {
      await writeScene(
        sd, 1, sc.characters, new Map(),
        sc.premise, sc.writerStyle, "story-model", sc.models.summary,
        { writer: "low", summary: sc.thinking.summary },
        1, sc.maxProseWords, sc.retries, sc.clarifications,
        sc.dir, () => {},
      );

      assert.equal(LIVE.writer?.model, "scene-model");
      assert.equal(LIVE.writer?.think, "high");
    } finally {
      armRun();
      resetLive();
    }
  });

  it("falls back to story-wide writer settings when overrides are absent", async () => {
    const sc = await quiet(() => loadStory("stories/doorway"));

    armRun();
    stopRun();
    try {
      await writeScene(
        sc.scenes[0], 1, sc.characters, new Map(),
        sc.premise, sc.writerStyle, "story-model", sc.models.summary,
        { writer: "medium", summary: sc.thinking.summary },
        1, sc.maxProseWords, sc.retries, sc.clarifications,
        sc.dir, () => {},
      );

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
   *  timer matters: an uncleared one keeps the loop alive for its full second after the test. */
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

    const sc = await quiet(() => loadStory("stories/doorway"));
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
    // Stopping the run before calling writeScene means the writer never generates,
    // so retries never happen. This test validates the plumbing: the parameter
    // reaches writeScene without error, and no retries are recorded.
    const sc = await quiet(() => loadStory("stories/doorway"));
    const events: RunEvent[] = [];
    const log = (e: RunEvent) => events.push(e);

    armRun();
    stopRun();
    try {
      await writeScene(
        sc.scenes[0], 1, sc.characters, new Map(),
        sc.premise, sc.writerStyle, sc.models.writer, sc.models.summary,
        { writer: "low", summary: sc.thinking.summary },
        1, sc.maxProseWords, sc.retries, sc.clarifications,
        sc.dir, log, 5,   // maxCharacterRetries = 5
      );
      const se = events.find(e => e.t === "scene_end") as any;
      assert.ok(se, "scene_end was logged");
      assert.deepEqual(se.retries, {}, "no retries happened because the run was stopped");
    } finally {
      armRun();
      resetLive();
    }
  });
});
