/**
 * Deterministic suite for host.ts's importCharacters: the server-side gate every new-story
 * character-selection path must go through. A hidden character must never enter a new story,
 * even if its id was chosen before it was hidden.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { importCharacters } from "../host.ts";
import { saveEntry, setVisibility } from "../engine/catalog.ts";

const baseChar = (id: string, name: string) => ({
  id, name, portablePersona: `A ${name}`, belief: "X", impulse: "Y",
  voice: ["Z"], skills: [], restrictions: [],
});

describe("importCharacters", () => {
  it("imports a visible character", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-import-test-"));
    const path = join(dir, "catalog.json");
    try {
      await saveEntry("characters", baseChar("alice", "Alice"), path);

      const { imported, missing } = await importCharacters(["alice"], path);
      assert.equal(missing.length, 0);
      assert.equal(imported.length, 1);
      assert.equal(imported[0].libraryId, "alice");
      assert.equal(imported[0].name, "Alice");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("excludes a hidden character, reporting it as missing rather than importing it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-import-test-"));
    const path = join(dir, "catalog.json");
    try {
      await saveEntry("characters", baseChar("bob", "Bob"), path);
      const hide = await setVisibility("characters", "bob", true, path);
      assert.equal(hide.ok, true);

      const { imported, missing } = await importCharacters(["bob"], path);
      assert.deepEqual(imported, [], "a hidden character must not be importable");
      assert.deepEqual(missing, ["bob"], "a hidden character is reported the same way as an absent one");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("restoring a previously-hidden character makes it importable again", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-import-test-"));
    const path = join(dir, "catalog.json");
    try {
      await saveEntry("characters", baseChar("carol", "Carol"), path);
      await setVisibility("characters", "carol", true, path);
      await setVisibility("characters", "carol", false, path);

      const { imported, missing } = await importCharacters(["carol"], path);
      assert.equal(missing.length, 0);
      assert.equal(imported.length, 1);
      assert.equal(imported[0].libraryId, "carol");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("imports the visible ones and reports the hidden ones as missing from a mixed request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-import-test-"));
    const path = join(dir, "catalog.json");
    try {
      await saveEntry("characters", baseChar("dana", "Dana"), path);
      await saveEntry("characters", baseChar("eve", "Eve"), path);
      await setVisibility("characters", "eve", true, path);

      const { imported, missing } = await importCharacters(["dana", "eve"], path);
      assert.deepEqual(imported.map(i => i.libraryId), ["dana"]);
      assert.deepEqual(missing, ["eve"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
