/**
 * Story spec tests — normalizing, editing, and rendering story proposals.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadStory, ROOT } from "../engine/story-format.ts";
import { slugify } from "../engine/config-util.ts";
import { normalizeSpec, applyEdits, directEdit, renderStory, sceneDrift, timelineDrift, specView, timelineBeatProblems, timelineOrderProblems, type SceneDef } from "../engine/story-spec.ts";
import { StoryJson } from "../engine/story-schema.ts";
import { quiet, quietSync } from "./helpers.ts";

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

describe("specView against the story schema", () => {
  // The new-story editor validates its draft with the strict StoryJson schema. specView carries two
  // shapes the schema rejects — `scene` as an alias for scenes[0], and skills split into
  // {text, meaning} — and the editor's scaffoldStory() reconciles them. When it did not drop
  // `scene`, every check failed with `Unrecognized key: "scene"` and the write button went dead on
  // the first edit with nothing on screen to say why. This pins the contract that fix relies on.
  const spec = normalizeSpec({
    title: "Doorway", premise: "A corridor at 3am.", writer_style: "Plain.",
    scene: { place: "Behind Kessel's", question: "Does she get in?", pov: "RIVEN", length: 700,
             roster: ["RIVEN"] },
    characters: [{ name: "RIVEN", persona: "A courier.", knows: "The code changed.", goal: "Get in.",
                   belief: "Doors open.", impulse: "when stopped → talk", voice: ["Let me in."],
                   skills: ["lockpicking"], restrictions: ["sight"] }],
  }).spec;

  /** story-edit.js scaffoldStory(), which is the only reconciliation between the two shapes. */
  const asEditorDraft = () => {
    const d: any = JSON.parse(JSON.stringify(specView(spec)));
    delete d.scene;
    d.characters = d.characters.map((c: any) => ({
      ...c,
      skills: (c.skills || []).map((s: any) =>
        typeof s === "string" ? s : [s.text, s.meaning].filter(Boolean).join(" :: ")),
    }));
    return d;
  };

  it("carries a `scene` alias the schema rejects, so the editor has to drop it", () => {
    const raw = StoryJson.safeParse(JSON.parse(JSON.stringify(specView(spec))));
    assert.equal(raw.success, false, "specView is a view, not a story.json");
    assert.match(raw.error!.issues.map(i => i.message).join(" "), /scene/);
  });

  it("validates once the editor has reconciled it", () => {
    const r = StoryJson.safeParse(asEditorDraft());
    assert.equal(r.success, true,
                 `the new-story draft must validate as loaded: ${JSON.stringify(r.error?.issues)}`);
  });

  it("still validates after the edits an author actually makes", () => {
    const d = asEditorDraft();
    d.characters[0].restrictions = [];             // the edit from the bug report
    d.characters[0].skills = [];
    d.scenes[0].roster = [];
    assert.equal(StoryJson.safeParse(d).success, true,
                 "clearing a list field must not invalidate the draft");
  });
});

describe("sceneDrift", () => {
  const base: SceneDef = { place: "A room", question: "Does she leave?", pov: "MAYA", length: 700, roster: ["MAYA", "IVAN"], reach: {} };

  it("returns [] for identical scenes", () => {
    const after: SceneDef = { place: "A room", question: "Does she leave?", pov: "MAYA", length: 700, roster: ["MAYA", "IVAN"], reach: {} };
    assert.deepEqual(sceneDrift(base, after), []);
  });

  it("returns a changed question", () => {
    const after: SceneDef = { ...base, question: "Does she stay?" };
    assert.deepEqual(sceneDrift(base, after), ["question"]);
  });

  it("returns multiple changed fields in stable order", () => {
    const after: SceneDef = { place: "Outside", question: "Does she leave?", pov: "IVAN", length: 800, roster: ["MAYA", "IVAN"], reach: {} };
    assert.deepEqual(sceneDrift(base, after), ["place", "pov", "length"]);
  });

  it("ignores roster reordering", () => {
    const after: SceneDef = { ...base, roster: ["IVAN", "MAYA"] };
    assert.deepEqual(sceneDrift(base, after), []);
  });

  it("detects an added name in the roster", () => {
    const after: SceneDef = { ...base, roster: ["MAYA", "IVAN", "LARS"] };
    assert.deepEqual(sceneDrift(base, after), ["roster"]);
  });

  it("returns [] when either side is undefined", () => {
    assert.deepEqual(sceneDrift(undefined, base), []);
    assert.deepEqual(sceneDrift(base, undefined), []);
    assert.deepEqual(sceneDrift(undefined, undefined), []);
  });

  it("detects a change in length as a number", () => {
    const after: SceneDef = { ...base, length: 850 };
    assert.deepEqual(sceneDrift(base, after), ["length"]);
  });

  it("ignores whitespace differences in strings", () => {
    const after: SceneDef = { place: "  A room  ", question: "  Does she leave?  ", pov: "  MAYA  ", length: 700, roster: ["MAYA", "IVAN"], reach: {} };
    assert.deepEqual(sceneDrift(base, after), []);
  });
});

