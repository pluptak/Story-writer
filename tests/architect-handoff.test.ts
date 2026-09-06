/**
 * Handoff-related architect tests — NextChapterSession initialization, shared prompts, and contract validation.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  loadStory, type Defaults,
} from "../engine/story-format.ts";
import { normalizeSpec } from "../engine/story-spec.ts";
import { bibleFrom } from "../engine/skills.ts";
import { architectNextChapter, architectVerify } from "../prompts.ts";
import { ScaffoldSession, consultCostNote, bibleCandidates, applyImportContract, type ImportedCharacter } from "../engine/architect.ts";
import { ScriptedAgent } from "./helpers.ts";

// -- SCAFFOLD SUPPORT -------------------------------------------------------
const SCAFFOLD_DEFAULTS: Defaults = {
  models: { default: "none", architect: "none", assistant: "none" },
  thinking: { architect: "low", assistant: "low" },
  requestTimeout: 120, attempts: 3, maxTokens: 2000, stream: false, debug: false,
};

const STORY = {
  title: "The Fog Signal",
  premise: "Two keepers, one lamp, and a night that did not happen the way the log says it did.",
  scene: { place: "the lamp room", question: "Does Aster admit the signal never fired?", pov: "ASTER", length: 700 },
  writer_style: "Plain sentences. No weather as metaphor.",
  characters: [
    { name: "ASTER", persona: "Keeps the log in a small clear hand and has never once falsified it.",
      knows: "The signal did not fire.", skills: ["lamp-tending :: trimming and lighting the great lens"], restrictions: [] },
    { name: "BRAE", persona: "Came up from the boats and trusts the weather over anyone's paperwork.",
      knows: "", skills: [], restrictions: ["hearing"] },
  ],
};

// -- THE HANDOFF -----------------------------------------------------------
describe("architectNextChapter", () => {
  const chapters = [{ n: 1, text: "The lamp went out." }, { n: 2, text: "Nobody relit it." }];
  const spec = JSON.stringify({ title: "Dark", scenes: [{}, {}] });

  it("asks for the chapter after the last one written, however the list is ordered", () => {
    const p = architectNextChapter("A premise.", spec, [chapters[1], chapters[0]]);
    assert.match(p, /Prepare chapter 3\./);
    assert.match(p, /Chapters 1-2 of this story are written/);
  });

  it("hands over the premise, every chapter's prose, and the story as it stands", () => {
    const p = architectNextChapter("A lighthouse, unlit.", spec, chapters);
    assert.match(p, /A lighthouse, unlit\./);
    assert.match(p, /CHAPTER 1, as written[\s\S]*The lamp went out\./);
    assert.match(p, /CHAPTER 2, as written[\s\S]*Nobody relit it\./);
    assert.ok(p.includes(spec), "the architect edits the story it was shown");
  });

  it("says the engine carries nothing forward — the reason the handoff exists at all", () => {
    const p = architectNextChapter("A premise.", spec, chapters);
    assert.match(p, /No character remembers a word of an earlier chapter/);
    assert.match(p, /roster/);
  });

  it("gives the edit vocabulary, including both ways to reach the next chapter's scene", () => {
    const p = architectNextChapter("A premise.", spec, chapters);
    for (const field of ["add_character", "remove_character", "add_scene", "remove_scene",
                         "characters.<NAME>.persona", "scene_<n>.place", "scene_<n>.reach"])
      assert.ok(p.includes(field), `the handoff must name ${field}`);
    assert.match(p, /scene_3\.place/);       // re-author the scene the story already has
    assert.match(p, /add_scene/);            // or add it when it does not
  });

  it("says reach never travels: last chapter's grants are gone unless the new place re-offers them", () => {
    const p = architectNextChapter("A premise.", spec, chapters);
    assert.match(p, /reach never travels with a person|is gone now; reach never travels/);
    assert.match(p, /scene_3\.reach/, "the re-grant path is named concretely");
  });

  it("counts one written chapter in the singular", () => {
    const p = architectNextChapter("A premise.", spec, [chapters[0]]);
    assert.match(p, /Chapter 1 of this story is written/);
    assert.match(p, /Prepare chapter 2\./);
  });
});

describe("architectVerify: reach rules", () => {
  const specJson = JSON.stringify({
    title: "Dark", characters: [{ name: "AURA" }],
    scenes: [{ place: "the lobby", roster: ["AURA"], reach: { AURA: ["cameras :: seeing through the feed"] } }],
  });

  it("asks whether reach names an interface or a sense, and what establishes it", () => {
    const p = architectVerify(specJson, "scene_1");
    // reach-to-non-roster is now a mechanical check in normalizeSpec, not a model prompt bullet
    assert.ok(!/reach granted to someone who is not in scene_1\.roster/.test(p));
    assert.match(p, /named after the SENSE it substitutes for/);
    assert.match(p, /neither scene_1\.place nor "facts" ever establishes/);
    // I5 stays a judgement call for the model, never a mechanical refusal
    assert.match(p, /This one is a judgement/);
  });
});

describe("consultCostNote", () => {

  it("says nothing about a duo", () => {
    const spec = normalizeSpec({
      title: "Test", premise: "A story", tension: "", scene: { place: "", question: "", pov: "", length: 700 },
      characters: [
        { name: "A", persona: "", knows: "", skills: [], restrictions: [] },
        { name: "B", persona: "", knows: "", skills: [], restrictions: [] },
      ],
      facts: [], config: { maxSteps: 24 },
    }).spec;
    assert.equal(consultCostNote(spec), "");
  });

  it("says nothing while the budget is still wide", () => {
    const spec = normalizeSpec({
      title: "Test", premise: "A story", tension: "", scene: { place: "", question: "", pov: "", length: 700 },
      characters: [
        { name: "A", persona: "", knows: "", skills: [], restrictions: [] },
        { name: "B", persona: "", knows: "", skills: [], restrictions: [] },
        { name: "C", persona: "", knows: "", skills: [], restrictions: [] },
      ],
      facts: [], config: { maxSteps: 24 },
    }).spec;
    assert.equal(consultCostNote(spec), "");
  });

  it("prices a wide roster against a tight budget", () => {
    const spec = normalizeSpec({
      title: "Test", premise: "A story", tension: "", scene: { place: "", question: "", pov: "", length: 700 },
      characters: [
        { name: "A", persona: "", knows: "", skills: [], restrictions: [] },
        { name: "B", persona: "", knows: "", skills: [], restrictions: [] },
        { name: "C", persona: "", knows: "", skills: [], restrictions: [] },
        { name: "D", persona: "", knows: "", skills: [], restrictions: [] },
      ],
      facts: [], config: { maxSteps: 24 },
    }).spec;
    const note = consultCostNote(spec);
    assert.notEqual(note, "");
    assert.match(note, /4 characters/);
    assert.match(note, /24/);
    assert.match(note, /beats wide/);
  });

  it("says nothing before there is a cast", () => {
    const spec = normalizeSpec({
      title: "Test", premise: "A story", tension: "", scene: { place: "", question: "", pov: "", length: 700 },
      characters: [],
      facts: [], config: { maxSteps: 24 },
    }).spec;
    assert.equal(consultCostNote(spec), "");
  });

  // Roster cost is only news once there is a scene to spend the budget on, so the note is the
  // scene gate's alone. It also has to survive that gate's verify pass, which rebuilds `problems`
  // from its own reading a moment after the stage content lands.
  it("the consult cost shows at the scene gate, not before, and survives the verify pass", async () => {
    const STORY_STAGE = {
      title: "Test Story",
      premise: "A test premise",
      tension: "Character A wants X; Character B wants Y",
      facts: [],
    };
    const CAST_STAGE = {
      characters: [
        { name: "A", persona: "First character", knows: "fact", skills: [], restrictions: [] },
        { name: "B", persona: "Second character", knows: "fact", skills: [], restrictions: [] },
        { name: "C", persona: "Third character", knows: "fact", skills: [], restrictions: [] },
        { name: "D", persona: "Fourth character", knows: "fact", skills: [], restrictions: ["hearing"] },
      ],
    };
    const SETTINGS_STAGE = { writer_style: "Plain prose." };
    const TECHNICAL_STAGE = {
      config: { maxSteps: 24, clarifications: 1, retries: 3, maxProseWords: 120 },
    };
    const SCENE_STAGE = { scene: { place: "the place", question: "What happens?", pov: "A", length: 700, roster: ["A", "B", "C", "D"] } };

    const judgeSaying = (verdict: unknown) => () => new ScriptedAgent([JSON.stringify(verdict)]);
    const passingJudge = judgeSaying({ ok: true });
    const s = new ScaffoldSession(
      new ScriptedAgent([
        JSON.stringify(STORY_STAGE),
        JSON.stringify(CAST_STAGE),
        JSON.stringify(SETTINGS_STAGE),
        JSON.stringify(TECHNICAL_STAGE),
        JSON.stringify(SCENE_STAGE),
        JSON.stringify({ edits: [], note: "verified" }),
      ]),
      SCAFFOLD_DEFAULTS,
      "test idea",
      undefined,
      "staged",
      passingJudge
    );

    await s.propose();
    await s.approve();  // cast gate
    assert.doesNotMatch(s.problems.join(" "), /beats wide/, "no cost note at cast gate");

    await s.approve();  // settings gate
    assert.doesNotMatch(s.problems.join(" "), /beats wide/, "no cost note at settings gate");

    await s.approve();  // technical gate
    assert.doesNotMatch(s.problems.join(" "), /beats wide/, "no cost note at technical gate");

    await s.approve();  // scene gate
    assert.equal(s.stage, "scene");
    assert.equal(s.spec.characters.length, 4, "four in the roster");
    assert.equal(s.spec.config.maxSteps, 24, "24 steps, so six beats wide");
    assert.match(s.problems.join(" "), /4 characters against maxSteps 24/,
                 "the scene gate prices the roster the author asked for");
  });
});

describe("bibleCandidates", () => {

  it("a bespoke skill with a meaning is a candidate", () => {
    const spec = normalizeSpec({
      title: "Test", premise: "A story", tension: "", scene: { place: "", question: "", pov: "", length: 700 },
      characters: [
        { name: "A", persona: "", knows: "", skills: ["tidewalking :: reading the turn of a tide"], restrictions: [] },
      ],
      facts: [],
    }).spec;
    const candidates = bibleCandidates(spec);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].name, "tidewalking");
    assert.equal(candidates[0].meaning, "reading the turn of a tide");
    assert.deepEqual(candidates[0].heldBy, ["A"]);
  });

  it("a bare skill name with no meaning is not a candidate", () => {
    const spec = normalizeSpec({
      title: "Test", premise: "A story", tension: "", scene: { place: "", question: "", pov: "", length: 700 },
      characters: [
        { name: "A", persona: "", knows: "", skills: ["tidewalking"], restrictions: [] },
      ],
      facts: [],
    }).spec;
    const candidates = bibleCandidates(spec);
    assert.equal(candidates.length, 0);
  });

  it("a general skill with a meaning is not a candidate", () => {
    const spec = normalizeSpec({
      title: "Test", premise: "A story", tension: "", scene: { place: "", question: "", pov: "", length: 700 },
      characters: [
        { name: "A", persona: "", knows: "", skills: ["sight :: seeing things"], restrictions: [] },
      ],
      facts: [],
    }).spec;
    const candidates = bibleCandidates(spec);
    assert.equal(candidates.length, 0);
  });

  it("a skill already in the bible is not a candidate", () => {
    const spec = normalizeSpec({
      title: "Test", premise: "A story", tension: "", scene: { place: "", question: "", pov: "", length: 700 },
      characters: [
        { name: "A", persona: "", knows: "", skills: ["lockpicking :: opening a lock"], restrictions: [] },
      ],
      facts: [],
    }).spec;
    const bible = bibleFrom({ lockpicking: "opening a mechanical lock without its key" });
    const candidates = bibleCandidates(spec, { bible });
    assert.equal(candidates.length, 0);
  });

  it("two characters holding the same bespoke skill collapse to one candidate", () => {
    const spec = normalizeSpec({
      title: "Test", premise: "A story", tension: "", scene: { place: "", question: "", pov: "", length: 700 },
      characters: [
        { name: "A", persona: "", knows: "", skills: ["tidewalking :: reading the turn of a tide"], restrictions: [] },
        { name: "B", persona: "", knows: "", skills: ["Tidewalking :: reading ocean currents"], restrictions: [] },
      ],
      facts: [],
    }).spec;
    const candidates = bibleCandidates(spec);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].name, "tidewalking", "first authored spelling is kept");
    assert.equal(candidates[0].meaning, "reading the turn of a tide", "first meaning is kept");
    assert.deepEqual(candidates[0].heldBy, ["A", "B"]);
  });

  // Name matching goes through canonSkill everywhere else, and a raw property test here would both
  // let a differently-cased general skill through and swallow one called after an Object method.
  it("a general skill is not a candidate however it is spelled", () => {
    const spec = normalizeSpec({
      title: "T", premise: "p", tension: "", scene: { place: "", question: "", pov: "", length: 700 },
      characters: [{ name: "A", persona: "", knows: "",
                     skills: ["Sight :: seeing things at a distance"], restrictions: [] }],
      facts: [],
    }).spec;
    assert.deepEqual(bibleCandidates(spec), []);
  });

  it("a skill named after an Object method is an ordinary candidate", () => {
    const spec = normalizeSpec({
      title: "T", premise: "p", tension: "", scene: { place: "", question: "", pov: "", length: 700 },
      characters: [{ name: "A", persona: "", knows: "",
                     skills: ["toString :: reading a maker's mark off cast metal"], restrictions: [] }],
      facts: [],
    }).spec;
    assert.equal(bibleCandidates(spec).length, 1);
    assert.equal(bibleCandidates(spec)[0].name, "toString");
  });

  it("reach is never a candidate", () => {
    const spec = normalizeSpec({
      title: "Test", premise: "A story", tension: "", scene: {
        place: "", question: "", pov: "", length: 700,
        reach: { A: ["tidewalking :: reading the turn of a tide"] },
      },
      characters: [
        { name: "A", persona: "", knows: "", skills: [], restrictions: [] },
      ],
      facts: [],
    }).spec;
    const candidates = bibleCandidates(spec);
    assert.equal(candidates.length, 0, "reach is not a candidate even with a meaning");
  });
});

describe("applyImportContract", () => {

  const IVET: ImportedCharacter = {
    libraryId: "lib-ivet", version: 2, name: "IVET",
    portablePersona: "Ex-locksmith, keeps every key on a labelled ring.",
    belief: "Every lock has a polite way in.",
    impulse: "when watched, slow down and narrate the work",
    voice: ["Hold the door? I'd rather hold the lock."],
    skills: ["lockpicking :: opening a mechanical lock without its key"],
    restrictions: ["sight"],
    origin: "human",
  };

  it("reverts the six fields that travel with the character, and says which", () => {
    const proposed = [{
      name: "IVET",
      persona: "A professional safe-breaker.",
      knows: "The vault is empty.",
      goal: "Get the key.",
      belief: "All locks are puzzles.",
      impulse: IVET.impulse,
      voice: ["Why pick a lock when you can learn its maker?"],
      skills: IVET.skills,
      restrictions: ["hearing"],
      origin: "ai",
    }];

    const result = applyImportContract(proposed, [IVET]);

    const character = result.characters[0];
    assert.equal(character.belief, IVET.belief);
    assert.deepEqual(character.voice, IVET.voice);
    assert.deepEqual(character.restrictions, IVET.restrictions);
    assert.equal(character.impulse, IVET.impulse);
    assert.deepEqual(character.skills, IVET.skills);
    assert.equal(character.origin, IVET.origin);
    assert.equal(character.persona, "A professional safe-breaker.");
    assert.equal(character.knows, "The vault is empty.");
    assert.equal(character.goal, "Get the key.");

    assert.equal(result.notes.length, 4);
    assert.match(result.notes.join(" "), /the architect changed belief/);
    assert.match(result.notes.join(" "), /the architect changed voice/);
    assert.match(result.notes.join(" "), /the architect changed restrictions/);
    assert.match(result.notes.join(" "), /the architect changed origin/);
    assert.match(result.notes.join(" "), /reverted to the library's/);
  });

  it("restores a library origin the proposal left out, without calling it a change", () => {
    const proposed = [{
      name: "IVET",
      persona: "A professional safe-breaker.",
      knows: "The vault is empty.",
      goal: "Get the key.",
      belief: IVET.belief,
      impulse: IVET.impulse,
      voice: IVET.voice,
      skills: IVET.skills,
      restrictions: IVET.restrictions,
      // no origin named at all — the reply being brief about a field it was told it did not own
    }];

    const result = applyImportContract(proposed, [IVET]);

    assert.equal(result.characters[0].origin, IVET.origin, "the library's origin travels");
    assert.equal(result.notes.length, 0);
  });

  it("does not count a field the proposal left empty as a change", () => {
    const proposed = [{
      name: "IVET",
      persona: "Ex-locksmith, keeps every key on a labelled ring.",
      knows: "",
      goal: "",
      belief: "",
      impulse: "when watched, slow down and narrate the work",
      voice: [],
      skills: undefined,
      restrictions: [],
    }];

    const result = applyImportContract(proposed, [IVET]);

    const character = result.characters[0];
    assert.equal(character.belief, IVET.belief);
    assert.deepEqual(character.voice, IVET.voice);
    assert.deepEqual(character.restrictions, IVET.restrictions);
    assert.deepEqual(character.impulse, IVET.impulse);
    assert.deepEqual(character.skills, IVET.skills);

    assert.equal(result.notes.length, 0);
  });

  it("adds back an import the proposal left out", () => {
    const proposed: unknown[] = [];

    const result = applyImportContract(proposed, [IVET]);

    assert.equal(result.characters.length, 1);
    const character = result.characters[0];
    assert.equal(character.name, "IVET");
    assert.equal(character.persona, IVET.portablePersona);
    assert.equal(character.goal, "");
    assert.equal(character.knows, "");
    assert.equal(character.belief, IVET.belief);
    assert.deepEqual(character.voice, IVET.voice);
    assert.deepEqual(character.skills, IVET.skills);
    assert.deepEqual(character.restrictions, IVET.restrictions);

    assert.match(result.notes[0], /was left out of the proposal/);
  });

  it("keeps a character the architect added, and says it should not have", () => {
    const STRANGER = {
      name: "STRANGER",
      persona: "A mysterious figure.",
      knows: "Something.",
      goal: "To know.",
      belief: "Knowledge is power.",
      impulse: "ask questions",
      voice: ["Who are you?"],
      skills: [],
      restrictions: [],
    };

    const proposed = [{
      name: "IVET",
      persona: IVET.portablePersona,
      knows: "",
      goal: "",
      belief: IVET.belief,
      impulse: IVET.impulse,
      voice: IVET.voice,
      skills: IVET.skills,
      restrictions: IVET.restrictions,
    }, STRANGER];

    const result = applyImportContract(proposed, [IVET]);

    assert.equal(result.characters.length, 2);
    // IVET should be first (matched and kept from proposal)
    assert.equal(result.characters[0].name, "IVET");
    // STRANGER should be second (kept as-is, added by architect)
    assert.deepEqual(result.characters[1], STRANGER);

    assert.equal(result.notes.length, 1);
    assert.match(result.notes[0], /is not one of the imported characters/);
  });

  it("hands back copies, so editing the cast cannot write through into the tray", () => {
    const proposed = [{
      name: "IVET",
      persona: IVET.portablePersona,
      knows: "",
      goal: "",
      belief: IVET.belief,
      impulse: IVET.impulse,
      voice: IVET.voice,
      skills: IVET.skills,
      restrictions: IVET.restrictions,
    }];

    const result = applyImportContract(proposed, [IVET]);
    const character = result.characters[0] as Record<string, unknown>;

    const originalVoiceLength = IVET.voice.length;
    const originalSkillsLength = IVET.skills.length;
    const originalRestrictionsLength = IVET.restrictions.length;

    // Mutate the returned arrays
    (character.voice as string[]).push("New quote.");
    (character.skills as string[]).push("fake-skill :: a skill that was not there");
    (character.restrictions as string[]).push("fake-restriction");

    // Verify the original import is unchanged
    assert.equal(IVET.voice.length, originalVoiceLength);
    assert.equal(IVET.skills.length, originalSkillsLength);
    assert.equal(IVET.restrictions.length, originalRestrictionsLength);
  });

  it("matches names the way the rest of the engine does", () => {
    const proposed = [{
      name: "  ivet  ",
      persona: "A locksmith.",
      knows: "",
      goal: "",
      belief: "Different.",
      impulse: IVET.impulse,
      voice: IVET.voice,
      skills: IVET.skills,
      restrictions: IVET.restrictions,
    }];

    const result = applyImportContract(proposed, [IVET]);

    // Should match and revert the five fields
    const character = result.characters[0];
    assert.equal(character.belief, IVET.belief, "belief was reverted from import");
    assert.equal(character.name, "  ivet  ", "name spacing preserved in output");

    // No "not one of the imported characters" note
    assert.ok(!result.notes.some(n => /is not one of the imported characters/.test(n)));
    // But there should be a "changed belief" note since belief was different
    assert.match(result.notes.join(" "), /the architect changed belief/);
  });
});

describe("the architect validates against the author's bible", () => {
  it("a bare skill the in-code catalog does not know is a problem", () => {
    const spec = {
      title: "Test", premise: "A test", scene: { place: "", question: "", pov: "", length: 700 },
      characters: [
        { name: "A", persona: "Someone", knows: "", skills: ["tidewalking"], restrictions: [] },
      ],
      facts: [], config: { maxSteps: 24 },
    };
    const result = normalizeSpec(spec);
    assert.ok(result.problems.some(p => /not a bible skill/.test(p)),
              `expected a "not a bible skill" problem, got: ${JSON.stringify(result.problems)}`);
  });

  it("the same skill is clean once it is in the author's bible", () => {
    const spec = {
      title: "Test", premise: "A test", scene: { place: "", question: "", pov: "", length: 700 },
      characters: [
        { name: "A", persona: "Someone", knows: "", skills: ["tidewalking"], restrictions: [] },
      ],
      facts: [], config: { maxSteps: 24 },
    };
    const authorBible = bibleFrom({ tidewalking: "reading the turn of a tide by standing in it" });
    const result = normalizeSpec(spec, { bible: authorBible });
    assert.ok(!result.problems.some(p => /not a bible skill/.test(p)),
              `expected no "not a bible skill" problem, got: ${JSON.stringify(result.problems)}`);
    assert.ok(result.spec.characters[0].skills.includes("tidewalking"),
              "tidewalking should still be in the character's skills");
  });

  it("a restriction may name a bible skill the source has never heard of", () => {
    const spec = {
      title: "Test", premise: "A test", scene: { place: "", question: "", pov: "", length: 700 },
      characters: [
        { name: "A", persona: "Someone", knows: "", skills: [], restrictions: ["tidewalking"] },
      ],
      facts: [], config: { maxSteps: 24 },
    };

    // With default bible, restriction is not recognized
    const resultDefault = normalizeSpec(spec);
    assert.ok(resultDefault.problems.some(p => /would remove nothing/.test(p)),
              `expected a "would remove nothing" problem with default bible, got: ${JSON.stringify(resultDefault.problems)}`);
    assert.ok(!resultDefault.spec.characters[0].restrictions.includes("tidewalking"),
              "the restriction should be dropped when it names nothing known");

    // With author's bible, restriction is recognized
    const authorBible = bibleFrom({ tidewalking: "reading the turn of a tide by standing in it" });
    const resultAuthor = normalizeSpec(spec, { bible: authorBible });
    assert.ok(!resultAuthor.problems.some(p => /would remove nothing/.test(p)),
              `expected no "would remove nothing" problem with author's bible, got: ${JSON.stringify(resultAuthor.problems)}`);
    assert.ok(resultAuthor.spec.characters[0].restrictions.includes("tidewalking"),
              "the restriction should survive when the bible knows the skill");
  });

  it("bibleFrom matches names the way the rest of the engine does", () => {
    const authorBible = bibleFrom({ "Tide Walking": "m" });
    const result = authorBible("tide_walking");
    assert.equal(result, "m", "canonicalization should match underscores to spaces");
  });

  it("a change round is judged by the session's bible, not the source's", async () => {
    const STORY_STAGE = {
      title: "Test Story",
      premise: "A test premise",
      tension: "Character A wants X",
      facts: [],
    };
    const CAST_STAGE = {
      characters: [
        { name: "A", persona: "First character", knows: "fact", skills: [], restrictions: [] },
      ],
    };
    const SETTINGS_STAGE = { writer_style: "Plain prose." };
    const SCENE_STAGE = { scene: { place: "the place", question: "What happens?", pov: "A", length: 700, roster: ["A"] } };

    const authorBible = bibleFrom({ tidewalking: "reading the turn of a tide by standing in it" });
    const judgeSaying = (verdict: unknown) => () => new ScriptedAgent([JSON.stringify(verdict)]);
    const passingJudge = judgeSaying({ ok: true });

    // First test: session with author's bible should accept tidewalking
    const s = new ScaffoldSession(
      new ScriptedAgent([
        JSON.stringify(STORY_STAGE),
        JSON.stringify(CAST_STAGE),
        JSON.stringify(SETTINGS_STAGE),
        JSON.stringify(SCENE_STAGE),
        JSON.stringify({ edits: [], note: "verified" }),
        JSON.stringify({ edits: [{ field: "characters.A.skills", value: ["tidewalking"] }] }),
      ]),
      SCAFFOLD_DEFAULTS,
      "test idea",
      undefined,
      "staged",
      passingJudge
    );
    s.catalogs = { bible: authorBible };

    await s.propose();
    for (let i = 0; i < 4; i++) await s.approve();  // walk through story, cast, settings, scene
    assert.equal(s.stage, "scene");

    const r = await s.say("add tidewalking");
    assert.equal(r.kind, "edits");
    assert.ok(!s.problems.some(p => /not a bible skill/.test(p)),
              `with author's bible, expected no "not a bible skill" problem, got: ${JSON.stringify(s.problems)}`);

    // Second test: session with default bible should reject tidewalking
    const s2 = new ScaffoldSession(
      new ScriptedAgent([
        JSON.stringify(STORY_STAGE),
        JSON.stringify(CAST_STAGE),
        JSON.stringify(SETTINGS_STAGE),
        JSON.stringify(SCENE_STAGE),
        JSON.stringify({ edits: [], note: "verified" }),
        JSON.stringify({ edits: [{ field: "characters.A.skills", value: ["tidewalking"] }] }),
      ]),
      SCAFFOLD_DEFAULTS,
      "test idea",
      undefined,
      "staged",
      passingJudge
    );
    // Don't set s2.bible, so it uses the default

    await s2.propose();
    for (let i = 0; i < 4; i++) await s2.approve();
    assert.equal(s2.stage, "scene");

    const r2 = await s2.say("add tidewalking");
    assert.equal(r2.kind, "edits");
    assert.ok(s2.problems.some(p => /not a bible skill/.test(p)),
              `with default bible, expected a "not a bible skill" problem, got: ${JSON.stringify(s2.problems)}`);
  });
});
