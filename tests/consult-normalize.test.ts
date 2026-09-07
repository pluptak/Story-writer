/**
 * Consult normalization and parsing tests — schema validation, verdict parsing, and revision handling.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeConsult, normalizeReactionConsult, parseVerdict, parseLintVerdict, parseBatchVerdict, parseClarifyAnswer, missingShape,
  reviseConsult, consult, CONSULT_WANTS, type ConsultEvent, type ConsultRequest,
} from "../engine/consult.ts";
import * as P from "../prompts.ts";
import { ScriptedAgent } from "./helpers.ts";

// -- ONE SCHEMA PER AGENT -------------------------------------------------
describe("the author-side agents each hold exactly one schema", () => {
  const cast = [{ name: "RIVEN", can: ["movement"], cannot: ["sight"] }];
  const judge = P.judgeSystem(cast);
  const clarify = P.clarifySystem({
    premise: "a premise", scene: { place: "a door", question: "does it open?" },
    facts: ["the lock is old"], cast,
  });

  it("the writer no longer carries the judge's or the clarifier's shape", () => {
    // Why they were split out: with all shapes in one format, the [WRITE] pattern won 7 times in 55.
    assert.ok(!P.WRITER_FORMAT.includes(`"verdict"`));
    assert.ok(!P.WRITER_FORMAT.includes(`"answer"`));
  });

  it("the judge carries no way to write prose", () => {
    assert.ok(!judge.includes(`"prose"`));
    assert.ok(!judge.includes(`"answer"`));
  });

  it("the clarifier carries neither prose nor a verdict", () => {
    assert.ok(!clarify.includes(`"prose"`));
    assert.ok(!clarify.includes(`"verdict"`));
  });

  it("both still know what the cast cannot do", () => {
    for (const s of [judge, clarify]) assert.match(s, /CANNOT: sight/);
  });

  it("the clarifier is told not to speak for a character it has not asked", () => {
    assert.match(clarify, /NEVER PUT WORDS IN ANOTHER CHARACTER'S MOUTH/);
  });

  it("the clarifier holds the premise and the facts, so what it settles cannot contradict them", () => {
    assert.match(clarify, /a premise/);
    assert.match(clarify, /the lock is old/);
  });

  it("the done judge carries no way to write prose, ask, or promote", () => {
    assert.ok(!P.DONE_JUDGE_FORMAT.includes(`"prose"`));
    assert.ok(!P.DONE_JUDGE_FORMAT.includes(`"consult"`));
    assert.ok(!P.DONE_JUDGE_FORMAT.includes(`"promotable"`));
  });
});

describe("doneJudgeRequest", () => {
  it("shows the question and the page, and nothing else", () => {
    const msg = P.doneJudgeRequest({ question: "does the door open?", prose: "They stood there." });
    assert.match(msg, /\[THE QUESTION THIS SCENE HAS TO ANSWER]\ndoes the door open\?/);
    assert.match(msg, /\[THE SCENE AS IT STANDS]\nThey stood there\./);
  });

  it("is told to weigh only whether the question is settled, not how well it is written", () => {
    // The judge shares the writer's model and would otherwise answer as a reader with taste.
    assert.match(P.DONE_JUDGE_FORMAT, /Judge nothing else/);
    assert.match(P.DONE_JUDGE_FORMAT, /Not whether the writing is good/);
  });

  it("counts a refusal that holds as an answer, and a live standoff as none", () => {
    assert.match(P.DONE_JUDGE_FORMAT, /"No" is an answer/);
    assert.match(P.DONE_JUDGE_FORMAT, /both sides where they started/);
  });

  it("says nothing to the writer at all — the verdict is a measurement, not an instruction", () => {
    // It was one, and the writer could not act on it: a deadlock is broken by somebody choosing
    // differently, which the writer may not write. Nothing in prompts/ addresses the writer here.
    assert.equal((P as Record<string, unknown>).questionUnanswered, undefined);
  });
});

describe("parseVerdict", () => {
  it("reads both verdicts, however they are cased", () => {
    assert.equal(parseVerdict({ verdict: "retry" }), "retry");
    assert.equal(parseVerdict({ verdict: " Retry " }), "retry");
    assert.equal(parseVerdict({ verdict: "accept" }), "accept");
  });

  it("treats an unrecognised verdict as accept, the safe reading", () => {
    assert.equal(parseVerdict({ verdict: "maybe" }), "accept");
  });

  it("returns null when there is no verdict to read", () => {
    // A reply in another shape is not a judgement, and must not become a silent accept.
    assert.equal(parseVerdict({ prose: "the door swings wide" }), null);
    assert.equal(parseVerdict({}), null);
    assert.equal(parseVerdict({ verdict: "" }), null);
  });
});

describe("parseLintVerdict", () => {
  it("reads an explicit pass and an explicit flag, boolean or string", () => {
    assert.deepEqual(parseLintVerdict({ ok: true }), { ok: true, why: "" });
    assert.deepEqual(parseLintVerdict({ ok: "TRUE" }), { ok: true, why: "" });
    assert.deepEqual(parseLintVerdict({ ok: false, why: "MERRITT was given a line" }),
      { ok: false, why: "MERRITT was given a line" });
    assert.deepEqual(parseLintVerdict({ ok: "false" }), { ok: false, why: "" });
  });

  // The whole point: a check that was never made must not read as a check that passed.
  it("returns null for a reply that carries no verdict at all", () => {
    assert.equal(parseLintVerdict({}), null);
    assert.equal(parseLintVerdict({ ok: "maybe" }), null);
    assert.equal(parseLintVerdict({ verdict: "accept" }), null);
    assert.equal(parseLintVerdict({ why: "something felt off" }), null);
  });
});

describe("parseBatchVerdict", () => {
  it("keys promotable flags by lowercased name", () => {
    const m = parseBatchVerdict({ verdicts: [
      { name: "ELARA", promotable: true }, { name: "Mira", promotable: false },
    ]});
    assert.equal(m.get("elara"), true);
    assert.equal(m.get("mira"), false);
  });

  it("reads the string \"true\" as promotable, anything else as not", () => {
    const m = parseBatchVerdict({ verdicts: [
      { name: "A", promotable: "true" }, { name: "B", promotable: "no" }, { name: "C", promotable: 1 },
    ]});
    assert.equal(m.get("a"), true);
    assert.equal(m.get("b"), false);
    assert.equal(m.get("c"), false);
  });

  it("leaves an omitted reactor with no entry, read as not promotable", () => {
    const m = parseBatchVerdict({ verdicts: [{ name: "ELARA", promotable: true }] });
    assert.equal(m.get("mira"), undefined);
  });

  it("yields an empty map for a malformed reply, so every deed lapses safely", () => {
    assert.equal(parseBatchVerdict({}).size, 0);
    assert.equal(parseBatchVerdict({ verdicts: "nope" }).size, 0);
    assert.equal(parseBatchVerdict({ verdicts: [{ promotable: true }] }).size, 0);  // nameless, skipped
  });
});

// -- A REVISION GOES THROUGH THE SAME DOOR --------------------------------
describe("reviseConsult", () => {
  const prev: ConsultRequest = {
    character: "RIVEN", situation: "You are kneeling by the steel service door, wrench in the cylinder.",
    question: "Do you turn it now?", wants: "decision",
  };

  /** Every valid revision now has to move the situation, so the shared fixture below supplies one. */
  const moved = "The wrench has slipped and the cylinder has not turned; footsteps have started up.";

  it("keeps what the judge left out", () => {
    const r = reviseConsult(prev, { situation: moved, question: "Do you turn it, knowing what it wakes?" });
    assert.ok(r.ok);
    assert.equal(r.req.wants, "decision", "an omitted field falls back, it does not blank");
    assert.equal(r.req.question, "Do you turn it, knowing what it wakes?");
  });

  it("refuses a revision that re-sends the same situation", () => {
    // The character is shown the situation, not the question, so sharpening the fork's wording sends
    // a fresh instance the identical message the last one answered. Seen twice in the first live run
    // under the withheld question, once with the question unchanged as well.
    const sharpened = reviseConsult(prev, { question: "Do you turn it, knowing what it wakes?" });
    assert.ok(!sharpened.ok, "an omitted situation falls back and is then the same ask");
    assert.match(sharpened.why, /has to change what they can perceive/);

    const verbatim = reviseConsult(prev, { situation: `  ${prev.situation}  `, question: "Do you turn it?" });
    assert.ok(!verbatim.ok, "and whitespace is not a change either");
  });

  it("takes a whole new situation and question when the judge writes one", () => {
    const r = reviseConsult(prev, {
      situation: "The corridor has gone quiet and the wrench is still in your hand.",
      question: "Do you call out first?", wants: "decision",
    });
    assert.ok(r.ok);
    assert.match(r.req.situation, /corridor has gone quiet/);
    assert.equal(r.req.question, "Do you call out first?");
    assert.equal(r.wantsRefused, "", "it kept the shape, so there is no drift to record");
  });

  it("refuses a revision the front door would have refused", () => {
    // The regression: "What do you do?" is rejected as a first consult, but used to be sent anyway
    // as a retry because the revision skipped the check.
    const r = reviseConsult(prev, { question: "What do you do?" });
    assert.ok(!r.ok);
    assert.match(r.why, /fork|stake/);
  });

  it("refuses a revision that guts the situation", () => {
    assert.ok(!reviseConsult(prev, { situation: "It is dark." }).ok);
  });

  // The judge may reframe a fork it asked badly. It may not turn one fork into another: "which way
  // do you go" and "what do you say about it" are different moments, and a judge that answers an
  // inconvenient reply by changing the shape has replaced the choice, not re-put it.
  it("pins the shape asked for, and records the one the judge wanted", () => {
    const r = reviseConsult(prev, { situation: moved, question: "Do you turn it slowly now?", wants: "speech" });
    assert.ok(r.ok);
    assert.equal(r.req.wants, "decision", "the original shape stands");
    assert.equal(r.wantsRefused, "speech", "and what the judge asked for is on the record");
  });

  it("reads a reworded shape as the same shape, not as drift", () => {
    const r = reviseConsult({ ...prev, wants: "speech" }, { situation: moved, wants: "what they say" });
    assert.ok(r.ok);
    assert.equal(r.req.wants, "speech");
    assert.equal(r.wantsRefused, "", "'what they say' canonicalizes to speech — nothing changed");
  });

  it("treats an unreadable wants as the judge not naming one", () => {
    const r = reviseConsult(prev, { situation: moved, wants: "???" });
    assert.ok(r.ok);
    assert.equal(r.req.wants, "decision");
    assert.equal(r.wantsRefused, "");
  });

  const blindCast = [{ name: "MERRITT", cannot: ["sight"] }, { name: "RIVEN", cannot: [] }];
  const merrittPrev: ConsultRequest = {
    character: "MERRITT", situation: "The ledger lies open on the counter, the pen beside your hand.",
    question: "Do you sign it now?", wants: "decision",
  };

  it("re-lints the judge's revised situation against the same CANNOT list — the fifth entry path", () => {
    const r = reviseConsult(merrittPrev, {
      situation: "You have just watched Riven sign the ledger in your place.",
      question: "Do you countersign it now?",
    }, blindCast);
    assert.ok(!r.ok, "a retry must not deliver as ground truth what the first ask was refused for");
    assert.match(r.why, /MERRITT/);
  });

  it("passes a clean revision through with the cast given", () => {
    const r = reviseConsult(merrittPrev, {
      situation: "The counter is bare under your hands; the pen has been taken away.",
      question: "Do you sign it now?",
    }, blindCast);
    assert.ok(r.ok);
    assert.match(r.req.situation, /pen has been taken away/);
  });

  it("refuses to re-ask an unchanged situation even when it is a clean one", () => {
    // It would pass every gate it passed the first time; that is exactly why it buys nothing.
    const r = reviseConsult(merrittPrev, { question: "Do you sign the ledger now?" }, blindCast);
    assert.ok(!r.ok);
    assert.match(r.why, /has to change what they can perceive/);
  });
});

