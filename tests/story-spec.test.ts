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
import { normalizeSpec, applyEdits, directEdit, renderStory } from "../engine/story-spec.ts";
import { quiet, quietSync, warnings } from "./helpers.ts";

// -- STORY SPEC (scaffolding, SPEC-S §3) -----------------------------------
describe("normalizeSpec", () => {
  const base = {
    title: "Doorway", premise: "A corridor at 3am.",
    scene: { place: "Behind Kessel's", question: "Does she get in?", pov: "RIVEN", length: 700 },
    characters: [{ name: "RIVEN", persona: "A courier.", knows: "The code changed.", skills: ["lockpicking :: picks locks"], restrictions: [] }],
  };

  it("accepts a well-formed proposal with no complaints", () => {
    const { spec, problems } = normalizeSpec(base);
    assert.deepEqual(problems, []);
    assert.equal(spec.scenes[0].pov, "RIVEN");
    assert.deepEqual(spec.characters[0].skills, ["lockpicking :: picks locks"]);
  });

  it("drops a restriction that names no general skill, and says why", () => {
    const { spec, problems } = normalizeSpec({
      ...base, characters: [{ ...base.characters[0], restrictions: ["telepathy", "sight"] }] });
    assert.deepEqual(spec.characters[0].restrictions, ["sight"]);
    assert.match(problems.join(" "), /telepathy/);
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
      persona: "A courier. VOICE: economical. KNOWS: the code changed. RESTRICTIONS: None." }] };
    assert.match(normalizeSpec(bled).problems.join(" "), /restates/);
    // A persona using the labelled headings the format actually asks for is fine.
    const ok = { ...base, characters: [{ ...base.characters[0],
      persona: "A courier. VOICE: economical. UNDER PRESSURE: politer, not louder." }] };
    assert.ok(!normalizeSpec(ok).problems.some(p => /restates/.test(p)));
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
    assert.deepEqual(r.applied, ["scene.place"]);
    assert.deepEqual(r.ignored, []);
    assert.equal(spec.scenes[0].place, "Behind Kessel's", "the input spec must not be mutated");
  });

  it("edits a character by name, case-insensitively", () => {
    const r = edit("characters.merritt.persona", "Older than they look.");
    assert.equal(r.spec.characters[1].persona, "Older than they look.");
    assert.deepEqual(r.applied, ["MERRITT.persona"]);
  });

  it("takes skills and restrictions as a list or a pipe-separated string", () => {
    assert.deepEqual(edit("characters.RIVEN.skills", ["climbing", "keys :: by feel"]).spec.characters[0].skills,
                     ["climbing", "keys :: by feel"]);
    assert.deepEqual(edit("characters.RIVEN.restrictions", "hearing | smell").spec.characters[0].restrictions,
                     ["hearing", "smell"]);
  });

  it("reports an unknown field instead of guessing at it", () => {
    const r = edit("scene.mood", "tense");
    assert.deepEqual(r.applied, []);
    assert.match(r.ignored.join(" "), /unknown field "scene\.mood"/);
    assert.deepEqual(r.spec, spec);
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
    assert.deepEqual(grown.applied, ["added scene 2"]);
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
    assert.deepEqual(r.applied, ["removed scene 1"]);

    const last = edit("remove_scene", 1);
    assert.equal(last.spec.scenes.length, 1);
    assert.match(last.ignored.join(" "), /a story needs at least one scene/);
  });

  it("ignores a remove_scene that names no scene", () => {
    for (const v of [0, 2, -1, "second", 1.5, null]) {
      const r = edit("remove_scene", v);
      assert.equal(r.spec.scenes.length, 1, String(v));
      assert.deepEqual(r.applied, [], String(v));
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
      assert.deepEqual(r.applied, ["scene.length"]);
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
    const original = JSON.parse(await readFile(join(ROOT, "stories/doorway/story.json"), "utf8"));
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
