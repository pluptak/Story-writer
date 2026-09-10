/**
 * Consult prompt formatting tests — judgeRequest through narrationLintSystem.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CONSULT_WANTS,
} from "../engine/consult.ts";
import * as P from "../prompts.ts";

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

describe("the autonomous character format", () => {
  const sys = () => P.characterSystem({
    persona: "A night porter.",
    place: "The lobby.",
    skills: [{ name: "keys", meaning: "carrying every key" }],
    limits: ["sight"],
    knows: "The lock sticks.",
    goal: "Keep the door shut.",
  });

  it("is structured as identity / capabilities / memory / situation / motivation", () => {
    const s = sys();
    for (const head of ["IDENTITY", "CAPABILITIES", "MEMORY", "CURRENT SITUATION", "MOTIVATION"])
      assert.match(s, new RegExp(head));
  });

  it("states hard limits to the character for the first time, as absolute", () => {
    const s = sys();
    assert.match(s, /HARD LIMITS/);
    assert.match(s, /sight/);
    assert.match(s, /absolute/);
  });

  it("frames skills as tendencies, not a fence", () => {
    assert.match(P.CHARACTER_FORMAT, /TENDENCIES, NOT A FENCE/);
    assert.match(P.CHARACTER_FORMAT, /clumsily/);
    assert.ok(!P.CHARACTER_FORMAT.includes("STAY INSIDE YOUR SKILLS"));
  });

  it("defaults to inference over asking, reserving need for load-bearing facts", () => {
    assert.match(P.CHARACTER_FORMAT, /FIRST DECIDE: know it, infer it, assume it, or ask/);
    assert.match(P.CHARACTER_FORMAT, /would change WHAT YOU DO/);
  });

  it("reserves note for material assumptions, not every inference", () => {
    assert.match(P.CHARACTER_FORMAT, /MATERIALLY/);
  });

  it("permits surprising the writer and closes as the character, not the author's intention", () => {
    assert.match(P.CHARACTER_FORMAT, /betray/);
    assert.match(P.CHARACTER_FORMAT, /PLAY THE CHARACTER, DO NOT PLAY THE AUTHOR'S INTENTION/);
  });

  it("keeps the reply schema unchanged", () => {
    assert.match(P.CHARACTER_FORMAT, /"thought"/);
    assert.match(P.CHARACTER_FORMAT, /\{"need"/);
  });

  it("threads def.limits through wrapCharacter", async () => {
    const { loadStory } = await import("../engine/story-format.ts");
    const { wrapCharacter } = await import("../engine/scene-loop.ts");
    const sc = await loadStory("tests/fixtures/doorway");
    const merritt = sc.characters.find(c => c.name === "MERRITT")!;
    assert.ok(merritt.limits.length > 0, "fixture needs a CANNOT for this to mean anything");
    const p = wrapCharacter(merritt, sc.scenes[0].place);
    assert.match(p, /HARD LIMITS/);
    for (const l of merritt.limits) assert.ok(p.includes(l));
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
