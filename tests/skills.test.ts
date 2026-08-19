/**
 * Skills tests — splitMeaning, resolveSkills.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { splitMeaning, resolveSkills, SKILL_CATALOG, type Skill } from "../engine/skills.ts";
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
