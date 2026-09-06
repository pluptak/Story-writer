/** Deterministic suite for tags, tag duplicates, and origins seeding and validation. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadStory } from "../engine/story-format.ts";
import { loadCatalog, checkEntry, saveEntry, deleteEntry, skillBible, originSkillGroups, skillOrigins } from "../engine/catalog.ts";
import { WARN } from "../engine/warnings.ts";
import { quiet } from "./helpers.ts";
import { ORIGIN_SKILL_GROUPS, SPECIAL_SKILL_CATALOG } from "../engine/skills.ts";

describe("tags seeding", () => {
  it("loadCatalog('tags') on a missing path returns the seed, not an empty list, and emits no warning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tags-seed-test-"));
    const path = join(dir, "nonexistent-tags.json");
    try {
      const warns: string[] = [];
      const orig = WARN.sink;
      WARN.sink = (msg: string) => { warns.push(msg); };
      let result;
      try {
        result = await loadCatalog("tags", path);
      } finally {
        WARN.sink = orig;
      }

      // Should have entries from the seed
      assert.ok(result.entries.length > 0, "missing tags file should return seed");
      // Check that we have entries from all three facets
      const facets = new Set(result.entries.map((e: any) => e.facet));
      assert.ok(facets.has("genre"), "seed should include genre tags");
      assert.ok(facets.has("dramaticMode"), "seed should include dramaticMode tags");
      assert.ok(facets.has("tone"), "seed should include tone tags");
      // Should not warn
      assert.equal(warns.length, 0, "missing file should not warn");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loadCatalog('tags') on an existing file returns exactly that file's entries — seed tags deleted from the file stay deleted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tags-override-test-"));
    const path = join(dir, "tags.json");
    try {
      // Write a minimal tags file (without the seed)
      const minimalCatalog = {
        entries: [
          {
            id: "custom-tag",
            version: 1,
            facet: "genre",
            label: "steampunk",
          },
        ],
      };
      await writeFile(path, JSON.stringify(minimalCatalog, null, 2) + "\n", "utf8");

      const result = await loadCatalog("tags", path);

      // Should have only the custom tag, not the seed
      assert.equal(result.entries.length, 1, "should return only the file's entry, not the seed");
      assert.equal(result.entries[0].id, "custom-tag");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loadCatalog('characters') on a missing path still returns empty (characters have no seed)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "characters-no-seed-test-"));
    const path = join(dir, "nonexistent-chars.json");
    try {
      const result = await loadCatalog("characters", path);
      assert.deepEqual(result, { entries: [] }, "characters should have no seed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("tag duplicate labels", () => {
  it("saving a tag whose facet+label duplicates a different id yields the advisory problem and still saves", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tag-dup-test-"));
    const path = join(dir, "tags.json");
    try {
      // Save the first tag (seed gets materialized + new tag added)
      const tag1 = {
        id: "genre-sci-fi",
        facet: "genre",
        label: "science-fiction",
      };
      const save1 = await saveEntry("tags", tag1, path);
      assert.equal(save1.ok, true);

      // Try to save a different tag with the same facet+label as tag1
      // This creates a duplicate facet+label under a different id
      const tag2 = {
        id: "genre-scifi-alt",
        facet: "genre",
        label: "science-fiction",
      };
      const save2 = await saveEntry("tags", tag2, path);
      assert.equal(save2.ok, true, "should still save despite duplicate");
      if (save2.ok) {
        const hasDupWarning = save2.problems.some(p => p.includes("already exists"));
        assert.ok(hasDupWarning, "should include advisory about existing id");
      }

      // Verify: seed (24) + two new tags = 26 entries
      const loaded = await loadCatalog("tags", path);
      assert.equal(loaded.entries.length, 26, "should have seed (24) + two new tags (2)");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("saving a tag with the same facet+label under the SAME id does NOT report a duplicate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tag-resave-test-"));
    const path = join(dir, "tags.json");
    try {
      const tag = {
        id: "genre-mystery",
        facet: "genre",
        label: "mystery",
      };

      // First save: seed is loaded (mystery has version 1), updated to version 2
      const save1 = await saveEntry("tags", tag, path);
      assert.equal(save1.ok, true);

      // Re-save the same tag (same id as the seed entry)
      // File is loaded (mystery has version 2), updated to version 3
      const save2 = await saveEntry("tags", tag, path);
      assert.equal(save2.ok, true);
      if (save2.ok) {
        const hasDupWarning = save2.problems.some(p => p.includes("already exists"));
        assert.equal(hasDupWarning, false, "should not report duplicate for same-id re-save");
      }

      // Verify seed is still there (24 entries) with version bumped to 3
      const loaded = await loadCatalog("tags", path);
      assert.equal(loaded.entries.length, 24, "should still have entire seed");
      const mystery = loaded.entries.find((e: any) => e.id === "genre-mystery");
      assert.equal(mystery.version, 3, "re-saved entry should have version 3");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("kind-specific validation", () => {
  it("checkEntry('tags', …) rejects an unknown facet", async () => {
    const result = checkEntry("tags", {
      id: "bad-facet",
      facet: "unknownFacet",
      label: "test",
    });
    assert.equal(result.ok, false, "should reject unknown facet");
  });

  it("checkEntry('tags', …) reports the lowercase advisory", async () => {
    const result = checkEntry("tags", {
      id: "mixed-case",
      facet: "genre",
      label: "Science-Fiction",
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      const hasLowercaseWarning = result.problems.some(p => p.includes("lowercase"));
      assert.ok(hasLowercaseWarning, "should report lowercase advisory");
    }
  });

  it("checkEntry('characters', …) still behaves exactly as before", async () => {
    const result = checkEntry("characters", {
      id: "char-id",
      name: "Character Name",
      portablePersona: "A character",
      belief: "Something",
      impulse: "Do something",
      voice: ["A line."],
      skills: [],
      restrictions: [],
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.entry.name, "Character Name");
      assert.deepEqual(result.entry.skills, []);
    }
  });
});

describe("save/load boundary (seed materialization)", () => {
  it("saving one tag into a fresh file then loading returns 24 entries (seed + saved edit)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seed-materialize-test-"));
    const path = join(dir, "tags.json");
    try {
      // Save one tag to a fresh file
      const tag = {
        id: "tone-bleak",
        facet: "tone",
        label: "bleak",
      };
      const save = await saveEntry("tags", tag, path);
      assert.equal(save.ok, true);

      // Load should return seed (24) with the saved tag included
      const loaded = await loadCatalog("tags", path);
      assert.equal(loaded.entries.length, 24, "should have entire seed after first save");

      // The saved tag should be in the loaded catalog
      const found = loaded.entries.find((e: any) => e.id === "tone-bleak");
      assert.ok(found, "saved tag should be in loaded catalog");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("deleting a seed tag from a fresh file then loading returns 23 entries (seed minus deleted)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seed-delete-test-"));
    const path = join(dir, "tags.json");
    try {
      // Load fresh (gets seed)
      const fresh = await loadCatalog("tags", path);
      assert.equal(fresh.entries.length, 24, "fresh load should return seed");

      // Delete a seed tag
      const del = await deleteEntry("tags", "genre-western", path);
      assert.equal(del.ok, true);

      // Load should return seed minus the deleted tag (23 entries)
      const loaded = await loadCatalog("tags", path);
      assert.equal(loaded.entries.length, 23, "should have seed minus deleted tag");

      // Deleted tag should be gone
      const found = loaded.entries.find((e: any) => e.id === "genre-western");
      assert.equal(found, undefined, "deleted tag should be gone");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("deleting a tag then loading again returns 23 (seed does not resurrect)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seed-no-merge-test-"));
    const path = join(dir, "tags.json");
    try {
      // Load, delete, load
      let loaded1 = await loadCatalog("tags", path);
      assert.equal(loaded1.entries.length, 24);

      const del = await deleteEntry("tags", "genre-western", path);
      assert.equal(del.ok, true);

      let loaded2 = await loadCatalog("tags", path);
      assert.equal(loaded2.entries.length, 23, "first deletion removes one");

      // Load again — file still wins, seed does not come back
      let loaded3 = await loadCatalog("tags", path);
      assert.equal(loaded3.entries.length, 23, "seed does not resurrect on re-load");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("saving a NEW tag (not in seed) into a fresh file then loading returns 25 entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seed-new-tag-test-"));
    const path = join(dir, "tags.json");
    try {
      // Save a tag with an id not in the seed
      const newTag = {
        id: "genre-cyberpunk",
        facet: "genre",
        label: "cyberpunk",
      };
      const save = await saveEntry("tags", newTag, path);
      assert.equal(save.ok, true);

      // Load should return seed (24) plus the new tag (25)
      const loaded = await loadCatalog("tags", path);
      assert.equal(loaded.entries.length, 25, "should have seed plus new tag");

      const found = loaded.entries.find((e: any) => e.id === "genre-cyberpunk");
      assert.ok(found, "new tag should be in loaded catalog");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("character catalog save/load is unaffected by seed (0/1 pattern)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "char-boundary-test-"));
    const path = join(dir, "characters.json");
    try {
      // Fresh load (no seed for characters)
      const fresh = await loadCatalog("characters", path);
      assert.equal(fresh.entries.length, 0, "fresh characters should be empty");

      // Save one character
      const char = {
        id: "alice",
        name: "Alice",
        portablePersona: "A detective",
        belief: "X",
        impulse: "Y",
        voice: ["Z"],
        skills: [],
        restrictions: [],
      };
      const save = await saveEntry("characters", char, path);
      assert.equal(save.ok, true);

      // Load should have exactly 1 (no seed for characters)
      const loaded = await loadCatalog("characters", path);
      assert.equal(loaded.entries.length, 1, "characters have no seed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("separate catalogs per kind", () => {
  it("characters, tags, styles, and skills write to four different files with no collisions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "four-kinds-test-"));
    try {
      const charPath = join(dir, "catalog-characters.json");
      const tagPath = join(dir, "catalog-tags.json");
      const stylePath = join(dir, "catalog-styles.json");
      const skillPath = join(dir, "catalog-skills.json");

      const character = {
        id: "char-1",
        name: "Alice",
        portablePersona: "A character",
        belief: "X",
        impulse: "Y",
        voice: ["Z"],
        skills: [],
        restrictions: [],
      };

      const tag = {
        id: "genre-test",
        facet: "genre",
        label: "test-genre",
      };

      const style = {
        id: "style-1",
        name: "Noir",
        description: "Dark and gritty",
        voice: "The city never sleeps.",
      };

      const skill = {
        id: "custom-skill",
        name: "Custom Skill",
        meaning: "a custom ability",
        tags: [],
      };

      await saveEntry("characters", character, charPath);
      await saveEntry("tags", tag, tagPath);
      await saveEntry("styles", style, stylePath);
      await saveEntry("skills", skill, skillPath);

      // Verify each file exists independently
      const charContent = await readFile(charPath, "utf8");
      const tagContent = await readFile(tagPath, "utf8");
      const styleContent = await readFile(stylePath, "utf8");
      const skillContent = await readFile(skillPath, "utf8");

      const charData = JSON.parse(charContent);
      const tagData = JSON.parse(tagContent);
      const styleData = JSON.parse(styleContent);
      const skillData = JSON.parse(skillContent);

      // Each file should have the right number of entries
      assert.equal(charData.entries.length, 1, "character catalog should have 1 entry");
      assert.equal(tagData.entries.length, 25, "tag catalog should have seed (24) + new tag (1)");
      assert.equal(styleData.entries.length, 1, "style catalog should have 1 entry (no seed)");
      assert.equal(skillData.entries.length, 14, "skill catalog should have seed (8 general + 3 special + 2 origins) + new skill (1)");

      // Verify each entry is the correct one
      assert.equal(charData.entries[0].id, "char-1");
      const genreTest = tagData.entries.find((e: any) => e.id === "genre-test");
      assert.ok(genreTest, "genre-test should be in tag catalog");
      assert.equal(styleData.entries[0].id, "style-1");
      const customSkill = skillData.entries.find((e: any) => e.id === "custom-skill");
      assert.ok(customSkill, "custom-skill should be in skill catalog");

      // Verify the structure is correct for each kind
      assert.ok(charData.entries[0].portablePersona !== undefined);
      assert.ok(genreTest.facet !== undefined);
      assert.ok(styleData.entries[0].voice !== undefined);
      assert.ok(customSkill.meaning !== undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("origins seeding and functions", () => {
  it("loadCatalog('skills') on a missing path returns seed with general, special skills and origins", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skills-seed-with-origins-test-"));
    const path = join(dir, "nonexistent-skills.json");
    try {
      const result = await loadCatalog("skills", path);

      assert.equal(result.entries.length, 13, "should have general (8) + special (3) + origins (2) from seed");

      const lockpicking = result.entries.find((e: any) => e.id === "lockpicking");
      assert.ok(lockpicking, "lockpicking should be in seed");
      assert.equal(lockpicking.kind, "special");

      const movement = result.entries.find((e: any) => e.id === "movement");
      assert.ok(movement, "movement should be in seed");
      assert.equal(movement.kind, "general");

      const human = result.entries.find((e: any) => e.id === "human");
      assert.ok(human, "human origin should be in seed");
      assert.equal(human.kind, "origin");
      assert.deepEqual(human.general.sort(), [...ORIGIN_SKILL_GROUPS.human.skills].sort());

      const ai = result.entries.find((e: any) => e.id === "ai");
      assert.ok(ai, "ai origin should be in seed");
      assert.equal(ai.kind, "origin");
      assert.deepEqual(ai.general, ["speech", "recall"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skillBibleEntries returns only the special skills, not origins", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skillbible-origins-test-"));
    const path = join(dir, "skills.json");
    try {
      const entries = await skillBible(path);

      assert.equal(entries("lockpicking"), SPECIAL_SKILL_CATALOG.lockpicking, "should return special skill");
      assert.equal(entries("human"), undefined, "should not return origin");
      assert.equal(entries("ai"), undefined, "should not return origin");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("originSkillGroups returns only the origins with their general lists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "origins-test-"));
    const path = join(dir, "skills.json");
    try {
      const origins = await originSkillGroups(path);

      assert.ok(origins["human"], "should have human origin");
      assert.ok(origins["ai"], "should have ai origin");

      const humanSkills = origins["human"];
      assert.ok(humanSkills.includes("speech"), "human should have speech");
      assert.ok(humanSkills.includes("movement"), "human should have movement");
      assert.ok(humanSkills.includes("sight"), "human should have sight");

      const aiSkills = origins["ai"];
      assert.deepEqual(aiSkills.sort(), ["recall", "speech"]);

      assert.equal(origins["lockpicking"], undefined, "should not include special skills");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skillOrigins returns a lookup that works like originsFrom", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-origins-test-"));
    const path = join(dir, "skills.json");
    try {
      const origins = await skillOrigins(path);

      const aiSkills = origins("ai");
      assert.ok(aiSkills, "should find ai origin");
      assert.deepEqual(aiSkills, ["speech", "recall"]);

      assert.equal(origins("unknown"), undefined);

      assert.equal(origins("lockpicking"), undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
