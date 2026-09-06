/**
 * Consult protocol tests — consult, neglectedCast, writeInstruction, canonWants.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  consult, canonWants, type ConsultEvent, type ConsultRequest, type Clarifier,
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
    for (const w of ["speech", "action", "decision", "reaction"]) assert.equal(canonWants(w), w);
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
