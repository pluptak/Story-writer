/**
 * Answer-reach lint — the mechanical floor under "AN ANSWER HAS TO REACH THE SCENE": an empty
 * envelope and a thought-only answer from outside the point of view fold in as nothing, so
 * they are refused before the judge. Deterministic, no model involved.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { lintAnswerReach } from "../../engine/lint/answer-reach-lint.ts";
import type { ConsultReply } from "../../engine/consult.ts";

const reply = (over: Partial<ConsultReply>): ConsultReply => ({
  character: "RIVEN", thought: "", speech: "", action: "", note: "",
  clarifications: [], forced: false, raw: "", ...over,
});

describe("lintAnswerReach", () => {
  it("refuses the empty envelope — the shape the judge caught live, verbatim", () => {
    const hit = lintAnswerReach(reply({ raw: `{"thought":"","speech":"","action":""}` }), true);
    assert.deepEqual(hit, { why: "the answer carried no thought, speech, action or note" });
  });

  it("keeps a note-only answer — the stall beat is content, not an envelope", () => {
    const stalled = reply({ note: "did not answer; kept asking: who holds the ledger?" });
    assert.equal(lintAnswerReach(stalled, true), null);
  });

  it("refuses a thought-only answer from outside the point of view", () => {
    const hit = lintAnswerReach(
      reply({ thought: "So that is who holds the ledger." }), false);
    assert.deepEqual(hit,
      { why: "a thought from outside the point of view reaches the scene as nothing" });
  });

  it("a thought alone is a complete answer from the point-of-view character", () => {
    assert.equal(lintAnswerReach(
      reply({ thought: "So that is who holds the ledger." }), true), null);
  });

  it("keeps an answer that arrives through several channels at once — never a shape violation", () => {
    const alive = reply({ thought: "Steady.", speech: "Easy.", action: "Sets the pick on the crate." });
    assert.equal(lintAnswerReach(alive, true), null);
    assert.equal(lintAnswerReach(alive, false), null);
  });
});
