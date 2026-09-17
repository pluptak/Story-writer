import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadStory } from "../engine/story-format.ts";
import { newCharacterAgent, writeScene, type RunEvent } from "../engine/scene-loop.ts";
import { ENGINE } from "../engine/engine-state.ts";
import { NET } from "../engine/llm-client.ts";
import { armRun, resetLive } from "../live.ts";
import { quiet, sceneRun, siteFetch, type SiteHandler } from "./helpers.ts";

async function policyRun(routes: Record<string, SiteHandler>) {
  const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
  const events: RunEvent[] = [];
  const agents = new Map(sc.characters.map(def =>
    [def.name.toLowerCase(), newCharacterAgent(def, sc.scenes[0].place, "low")] as const));
  const fake = siteFetch({
    "judge.narration": { ok: true },
    "judge.done": { status: "resolved", evidence: "the page settles it" },
    ...routes,
  });
  const origFetch = globalThis.fetch;
  const origStream = ENGINE.stream;
  const origRetries = NET.retries;
  ENGINE.stream = false;
  NET.retries = 0;
  globalThis.fetch = fake.fetchMock;
  armRun();
  try {
    const result = await quiet(() => writeScene(sceneRun(sc, {
      scene: sc.scenes[0], agents, log: e => events.push(e),
    })));
    return { result, events, fake, scene: sc.scenes[0] };
  } finally {
    globalThis.fetch = origFetch;
    ENGINE.stream = origStream;
    NET.retries = origRetries;
    armRun();
    resetLive();
  }
}

describe("autonomy policy characterization", () => {
  it("publishes a narration-judge-flagged piece after one redraft even when it is flagged again", async () => {
    const original = "Merritt steps away from the service door.";
    const redrafted = "Merritt deliberately opens the service door.";
    const why = "Merritt's deliberate act was not granted by a character consult";
    const { result, events, fake } = await policyRun({
      "writer.draft": { prose: original, scene_done: true },
      "writer.redraft": { prose: redrafted, scene_done: true },
      "judge.narration": { ok: false, why },
    });

    assert.equal(fake.count("judge.narration"), 2);
    assert.equal(fake.count("writer.redraft"), 1);
    assert.deepEqual(result.prose, [redrafted]);
    assert.equal(result.done, true);
    assert.deepEqual(events.filter(e => e.t === "narration_flag"), [
      { t: "narration_flag", why, retried: false, chapter: 1 },
      { t: "narration_flag", why, retried: true, chapter: 1 },
    ]);
    assert.ok(events.some(e => e.t === "draft" && e.prose === redrafted));
    assert.ok(!events.some(e => e.t === "narration_quote_flag" || e.t === "narration_pronoun_flag"));
    assert.ok(fake.messagesOf("writer.redraft", 0).join("\n").includes(why));
  });

  it("commits prose before refusing an unknown consult target", async () => {
    const prose = "The service door rattles against its frame.";
    const ending = "Dust settles along the threshold.";
    const { result, fake } = await policyRun({
      "writer.draft": ({ n }) => n === 0 ? {
        prose,
        consult: {
          character: "GHOST",
          situation: "The service door rattles against its frame in front of you.",
          question: "Do you open the door?",
          wants: "decision",
        },
        scene_done: false,
      } : { prose: ending, scene_done: true },
      "character.consult": { speech: "I open it." },
    });

    assert.deepEqual(result.prose, [prose, ending]);
    assert.equal(fake.count("character.consult"), 0);
    assert.equal(fake.count("writer.draft"), 2);
    assert.match(fake.messagesOf("writer.draft", 1).join("\n"), /\[NO SUCH CHARACTER\].*GHOST/);
  });

  it("sends the done judge the question and scene but no granted ledger", async () => {
    const speech = "Keep that door shut.";
    const opening = "The service door rattles against its frame.";
    const ending = `Merritt says, "${speech}"`;
    const { result, events, fake, scene } = await policyRun({
      "writer.draft": ({ n }) => n === 0 ? {
        prose: opening,
        consult: {
          character: "MERRITT",
          situation: "Riven has the package under one arm and a hand flat on the service door.",
          question: "Do you let them through?",
          wants: "decision",
        },
        scene_done: false,
      } : { prose: ending, scene_done: true },
      "character.consult": { speech },
      "judge.answer": { verdict: "accept" },
    });

    assert.ok(events.some(e => e.t === "accept" && e.speech === speech));
    assert.match(fake.messagesOf("judge.narration", 1).join("\n"), /ALREADY GRANTED/);
    assert.ok(fake.messagesOf("judge.narration", 1).join("\n").includes(speech));
    assert.equal(fake.count("judge.done"), 1);
    const payload = fake.messagesOf("judge.done", 0).join("\n");
    assert.ok(payload.includes("[THE QUESTION THIS SCENE HAS TO ANSWER]"));
    assert.ok(payload.includes(scene.question));
    assert.ok(payload.includes("[THE SCENE AS IT STANDS]"));
    assert.ok(payload.includes(result.prose.join("\n\n")));
    assert.ok(!payload.includes("ALREADY GRANTED"));
  });
});
