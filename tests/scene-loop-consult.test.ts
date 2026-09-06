/** Judge, context fit warnings, and character consults. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadStory } from "../engine/story-format.ts";
import { newCharacterAgent, writeScene, type RunEvent } from "../engine/scene-loop.ts";
import { Agent, setFitWarning } from "../engine/agent.ts";
import { NET } from "../engine/llm-client.ts";
import { ENGINE } from "../engine/engine-state.ts";
import { WARN } from "../engine/warnings.ts";
import { LIVE, resetLive, RUN, armRun } from "../live.ts";
import { quiet, siteFetch, sceneRun } from "./helpers.ts";

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
