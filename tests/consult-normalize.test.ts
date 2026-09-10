/**
 * Consult normalization and parsing tests — schema validation, verdict parsing, and revision handling.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeConsult, normalizeReactionConsult, parseVerdict, parseLintVerdict, parseBatchVerdict, parseClarifyAnswer, nonPovThoughtOnly,
  reviseConsult, consult, type ConsultEvent, type ConsultRequest,
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
    assert.equal(r.req.wants, "decision", "the inert record is carried, never blanked");
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
    assert.equal(r.wantsRefused, "", "wants is inert — nothing to record");
  });

  it("refuses a revision the front door would have refused", () => {
    // The regression: "What do you do?" is rejected as a first consult, but used to be sent anyway
    // as a retry because the revision skipped the check.
    const r = reviseConsult(prev, { question: "What do you do?" });
    assert.ok(!r.ok);
    assert.match(r.why, /contradiction|repair/);
  });

  it("refuses a revision that guts the situation", () => {
    assert.ok(!reviseConsult(prev, { situation: "It is dark." }).ok);
  });

  // The judge names no output shape any more. A `wants` arriving on a revision — from an
  // older record, a paraphrase, or a hallucination — is carried as the inert record it is, never
  // honored and never refused over: there is no shape to reframe and no drift to record.
  it("ignores a shape the judge sends, keeping the inert record untouched", () => {
    const r = reviseConsult(prev, { situation: moved, question: "Do you turn it slowly now?", wants: "speech" });
    assert.ok(r.ok);
    assert.equal(r.req.wants, "decision", "the original record stands");
    assert.equal(r.wantsRefused, "", "and there is no drift to record any more");
  });

  it("reads a reworded shape as nothing at all, not as drift", () => {
    const r = reviseConsult({ ...prev, wants: "speech" }, { situation: moved, wants: "what they say" });
    assert.ok(r.ok);
    assert.equal(r.req.wants, "speech");
    assert.equal(r.wantsRefused, "");
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

// -- THE ONLY SHAPE FLOOR LEFT ---------------------------------------------
describe("nonPovThoughtOnly", () => {
  it("accepts every shape of answer from inside the point of view", () => {
    // No output shape is dictated any more: a thought alone, a line, a deed — all valid.
    assert.equal(nonPovThoughtOnly({ speech: "", action: "" }, true), null);
    assert.equal(nonPovThoughtOnly({ speech: "Not tonight.", action: "" }, true), null);
    assert.equal(nonPovThoughtOnly({ speech: "", action: "I turn away." }, true), null);
  });

  it("accepts a line or a deed from anyone, whatever was once wanted", () => {
    assert.equal(nonPovThoughtOnly({ speech: "Who's there?", action: "" }, false), null);
    assert.equal(nonPovThoughtOnly({ speech: "", action: "goes still" }, false), null);
  });

  it("refuses only a thought kept behind the eyes of someone the scene is not written from", () => {
    // Their thought never reaches the writer, so it is the same empty answer as nothing at all.
    assert.equal(nonPovThoughtOnly({ speech: "", action: "" }, false), "reaction");
  });

  it("asks nothing when the point of view is unknown", () => {
    assert.equal(nonPovThoughtOnly({ speech: "", action: "" }), null);
  });
});

describe("consult, with no shape to hold it to", () => {
  const REQ: ConsultRequest = { character: "TESTER", situation: "s", question: "q", wants: "" };
  const ask = (wants: ConsultRequest["wants"], script: string[], pov = true) => {
    const events: ConsultEvent[] = [];
    const agent = new ScriptedAgent(script);
    return consult(agent, { ...REQ, wants }, {
      clarifications: 2, clarify: async () => "two paces", log: (e: ConsultEvent) => events.push(e),
      pov,
    }).then(reply => ({ reply, events, agent }));
  };

  it("accepts a thought-only answer outright — departing from the want breaks nothing", async () => {
    // The case that tests whether the shape-dictation removal took: under the old missingShape
    // this spent a repair; now the answer stands as given.
    const { reply, events, agent } = await ask("speech", [
      `{"thought":"I weigh it up.","speech":"","action":""}`,
    ]);
    assert.equal(agent.calls, 1);
    assert.equal(reply.thought, "I weigh it up.");
    assert.ok(!events.some(e => e.t === "repair"));
  });

  it("does not re-ask a reaction that came back as a thought", async () => {
    const { reply, events, agent } = await ask("reaction", [`{"thought":"It lands like cold water."}`]);
    assert.equal(agent.calls, 1);
    assert.equal(reply.thought, "It lands like cold water.");
    assert.ok(!events.some(e => e.t === "repair"));
  });

  it("still re-asks a thought kept behind the eyes of someone the scene is not written from", async () => {
    const { reply, events, agent } = await ask("", [
      `{"thought":"It lands like cold water."}`,
      `{"thought":"It lands like cold water.","speech":"Who's there?"}`,
    ], false);
    assert.equal(agent.calls, 2);
    assert.equal(reply.speech, "Who's there?");
    assert.ok(events.some(e => e.t === "repair" && /behind their eyes/.test(e.why)));
  });

  it("still repairs a reply with nothing in it at all", async () => {
    const { reply, events, agent } = await ask("", [
      `{"thought":"","speech":"","action":""}`,
      `{"thought":"Enough.","speech":"Not tonight."}`,
    ]);
    assert.equal(agent.calls, 2);
    assert.equal(reply.speech, "Not tonight.");
    assert.ok(events.some(e => e.t === "repair" && /nothing usable/.test(e.why)));
  });
});

// -- THE CONTRADICTION-ONLY DECISION PROCEDURE -------------------------------
// Wording assertions (tests/consult-prompts.test.ts, "the retry template") pin what the judge is
// told. These pin the mechanics behind each leg of the procedure — the parts checkable without a
// model. The model-side half of each case (what a live judge actually verdicts) is the owner's
// live A/B runs; the scenario for each is named in the comment.
describe("the contradiction-only decision procedure", () => {
  it("a departure that breaks nothing established is accepted — e.g. leaving when staying was expected", () => {
    // Live: a character expected to stay instead leaves the room, with nothing on record saying
    // they would not. The judge must ACCEPT; "wrong fork" is a not-ground, not a verdict.
    assert.equal(nonPovThoughtOnly({ speech: "", action: "She walks out without a word." }, true), null);
    assert.match(P.JUDGE_FORMAT, /only surprising, unwelcome, or odd\?\s+ACCEPT/);
    assert.match(P.JUDGE_FORMAT, /the wrong fork/);
  });

  it("reaching through a CANNOT stays retry ground — e.g. magic against cannot: magic", () => {
    // Live: the answer uses magic with cannot: magic on record. The judge must RETRY; I2 does not
    // move, so the cast block and the absolute rule still reach the judge byte-identical.
    const s = P.judgeSystem([{ name: "RIVEN", can: [], cannot: ["magic"] }]);
    assert.match(s, /CANNOT: magic/);
    assert.match(s, /A CANNOT is absolute/);
    assert.match(P.JUDGE_FORMAT, /one of their CANNOTs\?\s+RETRY/);
  });

  it("unknowable knowledge stays retry ground — e.g. a fact nobody told them and they could not witness", () => {
    // Live: the answer states a fact the character had no way to perceive or already hold. The
    // judge must RETRY. No mechanical gate can see this — it is model-side — so the prompt leg is
    // the whole checkable claim here.
    assert.match(P.JUDGE_FORMAT, /no way to perceive or already hold\?\s+RETRY/);
  });

  it("reaching outside a listed skill but not a CANNOT is accepted — the fence-removal check", () => {
    // Live: no lockpicking skill on the list, but the character tries the lock anyway. The judge
    // must ACCEPT. This is the case that actually tests whether the skill-fence removal took: the
    // floor function takes only the reply and the POV — no skill list, no wants — so no skill can
    // fail it, and the judge is told outright that an unlisted skill is not a ground.
    assert.equal(nonPovThoughtOnly.length, 1, "reply and POV only: nothing to consult a skill list with");
    assert.equal(nonPovThoughtOnly({ speech: "", action: "She works the lock with a bent pin, slowly." }, true), null);
    assert.match(P.JUDGE_FORMAT, /outside a listed skill/);
  });

  it("a natural-reading inference needs no need and no note — e.g. the coat hanging nearby in the rain", async () => {
    // Live: rain outside, a coat hanging nearby, the character takes it and goes without asking
    // need for it. The ask-first default is gone (Block A), and the only floor left accepts the
    // deed: no clarification is spent and no repair fires.
    const events: ConsultEvent[] = [];
    const agent = new ScriptedAgent([
      `{"thought":"Rain. That coat will do.","speech":"","action":"She takes the hanging coat and steps out into the rain."}`,
    ]);
    const reply = await consult(agent,
      { character: "TESTER", situation: "Rain hammers the windows; a coat hangs by the door.", question: "q", wants: "" },
      { clarifications: 2, clarify: async () => "two paces", log: (e: ConsultEvent) => events.push(e) });
    assert.equal(agent.calls, 1);
    assert.equal(reply.action, "She takes the hanging coat and steps out into the rain.");
    assert.equal(reply.note, "");
    assert.ok(!events.some(e => e.t === "need" || e.t === "repair"));
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
  // The directed door still carries a question — the judge's internal record of the contradiction
  // it is repairing — but no longer any output shape: wants is an inert record, never a refusal.
  const good = { character: "RIVEN", situation: "You are kneeling by the steel service door, wrench in the cylinder.",
                 question: "Do you turn it now?", wants: "decision" };

  it("passes a real consult through, carrying wants as an inert record", () => {
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
      assert.match(r.why, /contradiction|repair/);
    }
  });

  it("keeps the questions that name a contradiction and its repair", () => {
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

  it("accepts a missing or unreadable wants — the shape requirement is gone", () => {
    // The inversion at the heart of Block B: this assertion used to refuse. wants is inert now,
    // so every one of these passes, carrying "" or whatever canonicalized.
    for (const wants of ["", "???", "speech", "what they decide"]) {
      const r = normalizeConsult({ ...good, wants }, undefined, "directed");
      assert.ok(r.ok, `"${wants}" should no longer be refused`);
    }
    const carried = normalizeConsult({ ...good, wants: "" }, undefined, "directed");
    assert.ok(carried.ok);
    assert.equal(carried.req.wants, "");
  });

  it("says what is wrong in terms the writer can act on", () => {
    for (const bad of [{ situation: "" }, { situation: "Dark." }, { question: "What do you do?" },
                        { question: "" }]) {
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
