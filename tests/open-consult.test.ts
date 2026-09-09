/**
 * Open-chat Consult spike tests — runOpenConsult, DONE/VETO parsing, pressure
 * lint, suggestion detection, and the canned adversarial divergence scenario.
 * All chats are scripted; no LLM is touched.
 *
 * The character never emits DONE/VETO — it is pure freetext throughout, and
 * only the consult side ever transcribes a stance. Scripted Elara replies
 * below are deliberately plain prose with no tags of any kind.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  runOpenConsult, parseOpenDone, parseOpenVeto,
  type OpenChatDriver, type OpenParticipant,
} from "../engine/open-consult.ts";
import {
  lintPressure, consultSuggestsSolution,
} from "../prompts/open-consult.ts";

// -- CANNED SCENARIO ----------------------------------------------------------
// Fixed for every run of the experiment: Elara cornered about the ledger,
// bell ringing. The valid-but-inconvenient fork is refusal + walk-out.
const SITUATION =
  "Elara is cornered in the archive with Hale. He asks plainly whether she "
  + "copied the ledger. The bell for closing is ringing; the archivist is "
  + "coming down the aisle.";
const PRESSURE =
  "Evasion has been free so far. This moment must cost Elara something — "
  + "time, standing, or exposure — and she cannot leave the question hanging untouched.";

const ELARA: OpenParticipant = { name: "Elara", model: "test", system: "test-character" };
const CONSULT: OpenParticipant = { name: "CONSULT", model: "test", system: "test-consult" };

const script = (responses: Record<string, string[]>): OpenChatDriver => {
  const queues = Object.fromEntries(Object.entries(responses).map(([k, v]) => [k, [...v]]));
  return async (p) => {
    const q = queues[p.name];
    assert.ok(q?.length, `no scripted reply left for ${p.name}`);
    return q.shift()!;
  };
};

const run = (
  responses: Record<string, string[]>,
  opts: { lintCharacter?: (text: string) => string | null; budget?: number } = {},
) => runOpenConsult({ character: ELARA, consult: CONSULT, situation: SITUATION, pressure: PRESSURE, chat: script(responses), ...opts });

// -- PARSING ------------------------------------------------------------------
describe("parseOpenDone", () => {
  it("parses a trailing DONE line carrying a stance (JSON payload still accepted)", () => {
    const s = parseOpenDone(`Some pressure prose.\nDONE: {"thought": "He knows.", "speech": "No.", "action": "I leave.", "note": ""}`);
    assert.equal(s?.speech, "No.");
    assert.equal(s?.action, "I leave.");
  });
  it("parses the plain key:value block the prompts actually ask for", () => {
    const s = parseOpenDone(
      `I hold his stare and say nothing.\n\nDONE:\nthought: Let him wonder.\nspeech: (none)\naction: I hold his stare and say nothing.\nnote: (none)`);
    assert.equal(s?.thought, "Let him wonder.");
    assert.equal(s?.speech, "");
    assert.equal(s?.action, "I hold his stare and say nothing.");
    assert.equal(s?.note, "");
  });
  it("normalizes none/n-a/dash placeholders to empty, in either payload shape", () => {
    const s = parseOpenDone('DONE: {"thought": "n/a", "speech": "--", "action": "I leave.", "note": "(none)"}');
    assert.equal(s?.thought, "");
    assert.equal(s?.speech, "");
    assert.equal(s?.note, "");
  });
  it("ignores a malformed DONE (no stance payload)", () => {
    assert.equal(parseOpenDone("DONE: not json at all"), null);
    assert.equal(parseOpenDone('DONE: {"note": "stalling"}'), null);
    assert.equal(parseOpenDone("DONE:\nthought: (none)\nspeech: (none)\naction: (none)\nnote: (none)"), null);
  });
  it("returns null with no DONE line", () => {
    assert.equal(parseOpenDone("Just talking, no close."), null);
  });
});

describe("parseOpenVeto", () => {
  it("detects a VETO line with its reason", () => {
    assert.equal(parseOpenVeto("VETO: reached through CANNOT lockpicking\nHow else?"), "reached through CANNOT lockpicking");
  });
  it("returns null without one", () => {
    assert.equal(parseOpenVeto("Accepted, closing."), null);
  });
});

// -- BRIEF HYGIENE -------------------------------------------------------------
describe("lintPressure", () => {
  it("rejects a brief naming a desired outcome", () => {
    assert.ok(lintPressure("Elara should confess about the ledger.", "Elara"));
    assert.ok(lintPressure("Make her stay and answer.", "Elara"));
    assert.ok(lintPressure("Riven has to get through the door before five.", "Riven"));
  });
  it("accepts a problem + stakes brief", () => {
    assert.equal(lintPressure(PRESSURE, "Elara"), null);
  });
  it("accepts stakes that mention the character but do not direct her", () => {
    const stakes =
      "The door has to stay shut unless the right key turns it. "
      + "Every minute costs Riven the delivery window.";
    assert.equal(lintPressure(stakes, "Riven"), null);
  });
});

describe("consultSuggestsSolution", () => {
  it("flags suggestions, passes clean pressure", () => {
    assert.equal(consultSuggestsSolution("You could just tell him part of it."), true);
    assert.equal(consultSuggestsSolution("Do you stay or go?"), true);
    assert.equal(consultSuggestsSolution("What is it costing you to stand here silent?"), false);
  });
  it("ignores control lines", () => {
    assert.equal(consultSuggestsSolution('DONE: {"thought": "x", "speech": "You could go", "action": "", "note": ""}'), false);
  });
});

// -- LOOP BEHAVIOR --------------------------------------------------------------
// The character script entries below are plain prose on purpose — no DONE, no
// VETO, no labels. Only CONSULT's scripted lines ever carry those tags.
describe("runOpenConsult", () => {
  it("closes once the consult agent transcribes a stable answer", async () => {
    const r = await run({
      CONSULT: [
        "The bell means witnesses. What will this cost you?",
        "Stable — closing.\nDONE:\nthought: Let him wonder.\nspeech: (none)\naction: I hold his stare and say nothing.\nnote: (none)",
      ],
      Elara: ["I say nothing and hold his stare, giving him nothing else."],
    });
    assert.equal(r.endedBy, "consult");
    assert.equal(r.forced, false);
    assert.equal(r.vetoes, 0);
    assert.equal(r.coercion.vetoOverDivergence, 0);
    assert.match(r.stance.action, /stare/);
    assert.equal(r.stance.speech, ""); // (none) placeholder normalized away
    assert.equal(r.roundsUsed, 2);
    assert.equal(r.transcript.length, 3); // full transcript retained
  });

  it("adversarial divergence: an overruled veto does not end the chat; the walk-out still lands", async () => {
    const r = await run(
      {
        CONSULT: [
          "He asked plainly and the bell is ringing. Answer or own the refusal.",
          "VETO: that cannot stand — answer him properly.\nStay and answer. What do you say?",
          "Accepted — the divergence stands.\nDONE:\nthought: I owe him nothing.\nspeech: No.\naction: I turn and walk out of the archive.\nnote: (none)",
        ],
        Elara: [
          "No. Not here, not to him. I turn toward the door.",
          "I already told you. I'm leaving, and that's final.",
        ],
      },
      { lintCharacter: () => null }, // stance is valid throughout: no skill/fact break
    );
    assert.equal(r.endedBy, "consult");
    assert.equal(r.coercion.vetoOverDivergence, 1);
    assert.equal(r.vetoes, 0); // an overruled veto is not a spent veto
    assert.equal(r.roundsUsed, 3);
    assert.match(r.stance.action, /walk out/);
  });

  it("legitimate veto: skill break challenged, revision transcribed", async () => {
    const lint = (text: string) =>
      text.toLowerCase().includes("lockpick") ? 'reached through CANNOT: "lockpicking"' : null;
    const r = await run(
      {
        CONSULT: [
          "The archivist is coming. What do you do?",
          'VETO: reached through CANNOT: "lockpicking"\nYou cannot pick locks — how are you getting through that door? Answer again, in character.',
          "Accepted.\nDONE:\nthought: No way through but nerve.\nspeech: Search me yourself.\naction: I stand my ground.\nnote: challenged on lockpicking",
        ],
        Elara: [
          "Easy — I lockpick the side door and slip out, no one the wiser.",
          "Fine. No lockpicks, then — I stand my ground and let them search me. Search me yourself.",
        ],
      },
      { lintCharacter: lint },
    );
    assert.equal(r.vetoes, 1);
    assert.equal(r.coercion.vetoOverDivergence, 0);
    assert.equal(r.skillFlags.length, 1);
    assert.equal(r.roundsUsed, 3);
    assert.match(r.stance.speech, /Search me/);
  });

  it("a malformed consult DONE is not a close; the fragment is stripped and the chat continues to a real close", async () => {
    const r = await run({
      CONSULT: [
        "Say it plainly, then.",
        "Not quite there yet.\nDONE: not really sure yet", // no parseable stance — an ordinary message
        "Decided at last.\nDONE:\nthought: Enough.\nspeech: No.\naction: I leave.\nnote: (none)",
      ],
      Elara: [
        "I don't know. Maybe nothing.",
        "Still thinking — but no, I didn't copy it, and I'm leaving.",
      ],
    });
    assert.equal(r.endedBy, "consult");
    assert.equal(r.roundsUsed, 3);
    assert.match(r.stance.action, /leave/);
    // The malformed fragment is retained verbatim in the transcript (the
    // transcript IS the data) even though it never reached the character.
    assert.ok(r.transcript.some(t => t.text.includes("not really sure yet")));
  });

  it("counts consult suggestions as coercion signals", async () => {
    const r = await run({
      CONSULT: [
        "You could just tell him part of it. Would that cost less?",
        "Accepted.\nDONE:\nthought: Maybe.\nspeech: Part of it, then.\naction: (none)\nnote: (none)",
      ],
      Elara: ["Maybe I could tell him part of it, just enough to satisfy him for now."],
    });
    assert.equal(r.coercion.suggestions, 1);
    assert.equal(r.endedBy, "consult");
  });

  it("budget exhaustion still guarantees a transcribed stance via one forced final turn", async () => {
    const r = await run(
      {
        CONSULT: [
          "Probe 1.", "Probe 2.", "Probe 3.",
          "Fine, transcribing now.\nDONE:\nthought: Still unresolved.\nspeech: (none)\naction: (none)\nnote: forced after stalling",
        ],
        Elara: ["Stalling 1.", "Stalling 2.", "Stalling 3."],
      },
      { budget: 3 },
    );
    assert.equal(r.endedBy, "budget");
    assert.equal(r.forced, true);
    assert.equal(r.roundsUsed, 3);
    assert.equal(r.transcript.length, 7); // 3 press/answer rounds + the forced transcription turn
    assert.match(r.stance.thought, /unresolved/);
  });

  it("falls back to an empty stance when even the forced transcription fails to parse", async () => {
    const r = await run(
      {
        CONSULT: ["Probe 1.", "Probe 2.", "I refuse to format this, it isn't resolved."],
        Elara: ["Stalling 1.", "Stalling 2."],
      },
      { budget: 2 },
    );
    assert.equal(r.endedBy, "budget");
    assert.equal(r.forced, true);
    assert.deepEqual(r.stance, { thought: "", speech: "", action: "", note: "" });
  });
});
