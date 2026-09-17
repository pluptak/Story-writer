/**
 * Quote-lint tests — the mechanical quotation half of the narration lint.
 * Deterministic: no model involved, so a missed quote cannot hide behind an LLM.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractQuotations, isAdvisoryQuoteHit, lintQuotations } from "../engine/quote-lint.ts";
import { lintPiece, type LintEvent } from "../engine/narration-lint.ts";
import { ScriptedAgent } from "./helpers.ts";

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

  it("extracts curly and punctuated single quotes in source order with exact offsets", () => {
    const prose = "‘I’ll go first.’\nShe adds:'Wait here!' Then “Stay close.”";
    const quotes = extractQuotations(prose);
    assert.deepEqual(quotes.map(q => q.text), ["I’ll go first.", "Wait here!", "Stay close."]);
    for (const q of quotes) assert.equal(prose.slice(q.index, q.index + q.text.length), q.text);
    assert.equal(extractQuotations("Marcus’ pen lay beside Mara's coat.").length, 0);
  });

  it("does not double-count nested single quotes", () => {
    assert.deepEqual(extractQuotations('"I called it \'the last chance\'."').map(q => q.text),
      ["I called it 'the last chance'."]);
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

  it("passes quoted text supplied by a granted action", () => {
    const g = [{ character: "VALE", speech: "", action:
      "I write 'Witness states no internal movement visible from her position' on the form" }];
    const prose = 'Vale writes "Witness states no internal movement visible from her position" on the form.';
    assert.equal(lintQuotations(prose, g, ["VALE"]), null);
    assert.equal(lintQuotations(prose, g), null);
  });

  it("passes an exact excerpt with the original first-person subject restored", () => {
    const speech = "I walked to hatch W-17, placed the ledger inside, and waited for the chime. "
      + "That is the extent of my involvement with the deposit.";
    assert.equal(lintQuotations('Marcus said "I placed the ledger inside, and waited for the chime."',
      granted(speech), ["Marcus"]), null);
  });

  it("rejects invented additions around a shared run", () => {
    const g = granted("At dawn we placed the ledger inside before leaving silently.");
    assert.ok(lintQuotations('"They said we placed the ledger inside yesterday."', g));
    assert.ok(lintQuotations('"Yesterday we placed the ledger inside quietly."', g));
  });

  it("flags a long invented line with no long contiguous run", () => {
    const hit = lintQuotations('Marcus said "I burned every document before escaping through the northern tunnel."',
      granted("I walked to hatch W-17, placed the ledger inside, and waited for the chime."), ["Marcus"]);
    assert.ok(hit);
    assert.equal(isAdvisoryQuoteHit(hit), false);
  });

  it("does not combine separated token runs to reach sixty percent", () => {
    const hit = lintQuotations('"We placed strange objects the ledger beside doors inside yesterday."',
      granted("At dawn we placed the ledger inside before leaving silently."));
    assert.ok(hit);
    assert.equal(isAdvisoryQuoteHit(hit), false);
  });

  it("rejects additions, negation changes, reordered roles, and duplicated tokens", () => {
    const cases: [string, string][] = [
      ["I placed the ledger inside and waited for the chime.", "I placed the ledger inside and waited for the chime, then burned it."],
      ["I placed the ledger inside and waited for the chime.", "I never placed the ledger inside and waited for the chime."],
      ["I did not place the ledger inside and wait for the chime.", "I did place the ledger inside and wait for the chime."],
      ["I never placed the ledger inside and waited for the chime.", "I placed the ledger inside and waited for the chime."],
      ["I gave Mara the ledger and Nkem the key.", "I gave Nkem the ledger and Mara the key."],
      ["The ledger stays with me tonight.", "The ledger ledger ledger ledger ledger."],
      ["The ledger stays with me tonight.", "The ledger stays stays with me tonight."],
    ];
    for (const [speech, quote] of cases) {
      const hit = lintQuotations(`Marcus said "${quote}"`, granted(speech), ["Marcus"]);
      assert.ok(hit, quote);
      assert.equal(isAdvisoryQuoteHit(hit), false, quote);
    }
  });

  it("does not turn action narration or written quotations into speech grants", () => {
    for (const action of ["I put the ledger in the drawer.", "I write 'The ledger stays here tonight.' on the form."]) {
      const g = [{ character: "Mara", speech: "", action }];
      const quote = action.startsWith("I put") ? action : "The ledger stays here tonight.";
      assert.ok(lintQuotations(`Mara said "${quote}"`, g, ["Mara"]));
      assert.ok(lintQuotations(`"${quote}"`, g));
    }
    assert.ok(lintQuotations('Mara writes "The ledger stays here tonight."',
      [{ character: "Mara", speech: "", action: "I recall 'The ledger stays here tonight.'" }], ["Mara"]));
  });

  it("blocks explicit named tags in either direction and preserves weak attribution as advisory", () => {
    const g = granted("The ledger stays with me tonight.", "Nkem");
    for (const prose of [
      'Mara said "The ledger stays with me tonight."',
      '“The ledger stays with me tonight,” Mara said.',
      "'The ledger stays with me tonight,' said Mara.",
      'Mara said "The ledger stays with me tonight." Nkem left.',
      'The sign flickered. Mara said "The ledger stays with me tonight."',
    ]) {
      const hit = lintQuotations(prose, g, ["Mara", "Nkem"]);
      assert.ok(hit, prose);
      assert.equal(hit.character, "Mara");
      assert.equal(isAdvisoryQuoteHit(hit), false);
    }
    const hit = lintQuotations('Mara waited. "The ledger stays with me tonight."', g, ["Mara", "Nkem"]);
    assert.ok(hit);
    assert.equal(isAdvisoryQuoteHit(hit), true);
  });

  it("does not let an advisory quote hide a later blocking quote", () => {
    const hit = lintQuotations('Mara waited. "The ledger stays with me tonight." Silence. Mara said "I burned the whole room."',
      granted("The ledger stays with me tonight.", "Nkem"), ["Mara", "Nkem"]);
    assert.ok(hit);
    assert.equal(hit.quote, "I burned the whole room.");
    assert.equal(isAdvisoryQuoteHit(hit), false);
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

  it("attributes an unmatched quote to the nearest name before it when nothing follows", () => {
    const prose = 'Elias watched. Marcus said "This is not my line to sign."';
    const hit = lintQuotations(prose, [], ["Elias", "Marcus"]);
    assert.ok(hit && !hit.ok);
    assert.equal(hit!.character, "Marcus");
  });

  it("prefers the trailing name over a nearer-but-wrong preceding one — the ordinary post-quote form", () => {
    // "Riven reaches for the door. "No, not tonight," Merritt says" — a backward-only scan would
    // report RIVEN, the nearest preceding name, even though the quote is Merritt's in the engine's
    // dominant post-dialogue style.
    const prose = 'Riven reaches for the door. "No, not tonight," Merritt says.';
    const hit = lintQuotations(prose, [], ["Riven", "Merritt"]);
    assert.ok(hit && !hit.ok);
    assert.equal(hit!.character, "Merritt");
  });

  it("falls back to the preceding name when the trailing clause names nobody", () => {
    const prose = 'Marcus said "This is not my line to sign," and looked away.';
    const hit = lintQuotations(prose, [], ["Marcus"]);
    assert.ok(hit && !hit.ok);
    assert.equal(hit!.character, "Marcus");
  });

  it("passes a line correctly attributed to the character it was granted to", () => {
    const prose = '"The ledger stays with me tonight," Merritt says.';
    const g = [{ character: "Merritt", speech: "The ledger stays with me tonight." },
               { character: "Nkem", speech: "I never signed anything." }];
    assert.equal(lintQuotations(prose, g, ["Merritt", "Nkem"]), null);
  });

  it("flags a line granted to one character but rendered as another's — the reassignment the old all-speeches match let through", () => {
    const prose = '"The ledger stays with me tonight," Merritt says.';
    const g = [{ character: "Nkem", speech: "The ledger stays with me tonight." }];
    const hit = lintQuotations(prose, g, ["Merritt", "Nkem"]);
    assert.ok(hit && !hit.ok, "a line granted to Nkem but spoken as Merritt must flag");
    assert.equal(hit!.character, "Merritt");
    assert.match(hit!.why, /granted to a different character/);
    assert.match(hit!.why, /^unmatched quotation/);
    assert.equal(isAdvisoryQuoteHit(hit), false);
  });

  it("still matches against every grant when the quote cannot be attributed to anybody", () => {
    const prose = '"The ledger stays with me tonight." Silence followed.';
    const g = [{ character: "Nkem", speech: "The ledger stays with me tonight." }];
    assert.equal(lintQuotations(prose, g, ["Merritt", "Nkem"]), null);
  });

  it("does not let a substring of an unrelated word fake a match", () => {
    // "no" must not match inside the granted speech "know" — token match, not substring. The quote
    // is multi-word because a bare single word is read as a machine label and never checked.
    const prose = 'He said "no, not tonight".';
    const hit = lintQuotations(prose, granted("I know the rhythm"), ["He"]);
    assert.ok(hit && !hit.ok);
  });

  it("passes a quoted rendering of a granted thought — felt interiority is a granted line too", () => {
    const g = [{ character: "Riven", speech: "", thought: "Too easy. That is the part I do not like." }];
    const prose = 'Riven thought, "Too easy."';
    assert.equal(lintQuotations(prose, g, ["Riven"]), null);
  });
});

describe("narration finding severities", () => {
  for (const mechanical of ["clean", "quote", "sense", "both"] as const) {
    for (const outcome of ["clean", "flag", "malformed", "outage"] as const) {
      it(`separates ${mechanical} mechanical findings from a ${outcome} judge`, async (t) => {
        const prose = [
          mechanical === "sense" || mechanical === "both" ? "Merritt watches the door." : "The door rattles.",
          mechanical === "quote" || mechanical === "both" ? 'Merritt says, "Keep that door shut tonight."' : "",
        ].filter(Boolean).join(" ");
        const advisory = "Merritt's deliberate act was not granted";
        const judge = new ScriptedAgent(outcome === "malformed" ? ["{}", "{}"]
          : [JSON.stringify(outcome === "flag" ? { ok: false, why: advisory } : { ok: true })]);
        if (outcome === "outage") t.mock.method(judge, "generate", async () => {
          throw new Error("simulated lint outage");
        });
        const events: LintEvent[] = [];
        const result = await lintPiece({
          prose, granted: [], cast: [{ name: "Merritt", cannot: ["sight"] }],
          pov: "Merritt", consult: null, chapter: 1,
          newNarrationJudge: () => judge, log: e => events.push(e),
        });
        assert.equal(result.advisory, outcome === "flag" ? advisory : null);
        if (mechanical === "clean") assert.equal(result.blocking, null);
        else {
          assert.ok(result.blocking);
          assert.equal(result.blocking.includes("unmatched quotation"), mechanical !== "sense");
          assert.equal(result.blocking.includes("sight"), mechanical !== "quote");
          assert.ok(!result.blocking.includes(advisory));
        }
        assert.equal(events.filter(e => e.t === "schema_mismatch").length, outcome === "malformed" ? 1 : 0);
        assert.equal(events.filter(e => e.t === "lint_failed").length, outcome === "outage" ? 1 : 0);
        if (outcome !== "outage") assert.equal(judge.calls, outcome === "malformed" ? 2 : 1);
      });
    }
  }
});

describe("advisory quotations in narration", () => {
  it("logs a possible misattribution without returning a redraft message", async () => {
    const events: LintEvent[] = [];
    const judge = new ScriptedAgent(['{"ok":true}']);
    const why = await lintPiece({
      prose: '"The ledger stays with me tonight." Merritt folds the paper.',
      granted: [{ character: "Nkem", speech: "The ledger stays with me tonight.", action: "" }],
      cast: [{ name: "Merritt", cannot: [] }, { name: "Nkem", cannot: [] }],
      pov: "Merritt", consult: null, chapter: 1,
      newNarrationJudge: () => judge, log: e => events.push(e),
    });
    assert.deepEqual(why, { blocking: null, advisory: null });
    assert.equal(judge.calls, 1);
    assert.equal(events.length, 1);
    assert.ok(events[0].t === "narration_quote_flag");
    assert.match(events[0].why, /^possible misattribution/);
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
