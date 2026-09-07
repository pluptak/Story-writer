/**
 * Story spec tests — rendering and slugifying story proposals.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadStory, ROOT } from "../engine/story-format.ts";
import { slugify } from "../engine/config-util.ts";
import { normalizeSpec, applyEdits, renderStory, specView } from "../engine/story-spec.ts";
import { StoryJson } from "../engine/story-schema.ts";
import { quiet, quietSync } from "./helpers.ts";

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

  it("omits writerStyleConstraints when empty, and includes it when non-empty", () => {
    const base = {
      title: "Test", premise: "A premise.",
      scene: { question: "Q?" },
      characters: [{ name: "X", persona: "Person." }],
    };
    const without = JSON.parse(renderStory(normalizeSpec(base).spec, { default: "m" })["story.json"]);
    assert.equal("writerStyleConstraints" in without, false, "omitted when empty");

    const withConstraints = JSON.parse(renderStory(
      normalizeSpec({ ...base, writerStyleConstraints: ["no omniscience"] }).spec,
      { default: "m" }
    )["story.json"]);
    assert.deepEqual(withConstraints.writerStyleConstraints, ["no omniscience"]);
  });
});

describe("writerStyleConstraints", () => {
  const base = {
    title: "Doorway", premise: "A corridor at 3am.",
    scene: { place: "Behind Kessel's", question: "Does she get in?", pov: "RIVEN", length: 700 },
    characters: [{ name: "RIVEN", persona: "A courier.", knows: "The code changed.",
      belief: "The back door is still unlocked.", impulse: "When challenged, shows the crate label first.",
      voice: ["I deliver."],
      skills: ["lockpicking"], restrictions: [] }],
  };

  it("normalizeSpec accepts both writer_style_constraints and writerStyleConstraints", () => {
    const snake = normalizeSpec({ ...base, writer_style_constraints: ["no omniscience"] }).spec;
    assert.deepEqual(snake.writerStyleConstraints, ["no omniscience"]);

    const camel = normalizeSpec({ ...base, writerStyleConstraints: ["no omniscience"] }).spec;
    assert.deepEqual(camel.writerStyleConstraints, ["no omniscience"]);
  });

  it("normalizeSpec defaults writerStyleConstraints to an empty array", () => {
    const { spec } = normalizeSpec(base);
    assert.deepEqual(spec.writerStyleConstraints, []);
  });

  it("applyEdits handles writer_style_constraints and writerStyleConstraints", () => {
    const spec = normalizeSpec(base).spec;
    const r = quietSync(() => applyEdits(spec, {
      edits: [{ field: "writer_style_constraints", value: ["no omniscience", "do not narrate X's thoughts"] }],
    }));
    assert.deepEqual(r.spec.writerStyleConstraints, ["no omniscience", "do not narrate X's thoughts"]);
    assert.equal(r.applied.length, 1);
    assert.deepEqual(r.applied[0].before, []);

    // Also accept camelCase
    const camel = quietSync(() => applyEdits(spec, {
      edits: [{ field: "writerStyleConstraints", value: "a constraint" }],
    }));
    assert.deepEqual(camel.spec.writerStyleConstraints, ["a constraint"]);
  });

  it("specView includes writerStyleConstraints", () => {
    const spec = normalizeSpec({ ...base, writerStyleConstraints: ["no omniscience"] }).spec;
    const view = specView(spec);
    assert.deepEqual(view.writerStyleConstraints, ["no omniscience"]);
  });

  it("loadStory carries writerStyleConstraints from story.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      const spec = normalizeSpec({ ...base, writerStyleConstraints: ["constraint one", "constraint two"] }).spec;
      await writeFile(
        join(dir, "story.json"),
        renderStory(spec, { default: "m" })["story.json"],
        "utf8"
      );
      const sc = await quiet(() => loadStory(dir));
      assert.deepEqual(sc.writerStyleConstraints, ["constraint one", "constraint two"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("loadStory defaults writerStyleConstraints to an empty array when not present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      const spec = normalizeSpec(base).spec;
      await writeFile(
        join(dir, "story.json"),
        renderStory(spec, { default: "m" })["story.json"],
        "utf8"
      );
      const sc = await quiet(() => loadStory(dir));
      assert.deepEqual(sc.writerStyleConstraints, []);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
