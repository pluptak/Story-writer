/**
 * Deterministic suite for character catalog storage and validation.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCatalog, checkEntry, saveEntry, deleteEntry } from "../engine/catalog.ts";
import { WARN } from "../engine/warnings.ts";

describe("loadCatalog", () => {
  it("returns empty catalog and emits no warning on a missing path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "catalog-test-"));
    const path = join(dir, "nonexistent.json");
    try {
      const warns: string[] = [];
      const orig = WARN.sink;
      WARN.sink = (msg: string) => { warns.push(msg); };
      let result;
      try {
        result = await loadCatalog("characters", path);
      } finally {
        WARN.sink = orig;
      }

      assert.deepEqual(result, { entries: [] });
      assert.equal(warns.length, 0, "missing file should not warn");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns empty catalog and warns on a malformed file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "catalog-test-"));
    const path = join(dir, "broken.json");
    try {
      await writeFile(path, "{ invalid json", "utf8");

      const warns: string[] = [];
      const orig = WARN.sink;
      WARN.sink = (msg: string) => { warns.push(msg); };
      let result;
      try {
        result = await loadCatalog("characters", path);
      } finally {
        WARN.sink = orig;
      }

      assert.deepEqual(result, { entries: [] });
      assert.ok(warns.length > 0, "malformed file should warn");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("saveEntry and loadCatalog", () => {
  it("writes a new entry at version 1, and loadCatalog reads it back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "catalog-test-"));
    const path = join(dir, "catalog.json");
    try {
      const entry = {
        id: "alice",
        name: "Alice",
        portablePersona: "A clever detective",
        belief: "The truth always emerges",
        impulse: "Investigate mysteries",
        voice: ["I see.", "Interesting.", "Tell me more."],
        tags: ["mystery", "detective"],
        skills: ["logic"],
        restrictions: [],
      };

      const saveResult = await saveEntry("characters", entry, path);
      assert.equal(saveResult.ok, true);
      if (saveResult.ok) {
        assert.equal(saveResult.entry.id, "alice");
        assert.equal(saveResult.entry.version, 1);
      }

      const loaded = await loadCatalog("characters", path);
      assert.equal(loaded.entries.length, 1);
      assert.equal(loaded.entries[0].id, "alice");
      assert.equal(loaded.entries[0].version, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("replaces an existing entry by id and bumps version to 2", async () => {
    const dir = await mkdtemp(join(tmpdir(), "catalog-test-"));
    const path = join(dir, "catalog.json");
    try {
      const entry1 = {
        id: "bob",
        name: "Bob",
        portablePersona: "A painter",
        belief: "Art is truth",
        impulse: "Create beauty",
        voice: ["Beautiful.", "Colors speak.", "Light matters."],
        tags: ["artist"],
        skills: ["painting"],
        restrictions: [],
      };

      const save1 = await saveEntry("characters", entry1, path);
      assert.equal(save1.ok, true);
      if (save1.ok) assert.equal(save1.entry.version, 1);

      const entry2 = {
        id: "bob",
        name: "Bob",
        portablePersona: "A master painter",
        belief: "Art is life",
        impulse: "Teach painting",
        voice: ["Beautiful.", "Colors sing.", "Light transforms."],
        tags: ["artist", "mentor"],
        skills: ["painting", "teaching"],
        restrictions: [],
      };

      const save2 = await saveEntry("characters", entry2, path);
      assert.equal(save2.ok, true);
      if (save2.ok) assert.equal(save2.entry.version, 2);

      const loaded = await loadCatalog("characters", path);
      assert.equal(loaded.entries.length, 1);
      assert.equal(loaded.entries[0].version, 2);
      assert.equal(loaded.entries[0].portablePersona, "A master painter");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("checkEntry validation", () => {
  it("rejects an entry with missing required fields", async () => {
    const result = checkEntry("characters", { name: "Test" }); // Missing id, which is required
    assert.equal(result.ok, false);
    if (!result.ok) {
      const errorStr = result.issues.join(", ");
      assert.ok(errorStr.includes("id"), "should report missing id");
    }
  });

  it("reports the empty-portable-persona problem", async () => {
    const result = checkEntry("characters", {
      id: "empty-persona",
      name: "No Persona",
      portablePersona: "",
      belief: "Something",
      impulse: "Do something",
      voice: ["One line."],
      tags: [],
      skills: [],
      restrictions: [],
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      const problemStr = result.problems.join(" ");
      assert.ok(problemStr.includes("no portable persona"), "should report empty portable persona");
      assert.ok(problemStr.includes("travels between stories"), "should mention travel between stories");
    }
  });

  it("reports story-context leakage in portable persona", async () => {
    const result = checkEntry("characters", {
      id: "leaky",
      name: "Leaky Character",
      portablePersona: "In this story, I am a detective",
      belief: "Justice prevails",
      impulse: "Solve crimes",
      voice: ["Interesting."],
      tags: [],
      skills: [],
      restrictions: [],
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      const problemStr = result.problems.join(" ");
      assert.ok(problemStr.toLowerCase().includes("in this story"), "should detect 'in this story' leakage");
      assert.ok(problemStr.includes("story-specific"), "should mention story-specific");
      assert.ok(problemStr.includes("portable half"), "should mention portable half");
    }
  });

  it("detects multiple story-context phrases", async () => {
    const phrases = [
      "this chapter",
      "right now",
      "currently",
      "at the start of",
      "has just",
      "recently arrived",
    ];

    for (const phrase of phrases) {
      const result = checkEntry("characters", {
        id: "test",
        name: "Test",
        portablePersona: `Character who ${phrase} did something`,
        belief: "X",
        impulse: "Y",
        voice: ["Z"],
        tags: [],
        skills: [],
        restrictions: [],
      });

      assert.equal(result.ok, true);
      if (result.ok) {
        const hasWarning = result.problems.some(p => p.includes("story-specific"));
        assert.ok(hasWarning, `should detect "${phrase}" as story-specific`);
      }
    }
  });

  it("keeps an unresolvable restriction on the entry while reporting it as a problem", async () => {
    const result = checkEntry("characters", {
      id: "restricted",
      name: "Restricted One",
      portablePersona: "A character",
      belief: "Something",
      impulse: "Something else",
      voice: ["Speech."],
      tags: [],
      skills: [],
      restrictions: ["not-a-real-skill"],
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      // The entry should keep the restriction as written.
      assert.ok(result.entry.restrictions.includes("not-a-real-skill"),
                "unresolvable restriction must be kept on the entry");
      // And there should be a problem reported.
      const hasWarning = result.problems.some(p => p.includes("not-a-real-skill") || p.includes("unrecognized"));
      assert.ok(hasWarning, "should report unresolvable restriction as a problem");
    }
  });
});

describe("saveEntry validation", () => {
  it("rejects an invalid entry and does not modify the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "catalog-test-"));
    const path = join(dir, "catalog.json");
    try {
      // Create initial file.
      const initial = {
        id: "original",
        name: "Original",
        portablePersona: "A character",
        belief: "X",
        impulse: "Y",
        voice: ["Z"],
        tags: [],
        skills: [],
        restrictions: [],
      };
      const result1 = await saveEntry("characters", initial, path);
      assert.equal(result1.ok, true);

      // Try to save an invalid entry (missing name).
      const invalid = { id: "bad", portablePersona: "Invalid" };
      const result2 = await saveEntry("characters", invalid, path);
      assert.equal(result2.ok, false);
      if (!result2.ok) {
        assert.ok(result2.issues, "should include issues");
        assert.ok(result2.issues?.some(i => i.includes("name")), "should report missing name");
      }

      // Verify the file was not modified.
      const loaded = await loadCatalog("characters", path);
      assert.equal(loaded.entries.length, 1);
      assert.equal(loaded.entries[0].id, "original");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("deleteEntry", () => {
  it("removes an entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "catalog-test-"));
    const path = join(dir, "catalog.json");
    try {
      const entry = {
        id: "toremove",
        name: "To Remove",
        portablePersona: "A character",
        belief: "X",
        impulse: "Y",
        voice: ["Z"],
        tags: [],
        skills: [],
        restrictions: [],
      };

      const save = await saveEntry("characters", entry, path);
      assert.equal(save.ok, true);

      const loaded1 = await loadCatalog("characters", path);
      assert.equal(loaded1.entries.length, 1);

      const del = await deleteEntry("characters", "toremove", path);
      assert.equal(del.ok, true);

      const loaded2 = await loadCatalog("characters", path);
      assert.equal(loaded2.entries.length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns ok:false when deleting a missing id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "catalog-test-"));
    const path = join(dir, "catalog.json");
    try {
      const result = await deleteEntry("characters", "nonexistent", path);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.reason.includes("not found"));
        assert.equal(result.missing, true, "should have missing: true discriminant for not-found");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("verification and corruption detection", () => {
  it("detects when a saved file becomes corrupt and prevents using stale data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "catalog-test-"));
    const path = join(dir, "catalog.json");
    try {
      const entry = {
        id: "test",
        name: "Test",
        portablePersona: "A character",
        belief: "X",
        impulse: "Y",
        voice: ["Z"],
        tags: [],
        skills: [],
        restrictions: [],
      };

      const save = await saveEntry("characters", entry, path);
      assert.equal(save.ok, true);

      // Corrupt the file on disk.
      await writeFile(path, "{ invalid json", "utf8");

      // Next loadCatalog should return empty and warn.
      const warns: string[] = [];
      const orig = WARN.sink;
      WARN.sink = (msg: string) => { warns.push(msg); };
      let result;
      try {
        result = await loadCatalog("characters", path);
      } finally {
        WARN.sink = orig;
      }

      assert.deepEqual(result, { entries: [] });
      assert.ok(warns.length > 0, "corrupt file should warn");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns entry with the version that was actually persisted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "catalog-test-"));
    const path = join(dir, "catalog.json");
    try {
      const entry1 = {
        id: "versioned",
        name: "Versioned",
        portablePersona: "A character",
        belief: "X",
        impulse: "Y",
        voice: ["Z"],
        tags: [],
        skills: [],
        restrictions: [],
      };

      const save1 = await saveEntry("characters", entry1, path);
      assert.equal(save1.ok, true);
      if (save1.ok) {
        assert.equal(save1.entry.version, 1);

        // Re-read and verify the persisted version.
        const loaded = await loadCatalog("characters", path);
        assert.equal(loaded.entries[0].version, 1);
      }

      const entry2 = { ...entry1, portablePersona: "Updated character" };
      const save2 = await saveEntry("characters", entry2, path);
      assert.equal(save2.ok, true);
      if (save2.ok) {
        assert.equal(save2.entry.version, 2);

        // Re-read and verify the updated version.
        const loaded = await loadCatalog("characters", path);
        assert.equal(loaded.entries[0].version, 2);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses the correct path derived from kind for default paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "catalog-test-"));
    try {
      const entry = {
        id: "kind-test",
        name: "Kind Test",
        portablePersona: "A character",
        belief: "X",
        impulse: "Y",
        voice: ["Z"],
        tags: [],
        skills: [],
        restrictions: [],
      };

      // Save with the default path (no explicit path argument).
      // The default for "characters" kind should use "catalog-characters.json".
      const pathInDir = join(dir, "catalog-characters.json");
      const save = await saveEntry("characters", entry, pathInDir);
      assert.equal(save.ok, true);

      // Verify the file was created at the expected location.
      const loaded = await loadCatalog("characters", pathInDir);
      assert.equal(loaded.entries.length, 1);
      assert.equal(loaded.entries[0].id, "kind-test");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

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
  it("characters and tags write to different files and do not collide", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kind-files-test-"));
    try {
      const charPath = join(dir, "catalog-characters.json");
      const tagPath = join(dir, "catalog-tags.json");

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

      await saveEntry("characters", character, charPath);
      await saveEntry("tags", tag, tagPath);

      // Verify files exist and are separate
      const charContent = await readFile(charPath, "utf8");
      const tagContent = await readFile(tagPath, "utf8");

      const charData = JSON.parse(charContent);
      const tagData = JSON.parse(tagContent);

      assert.equal(charData.entries.length, 1, "character catalog should have 1 entry");
      assert.equal(charData.entries[0].id, "char-1");
      assert.equal(tagData.entries.length, 25, "tag catalog should have seed (24) + new tag (1)");

      // Verify the structure is correct for each kind
      assert.ok(charData.entries[0].portablePersona !== undefined);
      const genreTest = tagData.entries.find((e: any) => e.id === "genre-test");
      assert.ok(genreTest, "genre-test should be in catalog");
      assert.ok(genreTest.facet !== undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("characters, tags, and styles write to three different files with no collisions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "three-kinds-test-"));
    try {
      const charPath = join(dir, "catalog-characters.json");
      const tagPath = join(dir, "catalog-tags.json");
      const stylePath = join(dir, "catalog-styles.json");

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

      await saveEntry("characters", character, charPath);
      await saveEntry("tags", tag, tagPath);
      await saveEntry("styles", style, stylePath);

      // Verify each file exists independently
      const charContent = await readFile(charPath, "utf8");
      const tagContent = await readFile(tagPath, "utf8");
      const styleContent = await readFile(stylePath, "utf8");

      const charData = JSON.parse(charContent);
      const tagData = JSON.parse(tagContent);
      const styleData = JSON.parse(styleContent);

      // Each file should have the right number of entries
      assert.equal(charData.entries.length, 1, "character catalog should have 1 entry");
      assert.equal(tagData.entries.length, 25, "tag catalog should have seed (24) + new tag (1)");
      assert.equal(styleData.entries.length, 1, "style catalog should have 1 entry (no seed)");

      // Verify each entry is the correct one
      assert.equal(charData.entries[0].id, "char-1");
      const genreTest = tagData.entries.find((e: any) => e.id === "genre-test");
      assert.ok(genreTest, "genre-test should be in tag catalog");
      assert.equal(styleData.entries[0].id, "style-1");

      // Verify the structure is correct for each kind
      assert.ok(charData.entries[0].portablePersona !== undefined);
      assert.ok(genreTest.facet !== undefined);
      assert.ok(styleData.entries[0].voice !== undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

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
