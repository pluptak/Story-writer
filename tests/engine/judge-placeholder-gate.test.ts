/**
 * The placeholder gate: a template slot in an answer is a formatting failure, not a choice,
 * so unlike a constraint hit it retries on a fresh fork — and when the budget is spent the
 * answer is discarded into the no-answer path, never accepted into the ledger. Deterministic —
 * the transport is faked and every call is counted.
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

const SLOT = { thought: "Say it plainly.", speech: "My name is [Name].", action: "" };
const FIXED = { thought: "Say it plainly.", speech: "My name is Mara.", action: "" };

async function gated(opts: { consults: Record<string, unknown>[]; retries: number }) {
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
  ENGINE.stream = false;
  NET.retries = 0;
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
      pov: true,
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
    armRun();
    resetLive();
  }
}

describe("the placeholder gate", () => {
  it("retries a slot and keeps the clean second answer", async () => {
    const { result, events, count, retryCounts } =
      await gated({ consults: [SLOT, FIXED], retries: 2 });

    const refused = events.filter(e => e.t === "placeholder_refused");
    assert.equal(refused.length, 1);
    assert.equal(refused[0].character, "RIVEN");
    assert.equal(refused[0].field, "speech");
    assert.equal(refused[0].match, "[Name]");

    assert.equal(count("character.consult"), 2);
    assert.equal(count("judge.answer"), 1, "only the kept answer is judged");
    assert.equal(result.reply?.speech, "My name is Mara.");
    assert.equal(result.constraintRefused, undefined);
    assert.equal(retryCounts.get("riven"), 1);
  });

  it("discards into the no-answer path when the budget is spent, never accepting", async () => {
    const { result, events, count } =
      await gated({ consults: [SLOT], retries: 0 });

    assert.equal(events.filter(e => e.t === "placeholder_refused").length, 1);
    assert.equal(count("character.consult"), 1);
    assert.equal(count("judge.answer"), 0);
    assert.equal(result.reply, null);
    assert.match(result.failed, /placeholder/);
  });

  it("does not flag a long bracketed aside", async () => {
    const ASIDE = { thought: "", speech: "",
      action: "I nod toward the corner [the one by the door, where we left it]." };
    const { result, events, count } =
      await gated({ consults: [ASIDE], retries: 2 });

    assert.equal(events.filter(e => e.t === "placeholder_refused").length, 0);
    assert.equal(count("judge.answer"), 1);
    assert.equal(result.reply?.action, ASIDE.action);
  });
});

describe("a placeholder that survives the budget", () => {
  it("reaches the writer as no answer, not as an acceptance", async () => {
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
    const events: RunEvent[] = [];
    const log = (e: RunEvent) => events.push(e);
    const agents = new Map(sc.characters.map(def =>
      [def.name.toLowerCase(), newCharacterAgent(def, sc.scenes[0].place, sc.thinking.character)]));

    const { fetchMock, messagesOf } = siteFetch({
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
        prose: "Riven says nothing useful, and the ledger stays blank.",
        consult: null,
        scene_done: true,
      },
      "character.consult": SLOT,
    });

    const origFetch = globalThis.fetch;
    const origStream = ENGINE.stream;
    const origRetries = NET.retries;
    ENGINE.stream = false;
    NET.retries = 0;
    globalThis.fetch = fetchMock;
    armRun();

    try {
      const r = await writeScene(sceneRun(sc, { scene: sc.scenes[0], agents, log, retries: 0 }));
      assert.equal(r.done, true);

      assert.equal(events.filter(e => e.t === "placeholder_refused").length, 1);
      assert.equal(events.filter(e => e.t === "accept").length, 0);

      const secondDraft = messagesOf("writer.draft", 1).join("\n");
      assert.match(secondDraft, /\[NO ANSWER\] RIVEN did not answer/);
    } finally {
      globalThis.fetch = origFetch;
      ENGINE.stream = origStream;
      NET.retries = origRetries;
      armRun();
      resetLive();
    }
  });
});
