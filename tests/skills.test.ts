/**
 * Skills tests — splitMeaning, resolveSkills.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { splitMeaning, resolveSkills, SKILL_CATALOG, TRAIT_CATALOG, type Skill } from "../engine/skills.ts";
import { quietSync, warnings } from "./helpers.ts";

describe("splitMeaning", () => {
  it("splits on the first :: and tolerates a missing meaning", () => {
    assert.deepEqual(splitMeaning("lockpicking :: opening a lock :: really"),
                     { text: "lockpicking", meaning: "opening a lock :: really" });
    assert.deepEqual(splitMeaning("  climbing  "), { text: "climbing", meaning: "" });
  });
});

// -- SKILLS ----------------------------------------------------------------
describe("resolveSkills", () => {
  const names = (s: Skill[]) => s.map(x => x.name);
  const general = Object.keys(SKILL_CATALOG);

  it("gives every general skill when nothing is declared", () => {
    const s = resolveSkills("X", "", "");
    assert.deepEqual(names(s), general);
    assert.ok(s.every(x => x.source === "general" && x.meaning));
  });

  it("removes what a character lacks and adds what the story gives them", () => {
    const s = quietSync(() => resolveSkills("X", "lockpicking :: picking locks | climbing", "sight"));    assert.ok(!names(s).includes("sight"));
    assert.deepEqual(names(s).slice(-2), ["lockpicking", "climbing"]);
    assert.equal(s.find(x => x.name === "lockpicking")!.meaning, "picking locks");
    assert.equal(s.length, general.length - 1 + 2);
  });

  it("matches names case- and spacing-insensitively so one skill cannot become two", () => {
    const s = quietSync(() => resolveSkills("X", "", "  Sight  "));
    assert.ok(!names(s).includes("sight"));
    const dup = quietSync(() => resolveSkills("X", "Lock Picking | lockpicking", ""));
    assert.equal(dup.filter(x => /lock/i.test(x.name)).length, 1);
  });

  it("warns about a lacks: entry that removes nothing, and keeps going", () => {
    const w = warnings(() => resolveSkills("X", "", "telepathy"));
    assert.equal(w.length, 1);
    assert.match(w[0], /telepathy/);
    assert.equal(resolveSkills("X", "", "telepathy").length, Object.keys(SKILL_CATALOG).length);
  });

  it("warns when a story redeclares a general skill, and the story's wording wins", () => {
    const w = warnings(() => resolveSkills("X", "sight :: seeing in the dark", ""));
    assert.match(w.join(" "), /redeclares/);
    const s = resolveSkills("X", "sight :: seeing in the dark", "");
    assert.equal(s.find(x => x.name === "sight")!.meaning, "seeing in the dark");
    assert.equal(s.length, Object.keys(SKILL_CATALOG).length);
  });

  it("a name in BOTH skills and restrictions ends up present, and says so", () => {
    const w = warnings(() => resolveSkills("X", "sight :: they can see after all", "sight"));
    assert.match(w.join(" "), /both skills and restrictions/);
    assert.ok(resolveSkills("X", "sight :: they can see after all", "sight").some(x => x.name === "sight"));
  });
});

// -- TRAIT BUNDLES ----------------------------------------------------------
describe("TRAIT_CATALOG", () => {
  it("is a fixed record of bundle name to skill-name array", () => {
    assert.ok("deprived" in TRAIT_CATALOG);
    assert.deepEqual(TRAIT_CATALOG.deprived, ["sight", "hearing"]);
  });
});

describe("resolveSkills with trait bundles", () => {
  const names = (s: Skill[]) => s.map(x => x.name);
  const general = Object.keys(SKILL_CATALOG);

  it("expands a bundle to its constituent skill restrictions", () => {
    const s = quietSync(() => resolveSkills("X", "", "deprived"));
    assert.ok(!names(s).includes("sight"), "deprived removes sight");
    assert.ok(!names(s).includes("hearing"), "deprived removes hearing");
    assert.equal(s.length, general.length - 2);
  });

  it("leaves unrelated skills untouched when a bundle removes some", () => {
    const s = quietSync(() => resolveSkills("X", "", "deprived"));
    assert.ok(names(s).includes("speech"), "deprived does not remove speech");
    assert.ok(names(s).includes("movement"), "deprived does not remove movement");
  });

  it("multiple bundles compose correctly", () => {
    const s = quietSync(() => resolveSkills("X", "", "deprived | insensate"));
    assert.ok(!names(s).includes("sight"));
    assert.ok(!names(s).includes("hearing"));
    assert.ok(!names(s).includes("touch"));
    assert.ok(!names(s).includes("taste"));
    assert.equal(s.length, general.length - 4);
  });

  it("a bundle alongside a single-skill restriction works", () => {
    const s = quietSync(() => resolveSkills("X", "", "deprived | speech"));
    assert.ok(!names(s).includes("sight"), "deprived removes sight");
    assert.ok(!names(s).includes("hearing"), "deprived removes hearing");
    assert.ok(!names(s).includes("speech"), "explicit speech restriction works");
    assert.equal(s.length, general.length - 3);
  });

  it("warns about an unrecognised entry and shows bundle names in the message", () => {
    const w = warnings(() => resolveSkills("X", "", "deprived | sights"));
    assert.equal(w.length, 1, "exactly one warning for the unrecognised entry");
    assert.match(w[0], /sights/, "the unknown entry name is mentioned");
    assert.match(w[0], /deprived/, "the known bundle is mentioned in the known list");
    const s = resolveSkills("X", "", "deprived | sights");
    assert.ok(!names(s).includes("sight"), "deprived still removes sight");
    assert.ok(names(s).includes("touch"), "sights (typo) removes nothing");
  });

  it("existing single-skill restrictions are unaffected by the bundle system", () => {
    const s1 = resolveSkills("X", "", "sight");
    const s2 = resolveSkills("X", "", "sight");
    assert.ok(!names(s1).includes("sight"));
    assert.equal(s1.length, s2.length);
  });

  it("a bundle entry is case- and spacing-insensitive like skills", () => {
    const s = quietSync(() => resolveSkills("X", "", "  Deprived  "));
    assert.ok(!names(s).includes("sight"));
    assert.ok(!names(s).includes("hearing"));
  });

  it("does not treat inherited object names as catalog entries", () => {
    const w = warnings(() => resolveSkills("X", "", "constructor"));
    assert.equal(w.length, 1);
    assert.match(w[0], /constructor/);
  });
});
