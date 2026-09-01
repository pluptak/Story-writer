/** The world timeline's decision half: what fires, what is held, which memories implant.
 *  Pure function — no agents, no fetch, no loop. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TimelineDef, type TimelineDef as Beat } from "../engine/story-schema.ts";
import { timelineTurn } from "../engine/world-timeline.ts";

const beat = (over: Partial<Beat> = {}): Beat =>
  TimelineDef.parse({ chapter: 1, hold: "the panel going into alarm", fired: "the fault alarm sounds", ...over });

describe("timelineTurn", () => {
  it("holds before the trigger and fires once at it", () => {
    const b = beat({ at: 0.5 });
    const fired = new Set<Beat>();
    const before = timelineTurn([b], 1, 0, 100, fired);
    assert.equal(before.fired, null);
    assert.equal(before.hold, "the panel going into alarm");

    const at = timelineTurn([b], 1, 50, 100, fired);
    assert.equal(at.fired, b);
    assert.equal(at.hold, "", "the fired and held forms are never live together");
    assert.deepEqual(at.memories, []);

    fired.add(b);
    const after = timelineTurn([b], 1, 90, 100, fired);
    assert.equal(after.fired, null);
    assert.equal(after.hold, "", "a spent beat holds nothing either");
  });

  it("fires at zero words when at is 0, and never past a full target when at is 1", () => {
    const fired = new Set<Beat>();
    const immediate = beat({ at: 0 });
    assert.equal(timelineTurn([immediate], 1, 0, 100, fired).fired, immediate);
    const boundary = beat({ at: 1 });
    assert.equal(timelineTurn([boundary], 1, 99, 100, fired).fired, null);
    assert.equal(timelineTurn([boundary], 1, 100, 100, fired).fired, boundary);
  });

  it("ignores beats aimed at another chapter, and void beats of any chapter", () => {
    const fired = new Set<Beat>();
    const other = beat({ chapter: 2 });
    const voided = beat({ state: "void" });
    const turn = timelineTurn([other, voided], 1, 90, 100, fired);
    assert.equal(turn.fired, null);
    assert.equal(turn.hold, "", "an unfireable beat must not hold the writer either");
  });

  it("queues beats in authored order: the second holds only after the first fires", () => {
    const first = beat({ at: 0.25 });
    const second = beat({
      hold: "the second held event", fired: "the second event lands",
      memories: { HALE: "the wing is insured on occupancy" }, at: 0.5,
    });
    const fired = new Set<Beat>();

    const turn1 = timelineTurn([first, second], 1, 10, 100, fired);
    assert.equal(turn1.fired, null);
    assert.equal(turn1.hold, first.hold, "the first beat's hold is live while it is unfired");

    fired.add(first);
    const turn2 = timelineTurn([first, second], 1, 30, 100, fired);
    assert.equal(turn2.fired, null);
    assert.equal(turn2.hold, second.hold, "the second beat's hold takes over once the first has fired");

    const turn3 = timelineTurn([first, second], 1, 50, 100, fired);
    assert.equal(turn3.fired, second);
    assert.deepEqual(turn3.memories, [["HALE", "the wing is insured on occupancy"]]);
  });

  it("carries every memory of the firing beat, keyed as authored", () => {
    const b = beat({ memories: { RIVEN: "one", "MERRITT": "two" } });
    const turn = timelineTurn([b], 1, 100, 100, new Set());
    assert.deepEqual(turn.memories, [["RIVEN", "one"], ["MERRITT", "two"]],
      "implanting decides who is present; the decision only reports what was authored");
  });

  it("returns nothing at all for an empty ledger, without any firing record", () => {
    const turn = timelineTurn([], 1, 50, 100, new Set());
    assert.equal(turn.fired, null);
    assert.equal(turn.hold, "");
    assert.deepEqual(turn.memories, []);
  });

});
