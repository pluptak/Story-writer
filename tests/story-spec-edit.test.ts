/**
 * Story spec tests — normalizing and editing story proposals.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeSpec, applyEdits, directEdit } from "../engine/story-spec.ts";
import { quietSync } from "./helpers.ts";

// -- STORY SPEC (scaffolding, SPEC-S §3) -----------------------------------
describe("normalizeSpec", () => {
  const base = {
    title: "Doorway", premise: "A corridor at 3am.",
    scene: { place: "Behind Kessel's", question: "Does she get in?", pov: "RIVEN", length: 700 },
    characters: [{ name: "RIVEN", persona: "A courier.", knows: "The code changed.",
      belief: "The back door is still unlocked.", impulse: "When challenged, shows the crate label first.",
      voice: ["\"I deliver. What happens after is not my department.\""],
      skills: ["lockpicking :: picks locks"], restrictions: [] }],
  };

  it("accepts a well-formed proposal with no complaints", () => {
    const { spec, problems } = normalizeSpec(base);
    assert.deepEqual(problems, []);
    assert.equal(spec.scenes[0].pov, "RIVEN");
    assert.deepEqual(spec.characters[0].skills, ["lockpicking :: picks locks"]);
  });

  it("refuses to read a scene that came back as text, rather than taking its length as a word count", () => {
    const { spec, problems } = normalizeSpec({ ...base, scene: "Behind Kessel's, at 3am." });
    assert.equal(spec.scenes[0].length, 700);
    assert.equal(spec.scenes[0].place, "");
    assert.match(problems.join(" "), /came back as text/);
  });

  it("requires a belief, an impulse and voice samples on every character", () => {
    const { problems } = normalizeSpec({
      ...base, characters: [{ ...base.characters[0], belief: "", impulse: "", voice: [] }] });
    const joined = problems.join(" ");
    assert.match(joined, /no belief/);
    assert.match(joined, /no impulse/);
    assert.match(joined, /no voice samples/);
  });

  it("caps voice at three samples and says so", () => {
    const { spec, problems } = normalizeSpec({
      ...base, characters: [{ ...base.characters[0], voice: ["one", "two", "three", "four"] }] });
    assert.deepEqual(spec.characters[0].voice, ["one", "two", "three"]);
    assert.match(problems.join(" "), /first 3/);
  });

  it("drops a restriction that names no general skill, and says why", () => {
    const { spec, problems } = normalizeSpec({
      ...base, characters: [{ ...base.characters[0], restrictions: ["telepathy", "sight"] }] });
    assert.deepEqual(spec.characters[0].restrictions, ["sight"]);
    assert.match(problems.join(" "), /telepathy/);
  });

  it("keeps a restriction that names a bible skill or the character's own skill", () => {
    const { spec, problems } = normalizeSpec({
      ...base, characters: [{ ...base.characters[0],
        skills: ["lockpicking :: picks locks"], restrictions: "climbing | lockpicking" }] });
    assert.deepEqual(spec.characters[0].restrictions, ["climbing", "lockpicking"]);
    assert.equal(problems.filter(p => /restrictions/.test(p)).length, 0);
  });

  it("still drops a restriction naming an undeclared bespoke skill", () => {
    const { spec, problems } = normalizeSpec({
      ...base, characters: [{ ...base.characters[0], skills: [], restrictions: ["fire"] }] });
    assert.deepEqual(spec.characters[0].restrictions, []);
    assert.match(problems.join(" "), /fire/);
  });

  it("flags a bespoke skill that is neither a bible skill nor carries a :: meaning", () => {
    const { spec, problems } = normalizeSpec({
      ...base, characters: [{ ...base.characters[0], skills: ["whispercraft", "chewing :: grinding through what others cannot", "lockpicking"] }] });
    assert.deepEqual(spec.characters[0].skills,
                     ["whispercraft", "chewing :: grinding through what others cannot", "lockpicking"]);
    assert.equal(problems.filter(p => /whispercraft/.test(p)).length, 1, "the unknown bare name is flagged");
    assert.ok(!problems.some(p => /chewing/.test(p)), "a custom skill WITH a meaning is legitimate");
    assert.ok(!problems.some(p => /lockpicking/.test(p)), "a bible skill needs no authored meaning");
  });

  it("clears a pov that is not one of the characters", () => {
    const { spec, problems } = normalizeSpec({ ...base, scene: { ...base.scene, pov: "NOBODY" } });
    assert.equal(spec.scenes[0].pov, "");
    assert.match(problems.join(" "), /NOBODY/);
  });

  it("takes skills and restrictions as a pipe-separated string too", () => {
    const { spec } = normalizeSpec({
      ...base, characters: [{ ...base.characters[0], skills: "climbing | keys :: by feel", restrictions: "sight" }] });
    assert.deepEqual(spec.characters[0].skills, ["climbing", "keys :: by feel"]);
    assert.deepEqual(spec.characters[0].restrictions, ["sight"]);
  });

  it("carries scene reach through, keyed by the character's own spelling of their name", () => {
    const { spec, problems } = normalizeSpec({
      ...base, scene: { ...base.scene,
        reach: { riven: ["cameras :: perceiving through the security cameras"], GHOST: ["doors :: opening"] } } });
    assert.deepEqual(spec.scenes[0].reach,
                     { RIVEN: ["cameras :: perceiving through the security cameras"] });
    assert.match(problems.join(" "), /GHOST/, "a grant to a non-character is dropped and reported");
  });

  it("drops a reach entry with no :: meaning — reach is never in the bible", () => {
    const { spec, problems } = normalizeSpec({
      ...base, scene: { ...base.scene,
        reach: { RIVEN: ["cameras :: seeing through the lobby feed", "doors"] } } });
    assert.deepEqual(spec.scenes[0].reach,
                     { RIVEN: ["cameras :: seeing through the lobby feed"] });
    assert.match(problems.join(" "), /doors/);
  });

  it("flags a roster name that is not one of the characters, and keeps it", () => {
    const { spec, problems } = normalizeSpec({ ...base, scene: { ...base.scene, roster: ["RIVEN", "GHOST"] } });
    assert.match(problems.join(" "), /roster "GHOST" is not one of the characters/);
    assert.deepEqual(spec.scenes[0].roster, ["RIVEN", "GHOST"]);
  });

  it("flags a pov that is set but absent from a non-empty roster, and passes a pov that is in it", () => {
    const twoChar = { ...base, characters: [{ ...base.characters[0] }, { ...base.characters[0], name: "MERRITT" }] };
    const ok = normalizeSpec({ ...twoChar, scene: { ...base.scene, roster: ["RIVEN"], pov: "RIVEN" } });
    assert.ok(!ok.problems.some(p => /not in the roster/.test(p)));
    const bad = normalizeSpec({ ...twoChar, scene: { ...base.scene, roster: ["RIVEN"], pov: "MERRITT" } });
    assert.match(bad.problems.join(" "), /pov "MERRITT" is not in the roster/);
  });

  it("reports (and keeps) a reach grant to someone absent from the roster", () => {
    const twoChar = { ...base, characters: [{ ...base.characters[0] }, { ...base.characters[0], name: "MERRITT" }] };
    const { spec, problems } = normalizeSpec({ ...twoChar, scene: { ...base.scene,
      roster: ["MERRITT"], reach: { RIVEN: ["cameras :: perceiving through the feed"] } } });
    assert.deepEqual(spec.scenes[0].reach, { RIVEN: ["cameras :: perceiving through the feed"] });
    assert.match(problems.join(" "), /grants reach to "RIVEN", who is not in its roster/);
  });

  it("drops a reach entry colliding with a general, bible, or own skill name", () => {
    const gen = normalizeSpec({ ...base, scene: { ...base.scene,
      reach: { RIVEN: ["sight :: perceiving through cameras"] } } });
    assert.match(gen.problems.join(" "), /collides with a skill name/);
    assert.deepEqual(gen.spec.scenes[0].reach, {}, "a general-skill-named reach entry is dropped");

    const own = normalizeSpec({ ...base, characters: [{ ...base.characters[0], skills: ["lockpicking :: picks locks"] }],
      scene: { ...base.scene, reach: { RIVEN: ["lockpicking :: a second way to pick"] } } });
    assert.match(own.problems.join(" "), /collides with a skill name/);
    assert.deepEqual(own.spec.scenes[0].reach, {}, "a reach entry reusing the character's own skill is dropped");

    const fine = normalizeSpec({ ...base, scene: { ...base.scene,
      reach: { RIVEN: ["cameras :: perceiving through the feed"] } } });
    assert.ok(!fine.problems.some(p => /collides/.test(p)));
    assert.deepEqual(fine.spec.scenes[0].reach, { RIVEN: ["cameras :: perceiving through the feed"] });
  });

  it("an edit to scene.reach replaces that scene's grants", () => {
    const withReach = normalizeSpec({
      ...base, scene: { ...base.scene, reach: { RIVEN: ["cameras :: seeing"] } } }).spec;
    const r = quietSync(() => applyEdits(withReach, { edits: [
      { field: "scene.reach", value: { RIVEN: ["doors :: unlocking the service doors"] } }] }));
    assert.deepEqual(r.spec.scenes[0].reach, { RIVEN: ["doors :: unlocking the service doors"] });
    assert.equal(r.applied.length, 1);
    // an empty object clears it entirely
    const cleared = quietSync(() => applyEdits(r.spec, { edits: [{ field: "scene_1.reach", value: {} }] }));
    assert.deepEqual(cleared.spec.scenes[0].reach, {});
    // a malformed value is not a crash
    const junk = quietSync(() => applyEdits(withReach, { edits: [{ field: "scene.reach", value: "nope" }] }));
    assert.deepEqual(junk.spec.scenes[0].reach, {});
  });

  it("enforces the cast bounds and rejects duplicates", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ ...base.characters[0], name: `C${i}` }));
    const { spec, problems } = normalizeSpec({ ...base, scene: { ...base.scene, pov: "" }, characters: many });
    assert.equal(spec.characters.length, 4);
    assert.match(problems.join(" "), /keeping the first 4/);

    const dup = normalizeSpec({ ...base, characters: [base.characters[0], { ...base.characters[0], persona: "other" }] });
    assert.equal(dup.spec.characters.length, 1);
    assert.match(dup.problems.join(" "), /two characters called/i);
  });

  it("notices a cast where nobody has any restrictions", () => {
    const flat = { ...base, scene: { ...base.scene, pov: "" },
      characters: [{ ...base.characters[0], name: "A", restrictions: [] }, { ...base.characters[0], name: "B", restrictions: [] }] };
    assert.match(normalizeSpec(flat).problems.join(" "), /asymmetry/);
    const sharp = { ...flat, characters: [flat.characters[0], { ...flat.characters[1], restrictions: ["sight"] }] };
    assert.ok(!normalizeSpec(sharp).problems.some(p => /asymmetry/.test(p)));
    // A single character has nobody to be asymmetric with; do not nag about it.
    assert.ok(!normalizeSpec(base).problems.some(p => /asymmetry/.test(p)));
  });

  it("notices a persona that restates the structured fields", () => {
    const bled = { ...base, characters: [{ ...base.characters[0],
      persona: "A courier. VOICE: economical. KNOWS: the code changed. BELIEF: something. RESTRICTIONS: None." }] };
    assert.match(normalizeSpec(bled).problems.join(" "), /restates/);
    // A persona using the labelled headings the format actually asks for is fine.
    const ok = { ...base, characters: [{ ...base.characters[0],
      persona: "A courier. UNDER PRESSURE: politer, not louder." }] };
    assert.ok(!normalizeSpec(ok).problems.some(p => /restates/.test(p)));
  });

  it("folds a proposal's learned into knows and keeps the field out of the spec", () => {
    const { spec, problems } = normalizeSpec({
      ...base, characters: [{ ...base.characters[0],
        knows: "The code changed.", learned: "Merritt took the ledger." }] });
    assert.equal(spec.characters[0].knows, "The code changed. Merritt took the ledger.");
    assert.ok(!("learned" in spec.characters[0]));
    assert.match(problems.join(" "), /learned/);

    // A character with no knows yet still takes it.
    const fresh = normalizeSpec({ ...base, characters: [{ ...base.characters[0], knows: "", learned: "The door opens inward." }] });
    assert.equal(fresh.spec.characters[0].knows, "The door opens inward.");
  });

  it("an ask-only reply yields no usable story", () => {
    const { spec } = normalizeSpec({ ask: "Who are these two people, and what do they want?" });
    assert.equal(spec.characters.length, 0);
    assert.equal(spec.title, "");
  });

  it("reports an empty proposal rather than throwing", () => {
    const { spec, problems } = normalizeSpec({});
    assert.equal(spec.scenes[0].length, 700);
    assert.equal(spec.characters.length, 0);
    assert.ok(problems.length >= 4, problems.join(" · "));
  });
});

describe("applyEdits", () => {
  const spec = normalizeSpec({
    title: "Doorway", premise: "A corridor at 3am.",
    scene: { place: "Behind Kessel's", question: "Does she get in?", pov: "RIVEN", length: 700 },
    writer_style: "Close third.",
    characters: [
      { name: "RIVEN", persona: "A courier.", knows: "The code changed.", skills: ["lockpicking"], restrictions: [] },
      { name: "MERRITT", persona: "A porter.", knows: "The lock sticks.", skills: [], restrictions: ["sight"] },
    ],
  }).spec;
  const edit = (field: string, value: any) => quietSync(() => applyEdits(spec, { edits: [{ field, value }] }));

  it("changes only the field named and leaves the rest untouched", () => {
    const r = edit("scene.place", "A stairwell");
    assert.equal(r.spec.scenes[0].place, "A stairwell");
    assert.equal(r.spec.premise, spec.premise);
    assert.deepEqual(r.spec.characters.map(c => c.name), ["RIVEN", "MERRITT"]);
    assert.equal(r.applied.length, 1);
    assert.equal(r.applied[0].field, "scene.place");
    assert.deepEqual(r.ignored, []);
    assert.equal(spec.scenes[0].place, "Behind Kessel's", "the input spec must not be mutated");
  });

  it("reports normalized before/after values, including each repeated edit", () => {
    const r = quietSync(() => applyEdits(spec, { edits: [
      { field: "scene.length", value: 901.4 },
      { field: "scene.length", value: 1200 },
    ] }));
    assert.deepEqual(r.applied.map(a => ({ field: a.field, before: a.before, after: a.after })), [
      { field: "scene.length", before: 700, after: 901 },
      { field: "scene.length", before: 901, after: 1200 },
    ]);
  });

  it("reports normalized objects for structural edits", () => {
    const added = edit("add_scene", { place: "  yard ", length: 801.4, question: "Follow?" });
    assert.deepEqual(added.applied[0].before, undefined);
    assert.deepEqual(added.applied[0].after, {
      place: "yard", question: "Follow?", pov: "", length: 801, roster: [], reach: {},
    });
    const removed = quietSync(() => applyEdits(added.spec, { edits: [{ field: "remove_scene", value: 2 }] }));
    assert.deepEqual(removed.applied[0].before, added.spec.scenes[1]);
    assert.deepEqual(removed.applied[0].after, undefined);
  });

  it("edits a character by name, case-insensitively", () => {
    const r = edit("characters.merritt.persona", "Older than they look.");
    assert.equal(r.spec.characters[1].persona, "Older than they look.");
    assert.equal(r.applied.length, 1);
    assert.equal(r.applied[0].field, "MERRITT.persona");
  });

  it("accepts edits whose keys are field names instead of {field,value} pairs", () => {
    const r = edit("title", "The Campfire Betrayal"); // establish a baseline
    const refined = quietSync(() => applyEdits(r.spec, {
      edits: [{ title: "The Sword's Weight", premise: "They mean to take the blade.", facts: ["isolation"] }],
    }));
    assert.equal(refined.spec.title, "The Sword's Weight");
    assert.equal(refined.spec.premise, "They mean to take the blade.");
    assert.deepEqual(refined.spec.facts, ["isolation"]);
    assert.equal(refined.ignored.length, 0, `expected no ignored edits, got: ${refined.ignored.join("; ")}`);
  });

  it("folds characters.<NAME>.learned into their knows and reports it as a knows change", () => {
    const r = edit("characters.RIVEN.learned", "Merritt was the one who copied the key.");
    assert.equal(r.spec.characters[0].knows, "The code changed. Merritt was the one who copied the key.");
    assert.ok(!("learned" in r.spec.characters[0]));
    assert.deepEqual([r.applied[0].field, r.applied[0].before, r.applied[0].after],
      ["RIVEN.learned", "The code changed.", "The code changed. Merritt was the one who copied the key."]);
    assert.deepEqual(r.ignored, []);

    // An empty learned carries nothing.
    const blank = edit("characters.RIVEN.learned", "   ");
    assert.match(blank.ignored.join(" "), /nothing to learn/);
    const nobody = edit("characters.NOBODY.learned", "Something.");
    assert.match(nobody.ignored.join(" "), /no character called/);
  });

  it("renames a character, and the roster and pov follow", () => {
    const r = edit("characters.RIVEN.name", "QUINN");
    assert.deepEqual(r.spec.characters.map(c => c.name), ["QUINN", "MERRITT"]);
    assert.equal(r.spec.scenes[0].pov, "QUINN");
    assert.deepEqual([r.applied[0].field, r.applied[0].before, r.applied[0].after], ["RIVEN.name", "RIVEN", "QUINN"]);
    assert.equal(spec.characters[0].name, "RIVEN", "the input spec must not be mutated");

    const rostered = normalizeSpec({
      title: "Doorway", premise: "A corridor at 3am.",
      scene: { place: "Behind Kessel's", question: "Does she get in?", pov: "RIVEN", length: 700,
               roster: ["RIVEN", "MERRITT"] },
      characters: spec.characters.map(c => ({ ...c })),
    }).spec;
    const rr = quietSync(() => applyEdits(rostered, { edits: [{ field: "characters.riven.name", value: "Quinn" }] }));
    assert.deepEqual(rr.spec.scenes[0].roster, ["Quinn", "MERRITT"]);

    // One round may rename and then address the old name -- later edits follow the rename.
    const multi = quietSync(() => applyEdits(rostered, { edits: [
      { field: "characters.RIVEN.name", value: "QUINN" },
      { field: "characters.riven.knows", value: "The code changed twice." },
    ] }));
    assert.equal(multi.spec.characters[0].name, "QUINN");
    assert.equal(multi.spec.characters[0].knows, "The code changed twice.");
    assert.deepEqual(multi.ignored, []);

    const dup = quietSync(() => applyEdits(r.spec, { edits: [{ field: "characters.QUINN.name", value: "merritt" }] }));
    assert.match(dup.ignored.join(" "), /already in the cast/);
    const blank = edit("characters.RIVEN.name", "   ");
    assert.match(blank.ignored.join(" "), /renamed to nothing/);

    // Models copy the <NAME> placeholder literally sometimes; the engine unwraps it.
    const brack = edit("characters.<MERRITT>.goal", "Get promoted.");
    assert.equal(brack.spec.characters[1].goal, "Get promoted.");
  });

  it("takes skills and restrictions as a list or a pipe-separated string", () => {
    assert.deepEqual(edit("characters.RIVEN.skills", ["climbing", "keys :: by feel"]).spec.characters[0].skills,
                     ["climbing", "keys :: by feel"]);
    assert.deepEqual(edit("characters.RIVEN.restrictions", "hearing | smell").spec.characters[0].restrictions,
                     ["hearing", "smell"]);
  });

  it("flags a stale old-name reference left in another character's fields after a rename", () => {
    const s = normalizeSpec({
      title: "Doorway", premise: "A corridor.",
      scene: { question: "Q?" },
      characters: [
        { name: "RIVEN", persona: "A courier.", knows: "Merritt told me the code.", skills: [], restrictions: [] },
        { name: "MERRITT", persona: "A porter.", knows: "The lock sticks.", skills: [], restrictions: ["sight"] },
      ],
    }).spec;
    const r = quietSync(() => applyEdits(s, { edits: [{ field: "characters.merritt.name", value: "MARA" }] }));
    // The authored spelling, not the lower-case lookup key the rename map is built on.
    assert.match(r.problems.join(" "), /RIVEN's knows still names "MERRITT", who was renamed to "MARA"/);
  });

  it("does not flag a rename that left no stale references", () => {
    const s = normalizeSpec({
      title: "Doorway", premise: "A corridor.",
      scene: { question: "Q?" },
      characters: [
        { name: "RIVEN", persona: "A courier.", knows: "The code changed.", skills: [], restrictions: [] },
        { name: "MERRITT", persona: "A porter.", knows: "The lock sticks.", skills: [], restrictions: ["sight"] },
      ],
    }).spec;
    const r = quietSync(() => applyEdits(s, { edits: [{ field: "characters.merritt.name", value: "MARA" }] }));
    assert.ok(!r.problems.some(p => /still names/.test(p)));
  });

  it("takes voice as a list or a pipe-separated string", () => {
    assert.deepEqual(edit("characters.RIVEN.voice", ["one line", "another"]).spec.characters[0].voice,
                     ["one line", "another"]);
    assert.deepEqual(edit("characters.RIVEN.voice", "a line | b line").spec.characters[0].voice,
                     ["a line", "b line"]);
  });

  it("reports an unknown field instead of guessing at it", () => {
    const r = edit("scene.mood", "tense");
    assert.equal(r.applied.length, 0);
    assert.match(r.ignored.join(" "), /unknown field "scene\.mood"/);
    assert.deepEqual(r.spec, spec);
  });

  it("reads the JSON-path bracket spellings models drift into, as zero-based indices", () => {
    const r = quietSync(() => applyEdits(spec, { edits: [
      { field: "scene[0].place", value: "A stairwell" },
      { field: "characters[MERRITT].goal", value: "Beat her to the door." },
    ] }));
    assert.equal(r.spec.scenes[0].place, "A stairwell");
    assert.equal(r.spec.characters[1].goal, "Beat her to the door.");
    assert.deepEqual(r.ignored, []);
  });

  it("adds and removes characters, and refuses the impossible ones", () => {
    const added = edit("add_character", { name: "TOVA", persona: "A cook.", knows: "", skills: [], restrictions: ["hearing"] });
    assert.deepEqual(added.spec.characters.map(c => c.name), ["RIVEN", "MERRITT", "TOVA"]);
    assert.match(edit("add_character", { name: "RIVEN", persona: "x" }).ignored.join(" "), /already in the cast/);
    assert.match(edit("remove_character", "NOBODY").ignored.join(" "), /not in the cast/);
  });

  it("removing the pov character clears the pov rather than leaving it dangling", () => {
    const r = edit("remove_character", "RIVEN");
    assert.deepEqual(r.spec.characters.map(c => c.name), ["MERRITT"]);
    assert.equal(r.spec.scenes[0].pov, "");
    assert.match(r.problems.join(" "), /RIVEN/);
  });

  it("re-validates after editing, so a bad restriction is caught in the round that caused it", () => {
    const r = edit("characters.MERRITT.restrictions", ["telepathy"]);
    assert.deepEqual(r.spec.characters[1].restrictions, []);
    assert.match(r.problems.join(" "), /telepathy/);
  });

  it("holds the cast bound when a fifth character is added", () => {
    let grown = spec;
    for (const n of ["TOVA", "KESS", "WREN"])
      grown = quietSync(() => applyEdits(grown, { edits: [{ field: "add_character", value: { name: n, persona: "x" } }] })).spec;
    assert.equal(grown.characters.length, 4);
    const r = quietSync(() => applyEdits(grown, { edits: [{ field: "add_character", value: { name: "EXTRA", persona: "x" } }] }));
    assert.equal(r.spec.characters.length, 4);
    assert.match(r.problems.join(" "), /keeping the first 4/);
  });

  it("adds a scene at the end and edits it by number", () => {
    const grown = edit("add_scene", { place: "The yard", question: "Does he follow?", pov: "MERRITT", length: 800, roster: ["MERRITT"] });
    assert.equal(grown.spec.scenes.length, 2);
    assert.equal(grown.applied.length, 1);
    assert.equal(grown.applied[0].field, "added scene 2");
    assert.equal(grown.spec.scenes[1].question, "Does he follow?");
    assert.deepEqual(grown.spec.scenes[1].roster, ["MERRITT"]);
    assert.equal(grown.spec.scenes[0].question, "Does she get in?", "the scene already there is untouched");

    const r = quietSync(() => applyEdits(grown.spec, { edits: [{ field: "scene_2.place", value: "The alley" }] }));
    assert.equal(r.spec.scenes[1].place, "The alley");
    assert.equal(r.spec.scenes[0].place, "Behind Kessel's");
  });

  it("fills a scene added with nothing in it from the schema defaults", () => {
    const r = edit("add_scene", {});
    assert.equal(r.spec.scenes.length, 2);
    assert.equal(r.spec.scenes[1].length, 700);
    assert.deepEqual(r.spec.scenes[1].roster, []);
    assert.match(r.problems.join(" "), /scene 2 has no question/);
  });

  it("refuses an add_scene that is not a scene object", () => {
    for (const v of ["a scene", 3, null, ["place"]]) {
      const r = edit("add_scene", v);
      assert.equal(r.spec.scenes.length, 1, String(v));
      assert.match(r.ignored.join(" "), /must be a scene object/);
    }
  });

  it("removes a scene by number, and never the only one there is", () => {
    const two = edit("add_scene", { question: "Does he follow?" }).spec;
    const r = quietSync(() => applyEdits(two, { edits: [{ field: "remove_scene", value: 1 }] }));
    assert.equal(r.spec.scenes.length, 1);
    assert.equal(r.spec.scenes[0].question, "Does he follow?");
    assert.equal(r.applied.length, 1);
    assert.equal(r.applied[0].field, "removed scene 1");

    const last = edit("remove_scene", 1);
    assert.equal(last.spec.scenes.length, 1);
    assert.match(last.ignored.join(" "), /a story needs at least one scene/);
  });

  it("ignores a remove_scene that names no scene", () => {
    for (const v of [0, 2, -1, "second", 1.5, null]) {
      const r = edit("remove_scene", v);
      assert.equal(r.spec.scenes.length, 1, String(v));
      assert.equal(r.applied.length, 0, String(v));
      assert.match(r.ignored.join(" "), /there is no scene/);
    }
  });

  it("survives an edits list that is missing, empty, or malformed", () => {
    for (const raw of [{}, { edits: [] }, { edits: [{ value: "x" }] }, { edits: "nonsense" }]) {
      const r = quietSync(() => applyEdits(spec, raw));
      assert.deepEqual(r.spec, spec);
    }
  });

  describe("directEdit", () => {
    it("sets the one field it is allowed to, through applyEdits", () => {
      const r = quietSync(() => directEdit(spec, "scene.length", 1200));
      assert.ok(r.ok);
      assert.equal(r.spec.scenes[0].length, 1200);
      assert.equal(r.applied.length, 1);
    assert.equal(r.applied[0].field, "scene.length");
      assert.equal(spec.scenes[0].length, 700, "the input spec must not be mutated");
    });

    it("rounds what it is given", () => {
      const r = quietSync(() => directEdit(spec, "scene.length", "850.6"));
      assert.ok(r.ok);
      assert.equal(r.spec.scenes[0].length, 851);
    });

    it("refuses every other field, however well-formed", () => {
      for (const f of ["premise", "title", "scene.place", "characters.RIVEN.persona", "scene.mood", ""]) {
        const r = quietSync(() => directEdit(spec, f, "anything"));
        assert.equal(r.ok, false, f);
      }
    });

    it("refuses a length it cannot use instead of silently substituting 700", () => {
      for (const v of [0, 12, 99, 10001, "", "soon", NaN, null, undefined]) {
        const r = quietSync(() => directEdit(spec, "scene.length", v));
        assert.equal(r.ok, false, String(v));
        if (!r.ok) assert.match(r.reason, /100/);
      }
    });
  });
});
