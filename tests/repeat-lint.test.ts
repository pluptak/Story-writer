/**
 * Repeat-lint tests — the mechanical guard against a piece re-emitting the page's tail.
 * Deterministic: no model involved. Calibration cases are shaped after the recorded evidence
 * (PLANS.md, Next item 1): the doorway 386-character paragraph repeat and quote-lint's 0.8 Dice.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { stripRepeatedPrefix, MIN_REPEAT_WORDS } from "../engine/repeat-lint.ts";

// The shape of the doorway defect: a two-sentence paragraph the writer will re-emit.
const P = "The fault alarm kept ringing over the empty wing while the cold worked through every "
        + "seam. Hale stood with the ledger under his arm and did not move.";

describe("stripRepeatedPrefix", () => {
  it("strips a verbatim paragraph repeat and keeps the new sentence — the doorway 386-char case", () => {
    const prose = P + " Then the corridor lights died.";
    const r = stripRepeatedPrefix(prose, P);
    assert.ok(r, "the doorway shape must strip");
    assert.equal(r.kept, "Then the corridor lights died.", "only the new sentence reaches the page");
    assert.equal(r.chars, prose.length - r.kept.length);
    assert.equal(r.whole, false);
  });

  it("strips a near-verbatim repeat — one word swapped, Dice >= 0.8", () => {
    const prose = "The fault alarm kept sounding over the empty wing. Somewhere below, a door slammed.";
    const r = stripRepeatedPrefix(prose, P);
    assert.ok(r, "a lightly edited re-emission is still the defect");
    assert.equal(r.kept, "Somewhere below, a door slammed.");
  });

  it("matches a repeat of the tail's middle, not just its last sentence", () => {
    const tail = "Riven knocked once. The crate shifted against the wall. Nobody answered.";
    const prose = tail.slice(0, tail.indexOf("Nobody")) + "The corridor stayed quiet all the same.";
    const r = stripRepeatedPrefix(prose, tail);
    assert.ok(r, "re-emitting an earlier sentence of the tail is the same defect");
    assert.equal(r.kept, "The corridor stayed quiet all the same.");
  });

  it("reports whole when the entire piece is already on the page", () => {
    const r = stripRepeatedPrefix(P, P);
    assert.ok(r);
    assert.equal(r.kept, "");
    assert.equal(r.whole, true);
    assert.ok(r.words >= MIN_REPEAT_WORDS);
  });

  it("is indifferent to case and punctuation — the repeat only has to read as such normalized", () => {
    const tail = '"Just delivering something," Riven said. "Leave it by the door."';
    const prose = 'Just delivering SOMETHING! Riven said. Leave it by the door. He set the box down.';
    const r = stripRepeatedPrefix(prose, tail);
    assert.ok(r);
    assert.equal(r.kept, "He set the box down.");
  });

  it("stops the walk at the first new sentence, keeping everything after it as-is", () => {
    const prose = P + " Unrelated new material. " + P;
    const r = stripRepeatedPrefix(prose, P);
    assert.ok(r);
    assert.equal(r.kept, "Unrelated new material. " + P,
      "a repeat that is not the leading run is out of scope and reaches the page untouched");
  });

  it("leaves a short opening echo alone — under the floor", () => {
    const tail = "Merritt nods, and signs the line without looking up.";
    const prose = "Merritt nods. Then he takes the pen back and writes his name twice.";
    assert.equal(stripRepeatedPrefix(prose, tail), null,
      "a one-sentence echo below MIN_REPEAT_WORDS is a tolerated callback, not a re-emission");
  });

  it("does not strip when the repeat is mid-piece — leading-prefix scope only", () => {
    const prose = "A brand new sentence opens the beat. " + P;
    assert.equal(stripRepeatedPrefix(prose, P), null,
      "the first new sentence ends the walk before any repeat is reached");
  });

  it("declines a partial match rather than cutting on half-shared words", () => {
    const tail = "Merritt signed the ledger without looking up and slid it back across the counter.";
    const prose = "Merritt signed the ledger and looked up sharply. The counter was cold.";
    assert.equal(stripRepeatedPrefix(prose, tail), null,
      "0.75 shared tokens is not verbatim; the guard declines instead of guessing");
  });

  it("returns null for ordinary continuation that merely shares words with the page", () => {
    const tail = "The service door banged shut behind them and the bolt did not catch.";
    const prose = "The bolt did not hold for long. The frame was rotten, and the two of them "
                + "stepped out into the loading yard.";
    assert.equal(stripRepeatedPrefix(prose, tail), null);
  });

  it("returns null when there is no page yet, or nothing drafted", () => {
    assert.equal(stripRepeatedPrefix(P, ""), null);
    assert.equal(stripRepeatedPrefix("", P), null);
  });

  it("returns null when the whole piece repeats but totals under the floor", () => {
    const tail = "He nods and signs the line.";
    assert.equal(stripRepeatedPrefix("He nods and signs the line.", tail), null,
      "six echoed words are not worth a strip event");
  });
});
