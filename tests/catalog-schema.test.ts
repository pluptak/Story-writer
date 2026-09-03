/**
 * Deterministic suite for character catalog schema and capability validation.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { LibraryCharacter, CharacterCatalog, TagEntry, TagCatalog, TAG_SEED, TAG_FACETS, LibraryStyle, StyleCatalog, LibrarySkill, SkillCatalog } from "../engine/catalog-schema.ts";
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

// -- TAG ENTRY SCHEMA -------------------------------------------------------
describe("TagEntry schema", () => {
  it("parses a full valid tag entry", () => {
    const tag = TagEntry.parse({
      id: "genre-scifi",
      version: 1,
      facet: "genre",
      label: "science-fiction",
    });
    assert.equal(tag.id, "genre-scifi");
    assert.equal(tag.facet, "genre");
    assert.equal(tag.label, "science-fiction");
  });

  it("applies defaults for missing optional fields", () => {
    const tag = TagEntry.parse({
      id: "tone-hopeful",
      facet: "tone",
      label: "hopeful",
    });
    assert.equal(tag.version, 1, "should default version to 1");
  });

  it("rejects an unknown facet", () => {
    const result = TagEntry.safeParse({
      id: "bad",
      facet: "unknownFacet",
      label: "test",
    });
    assert.equal(result.success, false);
  });

  it("rejects missing id", () => {
    const result = TagEntry.safeParse({
      facet: "genre",
      label: "test",
    });
    assert.equal(result.success, false);
  });

  it("rejects empty id", () => {
    const result = TagEntry.safeParse({
      id: "",
      facet: "genre",
      label: "test",
    });
    assert.equal(result.success, false);
  });

  it("rejects missing facet", () => {
    const result = TagEntry.safeParse({
      id: "tag-id",
      label: "test",
    });
    assert.equal(result.success, false);
  });

  it("rejects missing label", () => {
    const result = TagEntry.safeParse({
      id: "tag-id",
      facet: "genre",
    });
    assert.equal(result.success, false);
  });

  it("rejects empty label", () => {
    const result = TagEntry.safeParse({
      id: "tag-id",
      facet: "genre",
      label: "",
    });
    assert.equal(result.success, false);
  });

  it("rejects an unknown key (strictObject)", () => {
    const result = TagEntry.safeParse({
      id: "tag-id",
      facet: "genre",
      label: "test",
      unknownField: "should fail",
    });
    assert.equal(result.success, false);
  });
});

// -- TAG CATALOG SCHEMA -------------------------------------------------------
describe("TagCatalog schema", () => {
  it("parses an empty object into { entries: [] }", () => {
    const catalog = TagCatalog.parse({});
    assert.deepEqual(catalog.entries, []);
  });

  it("parses entries with multiple tags", () => {
    const catalog = TagCatalog.parse({
      entries: [
        { id: "genre-scifi", facet: "genre", label: "science-fiction" },
        { id: "tone-hopeful", facet: "tone", label: "hopeful" },
      ],
    });
    assert.equal(catalog.entries.length, 2);
    assert.equal(catalog.entries[0].facet, "genre");
    assert.equal(catalog.entries[1].facet, "tone");
  });
});

// -- TAG SEED -------------------------------------------------------
describe("TAG_SEED", () => {
  it("has entries in all three facets", () => {
    const facets = new Set(TAG_SEED.map(e => e.facet));
    assert.ok(facets.has("genre"), "should have genre tags");
    assert.ok(facets.has("dramaticMode"), "should have dramaticMode tags");
    assert.ok(facets.has("tone"), "should have tone tags");
  });

  it("has no duplicate facet+label pairs", () => {
    const seen = new Set<string>();
    for (const item of TAG_SEED) {
      const key = `${item.facet}::${item.label}`;
      assert.ok(!seen.has(key), `seed has duplicate facet+label: ${key}`);
      seen.add(key);
    }
  });

  it("contains the expected genre tags", () => {
    const genreTags = TAG_SEED.filter(e => e.facet === "genre").map(e => e.label);
    const expected = ["science-fiction", "fantasy", "mystery", "thriller", "horror", "literary", "historical", "western"];
    assert.deepEqual(genreTags.sort(), expected.sort());
  });

  it("contains the expected dramaticMode tags", () => {
    const modeTags = TAG_SEED.filter(e => e.facet === "dramaticMode").map(e => e.label);
    const expected = ["adventure", "survival", "romance", "political", "procedural", "coming-of-age", "revenge", "redemption"];
    assert.deepEqual(modeTags.sort(), expected.sort());
  });

  it("contains the expected tone tags", () => {
    const toneTags = TAG_SEED.filter(e => e.facet === "tone").map(e => e.label);
    const expected = ["hopeful", "bleak", "comic", "unsettling", "tender", "cold", "wry", "elegiac"];
    assert.deepEqual(toneTags.sort(), expected.sort());
  });
});

// -- LIBRARY STYLE SCHEMA -------------------------------------------------------
describe("LibraryStyle schema", () => {
  it("parses a full valid entry", () => {
    const style = LibraryStyle.parse({
      id: "style-123",
      version: 1,
      name: "Noir Detective",
      tags: ["noir", "gritty"],
      description: "First-person present-tense, world-weary voice",
      voice: "I don't ask questions I don't want answered. The city keeps its secrets.",
    });
    assert.equal(style.id, "style-123");
    assert.equal(style.name, "Noir Detective");
    assert.deepEqual(style.tags, ["noir", "gritty"]);
  });

  it("applies defaults for missing optional fields", () => {
    const style = LibraryStyle.parse({
      id: "style-456",
      name: "Minimal",
    });
    assert.equal(style.version, 1);
    assert.deepEqual(style.tags, []);
    assert.equal(style.description, "");
    assert.equal(style.voice, "");
  });

  it("rejects an unknown key (strictObject)", () => {
    const result = LibraryStyle.safeParse({
      id: "style-xyz",
      name: "Test",
      unknownField: "should fail",
    });
    assert.equal(result.success, false);
  });

  it("rejects missing id", () => {
    const result = LibraryStyle.safeParse({
      name: "NoId",
    });
    assert.equal(result.success, false);
  });

  it("rejects missing name", () => {
    const result = LibraryStyle.safeParse({
      id: "style-noname",
    });
    assert.equal(result.success, false);
  });

  it("rejects empty id", () => {
    const result = LibraryStyle.safeParse({
      id: "",
      name: "EmptyId",
    });
    assert.equal(result.success, false);
  });

  it("rejects empty name", () => {
    const result = LibraryStyle.safeParse({
      id: "style-empty-name",
      name: "",
    });
    assert.equal(result.success, false);
  });
});

// -- STYLE CATALOG SCHEMA -------------------------------------------------------
describe("StyleCatalog schema", () => {
  it("parses an empty object into { entries: [] }", () => {
    const catalog = StyleCatalog.parse({});
    assert.deepEqual(catalog.entries, []);
  });

  it("parses entries with multiple styles", () => {
    const catalog = StyleCatalog.parse({
      entries: [
        { id: "style-1", name: "First Person" },
        { id: "style-2", name: "Third Person Limited" },
      ],
    });
    assert.equal(catalog.entries.length, 2);
    assert.equal(catalog.entries[0].name, "First Person");
    assert.equal(catalog.entries[1].name, "Third Person Limited");
  });
});

// -- LIBRARY SKILL SCHEMA -------------------------------------------------------
describe("LibrarySkill schema", () => {
  it("parses a full valid entry", () => {
    const skill = LibrarySkill.parse({
      id: "lockpicking",
      version: 1,
      name: "Lockpicking",
      meaning: "opening a mechanical lock without its key",
      tags: ["security", "theft"],
    });
    assert.equal(skill.id, "lockpicking");
    assert.equal(skill.name, "Lockpicking");
    assert.equal(skill.meaning, "opening a mechanical lock without its key");
    assert.deepEqual(skill.tags, ["security", "theft"]);
  });

  it("applies defaults for missing optional fields", () => {
    const skill = LibrarySkill.parse({
      id: "climbing",
      name: "Climbing",
      meaning: "ascending a sheer surface",
    });
    assert.equal(skill.version, 1);
    assert.deepEqual(skill.tags, []);
  });

  it("rejects an entry with empty meaning", () => {
    const result = LibrarySkill.safeParse({
      id: "no-meaning",
      name: "No Meaning",
      meaning: "",
      tags: [],
    });
    assert.equal(result.success, false);
  });

  it("rejects an unknown key (strictObject)", () => {
    const result = LibrarySkill.safeParse({
      id: "skill-id",
      name: "Test",
      meaning: "A skill",
      unknownField: "should fail",
    });
    assert.equal(result.success, false);
  });

  it("rejects missing id", () => {
    const result = LibrarySkill.safeParse({
      name: "NoId",
      meaning: "A skill",
    });
    assert.equal(result.success, false);
  });

  it("rejects missing name", () => {
    const result = LibrarySkill.safeParse({
      id: "skill-noname",
      meaning: "A skill",
    });
    assert.equal(result.success, false);
  });

  it("rejects missing meaning", () => {
    const result = LibrarySkill.safeParse({
      id: "skill-nomeaning",
      name: "Test",
    });
    assert.equal(result.success, false);
  });

  it("rejects empty id", () => {
    const result = LibrarySkill.safeParse({
      id: "",
      name: "EmptyId",
      meaning: "A skill",
    });
    assert.equal(result.success, false);
  });

  it("rejects empty name", () => {
    const result = LibrarySkill.safeParse({
      id: "skill-empty-name",
      name: "",
      meaning: "A skill",
    });
    assert.equal(result.success, false);
  });
});

// -- SKILL CATALOG SCHEMA -------------------------------------------------------
describe("SkillCatalog schema", () => {
  it("parses an empty object into { entries: [] }", () => {
    const catalog = SkillCatalog.parse({});
    assert.deepEqual(catalog.entries, []);
  });

  it("parses entries with multiple skills", () => {
    const catalog = SkillCatalog.parse({
      entries: [
        { id: "lockpicking", name: "Lockpicking", meaning: "opening locks" },
        { id: "climbing", name: "Climbing", meaning: "ascending surfaces" },
      ],
    });
    assert.equal(catalog.entries.length, 2);
    assert.equal(catalog.entries[0].name, "Lockpicking");
    assert.equal(catalog.entries[1].name, "Climbing");
  });
});