// -- TIMELINE (the world-event ledger) ---------------------------------------
describe("timeline", () => {
  const base = {
    title: "Alarm", premise: "A wing under a fault alarm.",
    scene: { place: "the corridor", question: "Who answers the alarm?", length: 700 },
    characters: [
      { name: "HALE", persona: "Holds the contract.", knows: "The cage key.", belief: "Paperwork rules.", impulse: "when pressed → procedural", voice: ["Read me the log."], restrictions: ["sight"] },
      { name: "ODUYA", persona: "Owns the ledger.", knows: "Head office.", belief: "Exceptions cost.", impulse: "when doubted → cite policy", voice: ["Sign first."] },
    ],
  };
  const beat = {
    chapter: 1, hold: "the panel going into alarm", fired: "the fault alarm sounds",
    memories: { HALE: "the wing is insured on occupancy" },
  };

  it("normalizes a well-formed ledger with its defaults, and complains about nothing", () => {
    const { spec, problems } = normalizeSpec({ ...base, timeline: [beat] });
    assert.deepEqual(problems, []);
    assert.equal(spec.timeline.length, 1);
    assert.equal(spec.timeline[0].at, 0.45);
    assert.equal(spec.timeline[0].state, "pending");
  });

  it("reports a memory keyed to nobody and a beat aimed past the last scene, keeping both", () => {
    const { spec, problems } = normalizeSpec({
      ...base,
      timeline: [{ ...beat, memories: { HAIL: "typo" }, chapter: 9 }],
    });
    assert.equal(spec.timeline.length, 1, "a string-checkable problem is reported, never dropped");
    const joined = problems.join(" ");
    assert.match(joined, /memory to "HAIL"/);
    assert.match(joined, /chapter 9, past the story's last scene/);
  });

  it("drops a malformed beat and names the field that failed", () => {
    const { spec, problems } = normalizeSpec({
      ...base, timeline: [{ chapter: 1, hold: "the alarm" }, beat],
    });
    assert.equal(spec.timeline.length, 1, "the malformed entry costs itself, not the ledger");
    assert.equal(spec.timeline[0].fired, beat.fired);
    assert.match(problems.join(" "), /timeline beat 1/);
  });

  it("survives an edit round: applyEdits round-trips a ledger it has no edits for", () => {
    const { spec } = normalizeSpec({ ...base, timeline: [beat] });
    const r = applyEdits(spec, { edits: [{ field: "title", value: "Alarm, revised" }] });
    assert.deepEqual(r.spec.timeline, [{ ...beat, at: 0.45, memories: beat.memories, state: "pending" }]);
    assert.deepEqual(r.ignored, []);
  });

  it("renders into story.json, and omits the field entirely when the ledger is empty", () => {
    const models = { default: "m" };
    const withBeat = JSON.parse(renderStory(normalizeSpec({ ...base, timeline: [beat] }).spec, models)["story.json"]);
    assert.deepEqual(withBeat.timeline, [{ ...beat, at: 0.45, memories: beat.memories, state: "pending" }]);

    const without = JSON.parse(renderStory(normalizeSpec(base).spec, models)["story.json"]);
    assert.equal("timeline" in without, false, "no timeline field on stories that never had one");
  });

  it("renders a ledger a load will accept — normalize and renderStory agree about the shape", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      await writeFile(join(dir, "story.json"), renderStory(normalizeSpec({ ...base, timeline: [beat] }).spec, { default: "m" })["story.json"], "utf8");
      const sc = await quiet(() => loadStory(dir));
      assert.equal(sc.timeline.length, 1);
      assert.equal(sc.timeline[0].hold, beat.hold);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("renders a specView the schema still accepts once the editor drops its aliases", () => {
    const spec = normalizeSpec({ ...base, timeline: [beat] }).spec;
    const d: any = JSON.parse(JSON.stringify(specView(spec)));
    delete d.scene;
    d.characters = d.characters.map((c: any) => ({
      ...c,
      skills: (c.skills || []).map((s: any) =>
        typeof s === "string" ? s : [s.text, s.meaning].filter(Boolean).join(" :: ")),
    }));
    const r = StoryJson.safeParse(d);
    assert.equal(r.success, true, `the editor draft must validate: ${JSON.stringify(r.error?.issues)}`);
    assert.equal(r.success && r.data.timeline.length, 1);
  });

  it("reports a memory keyed to a character absent from that chapter's roster", () => {
    const { spec, problems } = normalizeSpec({
      ...base,
      scenes: [
        { place: "scene 1", question: "q1", roster: ["HALE"] },
        { place: "scene 2", question: "q2", roster: ["ODUYA"] },
      ],
      timeline: [{ chapter: 1, hold: "hold", fired: "fired", memories: { ODUYA: "fact" } }],
    });
    assert.equal(spec.timeline.length, 1, "the beat is kept");
    const joined = problems.join(" ");
    assert.match(joined, /ODUYA/);
    assert.match(joined, /chapter 1/);
    assert.match(joined, /roster/);
  });

  it("does not report a memory keyed to a character when the target scene's roster is empty (whole cast)", () => {
    const { spec, problems } = normalizeSpec({
      ...base,
      scenes: [
        { place: "scene 1", question: "q1", roster: [] },  // empty roster = whole cast
      ],
      timeline: [{ chapter: 1, hold: "hold", fired: "fired", memories: { ODUYA: "fact" } }],
    });
    assert.equal(spec.timeline.length, 1);
    const joined = problems.join(" ");
    assert.ok(!joined.includes("roster"), "no roster complaint when roster is empty");
  });

  it("reports both messages only if the character is not in the cast at all", () => {
    const { spec, problems } = normalizeSpec({
      ...base,
      scenes: [{ place: "scene 1", question: "q1", roster: ["HALE"] }],
      timeline: [{ chapter: 1, hold: "hold", fired: "fired", memories: { UNKNOWN: "fact" } }],
    });
    assert.equal(spec.timeline.length, 1);
    const joined = problems.join(" ");
    assert.match(joined, /not one of the characters/);
    assert.ok(!joined.includes("chapter 1's roster"), "no roster message for a character not in the cast");
  });

  it("survives an order check even with beats in different chapters", () => {
    const { spec, problems } = normalizeSpec({
      ...base,
      scenes: [{ place: "s1", question: "q1" }, { place: "s2", question: "q2" }],
      timeline: [
        { chapter: 1, hold: "h", fired: "f", at: 0.6, memories: {} },
        { chapter: 2, hold: "h", fired: "f", at: 0.3, memories: {} },
      ],
    });
    const joined = problems.join(" ");
    assert.ok(!joined.includes("order"), "beats in different chapters are not out of order");
  });
});

describe("timelineBeatProblems", () => {
  const beat = (over: Partial<{ chapter: number; hold: string; fired: string; at: number;
                                memories: Record<string, string>; state: "pending" | "fired" | "void" }> = {}) => ({
    chapter: 1, hold: "the panel going into alarm", fired: "the fault alarm sounds",
    at: 0.45, memories: {}, state: "pending" as const, ...over,
  });
  const cast = ["HALE", "ODUYA", "WREN"];
  const scenes = (...rosters: string[][]) => rosters.map(roster => ({ roster }));

  it("passes a plain beat aimed at a scene that exists", () => {
    assert.deepEqual(timelineBeatProblems("beat 1", beat(), cast, scenes([])), []);
  });

  it("reports a beat aimed past the last scene", () => {
    assert.match(timelineBeatProblems("beat 1", beat({ chapter: 3 }), cast, scenes([], []))[0],
      /aimed at chapter 3, past the story's last scene/);
  });

  // The one check with no test until it silently broke: a curly-quoted beat passed validation for a
  // while because the character class had been normalized to three ASCII quotes.
  for (const [label, text] of [
    ["straight quotes", `The tannoy says "clear the wing" twice.`],
    ["curly quotes", `The tannoy says “clear the wing” twice.`],
  ] as const) {
    it(`flags a fired form carrying ${label}`, () => {
      assert.match(timelineBeatProblems("beat 1", beat({ fired: text }), cast, scenes([])).join(" "),
        /fired form carries quoted speech/);
    });
    it(`flags a held form carrying ${label}`, () => {
      assert.match(timelineBeatProblems("beat 1", beat({ hold: text }), cast, scenes([])).join(" "),
        /held form carries quoted speech/);
    });
  }

  it("reports a memory keyed to a name that is in no chapter at all, and only that", () => {
    const out = timelineBeatProblems("beat 1", beat({ memories: { GHOST: "x" } }), cast, scenes(["HALE"]));
    assert.equal(out.length, 1, "one message, not both");
    assert.match(out[0], /"GHOST", who is not one of the characters/);
  });

  it("reports a memory keyed to a character absent from that chapter's roster", () => {
    const out = timelineBeatProblems("beat 1", beat({ chapter: 2, memories: { WREN: "x" } }),
      cast, scenes(["HALE", "WREN"], ["HALE", "ODUYA"]));
    assert.equal(out.length, 1);
    assert.match(out[0], /"WREN", who is not in chapter 2's roster/);
  });

  it("says nothing when the target scene's roster is empty — that means the whole cast is in it", () => {
    assert.deepEqual(timelineBeatProblems("beat 1", beat({ memories: { WREN: "x" } }), cast, scenes([])), []);
  });
});

describe("timelineOrderProblems", () => {
  it("reports nothing when beats descend across a chapter boundary — each chapter queues alone", () => {
    const beats = [
      { chapter: 1, hold: "h", fired: "f", at: 0.8, memories: {}, state: "pending" as const },
      { chapter: 2, hold: "h", fired: "f", at: 0.2, memories: {}, state: "pending" as const },
    ];
    assert.deepEqual(timelineOrderProblems(beats), []);
  });

  it("reports a descending pair within one chapter", () => {
    const beats = [
      { chapter: 1, hold: "h", fired: "f", at: 0.6, memories: {}, state: "pending" as const },
      { chapter: 1, hold: "h", fired: "f", at: 0.3, memories: {}, state: "pending" as const },
    ];
    const problems = timelineOrderProblems(beats);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /beat 2.*0\.3.*beat 1.*0\.6/);
  });

  it("reports nothing for ascending beats in the same chapter", () => {
    const beats = [
      { chapter: 1, hold: "h", fired: "f", at: 0.3, memories: {}, state: "pending" as const },
      { chapter: 1, hold: "h", fired: "f", at: 0.6, memories: {}, state: "pending" as const },
    ];
    const problems = timelineOrderProblems(beats);
    assert.deepEqual(problems, []);
  });

  it("ignores void beats", () => {
    const beats = [
      { chapter: 1, hold: "h", fired: "f", at: 0.6, memories: {}, state: "void" as const },
      { chapter: 1, hold: "h", fired: "f", at: 0.3, memories: {}, state: "pending" as const },
    ];
    const problems = timelineOrderProblems(beats);
    assert.deepEqual(problems, [], "void beats are not checked for ordering");
  });

  it("reports nothing for equal at values in the same chapter", () => {
    const beats = [
      { chapter: 1, hold: "h", fired: "f", at: 0.5, memories: {}, state: "pending" as const },
      { chapter: 1, hold: "h", fired: "f", at: 0.5, memories: {}, state: "pending" as const },
    ];
    const problems = timelineOrderProblems(beats);
    assert.deepEqual(problems, []);
  });
});

describe("editing the world-event ledger", () => {
  const beat = (over: Record<string, unknown> = {}) => ({
    chapter: 1, hold: "the panel going into alarm", fired: "The alarm takes over the wing.",
    at: 0.45, memories: { RIVEN: "the cage logs who was inside" }, state: "pending" as const, ...over,
  });
  const withLedger = (...beats: Record<string, unknown>[]) => normalizeSpec({
    title: "Doorway", premise: "A corridor at 3am.",
    scene: { place: "Behind Kessel's", question: "Does she get in?", pov: "RIVEN", length: 700 },
    scenes: [{ place: "Behind Kessel's", question: "Does she get in?", pov: "RIVEN", length: 700 },
             { place: "The yard", question: "Does she leave?", pov: "RIVEN", length: 700 }],
    characters: [{ name: "RIVEN", persona: "A courier.", knows: "The code changed.", skills: [], restrictions: [] }],
    timeline: beats,
  }).spec;
  const edit = (spec: any, field: string, value: any) =>
    quietSync(() => applyEdits(spec, { edits: [{ field, value }] }));

  // Re-aiming a stranded beat at the next chapter is what this surface exists for.
  it("re-aims a beat at another chapter", () => {
    const r = edit(withLedger(beat()), "beat_1.chapter", 2);
    assert.equal(r.spec.timeline[0].chapter, 2);
    assert.equal(r.applied[0].before, 1);
    assert.equal(r.applied[0].after, 2);
    assert.deepEqual(r.ignored, []);
  });

  it("voids a beat without removing it, so the ledger still records it was authored", () => {
    const r = edit(withLedger(beat()), "beat_1.state", "void");
    assert.equal(r.spec.timeline[0].state, "void");
    assert.equal(r.spec.timeline.length, 1);
  });

  it("edits the trigger and both forms", () => {
    let s: any = withLedger(beat());
    for (const [f, v] of [["beat_1.at", 0.8], ["beat_1.hold", "nothing yet"], ["beat_1.fired", "It happened."]] as const)
      s = edit(s, f, v).spec;
    assert.equal(s.timeline[0].at, 0.8);
    assert.equal(s.timeline[0].hold, "nothing yet");
    assert.equal(s.timeline[0].fired, "It happened.");
  });

  it("replaces the memory map wholesale, dropping blank names and blank memories", () => {
    const r = edit(withLedger(beat()), "beat_1.memories",
      { RIVEN: "a new one", "  ": "no name", MERRITT: "   " });
    assert.deepEqual(r.spec.timeline[0].memories, { RIVEN: "a new one" });
  });

  it("adds and removes a beat", () => {
    const added = edit(withLedger(beat()), "add_beat", beat({ chapter: 2, fired: "A second event." }));
    assert.equal(added.spec.timeline.length, 2);
    assert.match(added.applied[0].field, /added beat 2/);

    const removed = edit(added.spec, "remove_beat", 1);
    assert.equal(removed.spec.timeline.length, 1);
    assert.equal(removed.spec.timeline[0].fired, "A second event.");
  });

  it("ignores an edit to a beat that is not there, and says which", () => {
    for (const [field, value, why] of [
      ["beat_3.chapter", 2, /beat 3 does not exist/],
      ["remove_beat", 9, /there is no beat 9/],
      ["add_beat", "not an object", /the value must be a beat object/],
    ] as const) {
      const r = edit(withLedger(beat()), field, value);
      assert.match(r.ignored.join(" "), why);
      assert.equal(r.spec.timeline.length, 1, "and nothing changed");
    }
  });
});

describe("timelineDrift", () => {
  const beat = {
    chapter: 1, hold: "the panel going into alarm", fired: "the fault alarm sounds",
    at: 0.45, memories: { HALE: "the wing is insured on occupancy" }, state: "pending" as const,
  };

  it("returns [] for identical ledgers", () => {
    assert.deepEqual(timelineDrift([beat], [{ ...beat }]), []);
  });

  it("returns [] when both sides are empty", () => {
    assert.deepEqual(timelineDrift([], []), []);
  });

  it("names the beat and the field that changed", () => {
    assert.deepEqual(timelineDrift([beat], [{ ...beat, fired: "the fault alarm sounds again" }]),
      ["beat 1 (fired form)"]);
    assert.deepEqual(timelineDrift([beat], [{ ...beat, at: 0.5, memories: { HALE: "other" } }]),
      ["beat 1 (trigger, memories)"]);
  });

  it("ignores state changes — bookkeeping, not what the prose was written from", () => {
    assert.deepEqual(timelineDrift([beat], [{ ...beat, state: "void" }]), []);
  });

  it("is case-insensitive about memory keys and whitespace about values", () => {
    assert.deepEqual(timelineDrift([beat], [{ ...beat, memories: { hale: "  the wing is insured on occupancy  " } }]), []);
  });

  it("detects an added and a removed beat positionally", () => {
    assert.deepEqual(timelineDrift([], [beat]), ["beat 1 added"]);
    assert.deepEqual(timelineDrift([beat], []), ["beat 1 removed"]);
  });

  it("compares each position in order, not as a set", () => {
    const second = { ...beat, chapter: 2, hold: "the second held event", fired: "the second event lands" };
    assert.deepEqual(timelineDrift([beat, second], [second, beat]),
      ["beat 1 (chapter, held form, fired form)", "beat 2 (chapter, held form, fired form)"]);
  });
});

describe("slugify", () => {
  it("derives a safe folder name, or nothing at all", () => {
    assert.equal(slugify("The Unwritten Tide"), "the-unwritten-tide");
    assert.equal(slugify("  Bay 4 — Hatches!  "), "bay-4-hatches");
    assert.equal(slugify("../../etc/passwd"), "etc-passwd");
    assert.equal(slugify("???"), "", "nothing usable must yield nothing, not a fallback");
    assert.ok(slugify("x".repeat(80)).length <= 40);
    assert.ok(!slugify("Ends with punctuation ---").endsWith("-"));
  });

  // The accept step warns that a folder is taken before the click, so the viewer must know what the
  // engine will name the folder. That is a second implementation, pinned here: if they drift, the
  // warning silently stops matching what accept() actually refuses.
  it("matches the viewer's copy, which the accept step warns from", async () => {
    // The specifier goes through a variable on purpose: viewer JS is outside tsconfig's program, so
    // a literal import would be a TS7016 with no declaration file. This keeps it a plain runtime
    // import, which is all the test needs.
    const utilPath = "../server/gui/viewer/util.js";
    const viewerUtil = await import(utilPath) as { slugify: (s: string) => string };
    const viewerSlugify = viewerUtil.slugify;
    for (const s of ["The Cooling Loop", "  Bay 4 — Hatches!  ", "../../etc/passwd", "???",
                     "Ünïcodé Tïtlé", "Ends with punctuation ---", "x".repeat(80), ""])
      assert.equal(viewerSlugify(s), slugify(s), `viewer and engine disagree on ${JSON.stringify(s)}`);
  });
});

describe("renderStory round trip", () => {
  const spec = normalizeSpec({
    title: "The Unwritten Tide",
    premise: "Midwinter on a sea-stack lighthouse.\n\nThe relief boat is nine days overdue.",
    scene: { place: "The watchroom, 2am", question: "Does Elias catch her reading it?", pov: "MARA", length: 850 },
    writer_style: "Third person limited. Present tense.",
    characters: [
      { name: "ELIAS", persona: "The senior keeper.\n\nThirty years of it.", knows: "The radio only receives.",
        belief: "The relief boat is merely late, not lost.", impulse: "When the light fails, winds it by hand before saying a word.",
        voice: ["\"She has been late before. She has never been lost.\""],
        skills: ["writelog :: drafting entries in correct naval syntax"], restrictions: [] },
      { name: "MARA", persona: "The junior keeper.", knows: "The fog signal has not fired in eleven days.",
        skills: [], restrictions: ["hearing"] },
    ],
  }).spec;

  it("renders to a single story.json", () => {
    const files = renderStory(spec, { default: "some-model" });
    assert.deepEqual(Object.keys(files), ["story.json"]);
    assert.doesNotThrow(() => JSON.parse(files["story.json"]));
  });

  it("survives spec -> files -> loadStory unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      for (const [name, body] of Object.entries(renderStory(spec, { default: "some-model" })))
        await writeFile(join(dir, name), body, "utf8");
      const sc = await quiet(() => loadStory(dir));

      assert.equal(sc.premise, spec.premise, "paragraph breaks and all");
      assert.deepEqual(sc.scenes[0], spec.scenes[0]);
      assert.equal(sc.writerStyle.includes("Third person limited. Present tense."), true);
      assert.equal(sc.models.default, "some-model");
      assert.deepEqual(sc.characters.map(c => c.name), ["ELIAS", "MARA"]);

      const elias = sc.characters[0], mara = sc.characters[1];
      assert.equal(elias.knows, spec.characters[0].knows);
      assert.ok(elias.persona.includes("Thirty years of it."));
      assert.equal(elias.belief, "The relief boat is merely late, not lost.");
      assert.equal(elias.impulse, "When the light fails, winds it by hand before saying a word.");
      assert.deepEqual(elias.voice, ["\"She has been late before. She has never been lost.\""]);
      // The two things that would silently change the SCENE if lost:
      assert.ok(elias.skills.some(s => s.name === "writelog" && s.meaning.startsWith("drafting entries")));
      assert.ok(!mara.skills.some(s => s.name === "hearing"), "a restriction must survive as a real absence");
      assert.ok(mara.skills.some(s => s.name === "sight"), "and must not take anything else with it");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("round-trips a multi-line knows: literally — JSON needs no flattening", async () => {
    const messy = { ...spec, characters: [{ ...spec.characters[0], knows: "One thing.\nAnd another." }, spec.characters[1]] };
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      for (const [name, body] of Object.entries(renderStory(messy, { default: "m" })))
        await writeFile(join(dir, name), body, "utf8");
      const sc = await quiet(() => loadStory(dir));
      assert.equal(sc.characters[0].knows, "One thing.\nAnd another.");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("renders back every config key, models block and per-character model the story file declared", async () => {
    const original = JSON.parse(await readFile(join(ROOT, "tests/fixtures/doorway/story.json"), "utf8"));
    const { spec } = normalizeSpec(original);
    const rendered = JSON.parse(renderStory(spec, { default: "unused-fallback" })["story.json"]);

    for (const [key, value] of Object.entries(original.config))
      assert.deepEqual(rendered.config[key], value, `config.${key} must survive the round trip`);
    assert.deepEqual(rendered.models, original.models);
    assert.deepEqual(rendered.characters.map((c: any) => c.model),
                     original.characters.map((c: any) => c.model));
  });

  it("an unrelated edit does not disturb config or models", () => {
    const withConfig = normalizeSpec({
      title: "Title", premise: "A premise.",
      scene: { question: "Q?" },
      config: { maxProseWords: 200, maxSteps: 30 },
      models: { default: "model-a", writer: "model-w" },
      characters: [{ name: "SOLO", persona: "Alone.", model: "model-c" }],
    }).spec;

    const edited = quietSync(() => applyEdits(withConfig, { edits: [{ field: "title", value: "New Title" }] })).spec;
    assert.equal(edited.title, "New Title");
    assert.equal(edited.config.maxProseWords, 200, "maxProseWords must be preserved");
    assert.equal(edited.config.maxSteps, 30, "maxSteps must be preserved");
    assert.equal(edited.models.default, "model-a", "models.default must be preserved");
    assert.equal(edited.models.writer, "model-w", "models.writer must be preserved");
    assert.equal(edited.characters[0].model, "model-c", "per-character model must be preserved");
  });

  it("a fresh proposal with no config still renders with schema defaults and fallback model", () => {
    const fresh = normalizeSpec({}).spec;
    const rendered = renderStory(fresh, { default: "fallback-model" });
    const story = JSON.parse(rendered["story.json"]);
    assert.equal(story.config.maxProseWords, 140, "schema default for maxProseWords");
    assert.equal(story.config.maxSteps, 24, "schema default for maxSteps");
    assert.equal(story.models.default, "fallback-model", "fallback model from argument");
    assert.ok(!story.models.writer, "empty writer should not be emitted");
    assert.ok(!story.models.summary, "empty summary should not be emitted");
  });
});

describe("renderStory shape", () => {
  const bare = normalizeSpec({
    title: "Bare", premise: "A room.", scene: { question: "Does it end?" },
    characters: [{ name: "SOLO", persona: "Alone." }],
  }).spec;

  it("renders exactly one file, regardless of what was left blank", () => {
    const files = renderStory(bare, { default: "m" });
    assert.deepEqual(Object.keys(files), ["story.json"]);
  });

  it("writes empty fields as empty JSON values rather than omitting them, and fills in scene defaults", () => {
    const story = JSON.parse(renderStory(bare, { default: "m" })["story.json"]);
    assert.equal(story.writerStyle, "");
    assert.equal(story.scenes[0].place, "");
    assert.equal(story.scenes[0].pov, "");
    assert.equal(story.scenes[0].length, 700);
  });
});
