/**
 * The reach gate and the flat judge sample. The reach floor: an answer that folds in as
 * nothing (empty envelope, thought-only outside the POV) retries on a fresh fork like a
 * placeholder, and is discarded into the no-answer path when the budget is spent. The sample
 * (--judge-sample): a flat random roll may skip the judge entirely — the answer folds in as
 * accepted and the sampled-out event marks the denominator. Deterministic — the transport is
 * faked and every call is counted.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadStory } from "../../engine/story-format.ts";
import { judgeGate } from "../../engine/judge-gate.ts";
import { newCharacterAgent, writeScene, type RunEvent } from "../../engine/scene-loop.ts";
import { Agent } from "../../engine/agent.ts";
import { NET } from "../../engine/llm-client.ts";
import { ENGINE } from "../../engine/engine-state.ts";
import { armRun, resetLive } from "../../live.ts";
import { quiet, siteFetch, sceneRun } from "../helpers.ts";

const EMPTY = { thought: "", speech: "", action: "" };
const ALIVE = { thought: "Steady.", speech: "Easy.", action: "" };
const THOUGHT_ONLY = { thought: "So that is who holds the ledger.", speech: "", action: "" };

async function gated(opts: { consults: Record<string, unknown>[]; retries: number; pov?: boolean;
                             judgeSample?: number }) {
  const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
  const def = sc.characters.find(c => c.name === "RIVEN")!;
  const events: Record<string, any>[] = [];
  const retryCounts = new Map<string, number>();
  const { fetchMock, count } = siteFetch({
    "character.consult": (call) => opts.consults[call.n],
    "judge.answer": { verdict: "accept" },
  });

  const origFetch = globalThis.fetch;
  const origStream = ENGINE.stream;
  const origRetries = NET.retries;
  const origSample = ENGINE.judgeSample;
  ENGINE.stream = false;
  NET.retries = 0;
  ENGINE.judgeSample = opts.judgeSample ?? 1;
  globalThis.fetch = fetchMock;
  armRun();

  try {
    const agent = new Agent(def.name, "none", "system", 0.9);
    const result = await judgeGate({
      def,
      agent,
      req: { character: def.name, situation: "The porter asks plainly for a name to write in the night ledger.", question: "", wants: "" },
      cast: [{ name: def.name, cannot: [] }],
      constraint: [],
      retries: opts.retries,
      clarifications: 2,
      clarify: async () => "",
      pov: opts.pov ?? true,
      chapter: 1,
      retryCounts,
      newJudge: () => new Agent("JUDGE", "none", "system", 0.3),
      beginAttempt: () => {},
      dropClarifications: () => {},
      log: (e) => events.push(e as Record<string, any>),
    });
    return { result, events, count, retryCounts };
  } finally {
    globalThis.fetch = origFetch;
    ENGINE.stream = origStream;
    NET.retries = origRetries;
    ENGINE.judgeSample = origSample;
    armRun();
    resetLive();
  }
}

describe("the reach gate", () => {
  // consult() repairs an empty or unreachable answer once in-call, so a repeat that reaches the
  // gate costs TWO character.consult calls per attempt — the answer and the repair's response.
  it("retries an empty envelope and keeps the clean second answer", async () => {
    const { result, events, count, retryCounts } =
      await gated({ consults: [EMPTY, EMPTY, ALIVE], retries: 2 });

    const refused = events.filter(e => e.t === "reach_refused");
    assert.equal(refused.length, 1);
    assert.match(refused[0].why, /no thought, speech, action or note/);

    assert.equal(count("character.consult"), 3, "the repair ran once in-call, then the retry");
    assert.equal(count("judge.answer"), 1, "only the kept answer is judged");
    assert.equal(result.reply?.speech, "Easy.");
    assert.equal(retryCounts.get("riven"), 1);
  });

  it("discards a stubborn empty answer into the no-answer path, never accepting nothing", async () => {
    const { result, events, count } = await gated({ consults: [EMPTY, EMPTY], retries: 0 });

    assert.equal(events.filter(e => e.t === "reach_refused").length, 1);
    assert.equal(count("character.consult"), 2);
    assert.equal(count("judge.answer"), 0);
    assert.equal(result.reply, null);
    assert.match(result.failed, /no thought, speech, action or note/);
  });

  it("refuses a thought-only repeat from outside the point of view, and not from the POV", async () => {
    const { events, count, result } =
      await gated({ consults: [THOUGHT_ONLY, THOUGHT_ONLY], retries: 0, pov: false });
    assert.equal(events.filter(e => e.t === "reach_refused").length, 1);
    assert.match(events.filter(e => e.t === "reach_refused")[0].why, /outside the point of view/);
    assert.equal(count("judge.answer"), 0, "the budget was spent on the refusal");
    assert.equal(result.reply, null);

    const fromPov = await gated({ consults: [THOUGHT_ONLY], retries: 2, pov: true });
    assert.equal(fromPov.events.filter(e => e.t === "reach_refused").length, 0,
      "a thought alone is a complete answer from the point-of-view character");
    assert.equal(fromPov.count("judge.answer"), 1);
  });
});

describe("the flat judge sample", () => {
  it("default arm judges every answer — no sampled-out events, no behaviour change", async () => {
    const { events, count, result } = await gated({ consults: [ALIVE], retries: 2 });
    assert.equal(events.filter(e => e.t === "judge_sampled_out").length, 0);
    assert.equal(count("judge.answer"), 1);
    assert.equal(result.reply?.speech, "Easy.");
  });

  it("sample 0 skips the judge for every ask: the answer folds in as accepted, and the event marks the denominator", async () => {
    const { events, count, result } = await gated({ consults: [ALIVE], retries: 2, judgeSample: 0 });

    assert.equal(count("judge.answer"), 0, "no judge call was made");
    const sampled = events.filter(e => e.t === "judge_sampled_out");
    assert.equal(sampled.length, 1);
    assert.equal(sampled[0].character, "RIVEN");
    assert.equal(result.reply?.speech, "Easy.", "the answer is kept, not retried");
    assert.equal(events.filter(e => e.t === "judge").length, 0,
      "no verdict is invented — the skip is visible as a skip");
  });

  it("the sample runs beside the mechanical checks: a constraint hit is kept even when the judge is skipped", async () => {
    // The doorway fixture's RIVEN carries no scene constraint, so exercise the mechanism with
    // an authored one: the answer folds in as accepted, and the hit travels with the result.
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
    const def = sc.characters.find(c => c.name === "RIVEN")!;
    const events: Record<string, any>[] = [];
    const reaches = { thought: "Steady.", speech: "Easy.", action: "Reaches across the table for the pen." };
    const { fetchMock } = siteFetch({
      "character.consult": reaches,
      "judge.answer": { verdict: "accept" },
    });
    const origFetch = globalThis.fetch;
    const origStream = ENGINE.stream;
    const origRetries = NET.retries;
    const origSample = ENGINE.judgeSample;
    ENGINE.stream = false;
    NET.retries = 0;
    ENGINE.judgeSample = 0;
    globalThis.fetch = fetchMock;
    armRun();
    try {
      const agent = new Agent(def.name, "none", "system", 0.9);
      const result = await judgeGate({
        def, agent,
        req: { character: def.name, situation: "The porter asks plainly for a name to write in the night ledger.", question: "", wants: "" },
        cast: [{ name: def.name, cannot: [] }],
        constraint: [{ name: "secured chair", meaning: "she cannot stand or reach" }],
        retries: 2, clarifications: 2, clarify: async () => "", pov: true, chapter: 1,
        retryCounts: new Map(),
        newJudge: () => new Agent("JUDGE", "none", "system", 0.3),
        beginAttempt: () => {}, dropClarifications: () => {},
        log: (e) => events.push(e as Record<string, any>),
      });
      assert.equal(events.filter(e => e.t === "judge_sampled_out").length, 1);
      assert.equal(result.reply?.speech, "Easy.");
      assert.ok(result.constraintRefused, "the mechanical hit survives the skip");
      assert.equal(result.constraintRefused?.constraint, "secured chair");
      assert.match(result.constraintRefused?.action ?? "", /[Rr]eaches/);
    } finally {
      globalThis.fetch = origFetch;
      ENGINE.stream = origStream;
      NET.retries = origRetries;
      ENGINE.judgeSample = origSample;
      armRun();
      resetLive();
    }
  });
});

describe("the sample inside the scene loop", () => {
  it("a sampled-out ask folds into the page without a judge call", async () => {
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
    const events: RunEvent[] = [];
    const log = (e: RunEvent) => events.push(e);
    const agents = new Map(sc.characters.map(def =>
      [def.name.toLowerCase(), newCharacterAgent(def, sc.scenes[0].place, sc.thinking.character)]));

    const { fetchMock } = siteFetch({
      "judge.answer": { verdict: "accept" },
      "judge.narration": { ok: true },
      "judge.done": { ok: true },
      "writer.draft": (call) => call.n === 0 ? {
        prose: "Riven meets the porter's eyes across the corridor.",
        consult: {
          character: "RIVEN",
          situation: "The porter asks plainly for a name to write down in the night ledger book.",
          question: "",
          wants: "",
        },
        scene_done: false,
      } : {
        prose: "The ledger takes the name.",
        consult: null,
        scene_done: true,
      },
      "character.consult": ALIVE,
    });

    const origFetch = globalThis.fetch;
    const origStream = ENGINE.stream;
    const origRetries = NET.retries;
    const origSample = ENGINE.judgeSample;
    ENGINE.stream = false;
    NET.retries = 0;
    ENGINE.judgeSample = 0;
    globalThis.fetch = fetchMock;
    armRun();

    try {
      const r = await writeScene(sceneRun(sc, { scene: sc.scenes[0], agents, log }));
      assert.equal(r.done, true);
      assert.equal(events.filter(e => e.t === "judge_sampled_out").length, 1);
      assert.equal(events.filter(e => e.t === "accept").length, 1,
        "the answer folds in exactly as a judged accept would");
    } finally {
      globalThis.fetch = origFetch;
      ENGINE.stream = origStream;
      NET.retries = origRetries;
      ENGINE.judgeSample = origSample;
      armRun();
      resetLive();
    }
  });
});
