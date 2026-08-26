/** The live session state the loop and the server share. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadStory } from "../engine/story-format.ts";
import { StoryJson } from "../engine/story-schema.ts";
import { consult, type ConsultEvent, type ConsultRequest } from "../engine/consult.ts";
import { wrapWriter, writerCast, runChapter, writeScene, newCharacterAgent, type RunEvent } from "../engine/scene-loop.ts";
import { Agent, setFitWarning } from "../engine/agent.ts";
import { complete, NET } from "../engine/llm-client.ts";
import { ENGINE } from "../engine/engine-state.ts";
import { WARN } from "../engine/warnings.ts";
import { LIVE, runState, resetLive, RUN, stopRun, armRun, StoppedError } from "../live.ts";
import { handleRunControl } from "../server/run-control-routes.ts";
import type { ServerHost } from "../server/server.ts";
import { quiet, ScriptedAgent, callRoute } from "./helpers.ts";

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
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));

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
    // Stopping the run before calling writeScene means the writer never generates,
    // so retries never happen. This test validates the plumbing: the parameter
    // reaches writeScene without error, and no retries are recorded.
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
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
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ prose: "word ".repeat(25).trim(), scene_done: false }) } }],
    }))) as any;

    armRun();
    try {
      const r = await writeScene(
        sd, 1, sc.characters, new Map(),
        sc.premise, sc.writerStyle, sc.models.writer, sc.models.summary,
        { writer: "low", summary: sc.thinking.summary },
        30, sc.maxProseWords, sc.retries, sc.clarifications,
        sc.dir, log,
      );

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

// -- THE NARRATION LINT -------------------------------------------------------
describe("the narration lint", () => {
  const sc0 = () => quiet(() => loadStory("tests/fixtures/doorway"));

  /** Routes a mocked completion by which system prompt asked for it — the writer's own `[WRITE]`
   *  loop and the lint's stateless check share one fetch mock, so call order alone can't tell them
   *  apart once a redraft happens. Each branch advances its own counter independently. */
  function scriptedFetch(opts: {
    writerReplies: Record<string, unknown>[];
    lintReplies?: Record<string, unknown>[];
    lintFails?: boolean;
  }) {
    let writerCall = 0, lintCall = 0;
    const fetchMock = (async (_url: string, init: any) => {
      const body = JSON.parse(String(init.body));
      const sys = String(body.messages?.[0]?.content ?? "");
      if (sys.includes("CHECKING ONE PIECE YOU JUST WROTE")) {
        if (opts.lintFails) { lintCall++; throw new Error("simulated lint outage"); }
        const content = JSON.stringify(opts.lintReplies![lintCall++]);
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
      }
      const content = JSON.stringify(opts.writerReplies[writerCall++]);
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
    }) as any;
    return { fetchMock, calls: () => ({ writerCall, lintCall }) };
  }

  it("redrafts once when the writer invents a line for someone not consulted, and keeps the redraft", async () => {
    const sc = await sc0();
    const events: RunEvent[] = [];
    const log = (e: RunEvent) => events.push(e);

    const flaggedProse = `Riven reaches for the door. "No," Merritt says, without looking up.`;
    const cleanProse = `Riven reaches for the door and waits, listening for Merritt's crate to creak.`;
    const { fetchMock, calls } = scriptedFetch({
      writerReplies: [
        { prose: flaggedProse, scene_done: false },
        { prose: cleanProse, scene_done: true },
      ],
      lintReplies: [
        { ok: false, why: "MERRITT was given a line — THE ONE RULE — nobody asked them." },
        { ok: true },
      ],
    });

    const origFetch = globalThis.fetch;
    const origStream = ENGINE.stream;
    ENGINE.stream = false;
    globalThis.fetch = fetchMock;

    armRun();
    try {
      const r = await writeScene(
        sc.scenes[0], 1, sc.characters, new Map(),
        sc.premise, sc.writerStyle, sc.models.writer, sc.models.summary,
        { writer: "low", summary: sc.thinking.summary },
        10, sc.maxProseWords, sc.retries, sc.clarifications,
        sc.dir, log,
      );

      assert.equal(r.done, true);
      assert.deepEqual(r.prose, [cleanProse], "the redraft is what's on the page, not the flagged draft");

      const flags = events.filter(e => e.t === "narration_flag") as any[];
      assert.equal(flags.length, 1, "flagged once, then passed clean");
      assert.equal(flags[0].retried, false);
      assert.match(flags[0].why, /MERRITT/);

      const drafts = events.filter(e => e.t === "draft") as any[];
      assert.equal(drafts.length, 1, "the flagged draft never got its own draft event");
      assert.equal(drafts[0].prose, cleanProse);

      assert.deepEqual(calls(), { writerCall: 2, lintCall: 2 });
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

    const firstProse = `Riven reaches for the door. "No," Merritt says, without looking up.`;
    const redraftProse = `Riven reaches for the door. Merritt already knows, and says so.`;
    const { fetchMock, calls } = scriptedFetch({
      writerReplies: [
        { prose: firstProse, scene_done: false },
        { prose: redraftProse, scene_done: true },
      ],
      lintReplies: [
        { ok: false, why: "MERRITT was given a line nobody asked for." },
        { ok: false, why: "MERRITT was given a line nobody asked for, again." },
      ],
    });

    const origFetch = globalThis.fetch;
    const origStream = ENGINE.stream;
    ENGINE.stream = false;
    globalThis.fetch = fetchMock;

    armRun();
    try {
      const r = await writeScene(
        sc.scenes[0], 1, sc.characters, new Map(),
        sc.premise, sc.writerStyle, sc.models.writer, sc.models.summary,
        { writer: "low", summary: sc.thinking.summary },
        10, sc.maxProseWords, sc.retries, sc.clarifications,
        sc.dir, log,
      );

      assert.equal(r.done, true, "a scene that keeps failing the lint still finishes, never blocked");
      assert.deepEqual(r.prose, [redraftProse], "the still-flagged redraft is accepted, not discarded");

      const flags = events.filter(e => e.t === "narration_flag") as any[];
      assert.equal(flags.length, 2);
      assert.equal(flags[0].retried, false);
      assert.equal(flags[1].retried, true, "the second flag is reported as the spent retry");

      const drafts = events.filter(e => e.t === "draft") as any[];
      assert.equal(drafts.length, 1);
      assert.equal(drafts[0].prose, redraftProse);

      assert.deepEqual(calls(), { writerCall: 2, lintCall: 2 }, "one redraft only, however the lint calls it");
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
      const r = await writeScene(
        sc.scenes[0], 1, sc.characters, new Map(),
        sc.premise, sc.writerStyle, sc.models.writer, sc.models.summary,
        { writer: "low", summary: sc.thinking.summary },
        10, sc.maxProseWords, sc.retries, sc.clarifications,
        sc.dir, log,
      );

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
      const r = await writeScene(
        sc.scenes[0], 1, sc.characters, new Map(),
        sc.premise, sc.writerStyle, sc.models.writer, sc.models.summary,
        { writer: "low", summary: sc.thinking.summary },
        10, sc.maxProseWords, sc.retries, sc.clarifications,
        sc.dir, e => events.push(e),
      );
      return { r, events, calls: calls(), prose, redraft };
    } finally {
      globalThis.fetch = origFetch;
      ENGINE.stream = origStream;
      armRun();
      resetLive();
    }
  }

  // A reply that carries no verdict is not a pass. `{}` and `{"ok":"maybe"}` used to clear a piece
  // silently, which is a check performed without ever being made.
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
        question: "Do you open the door, or refuse?",
        wants: "decision",
      },
      scene_done: true,
    };

    const fetchMock = (async (_url: string, init: any) => {
      const body = JSON.parse(String(init.body));
      const sys = String(body.messages?.[0]?.content ?? "");
      if (sys.includes("CHECKING ONE ANSWER")) throw new Error("simulated judge outage");
      if (sys.includes("CHECKING ONE PIECE YOU JUST WROTE"))
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ok: true }) } }] }));
      if (sys.includes("YOU ARE THE AUTHOR. You are writing one scene"))
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(draft) } }] }));
      // MERRITT's own agent, asked for a decision
      const content = JSON.stringify({ speech: "I open it." });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
    }) as any;

    const origFetch = globalThis.fetch;
    const origStream = ENGINE.stream;
    const origRetries = NET.retries;
    ENGINE.stream = false;
    NET.retries = 0;   // don't let the judge's own retry/backoff slow this down
    globalThis.fetch = fetchMock;

    armRun();
    try {
      const r = await writeScene(
        sc.scenes[0], 1, sc.characters, agents,
        sc.premise, sc.writerStyle, sc.models.writer, sc.models.summary,
        { writer: "low", summary: sc.thinking.summary },
        10, sc.maxProseWords, sc.retries, sc.clarifications,
        sc.dir, log,
      );

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
      await agent.generate("t");
      await agent.generate("t");
      await agent.generate("t");

      assert.equal(warned.filter(w => w.includes("is loaded with 4096")).length, 1,
        "the same model is warned about exactly once");
      assert.deepEqual(events.map(e => e.t), ["context_risk"]);
      const risk = events[0] as any;
      assert.equal(risk.model, "tight-model");
      assert.equal(risk.needs, 9000);
      assert.equal(risk.has, 4096);

      // A different model is not covered by the first one's warning.
      const other = new Agent("OTHER", "roomy-model", "sys", 0);
      await other.generate("t");
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
// An accept only puts the answer in the writer's history. The one thing that can put it in the
// chapter is a writing turn after it, and both of these tests are about whether the loop takes one.
describe("an answer still owed the page", () => {
  /** Routes a mocked completion by which system prompt asked for it: the writer's `[WRITE]` loop,
   *  the stateless lint, the stateless judge, and the consulted character each have their own. */
  function consultFetch(opts: {
    writerReplies: Record<string, unknown>[];
    characterReplies: Record<string, unknown>[];
  }) {
    let writerCall = 0, characterCall = 0;
    const fetchMock = (async (_url: string, init: any) => {
      const body = JSON.parse(String(init.body));
      const sys = String(body.messages?.[0]?.content ?? "");
      const reply = (o: unknown) =>
        new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(o) } }] }));
      if (sys.includes("CHECKING ONE PIECE YOU JUST WROTE")) return reply({ ok: true });
      if (sys.includes("CHECKING ONE ANSWER")) return reply({ verdict: "accept" });
      if (sys.includes("YOUR OUTPUT FORMAT")) return reply(opts.characterReplies[characterCall++]);
      return reply(opts.writerReplies[writerCall++]);
    }) as any;
    return { fetchMock, calls: () => ({ writerCall, characterCall }) };
  }

  const ASK = {
    character: "MERRITT",
    situation: "Riven has the package under one arm and a hand flat on the service door.",
    question: "Do you let them through, or do you stand up?",
    wants: "decision",
  };

  async function runIt(opts: {
    writerReplies: Record<string, unknown>[];
    maxSteps: number;
  }) {
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
    const events: RunEvent[] = [];
    const agents = new Map(sc.characters.map(c =>
      [c.name.toLowerCase(), newCharacterAgent(c, sc.scenes[0].place, "low")] as const));
    const { fetchMock, calls } = consultFetch({
      writerReplies: opts.writerReplies,
      characterReplies: [{ speech: "No.", action: "stands up off the crate" }],
    });

    const origFetch = globalThis.fetch;
    const origStream = ENGINE.stream;
    ENGINE.stream = false;
    globalThis.fetch = fetchMock;

    armRun();
    try {
      const r = await quiet(() => writeScene(
        sc.scenes[0], 1, sc.characters, agents,
        sc.premise, sc.writerStyle, sc.models.writer, sc.models.summary,
        { writer: "low", summary: sc.thinking.summary },
        opts.maxSteps, sc.maxProseWords, sc.retries, sc.clarifications,
        sc.dir, e => events.push(e),
      ));
      return { r, events, calls: calls(), agents };
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
});

