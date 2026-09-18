/** Narration lint, repeat guard, and world timeline checks. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadStory } from "../../engine/story-format.ts";
import { newCharacterAgent, writeScene, type RunEvent } from "../../engine/scene-loop.ts";
import { NET } from "../../engine/llm-client.ts";
import { Agent } from "../../engine/agent.ts";
import { StoppedError } from "../../live.ts";
import { ENGINE } from "../../engine/engine-state.ts";
import { LIVE, resetLive, RUN, armRun, stopRun, type LintDecision, type LintPrompt, type SceneIo } from "../../live.ts";
import { quiet, siteFetch, sceneRun } from "../helpers.ts";

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
      "judge.done": { status: "resolved", evidence: "the page settles it" },
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
      memories: { RIVEN: rivenMem, NOBODY: "keyed to nobody — never implanted", MERRITT: "   " },
      state: "pending" as const, scope: "world" as const,
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
        "implanted for the one present character the beat names; NOBODY is skipped quietly, "
        + "and so is MERRITT's blank (whitespace-only) memory");

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

  it("gates a fired beat's memory on the beat's scope for a remote character", async () => {
    // A "scene"-scoped beat is locally knowable: it must not implant for a character marked
    // "remote" in that scene. A "world" beat (or one with scope omitted, which defaults to
    // today's unconditional-implant behavior) still implants for them.
    for (const scope of [undefined, "world", "scene"] as const) {
      const sc = await sc0();
      const sd = { ...sc.scenes[0], length: 40, roster: [],
        presence: { RIVEN: "remote :: the phone line" } };
      const rivenMem = "the wing is insured on occupancy, and her name is on the policy";
      const timeline: any[] = [{
        chapter: 1, hold: "the fault alarm sounding", fired: "the fault alarm sounds", at: 0.5,
        memories: { RIVEN: rivenMem }, state: "pending" as const,
        ...(scope === undefined ? {} : { scope }),
      }];
      const events: RunEvent[] = [];
      const log = (e: RunEvent) => events.push(e);
      const agents = new Map(sc.characters.map(c => [c.name.toLowerCase(), newCharacterAgent(c, sd.place, "low" as const)]));

      const origFetch = globalThis.fetch;
      const origStream = ENGINE.stream;
      ENGINE.stream = false;
      globalThis.fetch = scriptedFetch([
        { prose: "word ".repeat(25).trim(), scene_done: false },
        { prose: "another piece", scene_done: true },
      ]);
      armRun();
      try {
        await writeScene({
          scene: sd, chapter: 1, characters: sc.characters, agents: agents,
          premise: sc.premise, writerStyle: sc.writerStyle, writerStyleConstraints: sc.writerStyleConstraints,
          writerModel: sc.models.writer, summaryModel: sc.models.summary,
          thinking: { writer: "low", summary: sc.thinking.summary },
          maxSteps: 10, maxProseWords: sc.maxProseWords,
          retries: sc.retries, clarifications: sc.clarifications,
          dir: sc.dir, log, timeline,
        });

        const label = scope === undefined ? "(scope omitted)" : `(scope: "${scope}")`;
        assert.ok(events.some(e => e.t === "world_beat"), `${label}: the beat still fires`);
        const memories = events.filter(e => e.t === "memory_surfaced") as any[];
        const riven = agents.get("riven")!;
        if (scope === "scene") {
          assert.deepEqual(memories, [], `${label}: no implant for a remote character`);
          assert.ok(!riven.system.includes(rivenMem), `${label}: the memory never reaches system`);
          assert.equal(riven.history.filter(m => m.content.includes("[YOU REMEMBER]")).length, 0,
            `${label}: no history marker either`);
        } else {
          assert.deepEqual(memories.map(m => m.character), ["RIVEN"], `${label}: world implants even remote`);
          assert.ok(riven.system.includes(rivenMem), `${label}: the memory rides in system`);
          assert.equal(riven.history.filter(m => m.content.includes("[YOU REMEMBER]")).length, 1,
            `${label}: one history marker`);
        }
      } finally {
        globalThis.fetch = origFetch;
        ENGINE.stream = origStream;
        armRun();
        resetLive();
      }
    }
  });

  for (const { mode, scope, receives } of [
    { mode: "here", scope: "scene", receives: true },
    { mode: "remote", scope: "scene", receives: false },
    { mode: "partial", scope: "scene", receives: true },
    { mode: "remote", scope: "world", receives: true },
  ] as const) {
    it(`delivers a ${scope}-scoped event verbatim with ${mode} presence, independently of memories`, async () => {
      const sc = await sc0();
      const sd: typeof sc.scenes[number] = { ...sc.scenes[0], roster: [],
        presence: mode === "here" ? {} : { RIVEN: `${mode} :: the phone line` } };
      const beat = "A frantic pounding on the heavy oak door";
      const memory = "The door's hinges were replaced last winter.";
      const timeline = [{
        chapter: 1, hold: "the pounding starting", fired: beat, at: 0,
        memories: { rIvEn: "   ", mErRiTt: memory, NOBODY: "an absent character's memory" },
        state: "pending" as const, scope,
      }];
      const events: RunEvent[] = [];
      const agents = new Map(sc.characters.map(c =>
        [c.name.toLowerCase(), newCharacterAgent(c, sd.place, "low")] as const));
      const fake = siteFetch({
        "writer.draft": ({ n }) => n < 2 ? {
          prose: "",
          consult: {
            character: n === 0 ? "RIVEN" : "MERRITT",
            situation: "The service door is closed, with a package resting on the floor beside it and the lock still fastened from inside.",
            question: "Do you open the door?",
            wants: "decision",
          },
          scene_done: false,
        } : { prose: "Dust settles along the threshold.", scene_done: true },
        "judge.narration": { ok: true },
        "judge.answer": { verdict: "accept" },
        "judge.done": { status: "resolved", evidence: "the page settles it" },
        "character.consult": { speech: "Keep it shut." },
      });
      const origFetch = globalThis.fetch;
      const origStream = ENGINE.stream;
      const origRetries = NET.retries;
      ENGINE.stream = false;
      NET.retries = 0;
      globalThis.fetch = fake.fetchMock;
      armRun();
      try {
        const r = await quiet(() => writeScene(sceneRun(sc, {
          scene: sd, agents, timeline, log: e => events.push(e),
        })));

        assert.equal(r.done, true);
        assert.equal(fake.count("character.consult"), 2);
        const implant = `[WHAT HAS HAPPENED]\n${beat}`;
        assert.equal(fake.messagesOf("character.consult", 0)[0].includes(implant), receives);
        assert.equal(fake.messagesOf("character.consult", 0).join("\n").includes(beat), receives);
        assert.ok(fake.messagesOf("character.consult", 1)[0].includes(implant));
        assert.ok(fake.messagesOf("character.consult", 1)[0].includes(memory));
        assert.ok(!agents.get("riven")!.system.includes(memory));
        assert.equal(agents.get("riven")!.fork().system.includes(implant), receives);
        assert.equal(agents.get("merritt")!.system.split(implant).length - 1, 1);
        const delivered = events.filter(e => e.t === "world_event_surfaced");
        assert.deepEqual(delivered, (receives ? ["RIVEN", "MERRITT"] : ["MERRITT"]).map(character => ({
          t: "world_event_surfaced", character, beat, chapter: 1,
        })));
        assert.deepEqual(events.filter(e => e.t === "memory_surfaced"), [
          { t: "memory_surfaced", character: "MERRITT", chapter: 1 },
        ]);
        assert.ok(fake.messagesOf("writer.draft", 0).join("\n").includes(`[WORLD] ${beat}`));
      } finally {
        globalThis.fetch = origFetch;
        ENGINE.stream = origStream;
        NET.retries = origRetries;
        armRun();
        resetLive();
      }
    });
  }

  for (const absent of ["unrostered", "exited"] as const) {
    it(`skips event and memory delivery to an ${absent} character`, async () => {
      const sc = await sc0();
      const sd = { ...sc.scenes[0], length: 40, roster: absent === "unrostered" ? ["RIVEN"] : [] };
      const beat = "A frantic pounding on the heavy oak door";
      const memory = "The door's hinges were replaced last winter.";
      const timeline = [{
        chapter: 1, hold: "the pounding starting", fired: beat, at: 0.5,
        memories: { MERRITT: memory }, state: "pending" as const, scope: "world" as const,
      }];
      const events: RunEvent[] = [];
      const agents = new Map(sc.characters.map(c =>
        [c.name.toLowerCase(), newCharacterAgent(c, sd.place, "low")] as const));
      const origFetch = globalThis.fetch;
      const origStream = ENGINE.stream;
      ENGINE.stream = false;
      globalThis.fetch = scriptedFetch([
        { prose: "word ".repeat(25).trim(), scene_done: false,
          ...(absent === "exited" ? { exit: "MERRITT" } : {}) },
        { prose: "Dust settles along the threshold.", scene_done: true },
      ]);
      armRun();
      try {
        await quiet(() => writeScene(sceneRun(sc, {
          scene: sd, agents, timeline, log: e => events.push(e),
        })));

        assert.ok(agents.get("riven")!.system.includes(beat));
        assert.ok(!agents.get("merritt")!.system.includes(beat));
        assert.ok(!agents.get("merritt")!.system.includes(memory));
        assert.deepEqual(events.filter(e => e.t === "world_event_surfaced"), [
          { t: "world_event_surfaced", character: "RIVEN", beat, chapter: 1 },
        ]);
        assert.ok(!events.some(e => e.t === "memory_surfaced"));
        if (absent === "exited") assert.ok(events.some(e => e.t === "exit" && e.character === "MERRITT"));
      } finally {
        globalThis.fetch = origFetch;
        ENGINE.stream = origStream;
        armRun();
        resetLive();
      }
    });
  }

  it("records a beat whose trigger the scene never reached, and says nothing about other chapters", async () => {
    // The scene closes at 3 words against a 40-word target, so a beat set at 0.9 never fires. Only
    // a firing leaves a mark otherwise, so silence would read exactly like a beat that had landed.
    const { events } = await runWith(
      [{ ...beatAt(0.9), fired: "the roof gives way" },
       { chapter: 2, hold: "h2", fired: "a beat for the next chapter", at: 0, memories: {}, scope: "world" as const, state: "pending" as const },
       { chapter: 1, hold: "h3", fired: "a beat nobody wants", at: 0.9, memories: {}, scope: "world" as const, state: "void" as const }],
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
      memories: { RIVEN: "never" }, state: "pending" as const, scope: "world" as const,
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
    memories: {}, state: "pending" as const, scope: "world" as const,
  });
  const runWith = async (
    timeline: { chapter: number; hold: string; fired: string; at: number; memories: Record<string, string>; scope: "scene" | "world"; state: "pending" | "fired" | "void" }[],
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

// -- THE LINT DECISION GATE IN THE LOOP --------------------------------------
describe("the lint decision gate in the loop", () => {
  const sc0 = () => quiet(() => loadStory("tests/fixtures/doorway"));

  /** The draft is flagged mechanically and — the point — the automatic redraft comes back with
   *  the same finding still on it, which is what earns the human a say. Only the second redraft
   *  (the one a "redraft again" choice buys) comes back clean. */
  function flaggedFetch() {
    const flagged = 'Riven reaches for the door. "Not tonight," Merritt says, without looking up.';
    const clean = "Riven crosses the corridor and tries the door.";
    let writerCall = 0;
    const { fetchMock } = siteFetch({
      "judge.narration": { ok: true },
      "judge.done": { status: "resolved", evidence: "the page settles it" },
      "writer.draft": () => ({ prose: flagged, scene_done: true }),
      "writer.redraft": () => ({ prose: ++writerCall === 1 ? flagged : clean, scene_done: true }),
    });
    return { fetchMock, calls: () => ({ writerCall }), flagged, clean };
  }

  /** Drive the loop with a scripted port: one redraft, then the human decision, with the prompt
   *  the gate receives captured for the assertions below. */
  function decisionIo(choice: LintDecision | "throw") {
    const asked: LintPrompt[] = [];
    const io: SceneIo = {
      moreSteps: async () => 0,
      pauseGate: async () => false,
      readerTake: () => false,
      readerAnswer: async () => "",
      lintDecision: async p => {
        asked.push(p);
        if (choice === "throw") throw new Error("simulated decision-port outage");
        return choice;
      },
    };
    return { io, asked };
  }

  for (const choice of ["redraft", "publish", "stop"] as const) {
    it(`a mechanical finding that survives the automatic redraft asks the ${choice === "publish" ? "human" : choice === "stop" ? "human and stops" : "human, then redrafts again"}, and ${choice === "publish" ? "the piece reaches the page" : choice === "stop" ? "the chapter ends preserving the committed page" : "the next piece is what the loop waits for"}`, async () => {
      const sc = await sc0();
      const events: RunEvent[] = [];
      const log = (e: RunEvent) => events.push(e);
      const { fetchMock, calls, flagged, clean } = flaggedFetch();
      const { io, asked } = decisionIo(choice);

      const origFetch = globalThis.fetch;
      const origStream = ENGINE.stream;
      ENGINE.stream = false;
      globalThis.fetch = fetchMock;
      armRun();
      try {
        const r = await writeScene(sceneRun(sc, { scene: sc.scenes[0], log, io }));

        assert.equal(asked.length, 1, "the gate is asked exactly once, after the automatic redraft");
        assert.equal(asked[0].blocking?.includes("unmatched quotation"), true, "the prompt carries the mechanical finding");
        assert.equal(asked[0].prose, flagged, "the prompt shows the flagged piece itself");
        assert.equal(asked[0].advisory, null, "a clean judge adds nothing to the prompt");

        if (choice === "redraft") {
          assert.deepEqual(r.prose, [clean], "the human's redraft is checked like any other piece");
          assert.equal(calls().writerCall, 2);
          assert.equal(r.done, true);
        } else if (choice === "publish") {
          assert.deepEqual(r.prose, [flagged], "publish commits the flagged piece as-is");
          assert.equal(calls().writerCall, 1, "publish spends no further writer call");
          assert.equal(r.done, true);
        } else {
          assert.deepEqual(r.prose, [], "stop ends the chapter with the page as it was");
          assert.equal(r.done, false);
        }
        const flags = events.filter(e => e.t === "narration_flag") as any[];
        assert.equal(flags.length, 2);
        assert.equal(flags[1].retried, true, "the second flag is reported as the spent retry");
      } finally {
        globalThis.fetch = origFetch;
        ENGINE.stream = origStream;
        armRun();
        resetLive();
      }
    });
  }

  it("a decision port that throws ends the chapter rather than hanging the scene", async () => {
    const sc = await sc0();
    const { fetchMock, calls, flagged } = flaggedFetch();
    const { io } = decisionIo("throw");
    const origFetch = globalThis.fetch;
    const origStream = ENGINE.stream;
    ENGINE.stream = false;
    globalThis.fetch = fetchMock;
    armRun();
    try {
      const r = await writeScene(sceneRun(sc, { scene: sc.scenes[0], io }));
      assert.deepEqual(r.prose, [], "the committed page is preserved — nothing is discarded or invented");
      assert.equal(r.done, false);
      assert.equal(calls().writerCall, 1, "a port outage is not a second redraft");
      assert.equal(!!flagged, true);
    } finally {
      globalFetchRestore(origFetch);
      ENGINE.stream = origStream;
      armRun();
      resetLive();
    }
  });
});

