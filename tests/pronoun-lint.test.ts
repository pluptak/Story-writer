/**
 * Pronoun-lint tests — the mechanical pronoun-drift half of the narration lint.
 * Deterministic, no model involved. Detects when a character's declared pronoun set
 * contradicts their prose rendering, and logs (observe-only, does not gate).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { lintPronouns, type PronounSet } from "../engine/pronoun-lint.ts";

const merritt: PronounSet = { subject: "he", object: "him", possessive: "his", reflexive: "himself" };
const riven: PronounSet = { subject: "they", object: "them", possessive: "their", reflexive: "themself" };

describe("lintPronouns", () => {
  it("passes when the pronoun matches the character's declared set", () => {
    const hit = lintPronouns("Merritt shifts his weight.", [{ name: "Merritt", pronouns: merritt }]);
    assert.equal(hit, null);
  });

  it("flags a pronoun that contradicts the declared set", () => {
    const hit = lintPronouns("Merritt shifts their weight.", [{ name: "Merritt", pronouns: merritt }]);
    assert.ok(hit);
    assert.equal(hit.character, "Merritt");
    assert.equal(hit.found, "their");
    assert.match(hit.why, /Merritt/);
    assert.match(hit.why, /their/);
    assert.match(hit.why, /he\/him\/his\/himself/);
  });

  it("does not flag when the pronoun is used in quoted dialogue", () => {
    const hit = lintPronouns('Merritt says, "their weight shifts"', [{ name: "Merritt", pronouns: merritt }]);
    assert.equal(hit, null);
  });

  it("does not flag a mismatch when another cast member's name appears in the same sentence", () => {
    const cast = [
      { name: "Merritt", pronouns: merritt },
      { name: "Riven", pronouns: riven },
    ];
    const hit = lintPronouns("Merritt and Riven stood, their breath visible in the cold.", cast);
    assert.equal(hit, null);
  });

  it("does not flag a mismatch when another character's name appears anywhere in the sentence", () => {
    const cast = [
      { name: "Merritt", pronouns: merritt },
      { name: "Riven", pronouns: riven },
    ];
    const hit = lintPronouns("Merritt watched Riven lift his bag.", cast);
    assert.equal(hit, null);
  });

  it("skips an object or possessive pronoun declared by exactly one other member", () => {
    const cast = [
      { name: "Merritt", pronouns: merritt },
      { name: "Mara", pronouns: { subject: "she", object: "her", possessive: "her", reflexive: "herself" } },
    ];
    assert.equal(lintPronouns("Merritt set down the form and slid it toward her.", cast), null);
    assert.equal(lintPronouns("Merritt picked up HER receipt.", cast), null);
  });

  it("flags unclaimed pronouns even when another member declares pronouns", () => {
    const cast = [
      { name: "Merritt", pronouns: merritt },
      { name: "Mara", pronouns: { subject: "she", object: "her", possessive: "her", reflexive: "herself" } },
    ];
    for (const found of ["they", "them", "their"]) {
      const hit = lintPronouns(`Merritt watched ${found} move.`, cast);
      assert.ok(hit);
      assert.equal(hit.character, "Merritt");
      assert.equal(hit.found, found);
    }
  });

  it("continues past an undecidable pronoun to the first unclaimed mismatch", () => {
    const cast = [
      { name: "Merritt", pronouns: merritt },
      { name: "Mara", pronouns: { subject: "she", object: "her", possessive: "her", reflexive: "herself" } },
    ];
    const hit = lintPronouns("Merritt gave her their form, then them a pen.", cast);
    assert.ok(hit);
    assert.equal(hit.character, "Merritt");
    assert.equal(hit.found, "their");
    assert.equal(hit.match, "Merritt gave her their");
  });

  it("does not apply the new skip when two other members declare the word", () => {
    const cast = [
      { name: "Merritt", pronouns: merritt },
      { name: "Riven", pronouns: riven },
      { name: "Mara", pronouns: riven },
    ];
    const hit = lintPronouns("Merritt shifted their weight.", cast);
    assert.ok(hit);
    assert.equal(hit.found, "their");
  });

  it("accepts an own pronoun shared with another member", () => {
    const cast = [
      { name: "Merritt", pronouns: merritt },
      { name: "Vale", pronouns: merritt },
    ];
    assert.equal(lintPronouns("Merritt shifted his weight.", cast), null);
  });

  it("returns null for a character with no declared pronouns", () => {
    const hit = lintPronouns("Merritt shifts their weight.", [{ name: "Merritt" }]);
    assert.equal(hit, null);
  });

  it("flags reflexive drift even when another cast member owns that form", () => {
    const cast = [{ name: "Riven", pronouns: riven }, { name: "Merritt", pronouns: merritt }];
    const hit = lintPronouns("Riven steadied himself.", cast);
    assert.ok(hit);
    assert.equal(hit.character, "Riven");
    assert.equal(hit.found, "himself");
    const neo = { subject: "ze", object: "zem", possessive: "zer", reflexive: "zir" };
    assert.equal(lintPronouns("Riven steadied zir.", [...cast, { name: "Sam", pronouns: neo }])?.found, "zir");
  });

  it("flags a reflexive form mismatch", () => {
    const hit = lintPronouns("Riven steadied himself.", [{ name: "Riven", pronouns: riven }]);
    assert.ok(hit);
    assert.equal(hit.character, "Riven");
    assert.equal(hit.found, "himself");
    assert.match(hit.why, /Riven/);
    assert.match(hit.why, /himself/);
    assert.match(hit.why, /they\/them\/their\/themself/);
  });

  it("returns null for empty prose", () => {
    const hit = lintPronouns("", [{ name: "Merritt", pronouns: merritt }]);
    assert.equal(hit, null);
  });

  it("returns null for whitespace-only prose", () => {
    const hit = lintPronouns("   \n  ", [{ name: "Merritt", pronouns: merritt }]);
    assert.equal(hit, null);
  });

  it("flags an object pronoun mismatch", () => {
    const hit = lintPronouns("The stranger watched her closely.", [{ name: "her", pronouns: riven }]);
    assert.equal(hit, null); // name "her" is unrealistic, but checking name matching
    const hit2 = lintPronouns("Riven noticed him approach.", [{ name: "Riven", pronouns: riven }]);
    assert.ok(hit2);
    assert.equal(hit2.found, "him");
  });

  it("flags a possessive pronoun mismatch", () => {
    const hit = lintPronouns("Merritt found his keys.", [{ name: "Merritt", pronouns: riven }]);
    assert.ok(hit);
    assert.equal(hit.found, "his");
  });

  it("respects subject window — does not match a pronoun too far after the name", () => {
    const farPronoun = "Merritt stood at the counter in the corner of the old library looking out the window. He shifted his weight.";
    const hit = lintPronouns(farPronoun, [{ name: "Merritt", pronouns: riven }]);
    // The subject window is 40 chars; the second sentence is separate and "He" should not match
    assert.equal(hit, null);
  });

  it("matches across an intervening clause within the subject window", () => {
    // Window is 40 chars; this text has "their" within that window after the intervening clause
    const hit = lintPronouns("Merritt, still in corner, shifted their weight.", [{ name: "Merritt", pronouns: merritt }]);
    assert.ok(hit, "should flag 'their' as wrong for Merritt (he/him/his/himself)");
    assert.equal(hit.found, "their");
  });

  it("does not borrow the next sentence's subject", () => {
    const hit = lintPronouns("Merritt waited. They watched the door.", [{ name: "Merritt", pronouns: merritt }]);
    assert.equal(hit, null);
  });

  it("returns null for a character with empty name", () => {
    const hit = lintPronouns("shifts their weight", [{ name: "  ", pronouns: merritt }]);
    assert.equal(hit, null);
  });

  it("checks every cast member with pronouns", () => {
    const cast = [
      { name: "Merritt", pronouns: merritt },
      { name: "Riven", pronouns: riven },
    ];
    const hit = lintPronouns("Riven shifted her weight.", cast);
    assert.ok(hit, "should flag 'her' as wrong for Riven (they/them/their/themself)");
    assert.equal(hit.character, "Riven");
    assert.equal(hit.found, "her");
  });

  it("does not match a name inside a longer word", () => {
    const hit = lintPronouns("Marshall watched their approach.", [{ name: "Merritt", pronouns: merritt }]);
    assert.equal(hit, null);
  });

  it("recognizes a declared neopronoun outside the standard set", () => {
    const neo: PronounSet = { subject: "ze", object: "zem", possessive: "zer", reflexive: "zeself" };
    const cast = [{ name: "Sam", pronouns: neo }];
    const hit = lintPronouns("Sam walked and shifted ze weight.", cast);
    assert.equal(hit, null);
  });

  it("flags a standard pronoun when a neopronoun is declared", () => {
    const neo: PronounSet = { subject: "ze", object: "zem", possessive: "zer", reflexive: "zeself" };
    const cast = [{ name: "Sam", pronouns: neo }];
    const hit = lintPronouns("Sam walked and shifted he weight.", cast);
    assert.ok(hit);
    assert.equal(hit.found, "he");
  });

  it("handles multiple cast members with different pronoun sets", () => {
    const cast = [
      { name: "Merritt", pronouns: merritt },
      { name: "Riven", pronouns: riven },
    ];
    const hit = lintPronouns("Merritt raised his head as Riven approached.", cast);
    assert.equal(hit, null);
  });

  it("returns the first mismatch found when multiple exist", () => {
    const cast = [
      { name: "Merritt", pronouns: merritt },
      { name: "Riven", pronouns: riven },
    ];
    // Separate sentences so ambiguity check doesn't skip
    const hit = lintPronouns("Merritt shifted her weight. Riven watched her approach.", cast);
    assert.ok(hit, "should find first mismatch in Merritt's sentence");
    assert.equal(hit.character, "Merritt");
    assert.equal(hit.found, "her");
  });

  it("handles curly quotes as well as straight quotes", () => {
    const hit = lintPronouns("Merritt says, “their weight shifts”", [{ name: "Merritt", pronouns: merritt }]);
    assert.equal(hit, null);
  });

  it("handles mixed quote types in one passage", () => {
    // Quotes are stripped, so the pronoun outside quotes within the window should be flagged
    const prose = 'Merritt says, "ok" then shifted their weight.';
    const hit = lintPronouns(prose, [{ name: "Merritt", pronouns: merritt }]);
    assert.ok(hit, "should flag 'their' outside quotes");
    assert.equal(hit.found, "their");
  });

  it("preserves the matched text for diagnostics", () => {
    const hit = lintPronouns("Merritt, watching carefully, shifted their weight.", [{ name: "Merritt", pronouns: merritt }]);
    assert.ok(hit);
    assert.match(hit.match, /Merritt.*their/);
  });
});
