/**
 * Consult protocol tests — consult, neglectedCast, canonWants, normalizeConsult.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  consult, normalizeConsult, normalizeReactionConsult, canonWants, parseVerdict, parseBatchVerdict, parseClarifyAnswer, missingShape,
  reviseConsult, parseLintVerdict, CONSULT_WANTS, type ConsultEvent, type ConsultRequest, type Clarifier,
} from "../engine/consult.ts";
import * as P from "../prompts.ts";
import { neglectedCast } from "../engine/scene-loop.ts";
import { Agent } from "../engine/agent.ts";
import { ScriptedAgent } from "./helpers.ts";

// -- CONSULT PROTOCOL ------------------------------------------------------
const REQ: ConsultRequest = { character: "TESTER", situation: "s", question: "q", wants: "" };
const run = (script: string[], clarifications = 2, clarify: Clarifier = async () => "two paces") => {
  const events: ConsultEvent[] = [];
  const agent = new ScriptedAgent(script);
  return consult(agent, REQ, { clarifications, clarify, log: e => events.push(e) })
    .then(reply => ({ reply, events, agent }));
};

describe("consult", () => {
  it("answers directly with speech in one call", async () => {
    const { reply, agent } = await run([`{"speech":"Early enough."}`]);
    assert.equal(agent.calls, 1);
    assert.equal(reply.speech, "Early enough.");
    assert.equal(reply.forced, false);
  });

  it("relays a clarifying question and feeds the answer back", async () => {
    const { reply, events } = await run([
      `{"need":"Can I reach the door handle?"}`,
      `{"action":"I reach for it."}`,
    ]);
    assert.deepEqual(reply.clarifications, [{ question: "Can I reach the door handle?", answer: "two paces" }]);
    assert.deepEqual(events.map(e => e.t), ["consult", "need", "clarify", "answer"]);
  });

  it("stops asking once the clarification budget is spent and answers anyway", async () => {
    const { reply, events } = await run([
      `{"need":"one?"}`, `{"need":"two?"}`, `{"action":"I go anyway."}`,
    ], 1);
    assert.equal(reply.clarifications.length, 1);      // only the first was answered
    assert.equal(reply.forced, true);
    assert.ok(events.some(e => e.t === "forced"));
  });

  it("an unanswerable clarification does not stall the consult", async () => {
    const { reply } = await run([`{"need":"anything?"}`, `{"action":"I decide."}`],
                                2, async () => "");
    assert.equal(reply.clarifications[0].answer, "(no answer)");
    assert.equal(reply.action, "I decide.");
  });

  it("an unreachable clarifier is told the author is done, not fed a fabricated answer", async () => {
    const { reply, events, agent } = await run([
      `{"need":"one?"}`, `{"need":"two?"}`, `{"action":"I go anyway."}`,
    ], 2, async () => null);
    assert.equal(agent.calls, 3, "no wasted retry of the dead clarifier on the second need");
    assert.equal(reply.clarifications.length, 0, "a failed clarify spends no clarification slot");
    assert.equal(reply.forced, true);
    assert.equal(reply.action, "I go anyway.");
    assert.deepEqual(events.filter(e => e.t === "clarify_failed").length, 1);
    assert.ok(!events.some(e => e.t === "clarify"), "nothing was fabricated as an answer");
  });

  it("a reply in labelled prose still answers, and says it did not arrive as JSON", async () => {
    const { reply, events } = await run([`**speech**: Early enough.\n**action**: I nod.`]);
    assert.equal(reply.speech, "Early enough.", "the prose fallback's fields are read as ever");
    assert.ok(events.some(e => e.t === "prose_reply"), "the degraded shape is recorded");
    assert.deepEqual(events.filter(e => e.t === "prose_reply").length, 1);
  });

  it("repairs a reply with no thought, speech or action", async () => {
    const { reply, events } = await run([`{}`, `{"speech":"Fine."}`]);
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
      `{"need":"where?"}`, `{"action":"I move."}`,
    ]);
    assert.equal(agent.history.length, 0);
  });

  it("a fork carries the persona and the accepted history so far", () => {
    const a = new Agent("RIVEN", "m", "persona", 0.9);
    a.think = "high";
    a.digest = "earlier, summarized";
    a.hear("something that happened");
    const f = a.fork();
    assert.equal(f.system, a.system);
    assert.equal(f.model, a.model);
    assert.equal(f.think, a.think);
    assert.equal(f.digest, a.digest);
    assert.deepEqual(f.history, a.history);
  });

  // The retry must be able to diverge without dragging the original along: what the fork is
  // asked, and whatever it answers, must never land in the history the accepted answer folds into.
  it("a fork's history is its own copy", () => {
    const a = new Agent("RIVEN", "m", "persona", 0.9);
    a.hear("something that happened");
    const f = a.fork();
    f.hear("the re-ask");
    f.said("the second answer");
    assert.equal(a.history.length, 1);
    assert.equal(f.history.length, 3);
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

  it("stops flagging a character once they are dropped from the active cast", () => {
    // writeScene passes the shrinking `active` set here, so an exited character never surfaces again.
    const lastAsked = new Map([["riven", 4]]);
    assert.deepEqual(neglectedCast(["RIVEN", "MERRITT"], lastAsked, 5, 3), ["MERRITT"]);
    assert.deepEqual(neglectedCast(["RIVEN"], lastAsked, 5, 3), []);
  });

  it("names nobody in a larger cast being attended to in strict rotation", () => {
    // One consult per step: four present cannot be asked more often than every fourth step, so a
    // fixed gap of 3 would name somebody here on every step of the scene, forever.
    const lastAsked = new Map([["riven", 5], ["merritt", 6], ["tibbs", 7], ["wren", 8]]);
    assert.deepEqual(neglectedCast(["RIVEN", "MERRITT", "TIBBS", "WREN"], lastAsked, 9, 3), []);
  });

  it("still names someone in a larger cast who is skipped past a full rotation", () => {
    const lastAsked = new Map([["riven", 3], ["merritt", 10], ["tibbs", 11], ["wren", 12]]);
    assert.deepEqual(neglectedCast(["RIVEN", "MERRITT", "TIBBS", "WREN"], lastAsked, 13, 3), ["RIVEN"]);
  });

  it("relaxes the threshold again as the cast shrinks", () => {
    const lastAsked = new Map([["riven", 5], ["merritt", 6], ["tibbs", 7], ["wren", 8]]);
    assert.deepEqual(neglectedCast(["RIVEN", "MERRITT"], lastAsked, 9, 3), ["RIVEN", "MERRITT"]);
  });
});

describe("writeInstruction", () => {
  const base = { maxProseWords: 140, overran: 0, neglected: [] as string[], hardCap: false };

  it("says nothing about length under 85% of target", () => {
    const msg = P.writeInstruction({ ...base, words: 50, target: 100 });
    assert.doesNotMatch(msg, /budget|at length|well past/);
  });

  it("warns softly between 85% and target", () => {
    const msg = P.writeInstruction({ ...base, words: 90, target: 100 });
    assert.match(msg, /almost out of budget/);
  });

  it("says to end once at or past target", () => {
    const msg = P.writeInstruction({ ...base, words: 100, target: 100 });
    assert.match(msg, /at length — bring the scene to its end/);
  });

  it("escalates past 130% of target", () => {
    const msg = P.writeInstruction({ ...base, words: 131, target: 100 });
    assert.match(msg, /well past length/);
    assert.doesNotMatch(msg, /at length — bring the scene to its end/);
  });

  it("demands an unconditional close when hardCap is set, overriding the softer tiers", () => {
    const msg = P.writeInstruction({ ...base, words: 250, target: 100, hardCap: true });
    assert.match(msg, /LAST PIECE OF THE SCENE/);
    assert.match(msg, /"scene_done": true/);
    assert.doesNotMatch(msg, /well past length/);
  });

  it("offers the exit as the other reading of a character who has gone quiet", () => {
    const msg = P.writeInstruction({ ...base, words: 50, target: 100, neglected: ["TIBBS"] });
    assert.match(msg, /TIBBS has gone unconsulted/);
    assert.match(msg, /written someone out the door, name them in "exit"/);
    assert.doesNotMatch(P.writeInstruction({ ...base, words: 50, target: 100 }), /exit/);
  });

  it("hands a fired world beat over as established fact, and is unchanged without one", () => {
    const plain = P.writeInstruction({ ...base, words: 50, target: 100 });
    const msg = P.writeInstruction({ ...base, words: 50, target: 100, fired: "The sounder took over." });
    assert.match(msg, /\[WORLD\] The sounder took over\. That has happened/);
    assert.match(msg, /nobody can decline it|nobody\s+can decline it/);
    assert.equal(P.writeInstruction({ ...base, words: 50, target: 100, fired: "" }), plain);
  });

  it("holds a withheld event back until it fires, and never sends both at once", () => {
    const held = P.writeInstruction({ ...base, words: 50, target: 100, hold: "the panel going into alarm" });
    assert.match(held, /\[HOLD\] the panel going into alarm -- that has NOT happened/);
    assert.doesNotMatch(held, /\[WORLD\]/);

    const both = P.writeInstruction({ ...base, words: 50, target: 100, fired: "It fired.", hold: "the panel going into alarm" });
    assert.match(both, /\[WORLD\]/);
    assert.doesNotMatch(both, /\[HOLD\]/);
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
    question: "Do you turn it now?", wants: "decision", thought: "t", speech: "s", action: "a",
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

describe("memorySurfaced", () => {
  it("renders the memory text and reads as knowledge, not as news", () => {
    const s = P.memorySurfaced("the lighthouse keeps its beam on a half-minute swing");
    assert.match(s, /the lighthouse keeps its beam on a half-minute swing/);
    assert.match(s, /WHAT YOU ALSO KNOW/);
  });

  it("begins with blank lines so it appends cleanly to an existing system prompt", () => {
    const s = P.memorySurfaced("anything");
    assert.match(s, /^\n\n/);
  });
});

describe("memoryMarker", () => {
  it("carries the memory and forbids narrating the act of remembering", () => {
    const mem = "the lighthouse keeps its beam on a half-minute swing";
    const s = P.memoryMarker(mem);
    assert.match(s, /\[YOU REMEMBER\]/);
    assert.match(s, new RegExp(mem));
    assert.match(s, /do not narrate remembering it/);
  });
});

describe("narrationLintRequest", () => {
  const base = {
    pov: "RIVEN", prose: "Riven crossed the room and reached for the door.",
    granted: [] as { character: string; speech: string; action: string }[],
    consult: null as { character?: string; reactors?: string[]; situation: string; question: string } | null,
  };

  it("carries the POV and the drafted prose", () => {
    const s = P.narrationLintRequest(base);
    assert.match(s, /RIVEN/);
    assert.match(s, /Riven crossed the room and reached for the door\./);
  });

  it("shows nobody has been granted anything yet", () => {
    assert.match(P.narrationLintRequest(base), /\(nobody yet\)/);
  });

  it("lists each granted line and deed", () => {
    const s = P.narrationLintRequest({ ...base,
      granted: [{ character: "MERRITT", speech: "No.", action: "" }, { character: "RIVEN", speech: "", action: "steps back" }] });
    assert.match(s, /MERRITT -- said: No\./);
    assert.match(s, /RIVEN -- did: steps back/);
  });

  it("lists a granted reaction as felt interiority, beside any line they gave", () => {
    const s = P.narrationLintRequest({ ...base,
      granted: [{ character: "MERRITT", speech: "Who's there?", action: "", thought: "Cold air. The door is open." }] });
    assert.match(s, /MERRITT -- said: Who's there\?/);
    assert.match(s, /-- felt: Cold air\. The door is open\./);
  });

  it("reactionsAnswered hands the writer exactly the line that was given, and no blanket dialogue ban",
    () => {
      const s = P.reactionsAnswered([{ name: "MERRITT", thought: "Cold air.", speech: "Who's there?" }]);
      assert.match(s, /says: "Who's there\?"/);
      assert.match(s, /render\s+exactly it and nothing more/);
      assert.ok(!/No dialogue/.test(s), "the old blanket ban would contradict the line just handed over");
    });

  it("omits the consult section entirely when there is no outgoing consult", () => {
    assert.doesNotMatch(P.narrationLintRequest(base), /CONSULT OPENED/);
  });

  it("names a single character asked, with the situation and question", () => {
    const s = P.narrationLintRequest({ ...base,
      consult: { character: "MERRITT", situation: "Your purse is gone from your coat.", question: "What do you do?" } });
    assert.match(s, /CONSULT OPENED BY THIS PIECE/);
    assert.match(s, /asking: MERRITT/);
    assert.match(s, /situation given: Your purse is gone from your coat\./);
    assert.match(s, /question: What do you do\?/);
  });

  it("lists reactors instead of a single character for a fan-out", () => {
    const s = P.narrationLintRequest({ ...base,
      consult: { reactors: ["ELARA", "MIRA"], situation: "s", question: "q" } });
    assert.match(s, /reactors: ELARA, MIRA/);
  });
});

describe("narrationFlagged", () => {
  it("carries the reason verbatim", () => {
    assert.match(P.narrationFlagged("MERRITT was given a line nobody asked for."),
                 /MERRITT was given a line nobody asked for\./);
  });

  it("tells the writer to redraft rather than continue", () => {
    assert.match(P.narrationFlagged("why"), /[Rr]edraft/);
    assert.match(P.narrationFlagged("why"), /not written to the page/);
  });
});

describe("clarifyRequest", () => {
  it("carries the asking character's own knows, labelled with their name", () => {
    const s = P.clarifyRequest("MERRITT", "Is the door locked?", "You sit by the door.",
                               "", "The lock has been sticking for a month.");
    assert.match(s, /WHAT MERRITT KNOWS COMING IN\] The lock has been sticking/);
  });

  it("omits the knows section when the character has none", () => {
    const s = P.clarifyRequest("RIVEN", "Is the door locked?", "You stand by the door.");
    assert.doesNotMatch(s, /KNOWS COMING IN/);
  });
});

describe("what the character is sent", () => {
  const req = { situation: "The alarm has been going for a minute and nobody has moved.",
                question: "Do you say the name, knowing what it admits?", wants: "speech" };

  it("gives them the situation and never the question", () => {
    // Stage 2 of the open-beat experiment: the author still writes the question -- it gates the
    // consult, anchors the judge, travels with the answer on the record -- but the character
    // answers the moment, not the fork the author picked out of it.
    const sent = P.askBlock(req);
    assert.match(sent, /The alarm has been going/, "the situation is their whole world");
    assert.ok(!sent.includes(req.question), "the question they were never shown is not in the ask");
    assert.ok(!/\bQuestion:/.test(sent), "and no empty label is left behind where it used to be");
  });

  it("still names the shape the answer has to arrive in", () => {
    // Kept deliberately: missingShape refuses an answer for lacking a shape, and refusing one the
    // character was never asked for would be a trap, not a check.
    assert.match(P.askBlock(req), /What they need from you: speech/);
  });

  it("puts the moment to them as theirs to take", () => {
    assert.match(P.askBlock(req), /nobody is going to hand you a better one/);
  });

  it("keeps the door to asking for a missing fact open", () => {
    // With no question, {"need": ...} is the only way a character can repair a thin situation.
    assert.match(P.askBlock(req), /Ask for it instead/);
  });

  it("folds the situation and the shape, and none of the standing instructions", () => {
    // The three assertions above cover the LIVE ask, which is unchanged. History keeps only the
    // record: everything else in askBlock is pressure to answer now, and re-reading it once per
    // consult for the rest of the scene is the cost the un-escalated fold refuses to pay.
    const fold = P.foldedAsk(req);
    assert.match(fold, /The alarm has been going/, "the situation it was asked about survives");
    assert.match(fold, /What they need from you: speech/, "and the shape that was wanted");
    assert.ok(!fold.includes(req.question), "still never the question");
    for (const gone of [/nobody is going to hand you a better one/, /Ask for it instead/,
                        /not a request you owe compliance to/, /the words they say/]) {
      assert.ok(!gone.test(fold), `standing instruction left in the fold: ${gone}`);
    }
    assert.ok(P.foldedAsk(req).length * 2 < P.askBlock(req).length, "and it is much shorter");
  });
});

describe("the retry template", () => {
  it("tells the judge that only the situation reaches them", () => {
    // Without this the judge sharpens the question on retry, the character sees an identical ask,
    // and a fresh instance answers identically — a retry spent on nothing.
    assert.match(P.JUDGE_FORMAT, /ONLY ONE OF THE THREE THEY WILL READ/);
  });

  it("does not let the judge retry an answer for taking a fork it had not planned", () => {
    assert.match(P.JUDGE_FORMAT, /is NOT unusable/);
    assert.match(P.JUDGE_FORMAT, /the moment was theirs to read/);
  });

  it("names every field a retry has to carry", () => {
    // A field missing from the template is a field the model does not send: `wants` was missing from
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

  it("tells the judge a thought alone answers only from inside the point of view", () => {
    assert.match(P.JUDGE_FORMAT, /a thought alone is a complete answer/);
    assert.match(P.JUDGE_FORMAT, /has to surface as a word or a movement/);
  });
});

describe("the narration lint format", () => {
  it("names the two reply shapes", () => {
    assert.match(P.NARRATION_LINT_FORMAT, /"ok":\s*true/);
    assert.match(P.NARRATION_LINT_FORMAT, /"ok":\s*false/);
  });

  it("names THE ONE RULE, CANNOT, and situation concreteness as what it checks", () => {
    assert.match(P.NARRATION_LINT_FORMAT, /THE ONE RULE/);
    assert.match(P.NARRATION_LINT_FORMAT, /CANNOT/);
    assert.match(P.NARRATION_LINT_FORMAT, /consequence/);
  });

  it("passes descriptions when in doubt but flags invented deeds and meaningful stillness, not quotations",
    () => {
      assert.match(P.NARRATION_LINT_FORMAT,
        /When in\s+doubt about a description, pass it; when in doubt about an invented deed or\s+meaningful stillness, flag it/);
    });

  it("tells the LLM quotations are checked mechanically, so it must not re-check dialogue",
    () => {
      assert.match(P.NARRATION_LINT_FORMAT,
        /Quotations are checked mechanically before you are called, so do NOT re-check\s+dialogue/);
    });

  it("narrows the incidental-continuity exemption to involuntary body continuation", () => {
    assert.match(P.NARRATION_LINT_FORMAT, /Involuntary continuity/);
    assert.match(P.NARRATION_LINT_FORMAT, /a breath, a flinch, weight shifting on a crate -- is not a deed/);
  });

  it("keeps stillness a choice inside the lint, matching THE ONE RULE rather than contradicting it",
    () => {
      assert.match(P.NARRATION_LINT_FORMAT,
        /Staying still, saying nothing, waiting, letting the moment pass are NOT covered by that exemption/);
      assert.ok(!/reacting within what this\s+piece already established/.test(P.NARRATION_LINT_FORMAT),
        "the old carve-out licensed exactly what the rule reserves for the character");
    });

  it("excepts granted interiority from the not-narratable clause, so a rendered reaction is not flagged",
    () => {
      assert.match(P.NARRATION_LINT_FORMAT,
        /The one exception is interiority this\s+scene was actually given: a thought shown under ALREADY GRANTED as "-- felt:"/);
    });
});

describe("narrationLintSystem", () => {
  it("carries the cast's can/cannot block", () => {
    const s = P.narrationLintSystem([{ name: "RIVEN", can: ["lockpicking"], cannot: ["sight"] }]);
    assert.match(s, /RIVEN -- can: lockpicking/);
    assert.match(s, /CANNOT: sight/);
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
  const ask = (wants: ConsultRequest["wants"], script: string[]) => {
    const events: ConsultEvent[] = [];
    const agent = new ScriptedAgent(script);
    return consult(agent, { ...REQ, wants }, {
      clarifications: 2, clarify: async () => "two paces", log: e => events.push(e),
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