// -- THE SHAPE THAT WAS ASKED FOR -----------------------------------------
describe("missingShape", () => {
  it("holds each shape to what it asked for", () => {
    assert.equal(missingShape("speech", { speech: "", action: "I turn away." }), "speech");
    assert.equal(missingShape("action", { speech: "Not tonight.", action: "" }), "action");
    assert.equal(missingShape("decision", { speech: "", action: "" }), "decision");
  });

  it("is satisfied by the thing it asked for", () => {
    assert.equal(missingShape("speech", { speech: "Not tonight.", action: "" }), null);
    assert.equal(missingShape("action", { speech: "", action: "I turn away." }), null);
    assert.equal(missingShape("decision", { speech: "I stay.", action: "" }), null);
    assert.equal(missingShape("decision", { speech: "", action: "I stay put." }), null);
  });

  it("lets a reaction be answered by a thought alone, from inside the point of view", () => {
    // The one shape that happens behind the eyes; holding it to speech or action would be wrong.
    assert.equal(missingShape("reaction", { speech: "", action: "" }, true), null);
  });

  it("makes anyone else's reaction reach the outside", () => {
    // Their thought never reaches the writer, so a reaction kept behind their eyes is the same
    // empty answer the other three shapes are refused for -- the ask would be spent on nothing.
    assert.equal(missingShape("reaction", { speech: "", action: "" }, false), "reaction");
    assert.equal(missingShape("reaction", { speech: "Who's there?", action: "" }, false), null);
    assert.equal(missingShape("reaction", { speech: "", action: "goes still" }, false), null);
  });

  it("asks no more than the four shapes always did when the point of view is unknown", () => {
    assert.equal(missingShape("reaction", { speech: "", action: "" }), null);
    assert.equal(missingShape("", { speech: "", action: "" }), null);
  });

  it("holds an open beat to the same floor, since it names no shape of its own", () => {
    // Stage 3 sends no `wants`, so the POV rule is all that is left -- and it is the same rule: a
    // thought from outside the POV reaches the writer as if nothing at all was asked.
    assert.equal(missingShape("", { speech: "", action: "" }, false), "reaction");
    assert.equal(missingShape("", { speech: "I stay put.", action: "" }, false), null);
    assert.equal(missingShape("", { speech: "", action: "goes still" }, false), null);
  });
});

