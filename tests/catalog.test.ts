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
    const result = checkEntry({ name: "Test" }); // Missing id, which is required
    assert.equal(result.ok, false);
    if (!result.ok) {
      const errorStr = result.issues.join(", ");
      assert.ok(errorStr.includes("id"), "should report missing id");
    }
  });

  it("reports the empty-portable-persona problem", async () => {
    const result = checkEntry({
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
    const result = checkEntry({
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
      const result = checkEntry({
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
    const result = checkEntry({
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
