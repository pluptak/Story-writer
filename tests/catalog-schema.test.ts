/**
 * Deterministic suite for character catalog schema and capability validation.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { LibraryCharacter, CharacterCatalog } from "../engine/catalog-schema.ts";
import { capabilityProblems } from "../engine/skills.ts";

// -- LIBRARY CHARACTER SCHEMA -----------------------------------------------
describe("LibraryCharacter schema", () => {
  it("parses a full valid entry", () => {
    const char = LibraryCharacter.parse({
      id: "char-123",
      version: 1,
      name: "Alice",
      tags: ["protagonist", "brave"],
      portablePersona: "determined and clever",
      belief: "good always wins",
      impulse: "when threatened → protect others",
      voice: ["I don't back down", "Come on, we've got this"],
      skills: ["lockpicking :: opening mechanical locks"],
      restrictions: ["sight"],
    });
    assert.equal(char.id, "char-123");
    assert.equal(char.name, "Alice");
    assert.deepEqual(char.tags, ["protagonist", "brave"]);
  });

  it("applies defaults for missing optional fields", () => {
    const char = LibraryCharacter.parse({
      id: "char-456",
      name: "Bob",
    });
    assert.equal(char.version, 1);
    assert.deepEqual(char.tags, []);
    assert.deepEqual(char.voice, []);
    assert.deepEqual(char.skills, []);
    assert.deepEqual(char.restrictions, []);
    assert.equal(char.portablePersona, "");
    assert.equal(char.belief, "");
    assert.equal(char.impulse, "");
  });

  it("truncates voice to 3 samples on load", () => {
    const char = LibraryCharacter.parse({
      id: "char-789",
      name: "Charlie",
      voice: ["line one", "line two", "line three", "line four"],
    });
    assert.deepEqual(char.voice, ["line one", "line two", "line three"]);
  });

  it("rejects an unknown key (strictObject)", () => {
    const result = LibraryCharacter.safeParse({
      id: "char-xyz",
      name: "Unknown",
      unknownField: "should fail",
    });
    assert.equal(result.success, false);
  });

  it("rejects missing id", () => {
    const result = LibraryCharacter.safeParse({
      name: "NoId",
    });
    assert.equal(result.success, false);
  });

  it("rejects missing name", () => {
    const result = LibraryCharacter.safeParse({
      id: "char-noname",
    });
    assert.equal(result.success, false);
  });

  it("rejects empty id", () => {
    const result = LibraryCharacter.safeParse({
      id: "",
      name: "EmptyId",
    });
    assert.equal(result.success, false);
  });

  it("rejects empty name", () => {
    const result = LibraryCharacter.safeParse({
      id: "char-empty-name",
      name: "",
    });
    assert.equal(result.success, false);
  });
});

// -- CHARACTER CATALOG SCHEMA -----------------------------------------------
describe("CharacterCatalog schema", () => {
  it("parses an empty object into { entries: [] }", () => {
    const catalog = CharacterCatalog.parse({});
    assert.deepEqual(catalog.entries, []);
  });

  it("parses entries with multiple characters", () => {
    const catalog = CharacterCatalog.parse({
      entries: [
        { id: "char-1", name: "Alice" },
        { id: "char-2", name: "Bob" },
      ],
    });
    assert.equal(catalog.entries.length, 2);
    assert.equal(catalog.entries[0].name, "Alice");
    assert.equal(catalog.entries[1].name, "Bob");
  });
});

// -- CAPABILITY PROBLEMS ----------------------------------------------------
describe("capabilityProblems", () => {
  it("produces no problem for a bible skill with no :: meaning", () => {
    const result = capabilityProblems("Alice", ["lockpicking"], []);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.restrictions, []);
  });

  it("produces a problem for a custom skill with no :: meaning", () => {
    const result = capabilityProblems("Bob", ["telepathy"], []);
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /Bob has skill "telepathy"/);
    assert.match(result.problems[0], /not a bible skill/);
  });

  it("accepts a custom skill with :: meaning", () => {
    const result = capabilityProblems("Charlie", ["telepathy :: reading minds"], []);
    assert.deepEqual(result.problems, []);
  });

  it("survives a restriction naming a general skill", () => {
    const result = capabilityProblems("Dave", [], ["sight"]);
    assert.deepEqual(result.restrictions, ["sight"]);
    assert.deepEqual(result.problems, []);
  });

  it("survives a restriction naming the character's own custom skill", () => {
    const result = capabilityProblems("Eve", ["lockpicking"], ["lockpicking"]);
    assert.deepEqual(result.restrictions, ["lockpicking"]);
    assert.deepEqual(result.problems, []);
  });

  it("drops a restriction naming nothing known and produces a problem", () => {
    const result = capabilityProblems("Frank", [], ["telepathy"]);
    assert.deepEqual(result.restrictions, []);
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /Frank "restrictions: telepathy"/);
    assert.match(result.problems[0], /not a known skill/);
  });

  it("preserves problem ordering: skills first, then restrictions", () => {
    const result = capabilityProblems("Grace", ["magic :: casting spells", "telepathy"], ["unknown"]);
    assert.equal(result.problems.length, 2);
    // First problem should be about the custom skill with no meaning
    assert.match(result.problems[0], /has skill "telepathy"/);
    // Second problem should be about the unknown restriction
    assert.match(result.problems[1], /restrictions: unknown/);
  });

  it("honors an injected bible parameter", () => {
    const stubBible = (name: string) => name === "custom-skill" ? "a custom ability" : undefined;
    const result = capabilityProblems("Henry", ["custom-skill"], [], stubBible);
    assert.deepEqual(result.problems, []);
  });

  it("uses the injected bible for restrictions too", () => {
    const stubBible = (name: string) => name === "custom-ability" ? "custom meaning" : undefined;
    const result = capabilityProblems("Iris", [], ["custom-ability"], stubBible);
    assert.deepEqual(result.restrictions, ["custom-ability"]);
    assert.deepEqual(result.problems, []);
  });
});