// -- A CLARIFICATION ON AN ATTEMPT THAT WAS THROWN AWAY -----------------------
// The rule is that only the accepted answer enters history. A clarification is part of an answer:
// the character asked for a fact and got one, and if that answer is rejected the fact was settled for
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
          question: "Do you let them through, or do you stand up?",
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
    const judgeReplies = [
      { verdict: "retry", revised: { question: "Do you stand up, or stay on the crate?" } },
      { verdict: "accept" },
    ];

    let writerCall = 0, characterCall = 0, clarifierCall = 0, judgeCall = 0;
    const clarifierPrompts: string[][] = [];
    const origFetch = globalThis.fetch;
    const origStream = ENGINE.stream;
    ENGINE.stream = false;
    globalThis.fetch = (async (_url: string, init: any) => {
      const body = JSON.parse(String(init.body));
      const msgs = (body.messages ?? []).map((m: any) => String(m.content ?? ""));
      const sys = msgs[0] ?? "";
      const reply = (o: unknown) =>
        new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(o) } }] }));
      if (sys.includes("CHECKING ONE PIECE YOU JUST WROTE")) return reply({ ok: true });
      if (sys.includes("CHECKING ONE ANSWER")) return reply(judgeReplies[Math.min(judgeCall++, 1)]);
      if (sys.includes("ANSWERING ONE QUESTION")) {
        clarifierPrompts.push(msgs);
        return reply(clarifierReplies[Math.min(clarifierCall++, 1)]);
      }
      if (sys.includes("YOUR OUTPUT FORMAT")) return reply(characterReplies[characterCall++]);
      return reply(writerReplies[Math.min(writerCall++, 1)]);
    }) as any;

    armRun();
    try {
      await quiet(() => writeScene(
        sc.scenes[0], 1, sc.characters, agents,
        sc.premise, sc.writerStyle, sc.models.writer, sc.models.summary,
        { writer: "low", summary: sc.thinking.summary },
        10, sc.maxProseWords, sc.retries, sc.clarifications,
        sc.dir, e => events.push(e),
      ));

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
          situation: "A bin goes over somewhere back down the corridor, out of sight.",
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
    globalThis.fetch = (async (_url: string, init: any) => {
      const body = JSON.parse(String(init.body));
      const msgs = (body.messages ?? []).map((m: any) => String(m.content ?? ""));
      const sys = msgs[0] ?? "";
      const reply = (o: unknown) =>
        new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(o) } }] }));
      if (sys.includes("CHECKING ONE PIECE YOU JUST WROTE")) {
        lintRequests.push(msgs.join("\n"));
        return reply({ ok: true });
      }
      if (sys.includes("WHICH REACTIONS MAY BECOME DEEDS"))
        return reply({ verdicts: [{ name: "MERRITT", promotable: true }] });
      if (sys.includes("YOUR OUTPUT FORMAT"))
        return reply({ thought: "Someone is out there.", action: deed });
      return reply(writerReplies[Math.min(writerCall++, 1)]);
    }) as any;

    armRun();
    try {
      await quiet(() => writeScene(
        sc.scenes[0], 1, sc.characters, agents,
        sc.premise, sc.writerStyle, sc.models.writer, sc.models.summary,
        { writer: "low", summary: sc.thinking.summary },
        10, sc.maxProseWords, sc.retries, sc.clarifications,
        sc.dir, e => events.push(e),
      ));

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
