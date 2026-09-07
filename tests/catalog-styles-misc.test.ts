/** Deterministic suite for style advisory problems, general skills, and origin interactions. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadStory } from "../engine/story-format.ts";
import { loadCatalog, checkEntry, saveEntry, deleteEntry, skillBibleEntries, skillOrigins, originSkillGroups, generalSkillEntries, persistedCatalogs } from "../engine/catalog.ts";
import { WARN } from "../engine/warnings.ts";
import { quiet } from "./helpers.ts";
import { SKILL_CATALOG, SPECIAL_SKILL_CATALOG, ORIGIN_SKILL_GROUPS } from "../engine/skills.ts";

describe("style advisory problems", () => {
  it("reports empty voice problem", async () => {
    const result = checkEntry("styles", {
      id: "empty-voice",
      name: "No Voice",
      description: "A style with no voice",
      voice: "",
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      const hasVoiceProblem = result.problems.some(p => p.includes("has no voice"));
      assert.ok(hasVoiceProblem, "should report empty voice");
      assert.ok(result.problems.some(p => p.includes("travels between stories")), "should mention travel");
    }
  });

  it("reports empty description problem", async () => {
    const result = checkEntry("styles", {
      id: "no-desc",
      name: "No Description",
      description: "",
      voice: "Some voice here.",
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      const hasDescProblem = result.problems.some(p => p.includes("has no description"));
      assert.ok(hasDescProblem, "should report empty description");
      assert.ok(result.problems.some(p => p.includes("chosen from a list")), "should mention preset selection");
    }
  });

  it("reports perception clause problem for 'cannot see'", async () => {
    const result = checkEntry("styles", {
      id: "perception-test",
      name: "With Perception Clause",
      description: "A style",
      voice: "I cannot see what others miss.",
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      const hasPerceptionProblem = result.problems.some(p => p.includes("story-specific perception rule"));
      assert.ok(hasPerceptionProblem, "should report perception clause");
      assert.ok(result.problems.some(p => p.includes("cannot see")), "should name the matched phrase");
      assert.ok(result.problems.some(p => p.includes("swapped")), "should mention swapping voices");
    }
  });

  it("reports perception clause problem for a contracted cannot", async () => {
    const result = checkEntry("styles", {
      id: "cant-see-test",
      name: "Can't See",
      voice: "I can't see in the dark.",
      description: "A style",
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      const hasPerceptionProblem = result.problems.some(p => p.includes("story-specific perception rule"));
      assert.ok(hasPerceptionProblem);
      assert.ok(result.problems.some(p => p.includes("can't see")));
    }
  });

  it("reports perception clause problem for 'is blind'", async () => {
    const result = checkEntry("styles", {
      id: "blind-test",
      name: "Blind Narrator",
      voice: "The narrator is blind to what happens offstage.",
      description: "A style",
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      const hasPerceptionProblem = result.problems.some(p => p.includes("story-specific perception rule"));
      assert.ok(hasPerceptionProblem);
      assert.ok(result.problems.some(p => p.includes("is blind")));
    }
  });

  it("reports perception clause problem for 'no omniscience'", async () => {
    const result = checkEntry("styles", {
      id: "no-omni-test",
      name: "Limited Narrator",
      voice: "There is no omniscience here.",
      description: "A style",
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      const hasPerceptionProblem = result.problems.some(p => p.includes("story-specific perception rule"));
      assert.ok(hasPerceptionProblem);
      assert.ok(result.problems.some(p => p.includes("no omniscience")));
    }
  });

  it("reports perception clause problem for 'only visible'", async () => {
    const result = checkEntry("styles", {
      id: "visible-test",
      name: "Visible Only",
      voice: "Render only visible things.",
      description: "A style",
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      const hasPerceptionProblem = result.problems.some(p => p.includes("story-specific perception rule"));
      assert.ok(hasPerceptionProblem);
      assert.ok(result.problems.some(p => p.includes("only visible")));
    }
  });

  it("reports perception clause problem for 'nothing that is only'", async () => {
    const result = checkEntry("styles", {
      id: "nothing-test",
      name: "Nothing Only",
      voice: "Render nothing that is only audible.",
      description: "A style",
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      const hasPerceptionProblem = result.problems.some(p => p.includes("story-specific perception rule"));
      assert.ok(hasPerceptionProblem);
      assert.ok(result.problems.some(p => p.includes("nothing that is only")));
    }
  });

  it("detects perception clause case-insensitively", async () => {
    const result = checkEntry("styles", {
      id: "case-test",
      name: "Case Test",
      voice: "CANNOT SEE things in the shadows.",
      description: "A style",
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      const hasPerceptionProblem = result.problems.some(p => p.includes("story-specific perception rule"));
      assert.ok(hasPerceptionProblem, "should detect case-insensitively");
    }
  });

  it("produces no perception problem when voice has no perception clause", async () => {
    const result = checkEntry("styles", {
      id: "clean-voice",
      name: "Clean Voice",
      description: "A proper voice",
      voice: "Terse. Present tense. Vivid imagery.",
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      const hasPerceptionProblem = result.problems.some(p => p.includes("story-specific perception rule"));
      assert.equal(hasPerceptionProblem, false, "should not report perception problem");
    }
  });

  it("reports all three problems when all are present", async () => {
    const result = checkEntry("styles", {
      id: "all-problems",
      name: "Problem Child",
      description: "",
      voice: "",
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.problems.length, 2, "should report empty voice and empty description");
      assert.ok(result.problems.some(p => p.includes("has no voice")));
      assert.ok(result.problems.some(p => p.includes("has no description")));
    }
  });

  it("reports voice + perception when both present", async () => {
    const result = checkEntry("styles", {
      id: "voice-and-perception",
      name: "Mixed",
      description: "Good description",
      voice: "I cannot see details.",
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.problems.length, 1, "should report only perception problem (not voice)");
      assert.ok(result.problems[0].includes("story-specific perception rule"));
    }
  });

  it("saves a style with advisory problems (problems do not block)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "style-advisory-test-"));
    const path = join(dir, "styles.json");
    try {
      const problematicStyle = {
        id: "problematic",
        name: "Problematic",
        description: "",
        voice: "I cannot see the future.",
      };

      const result = await saveEntry("styles", problematicStyle, path);
      assert.equal(result.ok, true, "should still save despite advisory problems");
      if (result.ok) {
        assert.ok(result.problems.length > 0, "should have reported problems");
        assert.ok(result.problems.some(p => p.includes("story-specific perception rule")));
        assert.ok(result.problems.some(p => p.includes("has no description")));
      }

      // Verify the style was actually saved
      const loaded = await loadCatalog("styles", path);
      assert.equal(loaded.entries.length, 1);
      assert.equal(loaded.entries[0].id, "problematic");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("a persisted origin reaching a story", () => {
  it("resolves a character's general skills against the author's catalog, not the in-code one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "origin-endtoend-test-"));
    const catalog = join(dir, "catalog-skills.json");
    try {
      await writeFile(catalog, JSON.stringify({ entries: [
        { id: "bird", version: 1, name: "bird", kind: "origin",
          meaning: "a small bird: it flies, sees and hears, and cannot speak or handle anything",
          general: ["movement", "sight", "hearing"], tags: [] },
      ] }), "utf8");
      await writeFile(join(dir, "story.json"), JSON.stringify({
        title: "T", premise: "A premise.",
        scenes: [{ place: "A branch", question: "Does it stay?" }],
        characters: [{ name: "PIP", persona: "A jackdaw.", origin: "bird" }],
      }), "utf8");

      const origins = await skillOrigins(catalog);
      const sc = await quiet(() => loadStory(dir, undefined, { origins }));
      const pip = sc.characters[0];
      assert.deepEqual(pip.skills.map(s => s.name), ["movement", "hearing", "sight"]);
      assert.deepEqual(pip.limits, ["speech", "touch", "taste", "smell", "recall"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("the shipped catalog-skills.json", () => {
  // The author's own file is gitignored user data, so what ships is whatever sits in data/catalogs/.
  // This pins it to the engine's in-code seed: a fresh install and a first save must agree on what
  // special skills and origins exist.
  const shipped = join(fileURLToPath(new URL("../..", import.meta.url)), "data", "catalogs", "catalog-skills.json");

  it("carries both the special skills and the origins", async () => {
    const bible = await skillBibleEntries(shipped);
    for (const [name, meaning] of Object.entries(SPECIAL_SKILL_CATALOG)) {
      assert.equal(bible[name], meaning, `shipped special skill "${name}"`);
    }
    assert.equal(bible.human, undefined, "an origin must never resolve as a special skill");

    const origins = await originSkillGroups(shipped);
    assert.deepEqual(origins["ai"], [...ORIGIN_SKILL_GROUPS.ai.skills]);
    assert.deepEqual(origins["human"], [...ORIGIN_SKILL_GROUPS.human.skills]);
    assert.equal(origins["lockpicking"], undefined, "a special skill is not an origin");
  });
});

describe("a malformed skills catalog", () => {
  it("degrades to an empty catalog rather than throwing out of the legacy-tags strip", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skills-malformed-test-"));
    const path = join(dir, "catalog-skills.json");
    try {
      await writeFile(path, JSON.stringify({ entries: "not an array" }), "utf8");
      const warns: string[] = [];
      const orig = WARN.sink;
      WARN.sink = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
      let result;
      try { result = await loadCatalog("skills", path); } finally { WARN.sink = orig; }
      assert.deepEqual(result.entries, []);
      assert.match(warns.join(" "), /could not be parsed/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("generalSkillEntries", () => {
  const write = async (entries: unknown[]) => {
    const dir = await mkdtemp(join(tmpdir(), "generals-test-"));
    const path = join(dir, "catalog-skills.json");
    await writeFile(path, JSON.stringify({ entries }), "utf8");
    return { dir, path };
  };

  it("returns the seeded eight when no file exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "generals-seed-test-"));
    try {
      assert.deepEqual(await generalSkillEntries(join(dir, "absent.json")), { ...SKILL_CATALOG });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("returns exactly the persisted general entries, ignoring the other kinds", async () => {
    const { dir, path } = await write([
      { id: "hearing", version: 1, name: "hearing", meaning: "perceiving sound", kind: "general", general: [] },
      { id: "lockpicking", version: 1, name: "lockpicking", meaning: "opening a lock", kind: "special", general: [] },
      { id: "bird", version: 1, name: "bird", meaning: "a small bird", kind: "origin", general: ["hearing"] },
    ]);
    try {
      assert.deepEqual(await generalSkillEntries(path), { hearing: "perceiving sound" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("falls back to the in-code eight for a catalog that predates general skills", async () => {
    // The destructive case: this file wins entirely over the seed, so reading {} off it would
    // strip every general skill from every character in every story.
    const { dir, path } = await write([
      { id: "lockpicking", version: 1, name: "lockpicking", meaning: "opening a lock", kind: "special", general: [] },
    ]);
    try {
      assert.deepEqual(await generalSkillEntries(path), { ...SKILL_CATALOG });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("persistedCatalogs wires all three lookups to the same file", async () => {
    const { dir, path } = await write([
      { id: "hearing", version: 1, name: "hearing", meaning: "perceiving sound", kind: "general", general: [] },
      { id: "echolocation", version: 1, name: "echolocation", meaning: "seeing by sound", kind: "special", general: [] },
      { id: "bat", version: 1, name: "bat", meaning: "a bat", kind: "origin", general: ["hearing"] },
    ]);
    try {
      const c = await persistedCatalogs(path);
      assert.deepEqual(c.generals, { hearing: "perceiving sound" });
      assert.equal(c.bible?.("echolocation"), "seeing by sound");
      assert.deepEqual(c.origins?.("bat"), ["hearing"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("deleting a general skill an origin grants", () => {
  const catalogWith = async (entries: unknown[]) => {
    const dir = await mkdtemp(join(tmpdir(), "general-delete-test-"));
    const path = join(dir, "catalog-skills.json");
    await writeFile(path, JSON.stringify({ entries }), "utf8");
    return { dir, path };
  };
  const general = (name: string) =>
    ({ id: name, version: 1, name, meaning: `the ${name} of it`, kind: "general", general: [] });
  const origin = (name: string, grants: string[]) =>
    ({ id: name, version: 1, name, meaning: `a ${name}`, kind: "origin", general: grants });

  it("refuses, naming the origin, and leaves the entry in place", async () => {
    const { dir, path } = await catalogWith([general("sight"), origin("human", ["sight"])]);
    try {
      const r = await deleteEntry("skills", "sight", path);
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.reason, /"sight" is granted by origin "human" — remove it from it first/);
      const after = await loadCatalog("skills", path);
      assert.ok(after.entries.some((e: any) => e.id === "sight"), "the entry must survive a refusal");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("names every origin that grants it", async () => {
    const { dir, path } = await catalogWith([
      general("sight"), origin("human", ["sight"]), origin("hawk", ["Sight"]),
    ]);
    try {
      const r = await deleteEntry("skills", "sight", path);
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.match(r.reason, /origins "human", "hawk"/, "matched by canon name, so Sight counts");
        assert.match(r.reason, /remove it from them first/);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("allows a general no origin grants, and never blocks a special or an origin", async () => {
    const { dir, path } = await catalogWith([
      general("sight"), general("smell"), origin("human", ["sight"]),
      { id: "lockpicking", version: 1, name: "lockpicking", meaning: "opening a lock", kind: "special", general: [] },
    ]);
    try {
      assert.equal((await deleteEntry("skills", "smell", path)).ok, true);
      assert.equal((await deleteEntry("skills", "lockpicking", path)).ok, true);
      assert.equal((await deleteEntry("skills", "human", path)).ok, true);
      // and with the origin gone, the general it used to grant can go too
      assert.equal((await deleteEntry("skills", "sight", path)).ok, true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
