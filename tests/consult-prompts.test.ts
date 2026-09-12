/**
 * Consult prompt formatting tests — judgeRequest through narrationLintSystem.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import * as P from "../prompts.ts";

// -- WHAT THE JUDGE IS SHOWN ----------------------------------------------
describe("judgeRequest", () => {
  const p = {
    name: "RIVEN", situation: "You are kneeling by the steel service door.",
    question: "Do you turn it now?", thought: "t", speech: "s", action: "a",
    note: "", flags: "",
  };

  it("shows the judge the situation it is told to repair", () => {
    // Without it, "fix the SITUATION, not the question" asks for a repair to something unseen.
    assert.match(P.judgeRequest(p), /You are kneeling by the steel service door\./);
  });

  it("names no wanted shape — the judge repairs contradictions, not output shapes", () => {
    // Block B: wants left the retry format, so showing one would invite judging against it.
    const s = P.judgeRequest({ ...p } as typeof p & { wants?: string });
    assert.ok(!/needed from them/.test(s), "the old wants line is gone");
    assert.ok(!/"wants"/.test(s));
  });

  it("keeps the question and the answer alongside it", () => {
    const s = P.judgeRequest(p);
    for (const part of [p.question, "thought: t", "speech: s", "action: a"]) assert.ok(s.includes(part));
  });

  it("says so when there was no question, rather than leaving the label empty", () => {
    const s = P.judgeRequest({ ...p, question: "", pov: false });
    assert.ok(!/You asked: *\n/.test(s), "the bare label is gone");
    assert.match(s, /You asked no question -- this was an open beat/);
  });

  it("marks the non-POV line as a flag, so it cannot read as the question's text", () => {
    // What it looked like before: "You asked: \nThey are not the point of view: ..." -- the flag
    // landed in the question's own slot and read as the thing the author had asked.
    const s = P.judgeRequest({ ...p, question: "", pov: false });
    assert.match(s, /\[NOT THE POINT OF VIEW\]/);
    const asked = s.split("\n").find(l => l.startsWith("You asked"))!;
    assert.ok(!asked.includes("point of view"), "the flag is its own line, not trailing the ask");
  });

  it("repairOnlyRequest renders the ask the same way — it is shown the same payload", () => {
    const s = P.repairOnlyRequest({ ...p, question: "", pov: false, why: "w" });
    assert.match(s, /You asked no question -- this was an open beat/);
    assert.match(s, /\[NOT THE POINT OF VIEW\]/);
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
    // Kept deliberately on the character side: directed retries still carry the inert wants
    // record, and refusing an answer for lacking a shape the character was never asked for
    // would be a trap, not a check. The judge, not the ask, is what stopped judging shapes.
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
    assert.match(P.JUDGE_FORMAT, /ONLY ONE OF THE TWO THEY WILL READ/);
  });

  it("defines acceptance positively — valid unless it contradicts established reality", () => {
    assert.match(P.JUDGE_FORMAT, /valid unless it contradicts reality already established/);
    assert.match(P.JUDGE_FORMAT, /protect continuity, not authorial intention/);
    assert.match(P.JUDGE_FORMAT, /A surprising choice is evidence about the character, not an error/);
  });

  it("decides through one explicit path to RETRY with everything else falling to ACCEPT", () => {
    assert.match(P.JUDGE_FORMAT, /DECIDE LIKE THIS/);
    for (const ground of ["an established fact about this character", "one of their CANNOTs",
                           "physically impossible", "no way to perceive",
                           "another character's private thoughts"]) {
      assert.ok(P.JUDGE_FORMAT.includes(ground), `missing retry ground: ${ground}`);
    }
  });

  it("names the not-grounds plainly, so no euphemism for dislike survives", () => {
    for (const ng of [/the wrong fork/, /the unexpected move/, /the inconvenient\s+choice/,
                       /what the writer intended/, /outside a listed skill/,
                       /more\s+elaboration than was asked for/]) {
      assert.match(P.JUDGE_FORMAT, ng, `missing not-ground: ${ng}`);
    }
  });

  it("names every field a retry has to carry — and wants is not one of them", () => {
    for (const field of ["revised", "situation", "question", "note"])
      assert.match(P.JUDGE_FORMAT, new RegExp(`"${field}"`));
    assert.ok(!/"wants"/.test(P.JUDGE_FORMAT), "wants left the retry schema");
    assert.ok(!/EXACTLY ONE of these four words/.test(P.JUDGE_FORMAT),
      "and the shape menu went with it — a listed skill is now a not-ground, not a verdict");
  });

  it("tells the judge not to paste the prose back as a situation", () => {
    assert.match(P.JUDGE_FORMAT, /Do not paste back the prose you wrote/);
  });

  it("tells the judge a thought alone answers only from inside the point of view", () => {
    assert.match(P.JUDGE_FORMAT, /a thought alone is a complete answer/);
    assert.match(P.JUDGE_FORMAT, /has to surface as a word or a movement/);
  });

  it("still refuses a retry that renames the contradiction and leaves the situation alone", () => {
    assert.match(P.JUDGE_FORMAT, /leaves the\s+situation alone re-sends them/);
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

describe("free consult (behavioral-steering strip spike)", () => {
  const sysArgs = {
    persona: "A night porter.",
    place: "The lobby.",
    skills: [{ name: "keys", meaning: "carrying every key" }],
    reach: [{ name: "the lobby doors", meaning: "they swing inward" }],
    limits: ["sight"],
    knows: "The lock sticks.",
    goal: "Keep the door shut.",
  };
  const req = { situation: "The alarm has been going for a minute and nobody has moved.",
                question: "Do you say the name, knowing what it admits?", wants: "speech" };

  it("defaults to the gated path — ENGINE.freeConsult is false", async () => {
    const { ENGINE } = await import("../engine/engine-state.ts");
    assert.equal(ENGINE.freeConsult, false);
  });

  it("FREE_CHARACTER_FORMAT drops only the play-the-character steering line", () => {
    assert.doesNotMatch(P.FREE_CHARACTER_FORMAT, /PLAY THE CHARACTER/);
    assert.ok(!P.FREE_CHARACTER_FORMAT.includes("You are not a writing assistant"),
      "the whole steering paragraph goes with the line");
    // Boundary content survives: protocol, ladder, knowledge, drives, tendencies, hard limits.
    for (const kept of [/YOUR OUTPUT FORMAT/, /"thought"/, /\{"need"/,
                         /FIRST DECIDE: know it, infer it, assume it, or ask/,
                         /WHAT YOU KNOW/, /WHAT YOU WANT IS THE POINT/,
                         /TENDENCIES, NOT A FENCE/, /HARD LIMIT/]) {
      assert.match(P.FREE_CHARACTER_FORMAT, kept);
    }
  });

  it("freeCharacterSystem renders the boundaries and drops the MOTIVATION closer", () => {
    const s = P.freeCharacterSystem(sysArgs);
    assert.ok(!s.includes("MOTIVATION:"), "the redundant steering closer is gone");
    assert.ok(!/PLAY THE CHARACTER/.test(s));
    for (const kept of ["IDENTITY", "CAPABILITIES", "MEMORY", "CURRENT SITUATION",
                        "HARD LIMITS", "sight", "the lobby doors", "Keep the door shut"]) {
      assert.ok(s.includes(kept), `boundary content lost: ${kept}`);
    }
  });

  it("freeMemoryMarker keeps the knowledge and drops the remembering suppression", () => {
    const mem = "the lighthouse keeps its beam on a half-minute swing";
    const s = P.freeMemoryMarker(mem);
    assert.match(s, /\[YOU REMEMBER\]/);
    assert.match(s, new RegExp(mem));
    assert.match(s, /You have always known this/);
    assert.match(s, /Act on it when it bears on what you are asked/);
    assert.doesNotMatch(s, /narrate remembering/);
  });

  it("freeAskBlock keeps the ask and drops the steering plus the attempt-3 nudge", () => {
    const s = P.freeAskBlock(req, 1);
    assert.match(s, /The alarm has been going/, "the situation is still their whole world");
    assert.match(s, /What they need from you: speech/, "the wanted shape still arrives");
    assert.match(s, /Ask for it instead/, "the ask-for-a-fact reminder stays");
    assert.ok(!s.includes("not a request you owe compliance to"));
    assert.ok(!/nobody is going to hand you a better one/.test(s), "THE_MOMENT_IS_YOURS is gone");
    const s3 = P.freeAskBlock(req, 3);
    assert.ok(!/This ask needs an answer/.test(s3), "no RETRY_NUDGE_FIRM append at attempt 3");
  });

  it("freeAskBlock keeps the REACTION_OUTWARD gloss for non-POV reactions", () => {
    const s = P.freeAskBlock({ situation: "Glass breaks across the room.", wants: "reaction" }, 1, false);
    assert.match(s, /surfacing where the room could catch it/);
  });
});

describe("free consult v2 (uncertainty-vs-missing-fact addendum)", () => {
  const sysArgs = {
    persona: "A night porter.",
    place: "The lobby.",
    skills: [{ name: "keys", meaning: "carrying every key" }],
    reach: [{ name: "the lobby doors", meaning: "they swing inward" }],
    limits: ["sight"],
    knows: "The lock sticks.",
    goal: "Keep the door shut.",
  };

  it("FREE_CHARACTER_FORMAT_V2 is v1 plus exactly the uncertainty paragraph", () => {
    assert.doesNotMatch(P.FREE_CHARACTER_FORMAT_V2, /PLAY THE CHARACTER/);
    assert.match(P.FREE_CHARACTER_FORMAT_V2, /NOT KNOWING WHAT IS TRUE IS NOT THE SAME AS NOT KNOWING WHAT TO DO/);
    assert.match(P.FREE_CHARACTER_FORMAT_V2, /suspect, guess, or\n  believe something/);
    // Every other line survives untouched — the only diff from v1 is the one inserted paragraph.
    const v1Lines = P.FREE_CHARACTER_FORMAT.split("\n");
    const v2Lines = P.FREE_CHARACTER_FORMAT_V2.split("\n");
    for (const line of v1Lines) assert.ok(v2Lines.includes(line), `v1 line dropped from v2: ${line}`);
  });

  it("freeCharacterSystemV2 renders over FREE_CHARACTER_FORMAT_V2 with the same boundary content as v1", () => {
    const s = P.freeCharacterSystemV2(sysArgs);
    assert.match(s, /NOT KNOWING WHAT IS TRUE IS NOT THE SAME AS NOT KNOWING WHAT TO DO/);
    assert.ok(!s.includes("MOTIVATION:"));
    for (const kept of ["IDENTITY", "CAPABILITIES", "MEMORY", "CURRENT SITUATION",
                        "HARD LIMITS", "sight", "the lobby doors", "Keep the door shut"]) {
      assert.ok(s.includes(kept), `boundary content lost: ${kept}`);
    }
  });
});

describe("free consult v3 (attempt-3 nudge reinstated, isolated from instruction)", () => {
  const req = { situation: "The alarm has been going for a minute and nobody has moved.",
                question: "Do you say the name, knowing what it admits?", wants: "speech" };

  it("freeAskBlockV3 matches freeAskBlock at attempt 1 — no nudge yet", () => {
    const v1 = P.freeAskBlock(req, 1);
    const v3 = P.freeAskBlockV3(req, 1);
    assert.equal(v3, v1, "attempt 1 should be identical to v1's askBlock");
  });

  it("freeAskBlockV3 appends the attempt-3 nudge that freeAskBlock omits", () => {
    const v1 = P.freeAskBlock(req, 3);
    const v3 = P.freeAskBlockV3(req, 3);
    assert.ok(!/This ask needs an answer/.test(v1), "v1/v2 stay nudge-free at attempt 3");
    assert.match(v3, /This ask needs an answer if there is any honest way to give one/);
    assert.ok(!v3.includes("not a request you owe compliance to"),
      "THE_MOMENT_IS_YOURS / compliance line stay gone — only the nudge comes back");
  });

  it("freeAskBlockV3 keeps the REACTION_OUTWARD gloss for non-POV reactions", () => {
    const s = P.freeAskBlockV3({ situation: "Glass breaks across the room.", wants: "reaction" }, 1, false);
    assert.match(s, /surfacing where the room could catch it/);
  });
});

// -- THE SPLIT JUDGE (--split-judge) ---------------------------------------
describe("split judge (verdict call and repair call, prototype)", () => {
  it("VERDICT_JUDGE_FORMAT keeps the decision ladder but drops the revision from its job", () => {
    assert.match(P.VERDICT_JUDGE_FORMAT, /DECIDE LIKE THIS/);
    assert.match(P.VERDICT_JUDGE_FORMAT, /one of their CANNOTs\?\s+RETRY/);
    assert.match(P.VERDICT_JUDGE_FORMAT, /only surprising, unwelcome, or odd\?\s+ACCEPT/);
    assert.match(P.VERDICT_JUDGE_FORMAT, /a thought alone is a complete answer/);
    assert.ok(!/"revised"/.test(P.VERDICT_JUDGE_FORMAT), "the verdict call still asks for a revision");
    assert.ok(!/"situation"/.test(P.VERDICT_JUDGE_FORMAT), "the verdict call still asks for a situation");
  });

  it("the verdict call's note is stated as the repair's only input", () => {
    assert.match(P.VERDICT_JUDGE_FORMAT, /the whole of what the repair is written from/);
    assert.match(P.VERDICT_JUDGE_FORMAT, /"note": "the contradiction, in one line -- required"/);
  });

  it("the note gloss demands both halves of the collision, not one", () => {
    // Measured: under the looser gloss models returned "Merritt CANNOT sight" (a fact, no
    // collision) and "thoughts of non-POV characters" (a rule, no answer), and one echoed the
    // schema's own placeholder back. The note is the repair call's entire input.
    assert.match(P.VERDICT_JUDGE_FORMAT, /BOTH halves/);
    assert.match(P.VERDICT_JUDGE_FORMAT, /what the answer actually said, in its own words/);
    assert.match(P.VERDICT_JUDGE_FORMAT, /Half a note is a note the repair cannot use/);
  });

  it("verdictJudgeSystem carries the cast block and the CANNOT absolute, like judgeSystem", () => {
    const s = P.verdictJudgeSystem([{ name: "RIVEN", can: ["lockpicking"], cannot: ["magic"] }]);
    assert.match(s, /RIVEN/);
    assert.match(s, /magic/);
    assert.match(s, /A CANNOT is absolute/);
  });

  it("the two wrong-shape nudges ask for their own call's shape, not each other's", () => {
    assert.ok(!/revised/.test(P.VERDICT_NOTE_ONLY), "the split verdict nudge still mentions revised");
    assert.match(P.VERDICT_NOTE_ONLY, /\{"verdict":"retry","note":"\.\.\."\}/);
    assert.match(P.REPAIR_SHAPE_ONLY, /\{"situation": "\.\.\.", "question": "\.\.\."\}/);
    assert.ok(!/verdict/.test(P.REPAIR_SHAPE_ONLY), "the repair nudge still mentions a verdict");
  });

  it("defaults to the single-call path — ENGINE.splitJudge is false", async () => {
    const { ENGINE } = await import("../engine/engine-state.ts");
    assert.equal(ENGINE.splitJudge, false);
  });
});
