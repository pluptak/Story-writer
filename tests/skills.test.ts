/**
 * Skills tests — splitMeaning, resolveSkills.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { splitMeaning, resolveSkills, SKILL_CATALOG, SPECIAL_SKILL_CATALOG, RESTRICTION_CATALOG, type Skill } from "../engine/skills.ts";
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

// -- SPECIAL-SKILL BIBLE ----------------------------------------------------
describe("SPECIAL_SKILL_CATALOG", () => {
  it("is a fixed name-to-meaning record, seeded with the reusable skills", () => {
    assert.ok("lockpicking" in SPECIAL_SKILL_CATALOG);
    assert.ok(SPECIAL_SKILL_CATALOG.lockpicking.length > 0);
  });

  it("a bible skill named with no meaning takes the catalog's meaning and is tagged bible", () => {
    const s = quietSync(() => resolveSkills("X", "lockpicking", ""));
    const picked = s.find(x => x.name === "lockpicking")!;
    assert.equal(picked.source, "bible");
    assert.equal(picked.meaning, SPECIAL_SKILL_CATALOG.lockpicking);
  });

  it("a bible skill with an authored meaning keeps the author's wording, still tagged bible", () => {
    const s = resolveSkills("X", "lockpicking :: picking locks", "");
    const picked = s.find(x => x.name === "lockpicking")!;
    assert.equal(picked.source, "bible");
    assert.equal(picked.meaning, "picking locks");
  });

  it("a bespoke skill stays custom and keeps its authored meaning", () => {
    const s = quietSync(() => resolveSkills("X", "chewing :: grinding through what others cannot", ""));
    const chew = s.find(x => x.name === "chewing")!;
    assert.equal(chew.source, "custom");
    assert.equal(chew.meaning, "grinding through what others cannot");
  });

  it("de-dup still holds across a bible spelling and a custom spelling of the same skill", () => {
    const dup = quietSync(() => resolveSkills("X", "Lock Picking | lockpicking", ""));
    assert.equal(dup.filter(x => /lock/i.test(x.name)).length, 1);
  });

  it("matches bible names case-, spacing- and punctuation-insensitively like everything else", () => {
    const s = quietSync(() => resolveSkills("X", "sleight of hand", ""));
    const sleight = s.find(x => /sleight/i.test(x.name))!;
    assert.equal(sleight.source, "bible");
    assert.equal(sleight.meaning, SPECIAL_SKILL_CATALOG["sleight-of-hand"]);
  });
});

// -- RESTRICTION CATALOG ----------------------------------------------------
describe("RESTRICTION_CATALOG", () => {
  it("is a fixed record of penalty name to disabled-skill-name array", () => {
    assert.ok("deprived" in RESTRICTION_CATALOG);
    assert.deepEqual(RESTRICTION_CATALOG.deprived, ["sight", "hearing"]);
  });

  it("some penalties disable bible skills as well as general ones", () => {
    assert.ok(RESTRICTION_CATALOG["hands-bound"].includes("lockpicking"));
    assert.ok(RESTRICTION_CATALOG.bound.includes("climbing"));
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

// -- PENALTIES REACHING SPECIAL SKILLS --------------------------------------
describe("resolveSkills: penalties vs special skills", () => {
  const names = (s: Skill[]) => s.map(x => x.name);

  it("a penalty disables a bible skill of a different name", () => {
    const s = quietSync(() => resolveSkills("X", "lockpicking :: picking locks", "hands-bound"));
    assert.ok(!names(s).includes("lockpicking"), "hands-bound removes lockpicking");
    assert.ok(!names(s).includes("touch"), "hands-bound also removes touch");
    assert.ok(names(s).includes("movement"), "and leaves movement alone");
  });

  it("a penalty expands to every skill it lists, general or bible", () => {
    const s = quietSync(() => resolveSkills("X", "climbing", "bound"));
    assert.ok(!names(s).includes("movement"));
    assert.ok(!names(s).includes("touch"));
    assert.ok(!names(s).includes("climbing"), "bound reaches the bible skill climbing");
    assert.ok(names(s).includes("speech"));
  });

  it("the same-name-authored escape hatch returns the skill, but via-penalty removal does not", () => {
    const authored = quietSync(() => resolveSkills("X", "sight :: they can see after all", "sight"));
    assert.ok(names(authored).includes("sight"), "named directly in both — they HAVE it");
    const penalized = quietSync(() => resolveSkills("X", "sight :: they can see after all", "deprived"));
    assert.ok(!names(penalized).includes("sight"), "removed through the deprived penalty despite being in skills");
  });

  it("a restriction naming a declared bespoke skill self-restricts instead of warning unknown", () => {
    const w = warnings(() => resolveSkills("X", "fire :: a small flame on his fingertip", ""));
    // no restrictions at all: fire is simply present
    assert.equal(w.length, 0);
    assert.ok(quietSync(() => resolveSkills("X", "fire :: a small flame on his fingertip", "fire"))
      .some(x => x.name === "fire" && x.meaning === "a small flame on his fingertip"));
    assert.equal(warnings(() => resolveSkills("X", "", "telepathy")).length, 1,
      "an undeclared bespoke name in restrictions is still flagged as removing nothing");
  });
});
