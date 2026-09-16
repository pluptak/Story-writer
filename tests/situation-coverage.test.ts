/** The situation-coverage measurement: does a re-consult's situation carry the intervening
 *  consequences? */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  contentWords, recall, scoreCoverage, type CoverageEvent,
} from "../engine/situation-coverage.ts";

describe("content words and recall", () => {
  it("keeps names and drops stopwords and short tokens", () => {
    assert.deepEqual(contentWords("Riven picked the lock by the door"), ["riven", "picked", "lock", "door"]);
  });

  it("scores 1 when there is nothing to find", () => {
    assert.equal(recall("", "anything at all"), 1);
    assert.equal(recall("the and of", "anything at all"), 1);
  });

  it("is a token recall, not a substring match", () => {
    assert.equal(recall("lock cylinder", "the lock cylinder gave way"), 1);
    assert.equal(recall("lock cylinder", "the lock held fast"), 0.5);
    assert.equal(recall("lock cylinder", "the door held fast"), 0);
  });
});

const CONSULT = (character: string, situation: string, attempt = 1): CoverageEvent =>
  ({ t: "consult", character, situation, attempt });
const ACCEPT = (character: string, speech: string, action = ""): CoverageEvent =>
  ({ t: "accept", character, speech, action });
const DRAFT = (prose: string): CoverageEvent => ({ t: "draft", prose });

describe("scoreCoverage", () => {
  it("scores no verdict for a first consult", () => {
    assert.deepEqual(scoreCoverage([CONSULT("MERRITT", "You sit on the crate in the dark service room.")]), []);
  });

  it("marks a re-consult with no intervening prose as trivially covered", () => {
    const [v] = scoreCoverage([
      CONSULT("MERRITT", "You sit on the crate in the dark service room."),
      ACCEPT("MERRITT", "", "I shift my weight on the crate."),
      CONSULT("MERRITT", "You are still on the crate in the dark service room."),
    ]);
    assert.equal(v.piecesSince, 0);
    assert.equal(v.covered, true);
    assert.deepEqual(v.items, []);
  });

  it("marks a re-consult covered when the situation carries the intervention", () => {
    const [v] = scoreCoverage([
      CONSULT("RIVEN", "You kneel by the service door in the dark basement corridor."),
      ACCEPT("RIVEN", "Stand back, I have got this.", "I work the pick into the service door lock."),
      CONSULT("MERRITT", "You sit on the crate in the dark service room above."),
      ACCEPT("MERRITT", "The lock is giving way, I can hear it.", "I stay still on the crate, listening."),
      DRAFT("Riven works the pick into the service door lock. The cylinder gives with a loud click as Merritt calls out."),
      CONSULT("RIVEN", "The service door lock cylinder just gave with a loud click under your pick. Merritt says the lock is giving way."),
    ]);
    assert.equal(v.piecesSince, 1);
    assert.equal(v.answeredSince, true);
    assert.equal(v.covered, true);
    assert.ok(v.items.some(x => x.kind === "speech" && x.character === "MERRITT" && x.covered),
      "another character's granted line re-appears and is strictly covered");
    assert.ok(!v.items.some(x => x.kind === "speech" && x.character === "RIVEN"),
      "one's own line is no news and is never a strict item");
  });

  it("flags a re-consult whose situation ignores the intervention", () => {
    const [v] = scoreCoverage([
      CONSULT("RIVEN", "You kneel by the service door in the dark basement corridor."),
      ACCEPT("RIVEN", "Stand back, I have got this.", "I work the pick into the service door lock."),
      CONSULT("MERRITT", "You sit on the crate in the dark service room above."),
      ACCEPT("MERRITT", "The lock is giving way, I can hear it."),
      DRAFT("Riven works the pick into the service door lock. The cylinder gives with a loud click as Merritt calls out."),
      CONSULT("RIVEN", "You are still kneeling in the corridor. The air smells of oil and damp concrete."),
    ]);
    assert.equal(v.piecesSince, 1);
    assert.equal(v.covered, false);
    assert.ok(v.items.some(x => x.kind === "speech" && x.character === "MERRITT" && !x.covered),
      "the missed line is listed verbatim to be read");
  });

  it("excludes a re-consult whose previous consult went unanswered from the denominator", () => {
    const [v] = scoreCoverage([
      CONSULT("MERRITT", "You sit on the crate in the dark service room."),
      DRAFT("Somewhere below, metal clangs against concrete."),
      CONSULT("MERRITT", "You sit on the crate. Somewhere below, metal clangs against concrete."),
    ]);
    assert.equal(v.answeredSince, false);
  });

  it("ignores judge retries: only attempt-1 consults score and reset the base", () => {
    const vs = scoreCoverage([
      CONSULT("MERRITT", "You sit on the crate in the dark service room."),
      ACCEPT("MERRITT", "", "I stay still on the crate, listening."),
      DRAFT("Merritt stays still on the crate, listening to the dark."),
      CONSULT("MERRITT", "You sit on the crate, listening to the dark service room.", 1),
      CONSULT("MERRITT", "You sit on the crate, listening hard for movement below.", 2),
      DRAFT("Below, something scrapes along concrete."),
      CONSULT("MERRITT", "Below you something scrapes along concrete while you listen from the crate.", 1),
    ]);
    assert.equal(vs.length, 2);
    assert.equal(vs[1].piecesSince, 1);
  });

  it("tracks characters independently", () => {
    const vs = scoreCoverage([
      CONSULT("MERRITT", "You sit on the crate in the dark service room."),
      ACCEPT("MERRITT", "", "I stay still."),
      CONSULT("RIVEN", "You kneel by the service door in the dark basement corridor."),
      ACCEPT("RIVEN", "Stand back.", "I work the pick."),
      DRAFT("Riven works the pick. Merritt stays still on the crate."),
      CONSULT("MERRITT", "Riven is working the pick at the service door while you stay still on the crate."),
    ]);
    assert.equal(vs.length, 1);
    assert.equal(vs[0].character, "MERRITT");
    assert.equal(vs[0].piecesSince, 1);
  });
});
