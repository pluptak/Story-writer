/**
 * Situation-lint tests — the input-side mirror of quote-lint: a situation that recaps speech
 * the ask's own heard block already carries is refused, through the same bad_consult door.
 * Deterministic: no model involved.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { lintReportedSpeech } from "../../engine/lint/situation-lint.ts";
import {
  normalizeConsult, reviseConsult, type ConsultRequest,
} from "../../engine/consult.ts";
import * as P from "../../prompts.ts";

import { loadStory } from "../../engine/story-format.ts";
import { newCharacterAgent, writeScene, type RunEvent } from "../../engine/scene-loop.ts";
import { ENGINE } from "../../engine/engine-state.ts";
import { NET } from "../../engine/llm-client.ts";
import { armRun, resetLive } from "../../live.ts";
import { quiet, sceneRun, siteFetch } from "../helpers.ts";

const CAST = ["Rowan", "Mara"];
const CAST_PRONOUNS = [
  { name: "ROWAN", pronouns: { subject: "he", object: "him", possessive: "his", reflexive: "himself" } },
  { name: "MARA", pronouns: { subject: "she", object: "her", possessive: "her", reflexive: "herself" } },
];
const HEARD = { lines: [["Mara", "If you call it magic, it is your miracle."]] as [string, string][] };
const EMPTY_HEARD = { lines: [] as [string, string][] };

// The calibration set, VERBATIM from the-healer-s-cell 2026-09-18T06-24-52-772Z: the six asks
// whose situation recapped speech its own heard block already carried, and the one that carried
// circumstance only. Written out as the run produced them rather than reworded to the frame
// list — rewording them is what let a version that refused two of these seven pass its tests.
const RECAPS: [string, string, string][] = [
  ["asking if", "MARA",
    "You are sitting in chains in a dungeon cell. Rowan is standing just outside the bars, "
    + "leaning in close and asking if the shadows in your garden moved by your will."],
  ["pressing you to", "MARA",
    "You are sitting in chains. Rowan has moved very close to the bars, gripping them tightly. "
    + "He is pressing you to explain the fever that killed the Miller's bull, looking for "
    + "something supernatural."],
  ["asked about", "MARA",
    "You are in chains. Rowan has just asked about your new moon herbs when a frantic pounding "
    + "sounds on the dungeon door."],
  ["answered that", "ROWAN",
    "You are standing outside Mara's cell. You have asked her if she controlled the shadows in "
    + "her garden; she has just answered that they merely follow the sun's path and are part of "
    + "nature's rest."],
  ["countered by", "ROWAN",
    "You are leaning into Mara's cell, gripping the bars. You have asked about the Miller's bull; "
    + "she has countered by describing fever as a natural imbalance that requires a 'steady hand' "
    + "to balance, like gardening."],
  ["offered", "ROWAN",
    "You are standing at the bars of Mara's cell. She has just offered a compromise: she will let "
    + "you claim her 'miracle' as divine grace to satisfy your political need for a conviction, "
    + "provided you frame it as medicine rather than witchcraft."],
];
// The seventh ask, which must pass: circumstance only, although a heard block rides with it.
const CLEAN =
  "You are in the cell with Mara. A frantic pounding on the heavy oak door has just occurred, "
  + "and you have turned your head toward it.";

describe("lintReportedSpeech — the calibration set", () => {
  for (const [frame, asked, situation] of RECAPS) {
    it(`refuses ${asked}'s live ask built on "${frame}"`, () => {
      const hit = lintReportedSpeech(situation, asked, CAST_PRONOUNS, HEARD);
      assert.ok(hit, frame);
      assert.match(hit!.match, new RegExp(frame.replace(/ /g, "\\s+"), "i"));
    });
  }

  it("passes the pure-circumstance ask with the same heard block", () => {
    assert.equal(lintReportedSpeech(CLEAN, "ROWAN", CAST_PRONOUNS, HEARD), null);
  });

  it("passes every recap when the heard block is empty — the opening consult stays free", () => {
    for (const [, asked, situation] of RECAPS)
      assert.equal(lintReportedSpeech(situation, asked, CAST_PRONOUNS, EMPTY_HEARD), null, situation);
    assert.equal(lintReportedSpeech(RECAPS[0][2], RECAPS[0][1], CAST_PRONOUNS), null);
  });

  // Three of the six pronominalise the speaker the sentence before named. A story that declares
  // no pronouns cannot resolve those, and gets the name-only behaviour rather than a guess —
  // the-healer-s-cell itself declares none, so this is what that run would still miss today.
  it("resolves a pronoun subject only where the cast declares one", () => {
    // These three are the ones whose only reporting subject is a pronoun; the other three name
    // the speaker or use "you", so they refuse with or without a declared pronoun set.
    const PRONOUN_ONLY = ["pressing you to", "answered that", "offered"];
    const pronominal = RECAPS.filter(([frame]) => PRONOUN_ONLY.includes(frame));
    assert.equal(pronominal.length, 3);
    for (const [, asked, situation] of pronominal) {
      assert.ok(lintReportedSpeech(situation, asked, CAST_PRONOUNS, HEARD), situation);
      assert.equal(lintReportedSpeech(situation, asked, CAST, HEARD), null, situation);
    }
  });

  it("leaves a pronoun two cast members share, and the asked character's own", () => {
    const shared = [
      { name: "ROWAN", pronouns: { subject: "they", object: "them", possessive: "their", reflexive: "themself" } },
      { name: "MARA", pronouns: { subject: "they", object: "them", possessive: "their", reflexive: "themself" } },
    ];
    const sit = "You are sitting in chains in the dark. They have just answered that the shadows move alone.";
    assert.equal(lintReportedSpeech(sit, "MARA", shared, HEARD), null);
    // The asked character's own pronoun is theirs to report: the heard block never carries it back.
    assert.equal(lintReportedSpeech(
      "You are sitting in chains in the dark. She has just answered that the shadows move alone.",
      "MARA", CAST_PRONOUNS, HEARD), null);
  });
});

describe("lintReportedSpeech — the line it holds", () => {
  it("lets the bare fact that someone spoke through", () => {
    for (const situation of [
      "You stand by the cold hearth in the dark. Mara spoke at last, her voice low.",
      "You wait in the dim light. You hear Mara's voice from the far side of the door.",
      "You stand with the lamp low. Mara has fallen silent beside the pallet.",
    ]) assert.equal(lintReportedSpeech(situation, "Rowan", CAST, HEARD), null, situation);
  });

  it("does not fire on its own subject — reporting your own speech is not double-delivery", () => {
    assert.equal(lintReportedSpeech(RECAPS[3][2], "MARA", CAST_PRONOUNS, HEARD), null);
  });

  it("fires when the addressee themself is the reporting subject", () => {
    const hit = lintReportedSpeech(
      "You stand by the cold hearth with your hands empty. You answered that you would wait until dawn.",
      "Rowan", CAST, HEARD);
    assert.ok(hit);
  });

  it("skips when another name stands between subject and verb — the governor is undecidable", () => {
    assert.equal(lintReportedSpeech(
      "You stand in the dark room beside the cold hearth. Mara told Rowan, then answered that she would wait.",
      "Rowan", CAST, HEARD), null);
  });

  it("does not reach across a sentence break", () => {
    assert.equal(lintReportedSpeech(
      "You saw Mara at dawn by the cold hearth. The bell answered that she would wait.",
      "Rowan", CAST, HEARD), null);
  });

  it("needs a cast subject — a letter reporting nothing heard is circumstance", () => {
    assert.equal(lintReportedSpeech(
      "You stand by the cold hearth reading in the dark. The letter answered that she would wait.",
      "Rowan", CAST, HEARD), null);
  });
});

describe("normalizeConsult — the heard half of the same door", () => {
  // The cast carries pronouns here, as the scene loop's mechanicalCast does, so the pronoun
  // subject of the live ask below resolves through CannotCast and not only inside the leaf.
  const cast = CAST_PRONOUNS.map(c => ({ ...c, cannot: [] as string[] }));
  const [, ASKED, RECAP] = RECAPS[3];

  it("refuses a recap when the ask carries the heard block", () => {
    const r = normalizeConsult({ character: ASKED, situation: RECAP }, cast, "open", { heard: HEARD });
    assert.ok(!r.ok);
    assert.match(r.why, /WHAT YOU HEARD/);
    assert.match(r.why, /circumstance only/i);
  });

  it("passes the same situation with no heard block — nothing to double-deliver", () => {
    assert.ok(normalizeConsult({ character: ASKED, situation: RECAP }, cast, "open").ok);
    assert.ok(normalizeConsult(
      { character: ASKED, situation: RECAP }, cast, "open", { heard: EMPTY_HEARD }).ok);
  });

  it("passes the clean circumstance ask with the heard block", () => {
    assert.ok(normalizeConsult({ character: ASKED, situation: CLEAN }, cast, "open", { heard: HEARD }).ok);
  });

  it("a judged revision that recaps heard speech is refused too — the retry keeps its block", () => {
    const prev: ConsultRequest =
      { character: ASKED, situation: CLEAN, question: "", wants: "", heard: HEARD };
    const r = reviseConsult(prev,
      { situation: RECAP, question: "How do you answer her demand, knowing the vial is missing?" }, cast);
    assert.ok(!r.ok);
    assert.match(r.why, /WHAT YOU HEARD/);
  });

  it("the refusal wording never describes the channel as the paraphrase fix", () => {
    const why = P.badConsult.reportedSpeech("ROWAN", "Mara answered that");
    assert.match(why, /heard block's job/);
    assert.match(why, /Do not paraphrase or recap speech/);
    assert.doesNotMatch(why, /default|promotion|verbatim delivery/i);
  });
});

describe("scene-loop — a recap consult is refused like a restricted-sense one", () => {
  const circumstance =
    "You are beside the locked door in the narrow corridor; the delivery deadline is approaching and the package remains outside.";
  const recap =
    "You stand by the cold door with the lamp burning low. RIVEN answered that she would carry the spare key herself at dawn.";
  const close = { prose: "The corridor falls quiet as dawn reaches the building.", scene_done: true };

  async function runRecap(drafts: Record<string, unknown>[]) {
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
    const agents = new Map(sc.characters.map(def =>
      [def.name.toLowerCase(), newCharacterAgent(def, sc.scenes[0].place, sc.thinking.character)]));
    const events: RunEvent[] = [];
    const fake = siteFetch({
      "writer.draft": ({ n }) => drafts[n] ?? close,
      "judge.narration": { ok: true },
      "judge.done": { ok: true },
      "judge.answer": { verdict: "accept" },
      "judge.batch": { verdicts: [] },
      "character.consult": ({ n }) => ({ thought: "Private thought.", speech: `Line ${n}.`, action: "" }),
    });
    const original = { stream: ENGINE.stream, heardChannel: ENGINE.heardChannel, consultSince: ENGINE.consultSince };
    const fetch = globalThis.fetch, retries = NET.retries;
    Object.assign(ENGINE, { stream: false, heardChannel: true, consultSince: true });
    globalThis.fetch = fake.fetchMock;
    NET.retries = 0;
    armRun();
    try {
      await writeScene(sceneRun(sc, { scene: sc.scenes[0], agents, maxSteps: 20, log: e => events.push(e) }));
    } finally {
      Object.assign(ENGINE, original);
      globalThis.fetch = fetch;
      NET.retries = retries;
      armRun();
      resetLive();
    }
    return { fake, events };
  }

  it("refuses a single recap consult at the heard attachment point", async () => {
    const { fake, events } = await runRecap([
      { prose: "", consult: { character: "RIVEN", situation: circumstance } },
      { prose: "", consult: { character: "MERRITT", situation: recap } },
      close,
    ]);
    // The opening consult went out with an empty block; only the recap is refused.
    assert.equal(fake.count("character.consult"), 1);
    const bad = events.filter(e => e.t === "bad_consult");
    assert.equal(bad.length, 1);
    assert.match(bad[0].why, /WHAT YOU HEARD/);
  });

  it("refuses a fan-out whose shared situation recaps heard speech", async () => {
    const { fake, events } = await runRecap([
      { prose: "", consult: { character: "RIVEN", situation: circumstance } },
      { prose: "", consult: { situation: recap, reactors: [{ name: "MERRITT" }] } },
      close,
    ]);
    assert.equal(fake.count("character.consult"), 1);
    assert.ok(events.some(e => e.t === "bad_consult" && /WHAT YOU HEARD/.test(e.why)));
  });
});
