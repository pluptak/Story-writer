/**
 * Consult protocol tests — consult, neglectedCast, canonWants, normalizeConsult.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  consult, normalizeConsult, canonWants, parseVerdict, parseClarifyAnswer, missingShape,
  reviseConsult, CONSULT_WANTS, type ConsultEvent, type ConsultRequest,
} from "../engine/consult.ts";
import * as P from "../prompts.ts";
import { wrapCharacter, wrapWriter, writerCast, neglectedCast, runChapter } from "../engine/scene-loop.ts";
import { Agent } from "../engine/agent.ts";
import { ScriptedAgent } from "./helpers.ts";
import type { Skill } from "../engine/skills.ts";

// -- CONSULT PROTOCOL ------------------------------------------------------
const REQ: ConsultRequest = { character: "TESTER", situation: "s", question: "q", wants: "" };
const SKILLS: Skill[] = [
  { name: "movement", meaning: "", source: "general" },
  { name: "speech", meaning: "", source: "general" },
];
const run = (script: string[], clarifications = 2, clarify = async () => "two paces") => {
  const events: ConsultEvent[] = [];
  const agent = new ScriptedAgent(script);
  return consult(agent, REQ, SKILLS, { clarifications, clarify, log: e => events.push(e) })
    .then(reply => ({ reply, events, agent }));
};

describe("consult", () => {
  it("answers straight through and reports the skills used", async () => {
    const { reply, agent } = await run([`{"speech":"Early enough.","skills_used":["speech"]}`]);
    assert.equal(agent.calls, 1);
    assert.equal(reply.speech, "Early enough.");
    assert.deepEqual(reply.skillsUsed, ["speech"]);
    assert.deepEqual(reply.unverified, []);
    assert.equal(reply.forced, false);
  });

  it("relays a clarifying question and feeds the answer back", async () => {
    const { reply, events } = await run([
      `{"need":"Can I reach the door handle?"}`,
      `{"action":"I reach for it.","skills_used":["movement"]}`,
    ]);
    assert.deepEqual(reply.clarifications, [{ question: "Can I reach the door handle?", answer: "two paces" }]);
    assert.deepEqual(events.map(e => e.t), ["consult", "need", "clarify", "answer"]);
  });

  it("stops asking once the clarification budget is spent and answers anyway", async () => {
    const { reply, events } = await run([
      `{"need":"one?"}`, `{"need":"two?"}`, `{"action":"I go anyway.","skills_used":["movement"]}`,
    ], 1);
    assert.equal(reply.clarifications.length, 1);      // only the first was answered
    assert.equal(reply.forced, true);
    assert.ok(events.some(e => e.t === "forced"));
  });

  it("an unanswerable clarification does not stall the consult", async () => {
    const { reply } = await run([`{"need":"anything?"}`, `{"action":"I decide.","skills_used":["movement"]}`],
                                2, async () => "");
    assert.equal(reply.clarifications[0].answer, "(no answer)");
    assert.equal(reply.action, "I decide.");
  });

  it("re-asks once when a skill is claimed that the character does not have", async () => {
    const { reply, events, agent } = await run([
      `{"action":"I pick the lock.","skills_used":["lockpicking"]}`,
      `{"action":"I knock instead.","skills_used":["movement"]}`,
    ]);
    assert.equal(agent.calls, 2);
    assert.deepEqual(reply.unverified, []);
    assert.equal(reply.action, "I knock instead.");
    assert.ok(events.some(e => e.t === "repair"));
    assert.ok(!events.some(e => e.t === "skill_flag"));
  });

  it("flags rather than silently accepts when the repair fails too", async () => {
    const { reply, events } = await run([
      `{"action":"I pick the lock.","skills_used":["lockpicking"]}`,
      `{"action":"I pick it anyway.","skills_used":["lockpicking","movement"]}`,
    ]);
    assert.deepEqual(reply.unverified, ["lockpicking"]);
    assert.equal(reply.action, "I pick it anyway.");   // the answer still reaches the author
    assert.ok(events.some(e => e.t === "skill_flag"));
  });

  it("repairs a reply with no thought, speech or action", async () => {
    const { reply, events } = await run([`{"skills_used":["speech"]}`, `{"speech":"Fine."}`]);
    assert.equal(reply.speech, "Fine.");
    assert.ok(events.some(e => e.t === "repair" && e.why.includes("nothing usable")));
  });

  it("gives up on a character that will not stop asking, in a bounded number of calls", async () => {
    const forever = Array(50).fill(`{"need":"but where exactly?"}`);
    const { reply, agent } = await run(forever, 2);
    assert.equal(agent.calls, 5, "2 clarifications + 1 forced + 1 repair + the reply that is read");
    assert.equal(reply.thought + reply.speech + reply.action, "");
    assert.match(reply.note, /kept asking/);
    assert.equal(reply.forced, true);
  });

  it("never touches the agent's history — the caller owns what becomes memory", async () => {
    const { agent } = await run([
      `{"need":"where?"}`, `{"action":"I move.","skills_used":["movement"]}`,
    ]);
    assert.equal(agent.history.length, 0);
  });

  it("a fork carries the persona and none of the history", () => {
    const a = new Agent("RIVEN", "m", "persona", 0.9);
    a.think = "high";
    a.hear("something that happened");
    const f = a.fork();
    assert.equal(f.system, a.system);
    assert.equal(f.model, a.model);
    assert.equal(f.think, a.think);
    assert.equal(f.history.length, 0);
    assert.equal(a.history.length, 1);
  });
});

// -- WHAT A CONSULT MUST CONTAIN ------------------------------------------
describe("neglectedCast", () => {
  it("names nobody before the cast has had a fair chance", () => {
    assert.deepEqual(neglectedCast(["RIVEN", "MERRITT"], new Map(), 0, 3), []);
    assert.deepEqual(neglectedCast(["RIVEN", "MERRITT"], new Map(), 2, 3), []);
  });

  it("names a cast member never consulted, once the gap has passed", () => {
    const lastAsked = new Map([["riven", 1]]);
    assert.deepEqual(neglectedCast(["RIVEN", "MERRITT"], lastAsked, 3, 3), ["MERRITT"]);
  });

  it("stops naming someone once they are asked again, and resumes after another full gap", () => {
    const lastAsked = new Map([["riven", 4], ["merritt", 6]]);
    assert.deepEqual(neglectedCast(["RIVEN", "MERRITT"], lastAsked, 6, 3), []);
    assert.deepEqual(neglectedCast(["RIVEN", "MERRITT"], lastAsked, 8, 3), ["RIVEN"]);
  });

  it("is case-insensitive against how lastAsked is keyed", () => {
    assert.deepEqual(neglectedCast(["Merritt"], new Map([["merritt", 3]]), 6, 3), ["Merritt"]);
  });
});

describe("canonWants", () => {
  it("takes the four exactly", () => {
    for (const w of CONSULT_WANTS) assert.equal(canonWants(w), w);
    assert.equal(canonWants("  Speech "), "speech");
  });

  it("canonicalizes what a writer actually writes", () => {
    assert.equal(canonWants("what they do next"), "action");        // 4 of 5 logged consults
    assert.equal(canonWants("what they say"), "speech");
    assert.equal(canonWants("whether they move aside"), "decision", "a fork beats the verb in it");
    assert.equal(canonWants("how she reacts"), "reaction");
  });

  it("returns null rather than guessing when there is no shape in it", () => {
    assert.equal(canonWants(""), null);
    assert.equal(canonWants("   "), null);
    assert.equal(canonWants(undefined), null);
    assert.equal(canonWants("please"), null);
    assert.equal(canonWants("how she takes it"), null, "a paraphrase with no keyword is refused, not guessed at");
  });
});

// -- WHAT THE JUDGE IS SHOWN ----------------------------------------------
describe("judgeRequest", () => {
  const p = {
    name: "RIVEN", situation: "You are kneeling by the steel service door.",
    question: "Do you turn it, or ease off?", wants: "decision", thought: "t", speech: "s", action: "a",
    note: "", flags: "",
  };

  it("shows the judge the situation it is told to repair", () => {
    // Without it, "fix the SITUATION, not the question" asks for a repair to something unseen.
    assert.match(P.judgeRequest(p), /You are kneeling by the steel service door\./);
  });

  it("names the shape that was asked for, so a short answer is visible as one", () => {
    assert.match(P.judgeRequest({ ...p, wants: "speech" }), /needed from them: speech/);
  });

  it("keeps the question and the answer alongside it", () => {
    const s = P.judgeRequest(p);
    for (const part of [p.question, "thought: t", "speech: s", "action: a"]) assert.ok(s.includes(part));
  });
});

describe("the retry template", () => {
  it("names every field a retry has to carry", () => {
    // A field absent from the template is a field the model does not send: `wants` was missing from
    // 17 of 17 logged retries, and `note` came back empty in 13 of them.
    for (const field of ["revised", "situation", "question", "wants", "note"])
      assert.match(P.JUDGE_FORMAT, new RegExp(`"${field}"`));
  });

  it("spells out the four wants", () => {
    for (const w of CONSULT_WANTS) assert.match(P.JUDGE_FORMAT, new RegExp(w));
  });

  it("tells the judge not to paste the prose back as a situation", () => {
    assert.match(P.JUDGE_FORMAT, /Do not paste back the prose you wrote/);
  });

  it("tells the judge that only a reaction is answered by a thought", () => {
    assert.match(P.JUDGE_FORMAT, /Only\s+a reaction is answered by a thought alone/);
  });
});

// -- ONE SCHEMA PER AGENT -------------------------------------------------
describe("the author-side agents each hold exactly one schema", () => {
  const cast = [{ name: "RIVEN", can: ["movement"], cannot: ["sight"] }];
  const judge = P.judgeSystem(cast);
  const clarify = P.clarifySystem({
    premise: "a premise", scene: { place: "a door", question: "does it open?" },
    facts: ["the lock is old"], cast,
  });

  it("the writer no longer carries the judge's or the clarifier's shape", () => {
    // The whole point of splitting them out: with both here, the [WRITE] pattern won 7 times in 55.
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

// -- A REVISION GOES THROUGH THE SAME DOOR --------------------------------
describe("reviseConsult", () => {
  const prev: ConsultRequest = {
    character: "RIVEN", situation: "You are kneeling by the steel service door, wrench in the cylinder.",
    question: "Do you turn it, or ease off?", wants: "decision",
  };

  it("keeps what the judge left out", () => {
    const r = reviseConsult(prev, { question: "Do you turn it, knowing what it wakes?" });
    assert.ok(r.ok);
    assert.equal(r.req.situation, prev.situation, "an omitted field falls back, it does not blank");
    assert.equal(r.req.wants, "decision");
    assert.equal(r.req.question, "Do you turn it, knowing what it wakes?");
  });

  it("takes a whole new consult when the judge writes one", () => {
    const r = reviseConsult(prev, {
      situation: "The corridor has gone quiet and the wrench is still in your hand.",
      question: "Do you call out, or keep working?", wants: "speech",
    });
    assert.ok(r.ok);
    assert.equal(r.req.wants, "speech");
    assert.match(r.req.situation, /corridor has gone quiet/);
  });

  it("refuses a revision the front door would have refused", () => {
    // The actual regression: "What do you do?" is rejected as a first consult, and used to be sent
    // anyway as a retry because the revision skipped the check.
    const r = reviseConsult(prev, { question: "What do you do?" });
    assert.ok(!r.ok);
    assert.match(r.why, /fork|stake/);
  });

  it("refuses a revision that guts the situation", () => {
    assert.ok(!reviseConsult(prev, { situation: "It is dark." }).ok);
  });

  it("canonicalizes a revised wants, and ignores one it cannot read", () => {
    assert.equal((reviseConsult(prev, { wants: "what they say" }) as any).req.wants, "speech");
    assert.equal((reviseConsult(prev, { wants: "???" }) as any).req.wants, "decision", "falls back");
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

  it("lets a reaction be answered by a thought alone", () => {
    // The one shape that happens behind the eyes; holding it to speech or action would be wrong.
    assert.equal(missingShape("reaction", { speech: "", action: "" }), null);
  });

  it("asks nothing of a consult that named no shape", () => {
    assert.equal(missingShape("", { speech: "", action: "" }), null);
  });
});

describe("consult, on the shape it was asked for", () => {
  const ask = (wants: ConsultRequest["wants"], script: string[]) => {
    const events: ConsultEvent[] = [];
    const agent = new ScriptedAgent(script);
    return consult(agent, { ...REQ, wants }, SKILLS, {
      clarifications: 2, clarify: async () => "two paces", log: e => events.push(e),
    }).then(reply => ({ reply, events, agent }));
  };

  it("re-asks a character that thought about it instead of answering", async () => {
    const { reply, events, agent } = await ask("speech", [
      `{"thought":"I weigh it up.","speech":"","action":""}`,
      `{"thought":"Enough.","speech":"Not tonight.","skills_used":["speech"]}`,
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

describe("normalizeConsult", () => {
  const good = { character: "RIVEN", situation: "You are kneeling by the steel service door, wrench in the cylinder.",
                 question: "Do you turn it, or ease off?", wants: "decision" };

  it("passes a real consult through, canonicalizing wants", () => {
    const r = normalizeConsult({ ...good, wants: "what they decide" });
    assert.ok(r.ok);
    assert.equal(r.req.wants, "decision");
    assert.equal(r.req.question, good.question);
    assert.equal(r.req.character, "RIVEN");
  });

  it("refuses an empty situation", () => {
    const r = normalizeConsult({ ...good, situation: "" });
    assert.ok(!r.ok);
    assert.match(r.why, /only world/);
  });

  it("refuses a situation too thin to answer from", () => {
    const r = normalizeConsult({ ...good, situation: "It is dark." });
    assert.ok(!r.ok);
    assert.match(r.why, /3 words/);
  });

  it("refuses an empty question", () => {
    assert.ok(!normalizeConsult({ ...good, question: "" }).ok);
  });

  it("refuses the questions that ask for nothing", () => {
    for (const q of ["What do you do?", "What does Elara do?", "What does Riven do next with the pick?",
                     "What happens next?", "Your move?"]) {
      const r = normalizeConsult({ ...good, question: q });
      assert.ok(!r.ok, `"${q}" should have been refused`);
      assert.match(r.why, /fork|stake/);
    }
  });

  it("keeps the questions that name a fork or a cost", () => {
    for (const q of ["Do you type the abort command?",
                     "Do you wake him or let him sleep?",
                     "Do you shift to get more comfortable, or stay perfectly still?",
                     "What do you say when he asks you directly?",
                     "Do you say the name, knowing what it admits?"]) {
      assert.ok(normalizeConsult({ ...good, question: q }).ok, `"${q}" should have been allowed`);
    }
  });

  it("refuses a wants it cannot make sense of, and names the four", () => {
    const r = normalizeConsult({ ...good, wants: "" });
    assert.ok(!r.ok);
    for (const w of CONSULT_WANTS) assert.match(r.why, new RegExp(w));
  });

  it("says what is wrong in terms the writer can act on", () => {
    for (const bad of [{ situation: "" }, { situation: "Dark." }, { question: "What do you do?" }, { wants: "" }]) {
      const r = normalizeConsult({ ...good, ...bad });
      assert.ok(!r.ok);
      assert.ok(r.why.length > 60, "a one-word complaint teaches nothing");
    }
  });
});
