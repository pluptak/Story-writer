/** Deterministic suite for styles and skills catalogs, including skill advisory problems and the skillBible. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCatalog, checkEntry, saveEntry, deleteEntry, skillBible } from "../engine/catalog.ts";
import { WARN } from "../engine/warnings.ts";
import { SPECIAL_SKILL_CATALOG } from "../engine/skills.ts";

describe("styles catalog (no seed)", () => {
  it("loadCatalog('styles') on a missing path returns empty and emits NO warning (no seed)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "styles-no-seed-test-"));
    const path = join(dir, "nonexistent-styles.json");
    try {
      const warns: string[] = [];
      const orig = WARN.sink;
      WARN.sink = (msg: string) => { warns.push(msg); };
      let result;
      try {
        result = await loadCatalog("styles", path);
      } finally {
        WARN.sink = orig;
      }

      // Styles have no seed, so missing file returns empty
      assert.deepEqual(result, { entries: [] }, "missing styles file should return empty, not a seed");
      assert.equal(warns.length, 0, "missing styles file should not warn");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("saves and loads a style entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "style-save-test-"));
    const path = join(dir, "styles.json");
    try {
      const style = {
        id: "noir",
        name: "Noir Detective",
        description: "Dark, cynical, first-person",
        voice: "The city keeps its secrets.",
        tags: ["noir", "detective"],
      };

      const saveResult = await saveEntry("styles", style, path);
      assert.equal(saveResult.ok, true);
      if (saveResult.ok) {
        assert.equal(saveResult.entry.id, "noir");
        assert.equal(saveResult.entry.version, 1);
      }

      const loaded = await loadCatalog("styles", path);
      assert.equal(loaded.entries.length, 1);
      assert.equal(loaded.entries[0].id, "noir");
      assert.equal(loaded.entries[0].name, "Noir Detective");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("re-saves a style and bumps version to 2", async () => {
    const dir = await mkdtemp(join(tmpdir(), "style-version-test-"));
    const path = join(dir, "styles.json");
    try {
      const style1 = {
        id: "noir",
        name: "Noir Detective",
        description: "Dark, cynical",
        voice: "The city keeps secrets.",
      };

      const save1 = await saveEntry("styles", style1, path);
      assert.equal(save1.ok, true);
      if (save1.ok) assert.equal(save1.entry.version, 1);

      const style2 = {
        id: "noir",
        name: "Noir Detective (Revised)",
        description: "Very dark, very cynical",
        voice: "The city never forgives.",
      };

      const save2 = await saveEntry("styles", style2, path);
      assert.equal(save2.ok, true);
      if (save2.ok) assert.equal(save2.entry.version, 2);

      const loaded = await loadCatalog("styles", path);
      assert.equal(loaded.entries.length, 1);
      assert.equal(loaded.entries[0].version, 2);
      assert.equal(loaded.entries[0].name, "Noir Detective (Revised)");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("deletes a style", async () => {
    const dir = await mkdtemp(join(tmpdir(), "style-delete-test-"));
    const path = join(dir, "styles.json");
    try {
      const style = {
        id: "noir",
        name: "Noir",
        description: "Dark",
        voice: "Gritty.",
      };

      const save = await saveEntry("styles", style, path);
      assert.equal(save.ok, true);

      const loaded1 = await loadCatalog("styles", path);
      assert.equal(loaded1.entries.length, 1);

      const del = await deleteEntry("styles", "noir", path);
      assert.equal(del.ok, true);

      const loaded2 = await loadCatalog("styles", path);
      assert.equal(loaded2.entries.length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("skills seeding", () => {
  it("loadCatalog('skills') on a missing path returns the seed with all three kinds of skills and lockpicking", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skills-seed-test-"));
    const path = join(dir, "nonexistent-skills.json");
    try {
      const warns: string[] = [];
      const orig = WARN.sink;
      WARN.sink = (msg: string) => { warns.push(msg); };
      let result;
      try {
        result = await loadCatalog("skills", path);
      } finally {
        WARN.sink = orig;
      }

      // Should have entries from the seed (8 general + 3 special + 2 origins = 13)
      assert.equal(result.entries.length, 13, "seed should have 8 general + 3 special + 2 origins");
      // Check that lockpicking (special) is in the seed
      const lockpicking = result.entries.find((e: any) => e.id === "lockpicking");
      assert.ok(lockpicking, "seed should include lockpicking");
      assert.equal(lockpicking.kind, "special", "lockpicking should be a special skill");
      assert.equal(lockpicking.name, "lockpicking", "lockpicking name should match id");
      assert.ok(lockpicking.meaning.includes("lock"), "lockpicking meaning should mention lock");
      // Check that a general skill is in the seed
      const movement = result.entries.find((e: any) => e.id === "movement");
      assert.ok(movement, "seed should include movement");
      assert.equal(movement.kind, "general", "movement should be a general skill");
      // Check that an origin is in the seed
      const human = result.entries.find((e: any) => e.id === "human");
      assert.ok(human, "seed should include human origin");
      assert.equal(human.kind, "origin", "human should be an origin");
      // Should not warn
      assert.equal(warns.length, 0, "missing file should not warn");
      // No entry should have a tags key
      assert.ok(result.entries.every((e: any) => !("tags" in e)), "no entry should carry a tags key");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loadCatalog('skills') on an existing file returns exactly that file's entries — seed skills deleted from the file stay deleted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skills-override-test-"));
    const path = join(dir, "skills.json");
    try {
      // Write a minimal skills file (without the seed)
      const minimalCatalog = {
        entries: [
          {
            id: "custom-skill",
            version: 1,
            name: "Custom Skill",
            meaning: "a custom skill",
            tags: [],
          },
        ],
      };
      await writeFile(path, JSON.stringify(minimalCatalog, null, 2) + "\n", "utf8");

      const result = await loadCatalog("skills", path);

      // Should have only the custom skill, not the seed
      assert.equal(result.entries.length, 1, "should return only the file's entry, not the seed");
      assert.equal(result.entries[0].id, "custom-skill");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("skills save/load boundary (seed materialization)", () => {
  it("saving one edited entry into a fresh skills file then loading returns all seed entries plus the edit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skills-materialize-test-"));
    const path = join(dir, "skills.json");
    try {
      // Save one skill edit to a fresh file
      const skill = {
        id: "lockpicking",
        name: "Lock Picking",
        meaning: "opening mechanical locks with tools",
      };
      const save = await saveEntry("skills", skill, path);
      assert.equal(save.ok, true);

      // Load should return all seed entries with the edited one included
      const loaded = await loadCatalog("skills", path);
      assert.equal(loaded.entries.length, 13, "the whole seed is materialized by the first save (8 general + 3 special + 2 origins)");

      // The edited skill should be in the loaded catalog
      const found = loaded.entries.find((e: any) => e.id === "lockpicking");
      assert.ok(found, "edited skill should be in loaded catalog");
      assert.equal(found.name, "Lock Picking", "edited name should be persisted");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("deleting a seed skill from a fresh file then loading returns all seed minus deleted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skills-delete-test-"));
    const path = join(dir, "skills.json");
    try {
      // Load fresh (gets seed)
      const fresh = await loadCatalog("skills", path);
      const seedCount = fresh.entries.length;
      assert.equal(seedCount, 13, "the seed is the in-code catalog (8 general + 3 special + 2 origins)");

      // Delete a seed skill
      const del = await deleteEntry("skills", "lockpicking", path);
      assert.equal(del.ok, true);

      // Load should return seed minus the deleted skill
      const loaded = await loadCatalog("skills", path);
      assert.equal(loaded.entries.length, seedCount - 1, "should have seed minus deleted skill");

      // Deleted skill should be gone
      const found = loaded.entries.find((e: any) => e.id === "lockpicking");
      assert.equal(found, undefined, "deleted skill should be gone");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("deleting a skill then loading again returns same count (seed does not resurrect)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skills-no-merge-test-"));
    const path = join(dir, "skills.json");
    try {
      // Load, delete, load
      let loaded1 = await loadCatalog("skills", path);
      const seedCount = loaded1.entries.length;

      const del = await deleteEntry("skills", "lockpicking", path);
      assert.equal(del.ok, true);

      let loaded2 = await loadCatalog("skills", path);
      assert.equal(loaded2.entries.length, seedCount - 1, "first deletion removes one");

      // Load again — file still wins, seed does not come back
      let loaded3 = await loadCatalog("skills", path);
      assert.equal(loaded3.entries.length, seedCount - 1, "seed does not resurrect on re-load");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("skill advisory problems", () => {
  it("checkEntry('skills', …) on an origin naming a non-general skill reports a problem", async () => {
    const result = checkEntry("skills", {
      id: "bad-origin",
      name: "bad-origin",
      meaning: "a test origin",
      tags: [],
      kind: "origin",
      general: ["speech", "telepathy"],
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      const hasProblem = result.problems.some(p => p.includes("telepathy") && p.includes("not a general skill"));
      assert.ok(hasProblem, "should report unknown general skill in origin");
    }
  });

  it("checkEntry('skills', …) on an origin with empty general reports a problem", async () => {
    const result = checkEntry("skills", {
      id: "empty-origin",
      name: "empty-origin",
      meaning: "an origin granting nothing",
      tags: [],
      kind: "origin",
      general: [],
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      const hasProblem = result.problems.some(p => p.includes("no general skills"));
      assert.ok(hasProblem, "should report empty origin general list");
    }
  });

  it("checkEntry('skills', …) on a special skill with a non-empty general reports a problem", async () => {
    const result = checkEntry("skills", {
      id: "bad-special",
      name: "bad-special",
      meaning: "a special skill with general field",
      tags: [],
      kind: "special",
      general: ["speech"],
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      const hasProblem = result.problems.some(p => p.includes("only an origin lists general skills"));
      assert.ok(hasProblem, "should report special skill carrying general list");
    }
  });

  it("checkEntry('skills', …) reports whitespace-only meaning problem", async () => {
    const result = checkEntry("skills", {
      id: "whitespace-meaning",
      name: "Whitespace Meaning",
      meaning: "   ",
      tags: [],
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      const hasMeaningProblem = result.problems.some(p => p.includes("has no meaning"));
      assert.ok(hasMeaningProblem, "should report whitespace-only meaning");
    }
  });

  it("checkEntry('skills', …) reports when name is a general skill", async () => {
    const result = checkEntry("skills", {
      id: "sight",
      name: "sight",
      meaning: "what sight lets you do",
      tags: [],
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      const hasGeneralProblem = result.problems.some(p => p.includes("general skill"));
      assert.ok(hasGeneralProblem, "should report general skill collision");
      assert.ok(result.problems.some(p => p.includes("already has")), "should mention already has");
    }
  });

  it("checkEntry('skills', …) reports when name contains '::'", async () => {
    const result = checkEntry("skills", {
      id: "bad-name",
      name: "bad :: name",
      meaning: "a skill",
      tags: [],
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      const hasColonProblem = result.problems.some(p => p.includes("::"));
      assert.ok(hasColonProblem, "should report :: in name");
      assert.ok(result.problems.some(p => p.includes("separator")), "should mention separator");
    }
  });

  it("checkEntry('skills', …) produces no problem for a valid bible skill", async () => {
    const result = checkEntry("skills", {
      id: "lockpicking",
      name: "lockpicking",
      meaning: "opening a mechanical lock without its key",
      tags: ["security"],
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.problems, [], "valid skill should have no problems");
    }
  });

  it("saves a skill with advisory problems (problems do not block)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-advisory-test-"));
    const path = join(dir, "skills.json");
    try {
      const problematicSkill = {
        id: "sight",
        name: "sight",
        meaning: "custom meaning for sight",
        tags: [],
      };

      const result = await saveEntry("skills", problematicSkill, path);
      assert.equal(result.ok, true, "should still save despite advisory problems");
      if (result.ok) {
        assert.ok(result.problems.length > 0, "should have reported problems");
        assert.ok(result.problems.some(p => p.includes("general skill")));
      }

      // Verify the skill was actually saved
      const loaded = await loadCatalog("skills", path);
      const found = loaded.entries.find((e: any) => e.id === "sight");
      assert.ok(found, "skill should be saved despite problems");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("checkEntry('skills', …) reports when a general entry carries a general list", async () => {
    const result = checkEntry("skills", {
      id: "movement",
      name: "Movement",
      meaning: "moving your own body",
      kind: "general",
      general: ["speech"],
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      const hasProblem = result.problems.some(p => p.includes("only an origin lists general skills"));
      assert.ok(hasProblem, "should report general entry carrying general list");
    }
  });
});

describe("legacy tags support in skills", () => {
  it("loadCatalog('skills') on a file with tags on each entry loads correctly and strips them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skills-legacy-tags-test-"));
    const path = join(dir, "skills.json");
    try {
      // Write a catalog with legacy tags on entries
      const withTags = {
        entries: [
          {
            id: "custom-skill",
            version: 1,
            name: "Custom Skill",
            meaning: "a custom skill",
            tags: ["custom", "legacy"],
            kind: "special",
            general: [],
          },
          {
            id: "human",
            version: 1,
            name: "human",
            meaning: "a person",
            tags: ["origin"],
            kind: "origin",
            general: ["speech", "recall", "movement"],
          },
        ],
      };
      await writeFile(path, JSON.stringify(withTags, null, 2) + "\n", "utf8");

      // Load should strip tags and return entries intact
      const loaded = await loadCatalog("skills", path);
      assert.equal(loaded.entries.length, 2, "both entries should load");
      assert.ok(loaded.entries.every((e: any) => !("tags" in e)), "no entry should carry a tags key");

      // Verify a specific entry's content
      const custom = loaded.entries.find((e: any) => e.id === "custom-skill");
      assert.ok(custom, "custom-skill should be loaded");
      assert.equal(custom.name, "Custom Skill", "content should be intact");
      assert.equal(custom.kind, "special", "kind should be preserved");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("saveEntry('skills', …) accepts tags in the payload and does not persist them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skills-save-tags-test-"));
    const path = join(dir, "skills.json");
    try {
      const payloadWithTags = {
        id: "test-skill",
        name: "Test Skill",
        meaning: "a test skill",
        tags: ["test", "example"],
        kind: "special",
        general: [],
      };

      const save = await saveEntry("skills", payloadWithTags, path);
      assert.equal(save.ok, true, "save with tags should succeed");

      // Reload and verify tags are not there
      const loaded = await loadCatalog("skills", path);
      const found = loaded.entries.find((e: any) => e.id === "test-skill");
      assert.ok(found, "entry should be saved");
      assert.equal(!("tags" in found), true, "persisted entry should not have tags");
      assert.equal(found.meaning, "a test skill", "other fields should be intact");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("skill canonical duplicate detection", () => {
  it("saveEntry('skills', …) reports duplicate canonical name under different id and still saves", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-dup-test-"));
    const path = join(dir, "skills.json");
    try {
      // Save first skill
      const skill1 = {
        id: "lockpicking",
        name: "lockpicking",
        meaning: "opening locks",
      };
      const save1 = await saveEntry("skills", skill1, path);
      assert.equal(save1.ok, true);

      // Try to save a second skill with different id but same canonical name
      const skill2 = {
        id: "pick-locks",
        name: "Lockpicking",
        meaning: "opening locks with picks",
      };
      const save2 = await saveEntry("skills", skill2, path);
      assert.equal(save2.ok, true, "should still save despite canonical duplicate");
      if (save2.ok) {
        const hasDupWarning = save2.problems.some(p => p.includes("already in the bible"));
        assert.ok(hasDupWarning, "should include advisory about canonical duplicate");
        assert.ok(save2.problems[0].includes("lockpicking"), "should name the existing entry");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("saveEntry('skills', …) does NOT report duplicate when same id is re-saved", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-resave-test-"));
    const path = join(dir, "skills.json");
    try {
      const skill = {
        id: "lockpicking",
        name: "lockpicking",
        meaning: "opening locks",
      };

      // First save
      const save1 = await saveEntry("skills", skill, path);
      assert.equal(save1.ok, true);

      // Re-save the same skill (same id)
      const save2 = await saveEntry("skills", skill, path);
      assert.equal(save2.ok, true);
      if (save2.ok) {
        const hasDupWarning = save2.problems.some(p => p.includes("already in the bible"));
        assert.equal(hasDupWarning, false, "should not report duplicate for same-id re-save");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("skillBible", () => {
  it("skillBible(tmpPath) on an absent file returns the in-code seed's meaning for lockpicking", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skillbible-absent-test-"));
    const path = join(dir, "nonexistent-skills.json");
    try {
      const bible = await skillBible(path);
      const meaning = bible("lockpicking");
      assert.equal(meaning, SPECIAL_SKILL_CATALOG.lockpicking, "should return seed meaning");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skillBible(tmpPath) on an absent file returns undefined for an unknown name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skillbible-unknown-test-"));
    const path = join(dir, "nonexistent-skills.json");
    try {
      const bible = await skillBible(path);
      const meaning = bible("unknown-skill");
      assert.equal(meaning, undefined, "should return undefined for unknown skill");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skillBible(tmpPath) on a written file returns that file's meanings, not the seed's", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skillbible-written-test-"));
    const path = join(dir, "skills.json");
    try {
      // Write a file with a custom skill and an edited lockpicking
      const customCatalog = {
        entries: [
          {
            id: "lockpicking",
            version: 1,
            name: "lockpicking",
            meaning: "custom lockpicking meaning",
            tags: [],
          },
          {
            id: "custom-skill",
            version: 1,
            name: "custom-skill",
            meaning: "a custom ability",
            tags: [],
          },
        ],
      };
      await writeFile(path, JSON.stringify(customCatalog, null, 2) + "\n", "utf8");

      const bible = await skillBible(path);

      // The file's custom meaning for lockpicking should be returned
      assert.equal(bible("lockpicking"), "custom lockpicking meaning", "should return file's meaning, not seed's");
      // The custom skill should be in the bible
      assert.equal(bible("custom-skill"), "a custom ability", "should return custom skill meaning");
      // A skill omitted from the file should not be in the bible (file wins entirely)
      assert.equal(bible("climbing"), undefined, "omitted skills should not be in the file-based bible");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skillBible: a blank/whitespace meaning in the file is skipped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skillbible-blank-test-"));
    const path = join(dir, "skills.json");
    try {
      // Write a file with a blank-meaning skill
      const customCatalog = {
        entries: [
          {
            id: "blank-skill",
            version: 1,
            name: "blank-skill",
            meaning: "   ",
            tags: [],
          },
          {
            id: "real-skill",
            version: 1,
            name: "real-skill",
            meaning: "a real skill",
            tags: [],
          },
        ],
      };
      await writeFile(path, JSON.stringify(customCatalog, null, 2) + "\n", "utf8");

      const bible = await skillBible(path);

      // The blank-meaning skill should return undefined
      assert.equal(bible("blank-skill"), undefined, "should skip blank meanings");
      // The real skill should still work
      assert.equal(bible("real-skill"), "a real skill", "should return non-blank meanings");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("checkEntry('characters', entryWithPromotedSkill, bible) reports NO problem when injected bible knows the skill", async () => {
    const customBible = (name: string) => name === "promoted-skill" ? "a promoted ability" : undefined;
    const entry = {
      id: "char",
      name: "Test",
      portablePersona: "A character",
      belief: "X",
      impulse: "Y",
      voice: ["Z"],
      skills: ["promoted-skill"],
      restrictions: [],
    };

    const result = checkEntry("characters", entry, { bible: customBible });
    assert.equal(result.ok, true);
    if (result.ok) {
      const hasProblem = result.problems.some(p => p.includes("not a bible skill"));
      assert.equal(hasProblem, false, "should not report promoted skill as not in bible when injected bible knows it");
    }
  });

  it("checkEntry('characters', entryWithPromotedSkill, bible) DOES report problem with default bible", async () => {
    const entry = {
      id: "char",
      name: "Test",
      portablePersona: "A character",
      belief: "X",
      impulse: "Y",
      voice: ["Z"],
      skills: ["promoted-skill"],
      restrictions: [],
    };

    const result = checkEntry("characters", entry);
    assert.equal(result.ok, true);
    if (result.ok) {
      const hasProblem = result.problems.some(p => p.includes("not a bible skill"));
      assert.equal(hasProblem, true, "should report promoted skill as not in default bible");
    }
  });
});