describe("consult, on the shape it was asked for", () => {
  const REQ: ConsultRequest = { character: "TESTER", situation: "s", question: "q", wants: "" };
  const ask = (wants: ConsultRequest["wants"], script: string[]) => {
    const events: ConsultEvent[] = [];
    const agent = new ScriptedAgent(script);
    return consult(agent, { ...REQ, wants }, {
      clarifications: 2, clarify: async () => "two paces", log: (e: ConsultEvent) => events.push(e),
    }).then(reply => ({ reply, events, agent }));
  };

  it("re-asks a character that thought about it instead of answering", async () => {
    const { reply, events, agent } = await ask("speech", [
      `{"thought":"I weigh it up.","speech":"","action":""}`,
      `{"thought":"Enough.","speech":"Not tonight."}`,
    ]);
    assert.equal(agent.calls, 2);
    assert.equal(reply.speech, "Not tonight.");
    assert.ok(events.some(e => e.t === "repair" && /asked for speech/.test(e.why)));
  });

  it("does not re-ask a reaction that came back as a thought", async () => {
    const { reply, events, agent } = await ask("reaction", [`{"thought":"It lands like cold water."}`]);
    assert.equal(agent.calls, 1);
    assert.equal(reply.thought, "It lands like cold water.");
    assert.ok(!events.some(e => e.t === "repair"));
  });

  it("still returns the short answer when the re-ask does not fix it", async () => {
    // The caller decides what to do with it; consult's job is to have asked once more.
    const { reply, events } = await ask("action", [
      `{"thought":"I consider it."}`, `{"thought":"I am still considering it."}`,
    ]);
    assert.equal(reply.action, "");
    assert.equal(missingShape("action", reply), "action");
    assert.ok(events.some(e => e.t === "repair"));
  });
});

