/**
 * Quote-lint tests — the mechanical quotation half of the narration lint.
 * These are deterministic: no model is involved, so a missed quote can never hide behind an LLM.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractQuotations, lintQuotations } from "../engine/quote-lint.ts";

const granted = (speech: string, character = "Marcus") => [{ character, speech }];

describe("extractQuotations", () => {
  it("pulls double-quoted dialogue", () => {
    const q = extractQuotations('He said "I will sign it" and left.');
    assert.equal(q.length, 1);
    assert.equal(q[0].text, "I will sign it");
  });

  it("does not split a single-quoted line on the apostrophe in a contraction", () => {
    const q = extractQuotations("She whispered 'I'll go first'.");
    assert.equal(q.length, 1);
    assert.equal(q[0].text, "I'll go first");
  });

  it("reads a possessive apostrophe as not-a-quote (no false open)", () => {
    const q = extractQuotations("Marcus' pen lay on the desk.");
    assert.equal(q.length, 0);
  });

  it("drops empty quoted spans", () => {
    const q = extractQuotations('He said "" and nothing else.');
    assert.equal(q.length, 0);
  });
});

describe("lintQuotations", () => {
  it("returns null when there are no quotations to check", () => {
    assert.equal(lintQuotations("The nib settled over the line.", []), null);
  });

  it("passes a verbatim granted line rendered in quotes", () => {
    const prose = 'Marcus said "I press down on the pen and sign."';
    assert.equal(lintQuotations(prose, granted("I press down on the pen and sign.")), null);
  });

  it("passes a near-verbatim quote (light edit) via token overlap", () => {
    const prose = 'Elias said "I will not sign that line."';
    assert.equal(lintQuotations(prose, granted("I will not sign the line.")), null);
  });

  it("flags an unmatched quotation against an empty ledger — the run 2 case", () => {
    const prose = 'Elias said "The transport is already moving."';
    const hit = lintQuotations(prose, [], ["Elias", "Marcus"]);
    assert.ok(hit && !hit.ok, "an unmatched quote against an empty ledger must flag");
    assert.match(hit!.why, /unmatched quotation/);
  });

  it("flags an unmatched quotation even with other granted lines present", () => {
    const prose = 'Marcus said "This is not my line to sign."';
    const hit = lintQuotations(prose, granted("I press down on the pen and sign."), ["Marcus"]);
    assert.ok(hit && !hit.ok);
    assert.equal(hit!.quote, "This is not my line to sign.");
  });

  it("attributes an unmatched quote to the nearest name before it", () => {
    const prose = 'Elias watched. Marcus said "This is not my line to sign."';
    const hit = lintQuotations(prose, [], ["Elias", "Marcus"]);
    assert.ok(hit && !hit.ok);
    assert.equal(hit!.character, "Marcus");
  });

  it("does not let a substring of an unrelated word fake a match", () => {
    // "no" must not match inside a granted speech "know" — token-based, not substring.
    const prose = 'He said "no".';
    const hit = lintQuotations(prose, granted("I know the rhythm"), ["He"]);
    assert.ok(hit && !hit.ok);
  });
});