function globalFetchRestore(orig: typeof globalThis.fetch) { globalThis.fetch = orig; }

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
      "judge.done": { status: "resolved", evidence: "the page settles it" },
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

  for (const path of ["narration", "single", "fanout", "revision", "presence", "pronouns"] as const) {
    it(`keeps ${path} mechanical checks invariant under cannotMeaning`, async () => {
      const outcomes = [];
      for (const cannotMeaning of [false, true]) {
        const sc = await sc0();
        const merritt = sc.characters.find(c => c.name === "MERRITT")!;
        merritt.limits = ["sight"];
        merritt.limitMeanings = [{ name: "sight", meaning: "cannot perceive light or colour" }];
        merritt.pronouns = { subject: "they", object: "them", possessive: "their", reflexive: "themself" };
        const scene = { ...sc.scenes[0],
          ...(path === "presence" ? { presence: { RIVEN: "remote :: a telephone line" } } : {}) };
        const safe = "You hear the service door rattle beside your crate in the cold corridor, followed by three heavy knocks.";
        const restricted = "You watch the red handle turning beside your crate in the cold corridor, while the service door rattles loudly.";
        const consult = path === "single" ? { character: "MERRITT", situation: restricted }
          : path === "fanout" ? { reactors: ["MERRITT"], situation: restricted }
          : path === "revision" ? { character: "MERRITT", situation: safe }
          : path === "presence" ? { character: "RIVEN", situation: restricted } : undefined;
        const prose = path === "narration" ? "Merritt watches the door."
          : path === "pronouns" ? "Merritt steadies himself on the crate." : "The pipes rattle overhead.";
        const events: RunEvent[] = [];
        const fake = siteFetch({
          "writer.draft": ({ n }) => n === 0 ? { prose, consult } : { prose: "The corridor is cold.", scene_done: true },
          "writer.redraft": { prose: "The corridor is cold.", scene_done: true },
          "judge.narration": { ok: true },
          "judge.done": { status: "resolved", evidence: "settled" },
          "character.consult": { speech: "Wait." },
          "judge.answer": { verdict: "retry", revised: { situation: restricted, question: "Do you reach for the handle?" } },
        });
        const origFetch = globalThis.fetch;
        const original = { stream: ENGINE.stream, cannotMeaning: ENGINE.cannotMeaning,
          cannotNone: ENGINE.cannotNone, splitJudge: ENGINE.splitJudge };
        Object.assign(ENGINE, { stream: false, cannotMeaning, cannotNone: true, splitJudge: false });
        globalThis.fetch = fake.fetchMock;
        const agents = new Map(sc.characters.map(c => [c.name.toLowerCase(), newCharacterAgent(c, scene.place, "low")]));
        armRun();
        try {
          const result = await writeScene(sceneRun(sc, { scene, agents, retries: 1, log: e => events.push(e) }));
          const findings = events.filter(e => e.t === "narration_flag" || e.t === "bad_consult" || e.t === "narration_pronoun_flag");
          assert.equal(findings.length, 1, path);
          if (path === "presence") assert.match((findings[0] as any).why, /not physically there/);
          else if (path !== "pronouns") assert.match((findings[0] as any).why, /sight/);
          assert.equal(fake.count("character.consult"), path === "revision" ? 1 : 0);
          assert.equal(fake.count("writer.redraft"), path === "narration" ? 1 : 0);
          const system = fake.messagesOf("judge.narration")[0];
          assert.equal(system.includes("sight -- cannot perceive light or colour"), cannotMeaning);
          assert.equal(LIVE.writer!.system.includes("sight -- cannot perceive light or colour"), cannotMeaning);
          if (path === "revision")
            assert.equal(fake.messagesOf("judge.answer")[0].includes("sight -- cannot perceive light or colour"), cannotMeaning);
          outcomes.push({ findings, prose: result.prose });
        } finally {
          globalThis.fetch = origFetch;
          Object.assign(ENGINE, original);
          armRun();
          resetLive();
        }
      }
      assert.deepEqual(outcomes[1], outcomes[0]);
    });
  }

  it("gives the narration judge each reactor's delivered override, shared fallback, and no fanout since", async () => {
    for (const consultSince of [false, true]) {
      const sc = await sc0();
      const shared = "You hear the service door slam against its frame in the cold corridor, followed by three heavy knocks.";
      const own = "Through the telephone you hear three heavy knocks and the service door rattling at the far end of the line.";
      const ignored = "This duplicate override must never be delivered.";
      const since = "This fanout since must never be delivered.";
      const events: RunEvent[] = [];
      const fake = siteFetch({
        "writer.draft": ({ n }) => n === 0 ? {
          prose: "The pipes rattle overhead.",
          consult: { reactors: [{ name: "RIVEN", situation: `  ${own}  ` },
            { name: "riven", situation: ignored }, { name: "MERRITT", situation: "  " }], situation: shared, since },
        } : { prose: "The corridor is cold.", scene_done: true },
        "judge.narration": { ok: true },
        "judge.done": { status: "resolved", evidence: "settled" },
        "character.consult": { speech: "Wait." },
      });
      const origFetch = globalThis.fetch;
      const original = { stream: ENGINE.stream, consultSince: ENGINE.consultSince };
      Object.assign(ENGINE, { stream: false, consultSince });
      globalThis.fetch = fake.fetchMock;
      armRun();
      try {
        const scene = { ...sc.scenes[0], presence: { RIVEN: "remote :: a telephone line" } };
        const agents = new Map(sc.characters.map(c => [c.name.toLowerCase(), newCharacterAgent(c, scene.place, "low")]));
        await writeScene(sceneRun(sc, { scene, agents, log: e => events.push(e) }));
        const payload = fake.messagesOf("judge.narration")[1];
        assert.ok(payload.includes(`RIVEN\nsituation given: ${own}`));
        assert.ok(payload.includes(`MERRITT\nsituation given: ${shared}`));
        assert.ok(!payload.includes(ignored) && !payload.includes(since));
        assert.equal(fake.count("character.consult"), 2);
        for (const [n, situation] of [own, shared].entries()) {
          const delivered = fake.messagesOf("character.consult", n).join("\n");
          assert.ok(delivered.includes(`Situation: ${situation}`));
          assert.ok(!delivered.includes(ignored) && !delivered.includes(since));
        }
        assert.ok(!events.some(e => e.t === "bad_consult" || e.t === "lint_failed"));
      } finally {
        globalThis.fetch = origFetch;
        Object.assign(ENGINE, original);
        armRun();
        resetLive();
      }
    }
  });

  it("shows the narration judge the same joined since payload as the lone consultee", async () => {
    for (const consultSince of [false, true]) {
      const sc = await sc0();
      const situation = "You hear the service door rattle beside your crate in the cold corridor, followed by three heavy knocks.";
      const since = "The knocks have grown louder.";
      const fake = siteFetch({
        "writer.draft": ({ n }) => n === 0 ? { prose: "The pipes rattle overhead.",
          consult: { character: "MERRITT", situation, since } } : { prose: "The corridor is cold.", scene_done: true },
        "judge.narration": { ok: true },
        "judge.answer": { verdict: "accept" },
        "judge.done": { status: "resolved", evidence: "settled" },
        "character.consult": { speech: "Wait." },
      });
      const origFetch = globalThis.fetch;
      const original = { stream: ENGINE.stream, consultSince: ENGINE.consultSince };
      Object.assign(ENGINE, { stream: false, consultSince });
      globalThis.fetch = fake.fetchMock;
      armRun();
      try {
        const scene = sc.scenes[0];
        const agents = new Map(sc.characters.map(c => [c.name.toLowerCase(), newCharacterAgent(c, scene.place, "low")]));
        await writeScene(sceneRun(sc, { scene, agents }));
        const delivered = situation + (consultSince ? `\n\nSince you were last asked: ${since}` : "");
        assert.ok(fake.messagesOf("judge.narration")[1].includes(`situation given: ${delivered}\nquestion:`));
        assert.ok(fake.messagesOf("character.consult").join("\n").includes(`Situation: ${delivered}`));
        assert.equal(fake.messagesOf("judge.narration")[1].includes(since), consultSince);
      } finally {
        globalThis.fetch = origFetch;
        Object.assign(ENGINE, original);
        armRun();
        resetLive();
      }
    }
  });

  for (const stage of [0, 1]) {
    for (const outcome of ["throw", "pass", "flag"] as const) {
      it(`does not commit when ${stage ? "redraft" : "initial"} lint stops with ${outcome}`, async (t) => {
        const sc = await sc0();
        const events: RunEvent[] = [];
        const origFetch = globalThis.fetch;
        const origStream = ENGINE.stream;
        const generate = Agent.prototype.generate;
        let lintCalls = 0;
        const fake = siteFetch({
          "writer.draft": { prose: "The corridor is cold.", scene_done: true },
          "writer.redraft": { prose: "The pipes rattle overhead.", scene_done: true },
        });
        t.mock.method(Agent.prototype, "generate", async function (this: Agent, ...args: Parameters<typeof generate>) {
          if (args[1] !== "judge.narration") return generate.apply(this, args);
          if (lintCalls++ < stage) return JSON.stringify({ ok: false, why: "redraft this piece" });
          if (outcome === "throw") throw new StoppedError();
          stopRun();
          return JSON.stringify({ ok: outcome === "pass", why: "stopped finding" });
        });
        ENGINE.stream = false;
        globalThis.fetch = fake.fetchMock;
        armRun();
        try {
          const result = await writeScene(sceneRun(sc, { scene: sc.scenes[0], log: e => events.push(e) }));
          assert.deepEqual(result.prose, []);
          assert.equal(result.words, 0);
          assert.equal(result.done, false);
          assert.equal(lintCalls, stage + 1);
          assert.equal(fake.count("writer.redraft"), stage);
          assert.ok(!events.some(e => e.t === "draft" || e.t === "lint_failed"));
          assert.equal(events.filter(e => e.t === "narration_flag").length, stage);
          assert.equal(LIVE.writer!.history.filter(m => m.role === "assistant").length, 0);
        } finally {
          t.mock.restoreAll();
          globalThis.fetch = origFetch;
          ENGINE.stream = origStream;
          armRun();
          resetLive();
        }
      });
    }
  }

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
// append (engine/lint/repeat-lint.ts) — the doorway run appended a verbatim repeat of its opening
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
      "judge.done": { status: "resolved", evidence: "the page settles it" },
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