describe("parseClarifyAnswer", () => {
  it("returns the fact it was given", () => {
    assert.equal(parseClarifyAnswer({ answer: "  two paces  " }), "two paces");
  });

  it("distinguishes answering with nothing from not answering at all", () => {
    assert.equal(parseClarifyAnswer({ answer: "" }), "", "present but empty is still a reply");
    assert.equal(parseClarifyAnswer({ verdict: "accept" }), null, "a verdict is not a reply to this");
    assert.equal(parseClarifyAnswer({}), null);
  });
});

describe("normalizeConsult, the judge's directed ask", () => {
  // Stage 3 did not remove the question gates; it narrowed them to the one path that still carries
  // a question — the judge escalating an open beat into a named fork.
  const good = { character: "RIVEN", situation: "You are kneeling by the steel service door, wrench in the cylinder.",
                 question: "Do you turn it now?", wants: "decision" };

  it("passes a real consult through, canonicalizing wants", () => {
    const r = normalizeConsult({ ...good, wants: "what they decide" }, undefined, "directed");
    assert.ok(r.ok);
    assert.equal(r.req.wants, "decision");
    assert.equal(r.req.question, good.question);
    assert.equal(r.req.character, "RIVEN");
  });

  it("refuses an empty situation", () => {
    const r = normalizeConsult({ ...good, situation: "" }, undefined, "directed");
    assert.ok(!r.ok);
    assert.match(r.why, /only world/);
  });

  it("refuses a situation too thin to answer from", () => {
    const r = normalizeConsult({ ...good, situation: "It is dark." }, undefined, "directed");
    assert.ok(!r.ok);
    assert.match(r.why, /3 words/);
  });

  it("refuses an empty question", () => {
    assert.ok(!normalizeConsult({ ...good, question: "" }, undefined, "directed").ok);
  });

  it("refuses the questions that ask for nothing", () => {
    for (const q of ["What do you do?", "What does Elara do?", "What does Riven do next with the pick?",
                     "What happens next?", "Your move?",
                     "What do you choose regarding the lock?",
                     "What do you decide to do with the current snag?"]) {
      const r = normalizeConsult({ ...good, question: q }, undefined, "directed");
      assert.ok(!r.ok, `"${q}" should have been refused`);
      assert.match(r.why, /fork|stake/);
    }
  });

  it("keeps the questions that name a fork or a cost", () => {
    for (const q of ["Do you type the abort command?",
                     "Do you wake him, knowing what the noise wakes with it?",
                     "Do you shift to get more comfortable?",
                     "What do you say when he asks you directly?",
                     "Do you say the name, knowing what it admits?",
                     "Do you open the order book?"]) {
      assert.ok(normalizeConsult({ ...good, question: q }, undefined, "directed").ok, `"${q}" should have been allowed`);
    }
  });

  it("refuses the question that carries both answers of its fork", () => {
    // The three live shapes: two doorway runs and the cooling-loop retry that came back with MORE
    // of the answer in it. A pre-written menu is answered by picking, and picking is all it leaves.
    for (const q of ["Do you concede and sign for A, or do you double down?",
                     "Do you side with Nkem (wait for engineers) or with Hale and Marsh (pull the lever now)?",
                     "Do you list yourself as the primary person who authorized the shutdown, " +
                     "or do you attribute it to the collective team?"]) {
      const r = normalizeConsult({ ...good, question: q }, undefined, "directed");
      assert.ok(!r.ok, `"${q}" should have been refused`);
      assert.match(r.why, /both branches|open question/);
    }
  });

  it("keeps the genuinely open question the live runs produced", () => {
    const r = normalizeConsult({ ...good,
      question: "What do you say to the group about the state of the hardware?" }, undefined, "directed");
    assert.ok(r.ok);
  });

  it("refuses a wants it cannot make sense of, and names the four", () => {
    const r = normalizeConsult({ ...good, wants: "" }, undefined, "directed");
    assert.ok(!r.ok);
    for (const w of CONSULT_WANTS) assert.match(r.why, new RegExp(w));
  });

  it("says what is wrong in terms the writer can act on", () => {
    for (const bad of [{ situation: "" }, { situation: "Dark." }, { question: "What do you do?" }, { wants: "" }]) {
      const r = normalizeConsult({ ...good, ...bad }, undefined, "directed");
      assert.ok(!r.ok);
      assert.ok(r.why.length > 60, "a one-word complaint teaches nothing");
    }
  });

  const sightLeaning = "You are leaning over Riven, observing their hands at the lock. Riven remains perfectly still under your gaze.";
  const forkQuestion = "Do you reach for the lock?";
  const cast = [{ name: "MERRITT", cannot: ["sight"] }, { name: "RIVEN", cannot: [] }];

  it("refuses a situation phrased around a sense its addressee CANNOT", () => {
    const r = normalizeConsult({ character: "MERRITT", situation: sightLeaning, question: forkQuestion, wants: "decision" }, cast, "directed");
    assert.ok(!r.ok);
    assert.match(r.why, /MERRITT/);
    assert.match(r.why, /sight/);
    assert.match(r.why, /CANNOT/);
  });

  it("sends the same situation to a character without that CANNOT", () => {
    const r = normalizeConsult({ character: "RIVEN", situation: sightLeaning, question: forkQuestion, wants: "decision" }, cast, "directed");
    assert.ok(r.ok);
    assert.equal(r.req.situation, sightLeaning);
  });

  it("matches the addressee case-insensitively against the cast", () => {
    const r = normalizeConsult({ character: "Merritt", situation: sightLeaning, question: forkQuestion, wants: "decision" }, cast, "directed");
    assert.ok(!r.ok);
  });

  it("checks nothing when no cast is given", () => {
    const r = normalizeConsult({ character: "MERRITT", situation: sightLeaning, question: forkQuestion, wants: "decision" }, undefined, "directed");
    assert.ok(r.ok, "a name the cast does not cover is not checked");
  });

  it("checks nothing for a name the cast does not hold", () => {
    const r = normalizeConsult({ character: "NOBODY", situation: sightLeaning, question: forkQuestion, wants: "decision" }, cast, "directed");
    assert.ok(r.ok);
  });
});

