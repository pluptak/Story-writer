/** The world repair entity: adjudicating outstanding beats after the story progressed.
 *  Pure function — no agents, no fetch, no loop, no personas, no goals. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TimelineDef, type TimelineDef as Beat } from "../engine/story-schema.ts";
import { adjudicateBeat, adjudicateChapter, type BeatStanding } from "../engine/world-repair.ts";

const beat = (over: Partial<Beat> = {}): Beat =>
  TimelineDef.parse({ chapter: 1, hold: "the panel going into alarm", fired: "the fault alarm sounds", ...over });

const standing = (over: Partial<BeatStanding> = {}): BeatStanding => ({
  fired: false, landed: null, possible: true, questionLive: true, ended: false, ...over,
});

describe("adjudicateBeat, the four repairs", () => {
  it("preempted: unfired and impossible in the established world voids the beat", () => {
    // They evacuated before the alarm fired — the beat is void; a replacement pressure, if the
    // story needs one, is the handoff's authorship, never this module's output.
    const r = adjudicateBeat(beat(), standing({ ended: true, possible: false }));
    assert.deepEqual(r, { op: "void", cause: "preempted" });
  });

  it("contradicted: fired but impossible revises the same obligation, never voids it", () => {
    // The thing cannot come through the sealed door — it comes through differently.
    const r = adjudicateBeat(beat(), standing({ fired: true, landed: true, possible: false }));
    assert.deepEqual(r, { op: "revise", cause: "contradicted" });
  });

  it("splits impossibility by firing: unfired voids, fired revises", () => {
    const unfired = adjudicateBeat(beat(), standing({ possible: false }));
    const fired = adjudicateBeat(beat(), standing({ fired: true, landed: true, possible: false }));
    assert.equal(unfired.op, "void", "an unfired beat has no obligation to reroute");
    assert.equal(fired.op, "revise", "a fired beat owes the same pressure by another route");
  });

  it("fired but did not land: escalates the same beat while the question stays live", () => {
    // Both alarm-wing runs: the alarm sounded and stayed a background chime.
    const r = adjudicateBeat(beat(), standing({ fired: true, landed: false }));
    assert.deepEqual(r, { op: "escalate", cause: "unlanded" });
  });

  it("stranded: unfired at chapter end with the pressure live re-aims at the next chapter", () => {
    const b = beat({ chapter: 2 });
    const r = adjudicateBeat(b, standing({ ended: true }));
    assert.deepEqual(r, { op: "re-aim", toChapter: 3, cause: "stranded" });
  });
});

describe("adjudicateBeat, the states that repair nothing", () => {
  it("a queued beat is the firing logic's, not the repair logic's", () => {
    assert.deepEqual(adjudicateBeat(beat(), standing()), { op: "none", cause: "queued" });
  });

  it("a landed beat is spent", () => {
    assert.deepEqual(adjudicateBeat(beat(), standing({ fired: true, landed: true })),
      { op: "none", cause: "spent" });
  });

  it("never escalates on a check that has not run", () => {
    // The removed mechanical check's defect: a consult-without-prose turn drew an escalation
    // with no piece to check. Awaiting a check is not failing one.
    const r = adjudicateBeat(beat(), standing({ fired: true, landed: null }));
    assert.deepEqual(r, { op: "none", cause: "awaiting-check" });
  });

  it("a stranded beat for a settled question voids instead of re-aiming", () => {
    const r = adjudicateBeat(beat(), standing({ ended: true, questionLive: false }));
    assert.deepEqual(r, { op: "void", cause: "spent" });
  });
});

describe("adjudicateBeat, the autonomy invariant", () => {
  it("an unexpected valid route that settles the question retires beats instead of reviving them", () => {
    // The stage-3 open-beat case: Elias does not convince Sara; he and Kane overpower her at the
    // lever and she concedes after. The scene answered its question by a better route than the
    // premise anticipated — the timeline must absorb that, never steer back to the scripted route.
    const firedUnlanded = adjudicateBeat(beat(),
      standing({ fired: true, landed: false, questionLive: false }));
    assert.deepEqual(firedUnlanded, { op: "none", cause: "spent" },
      "a fired beat that never landed is left alone once nothing is owed — not escalated");

    const unfired = adjudicateBeat(beat(), standing({ ended: true, questionLive: false }));
    assert.deepEqual(unfired, { op: "void", cause: "spent" },
      "an unfired beat is dropped — not re-aimed at the next chapter to force the planned path");

    const contradicted = adjudicateBeat(beat(),
      standing({ fired: true, possible: false, questionLive: false }));
    assert.deepEqual(contradicted, { op: "none", cause: "spent" },
      "even impossibility requests no revision for a settled question");
  });

  it("reads only world-side standing: the same standing always yields the same repair", () => {
    // The boundary as a test: there is no parameter for who chose what, so two different
    // character stories with the same world outcome cannot diverge here by construction.
    assert.equal(adjudicateBeat.length, 2, "beat and standing — nowhere to put a persona or a goal");
    const a = adjudicateBeat(beat(), standing({ fired: true, landed: false }));
    const b = adjudicateBeat(beat(), standing({ fired: true, landed: false }));
    assert.deepEqual(a, b, "identical standing, identical repair, whatever the characters did");
  });

  it("emits operations, never prose: no repair carries beat wording", () => {
    const b = beat({ hold: "the panel going into alarm", fired: "the fault alarm sounds" });
    for (const s of [
      standing({ ended: true, possible: false }),
      standing({ fired: true, landed: true, possible: false }),
      standing({ fired: true, landed: false }),
      standing({ ended: true }),
      standing({ ended: true, questionLive: false }),
    ]) {
      const json = JSON.stringify(adjudicateBeat(b, s));
      assert.ok(!json.includes("panel going into alarm"), `hold text leaked: ${json}`);
      assert.ok(!json.includes("fault alarm sounds"), `fired text leaked: ${json}`);
    }
  });
});

describe("adjudicateChapter", () => {
  it("adjudicates each beat aimed at the chapter in ledger order, skipping the rest", () => {
    const first = beat({ at: 0.25 });
    const second = beat({ chapter: 2 });
    const voided = beat({ state: "void" });
    const out = adjudicateChapter([first, second, voided], 1, () => standing({ ended: true }));
    assert.equal(out.length, 1, "other chapters and void beats are not consulted");
    assert.equal(out[0].beat, first);
    assert.deepEqual(out[0].repair, { op: "re-aim", toChapter: 2, cause: "stranded" });
  });

  it("returns nothing for a chapter with no live beats", () => {
    assert.deepEqual(adjudicateChapter([], 1, () => standing()), []);
    assert.deepEqual(adjudicateChapter([beat({ chapter: 2 })], 1, () => standing()), []);
  });
});
