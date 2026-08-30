/**
 * Skills tests — splitMeaning, resolveSkills.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { splitMeaning, resolveSkills, resolveReach, removedCapabilities, SKILL_CATALOG, SPECIAL_SKILL_CATALOG, type Skill } from "../engine/skills.ts";
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

  it("a restriction naming a declared bespoke skill self-restricts instead of warning unknown", () => {
    const w = warnings(() => resolveSkills("X", "fire :: a small flame on his fingertip", ""));
    // no restrictions at all: fire is simply present
    assert.equal(w.length, 0);
    assert.ok(quietSync(() => resolveSkills("X", "fire :: a small flame on his fingertip", "fire"))
      .some(x => x.name === "fire" && x.meaning === "a small flame on his fingertip"));
    assert.equal(warnings(() => resolveSkills("X", "", "telepathy")).length, 1,
      "an undeclared bespoke name in restrictions is still flagged as removing nothing");
  });

  it("does not treat inherited object names as catalog entries", () => {
    const w = warnings(() => resolveSkills("X", "", "constructor"));
    assert.equal(w.length, 1);
    assert.match(w[0], /constructor/);
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

// -- REACH ------------------------------------------------------------------
describe("reach", () => {
  const names = (s: Skill[]) => s.map(x => x.name);
  const sources = (s: Skill[]) => Object.fromEntries(s.map(x => [x.name, x.source]));

  it("a reach entry joins the resolved list as a third layer, tagged reach", () => {
    const s = quietSync(() => resolveSkills("AURA", "", "", "cameras :: perceiving through the lobby cameras"));
    assert.equal(sources(s)["cameras"], "reach");
    assert.equal(s.find(x => x.name === "cameras")!.meaning, "perceiving through the lobby cameras");
    assert.equal(sources(s)["movement"], "general", "the grant leaves the intrinsic layers alone");
    // and with no grant, no reach layer exists
    assert.ok(!names(resolveSkills("AURA", "", "")).includes("cameras"));
  });

  it("collapses to the one rule of I3: a reach name an intrinsic skill already uses is dropped, with a warning", () => {
    const wOwn = warnings(() => resolveSkills("X", "keys :: by feel", "", "keys :: through the key cabinet"));
    assert.match(wOwn.join(" "), /reach "keys" reuses a skill they already have/);
    const own = resolveSkills("X", "keys :: by feel", "", "keys :: through the key cabinet");
    assert.deepEqual(own.filter(x => x.name === "keys"),
                     [{ name: "keys", meaning: "by feel", source: "custom" }]);
    const wGen = warnings(() => resolveSkills("X", "", "", "speech :: talking through the intercom"));
    assert.match(wGen.join(" "), /reuses a skill/);
    const withGeneralCollision = resolveSkills("X", "", "", "speech :: talking through the intercom");
    assert.equal(withGeneralCollision.filter(x => x.source === "reach").length, 0,
      "a reach entry may not reuse a general skill's canon name either");
  });

  it("I2: a restriction removes the reach entry too, and names it under CANNOT", () => {
    const s = quietSync(() => resolveSkills("AURA", "", "cameras", "cameras :: perceiving through the lobby cameras"));
    assert.ok(!names(s).includes("cameras"), "the restriction reaches across layers");
    assert.deepEqual(removedCapabilities("AURA", "", "cameras", "cameras :: perceiving through the lobby cameras"),
                     ["cameras"]);
  });

  it("I2 corollary: a restriction never removes by resemblance — the blind AI keeps its camera feed", () => {
    const s = quietSync(() => resolveSkills("AURA", "", "sight", "cameras :: perceiving through the building's active security cameras"));
    const cam = s.find(x => x.name === "cameras");
    assert.ok(cam && cam.source === "reach", `restrictions: sight must not touch reach cameras`);
    assert.ok(!names(s).includes("sight"));
    // and the restriction is still named under CANNOT for what it DID remove
    assert.deepEqual(removedCapabilities("AURA", "", "sight", "cameras :: perceiving through the building's active security cameras"),
                     ["sight"]);
  });

  it("reach is character-in-scene: two characters granted different interfaces see only their own", () => {
    const aura = resolveReach("AURA", [], "", "cameras :: perceiving through the lobby cameras");
    const merritt = resolveReach("MERRITT", [], "", "keys :: locking and unlocking the automatic doors");
    assert.deepEqual(names(aura), ["cameras"]);
    assert.deepEqual(names(merritt), ["keys"]);
    assert.equal(warnings(() => { resolveReach("AURA", [], "", "cameras :: seeing"); resolveReach("MERRITT", [], "", "keys :: doors"); }).length, 0);
  });

  it("a reach entry without a :: meaning warns — reach is always bespoke", () => {
    const w = warnings(() => resolveReach("AURA", [], "", "cameras"));
    assert.equal(w.length, 1);
    assert.match(w[0], /no ":: meaning"/);
  });

  it("takes the resolved skills as they are: a general the character simply has is no redeclaration", () => {
    // What scene-loop hands it every scene — resolveSkills' own output, generals included. Re-running
    // the intrinsic layers over that used to warn once per general per character per call.
    const resolved = quietSync(() => resolveSkills("MERRITT", "keys :: by feel", "sight"));
    const w = warnings(() => resolveReach("MERRITT", resolved, "sight", "panel :: reading the fault codes"));
    assert.deepEqual(w, []);
    assert.deepEqual(names(resolveReach("MERRITT", resolved, "sight", "panel :: reading the fault codes")), ["panel"]);
  });

  it("still drops a grant colliding with the resolved list, general or own (I3)", () => {
    const resolved = quietSync(() => resolveSkills("MERRITT", "keys :: by feel", ""));
    for (const grant of ["speech :: through the intercom", "keys :: through the key cabinet"]) {
      const w = warnings(() => resolveReach("MERRITT", resolved, "", grant));
      assert.equal(w.length, 1, grant);
      assert.match(w[0], /reuses a skill they already have/);
      assert.deepEqual(quietSync(() => resolveReach("MERRITT", resolved, "", grant)), []);
    }
  });
});

// -- EXPLICIT NEGATIVES -----------------------------------------------------
describe("removedCapabilities", () => {
  it("a single-skill restriction names itself, in the spelling the author wrote", () => {
    assert.deepEqual(removedCapabilities("X", "", "Sight"), ["Sight"]);
  });

  it("names a bible skill a restriction removed, though absence from can would hide it", () => {
    assert.deepEqual(quietSync(() => removedCapabilities("X", "", "lockpicking")), ["lockpicking"]);
  });

  it("a skill named in both lists is one they HAVE, so it is no cannot", () => {
    assert.deepEqual(removedCapabilities("X", "sight :: they can see after all", "sight"), []);
  });

  it("an unknown restriction removes nothing, and says so once", () => {
    const w = warnings(() => removedCapabilities("X", "", "telepathy"));
    assert.equal(w.length, 1);
    assert.deepEqual(removedCapabilities("X", "", ""), []);
  });
});
