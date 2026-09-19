/**
 * The target channel: a character's answer may name the one thing its act is aimed at. The
 * name resolves against the live stage before anything folds in — the stage's own spelling
 * is what the writer is handed — and the engine refuses exactly one thing: a remote character
 * naming a staged entity, because a channel carries words, never hands. Everything else
 * permits. Deterministic — the transport is faked and every call is counted; the pure half
 * (resolveTarget) is covered in stage.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadStory } from "../../engine/story-format.ts";
import { newCharacterAgent, writeScene, type RunEvent } from "../../engine/scene-loop.ts";
import { NET } from "../../engine/llm-client.ts";
import { ENGINE } from "../../engine/engine-state.ts";
import { WARN } from "../../engine/warnings.ts";
import { armRun, resetLive } from "../../live.ts";
import { quiet, siteFetch, sceneRun } from "../helpers.ts";

const REACHING = { thought: "The door is right there.", speech: "",
                   action: "I set my palm flat against the steel door.", target: "steel door" };

async function runScene(opts: {
  staging?: string[];
  presence?: Record<string, string>;
  consults: Record<string, unknown>[];
  judge?: (call: { n: number }) => Record<string, unknown>;
}) {
  const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
  const sd = { ...sc.scenes[0],
    ...(opts.staging !== undefined ? { staging: opts.staging } : {}),
    ...(opts.presence ? { presence: opts.presence } : {}) };
  const events: RunEvent[] = [];
  const agents = new Map(sc.characters.map(def =>
    [def.name.toLowerCase(), newCharacterAgent(def, sc.scenes[0].place, sc.thinking.character)]));

  const { fetchMock, count, messagesOf } = siteFetch({
    "judge.answer": opts.judge ?? { verdict: "accept" },
    "judge.narration": { ok: true },
    "judge.done": { ok: true },
    "writer.draft": (call) => call.n === 0 ? {
      prose: "Riven stands close to the steel door, the parcel shifting in the satchel.",
      consult: { character: "RIVEN",
                 situation: "The corridor is empty but for the porter on his crate, and the door will not give.",
                 question: "", wants: "" },
      scene_done: false,
    } : {
      prose: "The lock does not turn. Somewhere above, the compressor shuts off.",
      consult: null,
      scene_done: true,
    },
    "character.consult": (call) => opts.consults[call.n],
  });

  const origFetch = globalThis.fetch;
  const origStream = ENGINE.stream;
  const origRetries = NET.retries;
  ENGINE.stream = false;
  NET.retries = 0;
  globalThis.fetch = fetchMock;
  armRun();

  try {
    const r = await writeScene(sceneRun(sc, { scene: sd, agents, log: (e) => events.push(e) }));
    return { r, events, count, messagesOf, agents };
  } finally {
    globalThis.fetch = origFetch;
    ENGINE.stream = origStream;
    NET.retries = origRetries;
    armRun();
    resetLive();
  }
}

describe("the one refusal: a remote character naming a staged entity", () => {
  it("is refused as a beat — the answer kept, the character and writer told, no retry", async () => {
    const { r, events, count, messagesOf, agents } = await runScene({
      presence: { RIVEN: "remote :: the phone line" },
      consults: [REACHING],
    });
    assert.equal(r.done, true);
    assert.equal(count("character.consult"), 1,
      "a refusal is a beat, not an error — re-asking buys the same answer twice");

    const refused = events.filter(e => e.t === "target_refused") as any[];
    assert.equal(refused.length, 1);
    assert.equal(refused[0].character, "RIVEN");
    assert.equal(refused[0].target, "steel door");
    assert.equal(refused[0].entity, "steel door", "the record carries the stage's own spelling");

    const accept = events.find(e => e.t === "accept") as any;
    assert.ok(accept, "the answer is kept");
    assert.equal(accept.action, REACHING.action);

    const secondDraft = messagesOf("writer.draft", 1).join("\n");
    assert.match(secondDraft, /reached for, and failed/,
      "the writer is handed the reach, marked as failed where it sits");
    assert.match(secondDraft, /reached for "steel door" from afar and the distance held/);
    assert.match(secondDraft, /never the touch as made/);

    const memory = agents.get("riven")!.history.map(m => String((m as any).content ?? "")).join("\n");
    assert.match(memory, /IT DID NOT LAND/);
    assert.match(memory, /words, never hands/);
  });

  it("an unstaged target from the same channel permits", async () => {
    const { events, messagesOf } = await runScene({
      presence: { RIVEN: "remote :: the phone line" },
      consults: [{ ...REACHING, target: "the window" }],
    });
    assert.equal(events.filter(e => e.t === "target_refused").length, 0);
    const accept = events.find(e => e.t === "accept") as any;
    assert.equal(accept.target, "the window");
    const secondDraft = messagesOf("writer.draft", 1).join("\n");
    assert.match(secondDraft, /target: the window/);
    assert.doesNotMatch(secondDraft, /reached for, and failed/);
    assert.doesNotMatch(secondDraft, /never the touch as made/);
  });
});

describe("a present character naming a staged entity", () => {
  it("permits, and the writer receives the stage's spelling rather than the character's", async () => {
    const { events, messagesOf } = await runScene({
      consults: [{ ...REACHING, target: "Steel Door" }],
    });
    assert.equal(events.filter(e => e.t === "target_refused").length, 0);
    const accept = events.find(e => e.t === "accept") as any;
    assert.equal(accept.target, "Steel Door", "the record keeps the character's own words");

    const secondDraft = messagesOf("writer.draft", 1).join("\n");
    assert.match(secondDraft, /target: steel door/,
      "one thing must read as one name across turns however each character spells it");
    assert.doesNotMatch(secondDraft, /target: Steel Door/);
    assert.doesNotMatch(secondDraft, /reached for, and failed/);
  });
});

describe("a story with no staging", () => {
  it("every target permits, nothing warns, nothing is added", async () => {
    const warns: string[] = [];
    const orig = WARN.sink;
    WARN.sink = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
    let out: Awaited<ReturnType<typeof runScene>>;
    try {
      out = await runScene({
        staging: [],
        consults: [{ ...REACHING, target: "the far wall" }],
      });
    } finally { WARN.sink = orig; }
    const { events, messagesOf } = out;
    assert.deepEqual(warns, []);
    assert.equal(events.filter(e => e.t === "target_refused").length, 0);
    assert.equal(events.filter(e => e.t === "stage_added").length, 0,
      "naming a thing is not placing it");
    assert.equal(events.filter(e => e.t === "stage_moved").length, 0);
    const secondDraft = messagesOf("writer.draft", 1).join("\n");
    assert.match(secondDraft, /target: the far wall/);
  });
});

describe("the refusal marker is per answer, not per ask", () => {
  it("a target refused on attempt 1 does not ride out on attempt 2's clean answer", async () => {
    const { events, count, messagesOf, agents } = await runScene({
      presence: { RIVEN: "remote :: the phone line" },
      consults: [
        REACHING,
        { thought: "Still there. Still shut.", speech: "",
          action: "I keep my hand against the door and count under my breath.", target: "" },
      ],
      // The revision must carry a changed situation AND a question: reviseConsult refuses
      // an unchanged situation and an empty question in directed mode, and a refused
      // revision keeps attempt 1's answer — the test would prove nothing.
      judge: (call) => call.n === 0
        ? { verdict: "retry",
            note: "the beat does not move the scene",
            revised: {
              situation: "The line crackles; the porter's breathing has changed on the far end.",
              question: "What do you make of the sound?",
            } }
        : { verdict: "accept" },
    });

    assert.equal(count("character.consult"), 2, "the judge's retry ran, not the refusal's");
    assert.equal(events.filter(e => e.t === "target_refused").length, 0,
      "attempt 1 was discarded by the retry — its refusal never folded anywhere");
    const accept = events.find(e => e.t === "accept") as any;
    assert.equal(accept.attempt, 2);
    assert.equal(accept.target, "");

    const secondDraft = messagesOf("writer.draft", 1).join("\n");
    assert.doesNotMatch(secondDraft, /never the touch as made/,
      "attempt 2's clean answer carries no refusal");
    assert.doesNotMatch(secondDraft, /reached for, and failed/);

    const memory = agents.get("riven")!.history.map(m => String((m as any).content ?? "")).join("\n");
    assert.doesNotMatch(memory, /IT DID NOT LAND/,
      "the persistent agent's memory is attempt 2's fold only");
  });
});
