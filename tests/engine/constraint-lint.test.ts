/**
 * Constraint-lint tests — the mechanical scene-constraint matcher.
 * Deterministic, no model involved: default-allow means a miss is acceptable
 * and a false refusal is not.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { lintConstraintAction, resetConstraintLintWarnings } from "../../engine/lint/constraint-lint.ts";
import { WARN } from "../../engine/warnings.ts";

const boundHands = [{ name: "hands", meaning: "bound to the chair, cannot reach or handle anything" }];

function warned(fn: () => void): string[] {
  const got: string[] = [];
  const orig = WARN.sink;
  WARN.sink = (msg: string) => { got.push(msg); };
  try { fn(); } finally { WARN.sink = orig; }
  return got;
}

describe("lintConstraintAction", () => {
  it("fires on bound hands plus a reaching action", () => {
    const hit = lintConstraintAction("She reaches for the rope.", "Merritt", boundHands);
    assert.ok(hit);
    assert.equal(hit.character, "Merritt");
    assert.equal(hit.constraint, "hands");
    assert.equal(hit.match, "reaches");
    assert.match(hit.why, /Merritt/);
    assert.match(hit.why, /reaches/);
  });

  it("fires on an inflected spelling of the barred verb", () => {
    const hit = lintConstraintAction("He grabbed the ledger.", "Riven",
      [{ name: "hands", meaning: "manacled, cannot grab or hold anything" }]);
    assert.ok(hit);
    assert.equal(hit.match, "grabbed");
  });

  it("permits a spoken-only answer with no warning", () => {
    const lines = warned(() => {
      assert.equal(lintConstraintAction("", "Merritt", boundHands), null);
    });
    assert.deepEqual(lines, []);
  });

  it("permits an action outside the barred verbs, silently", () => {
    const lines = warned(() => {
      assert.equal(lintConstraintAction("She nods and listens.", "Merritt", boundHands), null);
    });
    assert.deepEqual(lines, []);
  });

  it("permits an ambiguous meaning and warns instead of refusing", () => {
    let hit;
    const lines = warned(() => {
      hit = lintConstraintAction("She walks to the door.", "Merritt",
        [{ name: "nerves", meaning: "must stay calm" }]);
    });
    assert.equal(hit, null);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /nerves/);
  });

  it("reads stating the inability as honouring the constraint", () => {
    assert.equal(lintConstraintAction("I cannot reach the rope.", "Merritt", boundHands), null);
  });

  it("leaves see and saw out — figurative sight is a false refusal waiting to happen", () => {
    assert.equal(lintConstraintAction("I see what you mean.", "Merritt",
      [{ name: "sight", meaning: "blindfolded, cannot see" }]), null);
  });

  it("checks every constraint and fires on the one that bars the act", () => {
    const hit = lintConstraintAction("He runs for the stairs.", "Riven", [
      { name: "hands", meaning: "bound to the chair, cannot reach or handle anything" },
      { name: "legs", meaning: "shackled to the wall, cannot run or walk away" },
    ]);
    assert.ok(hit);
    assert.equal(hit.constraint, "legs");
    assert.equal(hit.match, "runs");
  });

  it("checks nothing without an action, a character, or a named constraint", () => {
    assert.equal(lintConstraintAction("She reaches for the rope.", "", boundHands), null);
    assert.equal(lintConstraintAction("She reaches for the rope.", "Merritt", []), null);
    assert.equal(lintConstraintAction("She reaches for the rope.", "Merritt",
      [{ name: "", meaning: "cannot reach anything" }]), null);
  });
});

const securedChair = [{
  name: "secured chair",
  meaning: "for this scene, you cannot stand, leave the chair, or reach or handle objects; " +
    "your head and shoulders can move, and your sight, hearing, speech, and ability to " +
    "decide what to say remain intact",
}];

describe("lintConstraintAction polarity", () => {
  it("fires on the barred acts", () => {
    resetConstraintLintWarnings();
    const stand = lintConstraintAction("I stand up from the chair.", "Mara", securedChair);
    assert.ok(stand);
    assert.equal(stand.constraint, "secured chair");
    assert.equal(stand.match, "stand");
    const reach = lintConstraintAction("I reach for the folder.", "Mara", securedChair);
    assert.ok(reach);
    assert.equal(reach.match, "reach");
  });

  it("permits what the flip clause leaves intact", () => {
    resetConstraintLintWarnings();
    assert.equal(lintConstraintAction("I move my head slowly to face him.", "Mara", securedChair), null);
    assert.equal(lintConstraintAction("I shake my head and say nothing.", "Mara", securedChair), null);
    assert.equal(lintConstraintAction("I turn my shoulders toward the door.", "Mara", securedChair), null);
    assert.equal(lintConstraintAction("I say his name quietly.", "Mara", securedChair), null);
  });

  it("warns once naming the constraint whose permissive clause was discarded", () => {
    resetConstraintLintWarnings();
    const lines = warned(() => {
      lintConstraintAction("I move my head slowly to face him.", "Mara", securedChair);
      lintConstraintAction("I say his name quietly.", "Mara", securedChair);
      lintConstraintAction("I stand up from the chair.", "Mara", securedChair);
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /secured chair/);
  });

  it("re-arms the once-per-scene warning at the scene boundary", () => {
    resetConstraintLintWarnings();
    const lines = warned(() => {
      lintConstraintAction("I move my head slowly to face him.", "Mara", securedChair);
    });
    assert.equal(lines.length, 1);
    resetConstraintLintWarnings();
    const again = warned(() => {
      lintConstraintAction("I move my head slowly to face him.", "Mara", securedChair);
    });
    assert.equal(again.length, 1);
  });
});