describe("normalizeReactionConsult", () => {
  const shared = "The service door explodes inward off its hinges, wood and dust coming across the floor "
    + "towards where you are standing.";
  const question = "";

  it("gives every reactor the shared situation and no question at all", () => {
    const r = normalizeReactionConsult({ reactors: [{ name: "ELARA" }, { name: "MIRA" }], situation: shared, question });
    assert.ok(r.ok);
    assert.equal(r.reqs.length, 2);
    assert.deepEqual(r.reqs.map(x => x.character), ["ELARA", "MIRA"]);
    for (const req of r.reqs) {
      assert.equal(req.situation, shared);
      assert.equal(req.question, "", "a fan-out is the several-at-once form of the open ask");
      assert.equal(req.wants, "", "and nothing is pinned to reaction any more");
    }
  });

  it("holds each reactor to the open situation floor", () => {
    const r = normalizeReactionConsult({ reactors: [{ name: "ELARA" }], situation: "A crash somewhere." });
    assert.ok(!r.ok);
    assert.match(r.why, /whole of what you are sending/);
  });

  it("lets a reactor override the situation (someone who only heard it)", () => {
    const heard = "From the next room you catch a splintering crash and then a rush of cold air coming in under the door.";
    const r = normalizeReactionConsult({
      reactors: [{ name: "ELARA" }, { name: "MIRA", situation: heard }], situation: shared, question,
    });
    assert.ok(r.ok);
    assert.equal(r.reqs[0].situation, shared);
    assert.equal(r.reqs[1].situation, heard);
  });

  it("collapses a duplicated reactor to one consult — first entry wins, with its own situation", () => {
    const heard = "From the next room you catch a splintering crash and then a rush of cold air coming in under the door.";
    const r = normalizeReactionConsult({
      reactors: [{ name: "ELARA", situation: heard }, { name: "elara" }, { name: "ELARA" }],
      situation: shared, question,
    });
    assert.ok(r.ok);
    assert.equal(r.reqs.length, 1, "one name, one consult — however it was spelled");
    assert.equal(r.reqs[0].character, "ELARA");
    assert.equal(r.reqs[0].situation, heard, "the survivor keeps its per-reactor situation");
  });

  it("accepts a bare string reactor", () => {
    const r = normalizeReactionConsult({ reactors: ["ELARA"], situation: shared, question });
    assert.ok(r.ok);
    assert.equal(r.reqs[0].character, "ELARA");
  });

  it("refuses an empty reactor list", () => {
    const r = normalizeReactionConsult({ reactors: [], situation: shared, question });
    assert.ok(!r.ok);
    assert.match(r.why, /reactors/);
  });

  it("refuses a nameless reactor", () => {
    const r = normalizeReactionConsult({ reactors: [{ situation: shared }], situation: shared, question });
    assert.ok(!r.ok);
    assert.match(r.why, /name/i);
  });

  it("holds each reactor to the same situation floor a lone consult faces", () => {
    const r = normalizeReactionConsult({ reactors: [{ name: "ELARA" }], situation: "It is loud.", question });
    assert.ok(!r.ok);
  });

  const sightShared = "The door swings open in front of you and you watch Riven hand the satchel across to the man waiting there.";
  const blindCast = [{ name: "MERRITT", cannot: ["sight"] }, { name: "RIVEN", cannot: [] }];

  it("refuses the whole fan-out when the shared situation breaks one reactor's CANNOT", () => {
    const r = normalizeReactionConsult({
      reactors: [{ name: "RIVEN" }, { name: "MERRITT" }], situation: sightShared, question,
    }, blindCast);
    assert.ok(!r.ok);
    assert.match(r.why, /MERRITT/, "the refusal names the reactor whose ground truth was corrupt");
  });

  it("checks a per-reactor override against its owner only", () => {
    const heard = "From the next room the door swings on its hinges and a voice you cannot make out follows it.";
    const r = normalizeReactionConsult({
      reactors: [{ name: "MERRITT", situation: heard }, { name: "RIVEN" }],
      situation: sightShared, question,
    }, blindCast);
    assert.ok(r.ok, "Merritt's override is clean for Merritt; the shared text only ever reaches Riven");
    assert.equal(r.reqs[0].situation, heard);
    assert.equal(r.reqs[1].situation, sightShared);
  });
});
