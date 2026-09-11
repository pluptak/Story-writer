/** The deterministic information boundary: presence + ledger state restrict delivery, and
 *  nothing here generates an inference. Pure functions — no agents, no fetch. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeConsult, normalizeReactionConsult, nonPovThoughtOnly,
} from "../engine/consult.ts";
import { timelineTurn } from "../engine/world-timeline.ts";
import { adjudicateBeat } from "../engine/world-repair.ts";
import { TimelineDef, type TimelineDef as Beat } from "../engine/story-schema.ts";
import * as P from "../prompts.ts";

const beat = (over: Partial<Beat> = {}): Beat =>
  TimelineDef.parse({ chapter: 1, hold: "the panel going into alarm", fired: "the fault alarm sounds", ...over });

const ROOM = "The service door hangs open on the dark corridor and cold air moves past you across the floor.";
const HEARD = "From the next room you catch a splintering crash and a rush of cold air under the door.";
const PHONE_HEARING =
  "You hear Riven's voice crackle through the phone line as he reads the ledger entries aloud to you now.";
const WATCHING = "You watch Riven sign the ledger and slide it back across the scarred counter toward you.";

const remoteCast = [{ name: "RIVEN", cannot: [] as string[],
  presenceState: { mode: "remote" as const, via: "the phone line" } }];
const hereCast = [{ name: "RIVEN", cannot: [] as string[] }];

// WORLD TRUTH → authorized observation → CHARACTER → interpretation/choice. Never
// WORLD TRUTH → authority → "therefore the character should believe X".

describe("1. an in-room character can receive an appropriate observation", () => {
  it("a perceivable present-tense situation passes the open door", () => {
    const r = normalizeConsult({ character: "RIVEN", situation: ROOM }, hereCast, "open");
    assert.ok(r.ok, `an in-room observation must pass: ${!r.ok ? r.why : ""}`);
  });

  it("a shared room-perspective fan-out reaches characters standing in it", () => {
    const r = normalizeReactionConsult(
      { reactors: [{ name: "RIVEN" }], situation: ROOM }, hereCast);
    assert.ok(r.ok);
    assert.equal(r.reqs[0].situation, ROOM);
  });
});

describe("2. a remote character cannot receive an in-room-only observation", () => {
  it("a single consult phrased around a position-ruled-out sense is refused", () => {
    const r = normalizeConsult({ character: "RIVEN", situation: WATCHING }, remoteCast, "open");
    assert.ok(!r.ok);
    assert.match(r.why, /not physically there/);
    assert.match(r.why, /the phone line/);
  });

  it("a fan-out's shared room text cannot stand in for a remote reactor's projection", () => {
    const r = normalizeReactionConsult(
      { reactors: [{ name: "RIVEN" }], situation: ROOM }, remoteCast);
    assert.ok(!r.ok, "the shared text is written from inside the room — it cannot be theirs");
    assert.match(r.why, /RIVEN/);
    assert.match(r.why, /the phone line/);
    assert.match(r.why, /their own "situation"/);
  });

  it("the refusal names the connection, never hidden world content", () => {
    const r = normalizeReactionConsult(
      { reactors: [{ name: "RIVEN" }], situation: ROOM }, remoteCast);
    assert.ok(!r.ok);
    assert.doesNotMatch(r.why, /alarm/i);
  });
});

describe("3. remote communication exposes only what the channel carries", () => {
  it("a remote reactor with an explicit channel-compatible override is asked", () => {
    const r = normalizeReactionConsult(
      { reactors: [{ name: "RIVEN", situation: HEARD }], situation: ROOM }, remoteCast);
    assert.ok(r.ok, `an explicit projection must pass: ${!r.ok ? r.why : ""}`);
    assert.equal(r.reqs[0].situation, HEARD, "the reactor keeps its own projection, not the room's");
  });

  it("hearing over the phone line passes; watching over it does not", () => {
    assert.ok(normalizeConsult({ character: "RIVEN", situation: PHONE_HEARING }, remoteCast, "open").ok);
    assert.ok(!normalizeConsult({ character: "RIVEN", situation: WATCHING }, remoteCast, "open").ok);
  });
});

describe("4. existing character knowledge remains available where legitimately established", () => {
  it("presence does not erase the character's own knowledge or capabilities", () => {
    const s = P.characterSystem({
      persona: "A night porter.", place: "The lobby.",
      skills: [{ name: "keys", meaning: "carrying every key" }],
      presence: { mode: "remote", via: "the phone line" },
      knows: "The lock has stuck every damp night for a month.", goal: "Keep the door shut.",
    });
    assert.match(s, /The lock has stuck every damp night/, "knows survives presence");
    assert.match(s, /keys/, "capabilities survive presence");
    assert.match(s, /not physically there.*phone line/, "and the position is still stated");
  });

  it("the clarifier still receives the asker's knows alongside the ledger boundary", () => {
    const s = P.clarifyRequest("MERRITT", "Is the door locked?", "You sit by the door.",
      "", "The lock has been sticking for a month.",
      { held: ["the panel going into alarm"], established: [] });
    assert.match(s, /WHAT MERRITT KNOWS COMING IN\] The lock has been sticking/,
      "knows is not erased by the boundary block");
    assert.match(s, /WHAT HAS NOT HAPPENED/, "and the boundary rides along");
  });

  it("the gates take no knowledge parameter — there is nothing in them that could erase it", () => {
    assert.equal(normalizeReactionConsult.length, 2, "raw + cast only");
  });
});

describe("5. a hidden world event does not automatically become character knowledge", () => {
  it("before the trigger the loop holds, fires nothing, and implants nothing", () => {
    const b = beat({ at: 0.5 });
    const turn = timelineTurn([b], 1, 0, 100, new Set());
    assert.equal(turn.fired, null);
    assert.equal(turn.hold, "the panel going into alarm");
    assert.deepEqual(turn.memories, []);
  });

  it("outstanding holds reach the clarifier labelled not-yet-true, never as fact", () => {
    const s = P.clarifyRequest("RIVEN", "What was that sound?", "A dull thud carries down the corridor.",
      "", "", { held: ["the panel going into alarm"], established: [] });
    assert.match(s, /WHAT HAS NOT HAPPENED/);
    assert.match(s, /the panel going into alarm/, "verbatim projection, not paraphrase");
    assert.match(s, /never confirm, deny, preview, or settle/);
    assert.ok(!/ALREADY TRUE/.test(s), "nothing unfired is presented as settled");
  });

  it("without ledger state the request is byte-identical to before the boundary existed", () => {
    const s = P.clarifyRequest("RIVEN", "Is the door locked?", "You stand by the door.");
    assert.doesNotMatch(s, /WHAT HAS NOT HAPPENED/);
    assert.doesNotMatch(s, /ALREADY TRUE/);
  });
});

describe("6. the mechanism generates no inference for the character", () => {
  const INFERENCE_WORDS = /believe|suspect|intend|intention|motivat|conclud|realize you|you should feel|you want/i;

  it("refusal reasons name the position and the remedy, never a conclusion", () => {
    const r = normalizeReactionConsult(
      { reactors: [{ name: "RIVEN" }], situation: ROOM }, remoteCast);
    assert.ok(!r.ok);
    assert.doesNotMatch(r.why, INFERENCE_WORDS);
  });

  it("the boundary block echoes ledger strings exactly and concludes nothing", () => {
    const s = P.worldBounds({ held: ["the panel going into alarm"], established: ["the fault alarm sounds"] });
    assert.ok(s.includes("- the panel going into alarm"));
    assert.ok(s.includes("- the fault alarm sounds"));
    assert.doesNotMatch(s, INFERENCE_WORDS);
  });

  it("a repair operation carries causes, never character-directed content", () => {
    const json = JSON.stringify(adjudicateBeat(beat(),
      { fired: true, landed: false, possible: true, questionLive: true, ended: false }));
    assert.doesNotMatch(json, INFERENCE_WORDS);
    assert.ok(!json.includes("fault alarm sounds"));
  });

  it("an escalate repair carries causes, never inference words or beat prose", () => {
    const repair = adjudicateBeat(beat(),
      { fired: true, landed: false, possible: true, questionLive: true, ended: true });
    assert.deepEqual(repair, { op: "escalate", cause: "unlanded" });
    const json = JSON.stringify(repair);
    assert.doesNotMatch(json, INFERENCE_WORDS);
    assert.ok(!json.includes("fault alarm sounds"));
  });
});

describe("7. an unexpected character choice remains valid", () => {
  it("a surprising line-and-deed answer passes the only shape floor left", () => {
    // No output shape is dictated any more: departing from the situation's apparent fork is valid.
    assert.equal(nonPovThoughtOnly(
      { speech: "No.", action: "She turns and walks out of the archive." }, true), null);
  });

  it("the boundary gates read standing only — no answer content could change their verdict", () => {
    // The fan-out door takes reactors + situation + cast. There is no parameter for what the
    // character will say, so an inconvenient-but-valid answer cannot make a permitted ask refused
    // nor a refused ask permitted: the verdict is fixed before anyone answers.
    const allowed = normalizeReactionConsult(
      { reactors: [{ name: "RIVEN", situation: HEARD }], situation: ROOM }, remoteCast);
    const refused = normalizeReactionConsult(
      { reactors: [{ name: "RIVEN" }], situation: ROOM }, remoteCast);
    assert.ok(allowed.ok && !refused.ok);
  });

  it("a settled-by-surprise question retires its beats instead of reviving them", () => {
    assert.deepEqual(adjudicateBeat(beat(),
      { fired: true, landed: false, possible: true, questionLive: false, ended: true }),
      { op: "none", cause: "spent" });
    assert.deepEqual(adjudicateBeat(beat(),
      { fired: false, landed: null, possible: true, questionLive: false, ended: true }),
      { op: "void", cause: "spent" });
  });
});

describe("8. timeline repair reacts to that choice independently", () => {
  it("an evacuation before the alarm voids the beat on world standing alone", () => {
    const alarm = beat({ fired: "the fault alarm starts in the west wing" });
    assert.deepEqual(adjudicateBeat(alarm,
      { fired: false, landed: null, possible: false, questionLive: true, ended: true }),
      { op: "void", cause: "preempted" });
  });

  it("a sealed door reroutes the fired beat without touching any character", () => {
    const thing = beat({ fired: "the thing in the dark reaches the door" });
    assert.deepEqual(adjudicateBeat(thing,
      { fired: true, landed: true, possible: false, questionLive: true, ended: true }),
      { op: "revise", cause: "contradicted" });
  });

  it("the repair signature admits no character data", () => {
    assert.equal(adjudicateBeat.length, 2, "beat and standing — nowhere to put who chose what");
  });
});
