/** Narration lint, repeat guard, and world timeline checks. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadStory } from "../engine/story-format.ts";
import { newCharacterAgent, writeScene, type RunEvent } from "../engine/scene-loop.ts";
import { NET } from "../engine/llm-client.ts";
import { ENGINE } from "../engine/engine-state.ts";
import { LIVE, resetLive, RUN, armRun, stopRun } from "../live.ts";
import { quiet, siteFetch, sceneRun } from "./helpers.ts";

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
        premise: sc.premise, writerStyle: sc.writerStyle, writerStyleConstraints: sc.writerStyleConstraints,
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
        premise: sc.premise, writerStyle: sc.writerStyle, writerStyleConstraints: sc.writerStyleConstraints,
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
        premise: sc.premise, writerStyle: sc.writerStyle, writerStyleConstraints: sc.writerStyleConstraints,
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
        premise: sc.premise, writerStyle: sc.writerStyle, writerStyleConstraints: sc.writerStyleConstraints,
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
