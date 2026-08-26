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
import { normalizeSpec, applyEdits, directEdit, renderStory, sceneDrift, type SceneDef } from "../engine/story-spec.ts";
import { quiet, quietSync, warnings } from "./helpers.ts";

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

describe("slugify", () => {
  it("derives a safe folder name, or nothing at all", () => {
    assert.equal(slugify("The Unwritten Tide"), "the-unwritten-tide");
    assert.equal(slugify("  Bay 4 — Hatches!  "), "bay-4-hatches");
    assert.equal(slugify("../../etc/passwd"), "etc-passwd");
    assert.equal(slugify("???"), "", "nothing usable must yield nothing, not a fallback");
    assert.ok(slugify("x".repeat(80)).length <= 40);
    assert.ok(!slugify("Ends with punctuation ---").endsWith("-"));
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
      // The two things that would silently change the SCENE if they were lost:
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
