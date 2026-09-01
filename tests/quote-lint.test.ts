/**
 * Quote-lint tests — the mechanical quotation half of the narration lint.
 * Deterministic: no model involved, so a missed quote cannot hide behind an LLM.
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
    // "no" must not match inside the granted speech "know" — token match, not substring. The quote
    // is multi-word because a bare single word is read as a machine label and never checked.
    const prose = 'He said "no, not tonight".';
    const hit = lintQuotations(prose, granted("I know the rhythm"), ["He"]);
    assert.ok(hit && !hit.ok);
  });
});

describe("world furniture — sourced quotes", () => {
  it("passes a multi-word sign nobody was granted", () => {
    const prose = 'The sign read "CLOSED FOR STOCKTAKE." Nobody had told the couriers.';
    assert.equal(lintQuotations(prose, [], ["Merritt"]), null);
  });

  it("passes a PA line even though it is framed with a speech verb", () => {
    // The case the source-frame list exists for: the PA speaks, but a PA is not a character and can
    // never hold a grant. Exempting on the ABSENCE of a speech verb would have flagged this.
    const prose = 'Halfway down the wing, the PA said "Evacuate the east wing." Twice.';
    assert.equal(lintQuotations(prose, [], ["Merritt"]), null);
  });

  it("passes recorded and displayed sources — a voicemail, a screen", () => {
    const voicemail = "The answerphone carried a voicemail: \"You have reached Kessel's after hours.\"";
    const screen = 'The dispatch screen showed "ROUTE 4 DELAYED" in amber.';
    assert.equal(lintQuotations(voicemail, [], ["Merritt"]), null);
    assert.equal(lintQuotations(screen, [], ["Merritt"]), null);
  });

  it("still flags a character's ungranted, speech-framed line", () => {
    const prose = 'Merritt said "Which key did you say you had?"';
    const hit = lintQuotations(prose, [], ["Merritt"]);
    assert.ok(hit && !hit.ok);
  });

  it("still flags a bare, unattributed line — the house style's dominant form", () => {
    const prose = '"I never signed anything." She turned away.';
    const hit = lintQuotations(prose, [], ["Merritt"]);
    assert.ok(hit && !hit.ok);
  });

  it("does not exempt on a source word outside the look-back window", () => {
    // ~160 characters of sourceless text push "sign" outside the 120-character look-back, so the
    // quote is checked despite an earlier source word in the same paragraph.
    const filler = "and".repeat(40);
    const prose = `The sign mentioned nothing at all. ${filler} Merritt said "This is not my line to sign."`;
    const hit = lintQuotations(prose, [], ["Merritt"]);
    assert.ok(hit && !hit.ok);
  });

  it("passes a one-word machine label", () => {
    const prose = "He threw the lever to the 'Shutdown' position and stepped back.";
    assert.equal(lintQuotations(prose, [], ["Merritt"]), null);
  });
});
