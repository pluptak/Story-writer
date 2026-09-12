/**
 * Skills tests — splitMeaning, resolveSkills.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { splitMeaning, resolveSkills, resolveReach, removedCapabilities, capabilityProblems,
         resolveOrigin, originsFrom, bibleMeaningOf, restrictionMeanings, cannotDisplay,
         SKILL_CATALOG, SPECIAL_SKILL_CATALOG,
         type Skill } from "../engine/skills.ts";
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
    assert.match(w.join(" "), /redeclares a general skill/);
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

// -- RESTRICTION MEANINGS ---------------------------------------------------
// A restriction may carry `:: what its absence leaves`, the way a skill carries `:: what it does`.
// splitMeaning always parsed it and parseRestrictions used to drop it on the floor, so `CANNOT:
// sight` was the whole of what any model ever saw. These pin that the meaning now survives, and —
// more importantly — that it reaches no matcher: it is evidence for a reader, never a second
// matching language (I2).
describe("restriction meanings", () => {
  it("keeps the authored meaning, and agrees with removedCapabilities on order and membership", () => {
    const skills = "", restrictions = "sight :: cannot perceive visual information | hearing";
    const names = quietSync(() => removedCapabilities("X", skills, restrictions));
    const pairs = quietSync(() => restrictionMeanings("X", skills, restrictions));
    assert.deepEqual(pairs.map(r => r.name), names, "same list, same order");
    assert.deepEqual(pairs, [
      { name: "sight", meaning: "cannot perceive visual information" },
      { name: "hearing", meaning: "" },
    ]);
  });

  it("warns for a restriction with no :: meaning, and changes nothing about what it removes", () => {
    const w = warnings(() => restrictionMeanings("X", "", "sight"));
    assert.equal(w.length, 1);
    assert.match(w[0], /no ":: meaning"/);
    // The warning is the whole of the change: the removal itself is exactly as it always was.
    assert.deepEqual(quietSync(() => removedCapabilities("X", "", "sight")), ["sight"]);
    assert.deepEqual(quietSync(() => restrictionMeanings("X", "", "sight")),
                     [{ name: "sight", meaning: "" }]);
  });

  it("nudges once per load, never once per scene — the per-scene path stays silent", () => {
    // restrictionMeanings runs once per character in loadStory; resolveReach runs again for every
    // scene and shares parseRestrictions with it. Warning inside the shared parser put an authoring
    // nudge on the per-scene path, which is the noise the I3 reach tests pin against.
    const resolved = quietSync(() => resolveSkills("MERRITT", "keys :: by feel", "sight"));
    assert.deepEqual(warnings(() => resolveReach("MERRITT", resolved, "sight", "panel :: the codes")), []);
    assert.deepEqual(warnings(() => removedCapabilities("MERRITT", "", "sight")), []);
    assert.equal(warnings(() => restrictionMeanings("MERRITT", "", "sight")).length, 1);
  });

  it("leaves an origin-withheld general with an empty meaning — there was nowhere to author one", () => {
    const bird = quietSync(() => resolveOrigin("PIP", "bird", { origins: originsFrom({ bird: ["hearing"] }) }))!;
    const pairs = quietSync(() => restrictionMeanings("PIP", "", "", "", bird));
    assert.ok(pairs.length > 0, "the origin withholds most of the catalog");
    assert.ok(pairs.every(r => r.meaning === ""), "withheld, not restricted — no authored entry exists");
  });

  it("removes only the capability it names, never anything its meaning mentions (I2)", () => {
    const restrictions = "sight :: no perceiving of light, shape or colour";
    const reach = "cameras :: reading the lobby feed";
    // The meaning names light, shape and colour. None of them is a capability, and the reach entry
    // the blind-AI corollary protects is untouched — the meaning is prose, not a matching language.
    const removed = quietSync(() => removedCapabilities("A", "", restrictions, reach));
    assert.deepEqual(removed, ["sight"]);
    const resolved = quietSync(() => resolveReach("A", [], restrictions, reach));
    assert.ok(resolved.some(s => s.name === "cameras"), "cameras survives a sight restriction");
    assert.ok(!resolved.some(s => s.name === "sight"), "sight itself is still gone");
  });

  it("cannotDisplay off is the authored spellings unchanged; on is the name -- meaning idiom", () => {
    const limits = ["sight"];
    const meanings = [{ name: "sight", meaning: "cannot perceive light" }];
    // Off has to be the identical array contents, or arm A is not a baseline.
    assert.deepEqual(cannotDisplay(limits, meanings, false), ["sight"]);
    assert.deepEqual(cannotDisplay(limits, meanings, true), ["sight -- cannot perceive light"]);
    // A meaningless entry falls back to the bare name rather than rendering a dangling separator.
    assert.deepEqual(cannotDisplay(["recall"], [{ name: "recall", meaning: "" }], true), ["recall"]);
  });

  it("cannotDisplay takes membership from limits, so a CANNOT can never be dropped", () => {
    // The loader keeps the two lists in step, but a hand-built CharacterDef can disagree, and
    // losing a limit the character really has is the direction that lets an answer through.
    assert.deepEqual(cannotDisplay(["sight"], [], true), ["sight"]);
    assert.deepEqual(cannotDisplay(["sight"], [{ name: "hearing", meaning: "deaf" }], true), ["sight"]);
    // Spelling-insensitively matched, like every other capability comparison.
    assert.deepEqual(cannotDisplay(["Sight"], [{ name: "sight", meaning: "blind" }], true),
                     ["Sight -- blind"]);
  });

  it("cannotDisplay names an empty list only when asked to", () => {
    assert.deepEqual(cannotDisplay([], [], false), []);
    assert.deepEqual(cannotDisplay([], [], true), []);
    assert.deepEqual(cannotDisplay([], [], false, "(none)"), ["(none)"]);
    // And a non-empty list is never replaced by the empty token.
    assert.deepEqual(cannotDisplay(["sight"], [], false, "(none)"), ["sight"]);
  });
});

// -- INJECTED BIBLE ---------------------------------------------------------
describe("injected bible", () => {
  it("resolveSkills with an injected bible resolves a skill not in SPECIAL_SKILL_CATALOG to that bible's meaning with source: bible", () => {
    const customBible = (name: string) => name === "custom-skill" ? "doing something custom" : undefined;
    const s = resolveSkills("X", "custom-skill", "", "", undefined, { bible: customBible });
    const found = s.find(x => x.name === "custom-skill");
    assert.ok(found, "should find the custom skill");
    assert.equal(found!.source, "bible", "should be tagged bible");
    assert.equal(found!.meaning, "doing something custom", "should use the bible's meaning");
  });

  it("resolveSkills without the injected bible resolves the same skill as source: custom with empty meaning", () => {
    const s = quietSync(() => resolveSkills("X", "custom-skill", ""));
    const found = s.find(x => x.name === "custom-skill");
    assert.ok(found, "should find the custom skill");
    assert.equal(found.source, "custom", "should be tagged custom without the bible");
    assert.equal(found.meaning, "", "should have empty meaning without the bible");
  });

  it("removedCapabilities with injected bible: a restriction naming an injected-bible skill IS removed and appears as a CANNOT", () => {
    const customBible = (name: string) => name === "injected-skill" ? "an injected ability" : undefined;
    const removed = quietSync(() => removedCapabilities("X", "", "injected-skill", "", undefined, { bible: customBible }));
    assert.deepEqual(removed, ["injected-skill"], "should list the removed skill");
  });

  it("removedCapabilities without injected bible: a restriction naming an unknown skill warns and removes nothing", () => {
    let removed: string[] = [];
    const w = warnings(() => { removed = removedCapabilities("X", "", "injected-skill"); });
    assert.equal(w.length, 1, "should warn once about unknown skill");
    assert.deepEqual(removed, [], "should remove nothing");
  });

  it("an authored :: meaning still beats the injected bible's meaning", () => {
    const customBible = (name: string) => name === "lockpicking" ? "bible meaning" : undefined;
    const s = resolveSkills("X", "lockpicking :: author's meaning", "", "", undefined, { bible: customBible });
    const found = s.find(x => x.name === "lockpicking");
    assert.ok(found, "should find lockpicking");
    assert.equal(found!.meaning, "author's meaning", "author's meaning should win over bible");
  });
});

// -- ORIGINS ----------------------------------------------------------------
describe("origins", () => {
  const names = (s: Skill[]) => s.map(x => x.name);
  const ai = () => resolveOrigin("AURA", "ai")!;

  it("no origin still gives every general skill, in catalog order", () => {
    assert.deepEqual(names(resolveSkills("X", "", "")), Object.keys(SKILL_CATALOG));
  });

  it("an origin narrows the general layer to its own group, keeping catalog order", () => {
    const s = resolveSkills("AURA", "", "", "", ai());
    assert.deepEqual(names(s), ["speech", "recall"]);
    assert.ok(s.every(x => x.source === "general"));
    assert.equal(s.find(x => x.name === "speech")!.meaning, SKILL_CATALOG.speech,
      "the meaning still comes from the catalog");
  });

  it("what the origin withholds becomes a cannot, since absence alone is invisible", () => {
    const limits = removedCapabilities("AURA", "", "", "", ai());
    assert.deepEqual(limits, ["movement", "hearing", "sight", "touch", "taste", "smell"]);
  });

  it("a withheld general the character declares anyway is not a cannot", () => {
    const limits = quietSync(() =>
      removedCapabilities("AURA", "sight :: through the lobby cameras", "", "", ai()));
    assert.ok(!limits.includes("sight"));
    assert.ok(quietSync(() => resolveSkills("AURA", "sight :: through the lobby cameras", "", "", ai()))
      .some(x => x.name === "sight"));
  });

  it("restriction-removed comes before origin-withheld, with no duplicates", () => {
    const limits = quietSync(() => removedCapabilities("AURA", "", "speech", "", ai()));
    assert.equal(limits[0], "speech");
    assert.equal(limits.filter(x => x === "speech").length, 1);
    assert.ok(limits.includes("sight"));
  });

  it("a restriction naming what the origin never granted removes nothing, and says so", () => {
    const w = warnings(() => resolveSkills("AURA", "", "sight", "", ai()));
    assert.equal(w.length, 1);
    assert.match(w[0], /nothing to remove/);
    assert.equal(quietSync(() => removedCapabilities("AURA", "", "sight", "", ai()))
      .filter(x => x === "sight").length, 1, "still one cannot — from the origin, not the restriction");
  });

  it("a skills entry overrides an origin-granted meaning, and the warning names the origin", () => {
    const w = warnings(() => resolveSkills("AURA", "speech :: over the corridor intercom", "", "", ai()));
    assert.match(w.join(" "), /redeclares a skill their origin grants/);
    const s = quietSync(() => resolveSkills("AURA", "speech :: over the corridor intercom", "", "", ai()));
    assert.equal(s.find(x => x.name === "speech")!.meaning, "over the corridor intercom");
  });

  it("capabilityProblems flags a restriction the origin already withheld", () => {
    const { problems, restrictions } = capabilityProblems("AURA", [], ["sight"], ai());
    assert.equal(restrictions.length, 0);
    assert.match(problems.join(" "), /would remove nothing/);
  });

  it("an unknown origin warns and falls back to every general skill", () => {
    const w = warnings(() => resolveOrigin("X", "wyvern"));
    assert.equal(w.length, 1);
    assert.match(w[0], /not a known origin/);
    assert.equal(quietSync(() => resolveOrigin("X", "wyvern")), undefined);
  });

  it("an empty origin is simply no origin", () => {
    assert.equal(resolveOrigin("X", ""), undefined);
    assert.equal(resolveOrigin("X", "   "), undefined);
  });

  it("resolves against an injected group set, dropping what is not a general skill", () => {
    const origins = originsFrom({ bird: ["Sight", "hearing", "telepathy"] });
    const w = warnings(() => resolveOrigin("PIP", "bird", { origins }));
    assert.match(w.join(" "), /telepathy/);
    const bird = quietSync(() => resolveOrigin("PIP", "bird", { origins }))!;
    assert.deepEqual(names(quietSync(() => resolveSkills("PIP", "", "", "", bird))),
                     ["hearing", "sight"], "catalog order, not the order the group was written in");
  });
});

describe("injected general skills", () => {
  const names = (s: Skill[]) => s.map(x => x.name);
  // A world whose people hear and remember, and have no eyes at all.
  const generals = { hearing: "perceiving sound", recall: "remembering what you lived through" };

  it("replaces the general layer, meanings included", () => {
    const s = resolveSkills("X", "", "", "", undefined, { generals });
    assert.deepEqual(names(s), ["hearing", "recall"]);
    assert.equal(s.find(x => x.name === "recall")!.meaning, "remembering what you lived through");
    assert.deepEqual(names(resolveSkills("X", "", "")), Object.keys(SKILL_CATALOG),
                     "and the in-code list still stands when no bag is passed");
  });

  it("computes what an origin withholds against the injected list, not the in-code one", () => {
    const bird = quietSync(() => resolveOrigin("PIP", "bird",
      { generals, origins: originsFrom({ bird: ["hearing"] }) }))!;
    assert.deepEqual(removedCapabilities("PIP", "", "", "", bird, { generals }), ["recall"],
                     "sight is not withheld here — this world never had it to withhold");
  });

  it("reports a restriction naming a general the injected list does not have", () => {
    const { problems, restrictions } = capabilityProblems("X", [], ["sight"], undefined, { generals });
    assert.equal(restrictions.length, 0);
    assert.match(problems.join(" "), /would remove nothing/);
  });

  it("drops an origin group entry the injected list does not have", () => {
    const w = warnings(() => resolveOrigin("PIP", "bird",
      { generals, origins: originsFrom({ bird: ["hearing", "sight"] }) }));
    assert.match(w.join(" "), /sight/);
    const bird = quietSync(() => resolveOrigin("PIP", "bird",
      { generals, origins: originsFrom({ bird: ["hearing", "sight"] }) }))!;
    assert.deepEqual([...bird.skills], ["hearing"]);
  });
});
