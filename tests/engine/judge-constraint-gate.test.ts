/**
 * The constraint gate: a high-confidence mechanical reading of an answer against the scene's
 * own constraint is kept as a beat, not retried — re-asking an unchanged situation buys the
 * same answer twice. The refusal travels on the result for the caller to fold in as content,
 * and the kept answer is still judged like any other. Deterministic — the transport is faked
 * and every call is counted.
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

const CONSTRAINT = [{ name: "hands", meaning: "bound to the chair, cannot reach or handle anything" }];

const VIOLATING = { thought: "The folder is right there.", speech: "", action: "I reach for the folder." };
const CLEAN = { thought: "Nothing to be done.", speech: "All right.", action: "" };

async function gated(opts: { consults: Record<string, unknown>[]; retries: number;
                       judge?: (call: { n: number }) => Record<string, unknown> }) {
  const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
  const def = sc.characters.find(c => c.name === "RIVEN")!;
  const events: Record<string, any>[] = [];
  const retryCounts = new Map<string, number>();
  const { fetchMock, count } = siteFetch({
    "character.consult": (call) => opts.consults[call.n],
    "judge.answer": opts.judge ?? { verdict: "accept" },
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
      req: { character: def.name, situation: "The folder sits on the table across the room.", question: "", wants: "" },
      cast: [{ name: def.name, cannot: [] }],
      constraint: CONSTRAINT,
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
    return { result, events, count, agent, retryCounts };
  } finally {
    globalThis.fetch = origFetch;
    ENGINE.stream = origStream;
    NET.retries = origRetries;
    armRun();
    resetLive();
  }
}

describe("the constraint gate", () => {
  it("keeps a violating answer with the refusal marked — exactly one consult, still judged", async () => {
    const { result, events, count, agent, retryCounts } =
      await gated({ consults: [VIOLATING], retries: 2 });

    assert.equal(count("character.consult"), 1, "no retry: a fresh fork on an unchanged ask buys the same answer");

    const refused = events.filter(e => e.t === "constraint_refused");
    assert.equal(refused.length, 1);
    assert.equal(refused[0].character, "RIVEN");
    assert.equal(refused[0].constraint, "hands");
    assert.equal(refused[0].match, "reach");
    assert.equal(refused[0].attempt, 1);

    assert.equal(count("judge.answer"), 1, "the kept answer is judged like any other");

    assert.ok(result.constraintRefused);
    assert.equal(result.constraintRefused.constraint, "hands");
    assert.match(result.constraintRefused.meaning, /cannot reach/);
    assert.equal(result.constraintRefused.action, VIOLATING.action);
    assert.equal(result.reply?.action, VIOLATING.action);
    assert.equal(result.usedAttempt, 1);

    assert.equal(retryCounts.get("riven") ?? 0, 0, "a constraint hit spends no retry budget");
    assert.equal(agent.history.length, 0,
      "consult() never touches agent.history — the caller folds the kept answer in");
  });

  it("leaves a clean answer unmarked", async () => {
    const { result, events, count } =
      await gated({ consults: [CLEAN], retries: 2 });

    assert.equal(events.filter(e => e.t === "constraint_refused").length, 0);
    assert.equal(result.constraintRefused, undefined);
    assert.equal(count("character.consult"), 1);
    assert.equal(count("judge.answer"), 1);
    assert.equal(result.reply?.speech, "All right.");
  });

  it("clears a hit when a judge retry lands a clean answer — the legal act survives", async () => {
    const LEGAL = { thought: "Only my head moves.", speech: "",
                    action: "I turn my head toward the door." };
    const { result, events, count } = await gated({
      consults: [VIOLATING, LEGAL],
      retries: 2,
      judge: (call) => call.n === 0
        ? { verdict: "retry",
            note: "the reach breaks the bind",
            revised: {
              situation: "The folder now lies beside the lamp on the far table, humming faintly with each tremor.",
              question: "What do you make of the sound?",
            } }
        : { verdict: "accept" },
    });

    assert.equal(count("character.consult"), 2);
    assert.equal(events.filter(e => e.t === "constraint_refused").length, 1,
      "attempt 1 was refused on the record");
    assert.equal(result.constraintRefused, undefined,
      "the marker describes the returned answer, not an earlier attempt");
    assert.equal(result.reply?.action, LEGAL.action);
    assert.equal(result.usedAttempt, 2);
  });
});

describe("the refused act folded as a beat", () => {
  it("marks the act attempted in the writer's payload, the ledger, and the character's memory", async () => {
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
    const sd = { ...sc.scenes[0], constraint: {
      RIVEN: ["hands :: bound to the chair, cannot reach or handle anything"] } };
    const events: RunEvent[] = [];
    const log = (e: RunEvent) => events.push(e);
    const agents = new Map(sc.characters.map(def =>
      [def.name.toLowerCase(), newCharacterAgent(def, sc.scenes[0].place, sc.thinking.character)]));

    const { fetchMock, messagesOf } = siteFetch({
      "judge.answer": { verdict: "accept" },
      "judge.narration": { ok: true },
      "judge.done": { ok: true },
      "writer.draft": (call) => call.n === 0 ? {
        prose: "Riven eyes the folder across the room.",
        consult: {
          character: "RIVEN",
          situation: "The folder sits on the table across the room, close enough to see plainly in the lamplight.",
          question: "",
          wants: "",
        },
        scene_done: false,
      } : {
        prose: "Riven strains against the chair, reaching, and the ropes hold.",
        consult: null,
        scene_done: true,
      },
      "character.consult": VIOLATING,
    });

    const origFetch = globalThis.fetch;
    const origStream = ENGINE.stream;
    const origRetries = NET.retries;
    ENGINE.stream = false;
    NET.retries = 0;
    globalThis.fetch = fetchMock;
    armRun();

    try {
      const r = await writeScene(sceneRun(sc, { scene: sd, agents, log }));
      assert.equal(r.done, true);

      const refused = events.filter(e => e.t === "constraint_refused") as any[];
      assert.equal(refused.length, 1);

      const secondDraft = messagesOf("writer.draft", 1).join("\n");
      assert.match(secondDraft, /tried, and failed/);
      assert.match(secondDraft, /never the deed as done/);

      const lintPayload = messagesOf("judge.narration", 1).join("\n");
      assert.match(lintPayload, /tried but failed: I reach for the folder\./);

      const memory = agents.get("riven")!.history.map(m => String((m as any).content ?? "")).join("\n");
      assert.match(memory, /IT DID NOT LAND/);
      assert.match(memory, /I reach for the folder\./);
    } finally {
      globalThis.fetch = origFetch;
      ENGINE.stream = origStream;
      NET.retries = origRetries;
      armRun();
      resetLive();
    }
  });
});
