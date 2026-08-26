/**
 * Sense-lint tests — the mechanical restricted-sense half of the narration lint.
 * Deterministic: no model is involved, which is the whole point — the LLM half passed
 * "Marsh watches them from his corner" for a sight-restricted character on every live run.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { lintRestrictedSenses } from "../engine/sense-lint.ts";

const blind = [{ name: "Marsh", cannot: ["sight"] }];

describe("lintRestrictedSenses", () => {
  it("flags the live miss: a sight-restricted character shown watching", () => {
    const hit = lintRestrictedSenses("Marsh watches them from his corner.", blind);
    assert.ok(hit);
    assert.equal(hit.character, "Marsh");
    assert.equal(hit.verb, "watches");
    assert.equal(hit.sense, "sight");
    assert.match(hit.why, /Marsh/);
    assert.match(hit.why, /watches/);
  });

  it("passes the same prose when nothing is restricted", () => {
    assert.equal(lintRestrictedSenses("Marsh watches them from his corner.",
      [{ name: "Marsh", cannot: [] }]), null);
  });

  it("reaches across an interposed clause inside the subject window", () => {
    const hit = lintRestrictedSenses("Marsh, still folded into his corner, glanced at the door.", blind);
    assert.ok(hit);
    assert.equal(hit.verb, "glanced");
  });

  it("does not borrow the next sentence's subject", () => {
    assert.equal(lintRestrictedSenses("Marsh waited. Riven watched the door.", blind), null);
  });

  it("does not flag a verb the restricted character does not govern", () => {
    assert.equal(lintRestrictedSenses("Riven watched Marsh cross the room.", blind), null);
  });

  it("leaves a pronoun subject to the LLM half", () => {
    assert.equal(lintRestrictedSenses("Marsh stayed where he was. She watches the door.", blind), null);
  });

  it("reads a determiner as making the word a noun, not a perception", () => {
    assert.equal(lintRestrictedSenses("Marsh flinched at the smell of smoke.",
      [{ name: "Marsh", cannot: ["smell"] }]), null);
    assert.equal(lintRestrictedSenses("Marsh returned her stare.", blind), null);
  });

  it("still flags the verb when a determiner sits earlier in the window", () => {
    const hit = lintRestrictedSenses("Marsh, at the far wall, stared at nothing.", blind);
    assert.ok(hit);
    assert.equal(hit.verb, "stared");
  });

  it("covers each of the five perception senses", () => {
    const cases: [string, string, string][] = [
      ["sight", "Marsh peered into the dark.", "peered"],
      ["hearing", "Marsh heard the latch give.", "heard"],
      ["smell", "Marsh sniffed at the doorway.", "sniffed"],
      ["taste", "Marsh tasted iron.", "tasted"],
      ["touch", "Marsh touched the frame.", "touched"],
    ];
    for (const [sense, prose, verb] of cases) {
      const hit = lintRestrictedSenses(prose, [{ name: "Marsh", cannot: [sense] }]);
      assert.ok(hit, `${sense} should flag "${prose}"`);
      assert.equal(hit.verb, verb);
      assert.equal(hit.sense, sense);
    }
  });

  it("matches the restriction's authored spelling case-insensitively", () => {
    assert.ok(lintRestrictedSenses("Marsh watched the hallway.", [{ name: "Marsh", cannot: ["Sight"] }]));
  });

  it("reports the authored spelling back in the why", () => {
    const hit = lintRestrictedSenses("Marsh watched the hallway.", [{ name: "Marsh", cannot: ["Sight"] }]);
    assert.ok(hit);
    assert.equal(hit.sense, "Sight");
    assert.match(hit.why, /CANNOT Sight/);
  });

  it("ignores a restriction with no verb table", () => {
    assert.equal(lintRestrictedSenses("Marsh watched the hallway.",
      [{ name: "Marsh", cannot: ["cameras"] }]), null);
  });

  it("leaves see and saw to the LLM half, figurative as they are", () => {
    assert.equal(lintRestrictedSenses("Marsh saw what he meant.", blind), null);
    assert.equal(lintRestrictedSenses("Marsh would see to it.", blind), null);
  });

  it("checks every cast member, not only one", () => {
    const cast = [{ name: "Riven", cannot: [] }, { name: "Marsh", cannot: ["hearing"] }];
    const hit = lintRestrictedSenses("Riven spoke. Marsh listened for the answer.", cast);
    assert.ok(hit);
    assert.equal(hit.character, "Marsh");
  });

  it("returns null on prose that is empty or all whitespace", () => {
    assert.equal(lintRestrictedSenses("", blind), null);
    assert.equal(lintRestrictedSenses("   \n  ", blind), null);
  });

  it("returns null on a cast with no usable name", () => {
    assert.equal(lintRestrictedSenses("watches the door", [{ name: "  ", cannot: ["sight"] }]), null);
  });

  it("does not match a name inside a longer word", () => {
    assert.equal(lintRestrictedSenses("Marshall watched the hallway.", blind), null);
  });
});
