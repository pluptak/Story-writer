/**
 * Sense-lint tests — the mechanical restricted-sense half of the narration lint.
 * Deterministic: no model is involved, which is the whole point — the LLM half passed
 * "Marsh watches them from his corner" for a sight-restricted character on every live run.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { lintRestrictedSenses, lintRestrictedSituation } from "../engine/sense-lint.ts";

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

  describe("the look family, gated", () => {
    it("flags the particle forms as the act they are", () => {
      const cases: [string, string][] = [
        ["Marsh does not look up immediately; his gaze remains fixed on the keys.", "look up"],
        ["Marsh looks at the door.", "looks at"],
        ["Marsh looked over his shoulder.", "looked over"],
        ["Marsh, restless, looked around the room.", "looked around"],
        ["Marsh held still, then kept looking down at the keys.", "looking down"],
        ["Marsh looked up at the ceiling.", "looked up"],
      ];
      for (const [prose, verb] of cases) {
        const hit = lintRestrictedSenses(prose, blind);
        assert.ok(hit, `"${prose}" should flag`);
        assert.equal(hit.verb, verb);
      }
    });

    it("refuses the copular and idiomatic forms bare look carries", () => {
      for (const prose of [
        "Marsh looks tired.",
        "Marsh looks like he has not slept in days.",
        "Marsh looks to Riven for a decision.",
        "Marsh looked up to Riven.",
        "Marsh looks outward at nothing.",
      ]) {
        assert.equal(lintRestrictedSenses(prose, blind), null, `"${prose}" should pass`);
      }
    });

    it("refuses the noun use the particle gate lets through", () => {
      for (const prose of [
        "Marsh gave Riven a long look at the satchel.",
        "Marsh gave her a look.",
        "Marsh's look at the door lingered.",
      ]) {
        assert.equal(lintRestrictedSenses(prose, blind), null, `"${prose}" should pass`);
      }
    });

    it("refuses a capacity modal — a possibility is not the act", () => {
      for (const prose of [
        "Marsh held the keys where Riven could look at them.",
        "Marsh stood where the man could look at him.",
      ]) {
        assert.equal(lintRestrictedSenses(prose, blind), null, `"${prose}" should pass`);
      }
    });

    it("flags a negated perception verb — narrating the sense at all is the defect", () => {
      const hit = lintRestrictedSenses("Marsh does not watch the door.", blind);
      assert.ok(hit);
      assert.equal(hit.verb, "watch");
    });
  });

  describe("the possessive sense-noun with an action predicate", () => {
    const merritt = [{ name: "Merritt", cannot: ["sight"] }];

    it("flags the act narrated through the noun", () => {
      const cases: [string, string][] = [
        ["Merritt's gaze travels down the line of keys.", "travels"],
        ["Merritt's stare settles on the ledger and stays there.", "settles"],
        ["Merritt's gaze slowly drifts to the window.", "drifts"],
        ["Merritt's glance held a question.", "held"],
        ["Merritt's gaze then dropped to the floor.", "dropped"],
        ["Merritt’s gaze rested on the wall behind Riven.", "rested"],
      ];
      for (const [prose, verb] of cases) {
        const hit = lintRestrictedSenses(prose, merritt);
        assert.ok(hit, `"${prose}" should flag`);
        assert.equal(hit.verb, verb);
        assert.equal(hit.sense, "sight");
        assert.match(hit.why, /Merritt/);
      }
    });

    it("refuses the noun as object — the verb comes before it, or no verb follows", () => {
      for (const prose of [
        "Riven returned Merritt's glance.",
        "Riven met Merritt's gaze and held it.",
        "Merritt's gaze is the least of your problems.",
        "Merritt's glance, heavy and slow, settled on nothing.",
      ]) {
        assert.equal(lintRestrictedSenses(prose, merritt), null, `"${prose}" should pass`);
      }
    });

    it("reads only the name-possessive — a pronoun possessive stays with the LLM half", () => {
      assert.equal(lintRestrictedSenses(
        "His gaze travels down the line of keys, then settles on a specific ring.", merritt), null);
    });

    it("lets the situation sibling keep its own reading of the possessive", () => {
      assert.equal(lintRestrictedSenses(
        "Riven remains perfectly still under your gaze.", merritt), null);
      const hit = lintRestrictedSituation(
        "Riven remains perfectly still under your gaze.", "MERRITT", merritt[0].cannot);
      assert.ok(hit);
      assert.equal(hit.verb, "gaze");
    });
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

describe("lintRestrictedSituation", () => {
  const merritt = { name: "MERRITT", cannot: ["sight"] };

  // The two verbatim cases from the doorway run (PLANS.md Next item 3's evidence).
  it("refuses the leaning-over situation from the live run", () => {
    const hit = lintRestrictedSituation(
      "You are leaning over Riven, observing their hands at the lock. Riven remains perfectly still under your gaze.",
      "MERRITT", merritt.cannot);
    assert.ok(hit);
    assert.equal(hit.verb, "observing", "the observ* decision: the worst case is caught by the family that was grown for it");
    assert.equal(hit.sense, "sight");
    assert.match(hit.why, /MERRITT/);
    assert.match(hit.why, /CANNOT sight/);
  });

  it("refuses the just-watched situation from the live run", () => {
    const hit = lintRestrictedSituation(
      "You have just watched Riven sign the ledger and slide it back across the counter.",
      "MERRITT", merritt.cannot);
    assert.ok(hit);
    assert.equal(hit.verb, "watched");
  });

  it("refuses the possessive forms the prose determiner guard would exculpate", () => {
    const hit = lintRestrictedSituation(
      "Riven remains perfectly still under your gaze.",
      "MERRITT", merritt.cannot);
    assert.ok(hit);
    assert.equal(hit.verb, "gaze");
    assert.equal(hit.match, "your gaze");
  });

  it("covers a second sense through the same tables", () => {
    const hit = lintRestrictedSituation(
      "The signal starts again, and you hear it through the wall this time.",
      "MERRITT", ["hearing"]);
    assert.ok(hit);
    assert.equal(hit.verb, "hear");
  });

  it("lets the addressee act, wait and be described without perceiving", () => {
    for (const situation of [
      "You remain seated on the crate as Riven moves away toward the counter.",
      "You maintain your pace, letting the corridor shrink behind you.",
      "Your hands find the lock by its cold brass rim.",
      "You say nothing, and the silence holds for a long moment.",
    ]) {
      assert.equal(lintRestrictedSituation(situation, "MERRITT", merritt.cannot), null, `"${situation}" should pass`);
    }
  });

  it("lets a situation say the sense is gone — that is the writer honouring the CANNOT", () => {
    for (const situation of [
      "You cannot look at them, but you can hear their voice clearly over the hum of the lamp.",
      "You can no longer look toward the door, and the corridor is only sound to you now.",
      "You are unable to look at the ledger, so Riven reads the entry aloud.",
      "You couldn't watch them cross the corridor; you tracked them by the scrape of their boots.",
    ]) {
      assert.equal(lintRestrictedSituation(situation, "MERRITT", merritt.cannot), null, `"${situation}" should pass`);
    }
  });

  it("reads incapacity for every sense, not only the gated look family", () => {
    assert.equal(lintRestrictedSituation(
      "You cannot hear the alarm through the wall, but you feel the floor carrying it.",
      "MERRITT", ["hearing"]), null);
  });

  it("leaves ordinary negation refused — only incapacity is the writer honouring the limit", () => {
    const hit = lintRestrictedSituation(
      "You do not watch Riven cross the corridor, though the door stays open.",
      "MERRITT", merritt.cannot);
    assert.ok(hit);
    assert.equal(hit.verb, "watch");
  });

  it("keeps the page's ruling: the same incapacity sentence is still a flag in prose", () => {
    const blindMerritt = [{ name: "Merritt", cannot: ["sight"] }];
    for (const prose of [
      "Merritt cannot look at the door, and has not for six years.",
      "Merritt can no longer look at the door, and has not for six years.",
      "Merritt is unable to look at the door, and has not for six years.",
    ]) {
      assert.ok(lintRestrictedSenses(prose, blindMerritt), `"${prose}" should flag`);
    }
  });

  it("still reads a genuine no-determiner noun use as the thing, not the act", () => {
    assert.equal(lintRestrictedSenses("Riven gave the door no look at all before turning away.",
      [{ name: "Riven", cannot: ["sight"] }]), null);
  });

  it("does not police other characters' perceiving in someone else's situation", () => {
    assert.equal(lintRestrictedSituation(
      "Riven watches you from the doorway, saying nothing.",
      "MERRITT", merritt.cannot), null);
  });

  it("does not police a gaze that is not the addressee's", () => {
    assert.equal(lintRestrictedSituation(
      "The camera's gaze sweeps the corridor and settles on the far door.",
      "MERRITT", merritt.cannot), null);
  });

  it("checks nothing without a cannot list, and nothing for an empty situation", () => {
    assert.equal(lintRestrictedSituation("You watch the door swing open.", "MERRITT", []), null);
    assert.equal(lintRestrictedSituation("", "MERRITT", merritt.cannot), null);
  });

  it("ignores a restriction with no verb table", () => {
    assert.equal(lintRestrictedSituation(
      "You watch the door swing open.",
      "MERRITT", ["cameras"]), null);
  });

  it("leaves you-see as a known miss — the discourse marker is too common to risk", () => {
    assert.equal(lintRestrictedSituation(
      "You see the ledger lying open on the counter.",
      "MERRITT", merritt.cannot), null);
  });

  it("flags you-look with a particle through the shared table", () => {
    const hit = lintRestrictedSituation(
      "You look up from the ledger when the voice stops you.",
      "MERRITT", merritt.cannot);
    assert.ok(hit);
    assert.equal(hit.verb, "look up");
  });

  it("refuses the noun use of look in a situation too", () => {
    assert.equal(lintRestrictedSituation(
      "You give Riven a long look at the satchel before speaking.",
      "MERRITT", merritt.cannot), null);
  });
});

describe("doorway run-3 evidence — the five lines PLANS.md item 3 put on the page", () => {
  const merritt = [{ name: "MERRITT", cannot: ["sight"] }];

  it("catches the look up — narrating the sense at all, negation included", () => {
    const hit = lintRestrictedSenses(
      "The sound of Riven's voice cuts through the quiet hum of the sodium lamp. " +
      "Merritt does not look up immediately; his gaze remains fixed on the tangle of keys in his hand. " +
      "A small, subtle shift occurs as he registers the intrusion and your proximity.",
      merritt);
    assert.ok(hit);
    assert.equal(hit.verb, "look up");
    assert.equal(hit.sense, "sight");
  });

  it("catches the possessive gaze carrying an action predicate", () => {
    const hit = lintRestrictedSenses(
      "Merritt's gaze travels down the line of keys, then settles on a specific ring near the " +
      "top-a thicker, darker piece. He begins to work with his fingers, selecting one key from the cluster.",
      merritt);
    assert.ok(hit);
    assert.equal(hit.verb, "travels");
    assert.match(hit.why, /gaze travels/);
  });

  it("still misses the pronoun-subject line — out of scope by the run-two ruling, left to the LLM half", () => {
    assert.equal(lintRestrictedSenses(
      "Merritt shifts his weight slowly on the crate. " +
      "He lifts his head just enough so that he can glance toward you without fully turning. " +
      "His expression is unreadable in the dim light, but his hands remain anchored to the keyring. " +
      "He does not speak, only holds your gaze for a moment before looking down again.",
      merritt), null);
  });

  it("still misses the see line — the exclusion is settled, recorded in the module docstring", () => {
    assert.equal(lintRestrictedSenses(
      "Riven retreats into the shadows of the brickwork, moving back to their original spot against the wall. " +
      "The distance between them and the door remains just wide enough for Merritt to see them, " +
      "but far enough that they are no longer a threat to his routine.",
      merritt), null);
  });

  it("pins the one catch the shipped lint already made", () => {
    const hit = lintRestrictedSenses(
      "Merritt watches this entire sequence from a distance within the service zone, " +
      "his posture remaining still and observant.",
      merritt);
    assert.ok(hit);
    assert.equal(hit.verb, "watches");
  });
});
