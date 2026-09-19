/**
 * Placeholder-lint tests — the mechanical template-slot check on a character's answer.
 * Deterministic, no model involved: only a short bracketed run of letters fires, so a
 * refusal is never spent on story content that merely looks bracketed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { lintPlaceholderAnswer } from "../../engine/lint/placeholder-lint.ts";

describe("lintPlaceholderAnswer", () => {
  it("fires on the live slot, in speech", () => {
    const hit = lintPlaceholderAnswer(
      { speech: "My name is [Name]. I was told to deliver the ledger.", action: "", thought: "" },
      "Mara");
    assert.ok(hit);
    assert.equal(hit.field, "speech");
    assert.equal(hit.match, "[Name]");
    assert.match(hit.why, /Mara/);
  });

  it("fires in action and thought too", () => {
    assert.equal(lintPlaceholderAnswer(
      { speech: "", action: "I hand the ledger to [the archivist].", thought: "" }, "Mara")?.match,
      "[the archivist]");
    assert.equal(lintPlaceholderAnswer(
      { speech: "", action: "", thought: "I should ask [REDACTED] about this." }, "Mara")?.match,
      "[REDACTED]");
  });

  it("does not fire on story content that is merely bracketed", () => {
    // The live run's own neighbours: a hatch marking and a chapter-style label.
    assert.equal(lintPlaceholderAnswer(
      { speech: "The hatch is marked W-17.", action: "", thought: "" }, "Mara"), null);
    assert.equal(lintPlaceholderAnswer(
      { speech: "", action: "I check the board: [Chapter 2].", thought: "" }, "Mara"), null);
  });

  it("does not fire on a long bracketed aside", () => {
    assert.equal(lintPlaceholderAnswer(
      { speech: "", action: "I nod toward the corner [the one by the door, where we left it].", thought: "" },
      "Mara"), null);
  });

  it("permits empty fields and an unnamed character silently", () => {
    assert.equal(lintPlaceholderAnswer({ speech: "", action: "", thought: "" }, "Mara"), null);
    assert.equal(lintPlaceholderAnswer({ speech: "[Name]" }, ""), null);
  });
});
