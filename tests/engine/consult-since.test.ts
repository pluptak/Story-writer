/** Stale-character `since` enforcement (--consult-since, Block B′). */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import * as P from "../../prompts.ts";
import { loadStory } from "../../engine/story-format.ts";
import { normalizeConsult } from "../../engine/consult.ts";
import {
  newCharacterAgent, parseDraftReply, writeScene, type RunEvent,
} from "../../engine/scene-loop.ts";
import { ENGINE } from "../../engine/engine-state.ts";
import { NET } from "../../engine/llm-client.ts";
import { armRun, resetLive } from "../../live.ts";
import { quiet, siteFetch, sceneRun } from "../helpers.ts";

describe("since plumbing", () => {
  it("parses the writer's since field, defaulting to empty", () => {
    const withSince = parseDraftReply(JSON.stringify({
      prose: "Merritt shifts on the crate.",
      consult: { character: "MERRITT", situation: "You sit on the crate in the dark.", since: "Riven crossed to the door." },
    }));
    assert.equal(withSince.consult?.since, "Riven crossed to the door.");
    const without = parseDraftReply(JSON.stringify({
      prose: "Merritt shifts on the crate.",
      consult: { character: "MERRITT", situation: "You sit on the crate in the dark." },
    }));
    assert.equal(without.consult?.since, "");
  });

  it("joins since onto the situation as one second-person channel", () => {
    assert.equal(
      P.withSince("You sit on the crate.", "Riven crossed to the door."),
      "You sit on the crate.\n\nSince you were last asked: Riven crossed to the door.");
  });

  it("carries since on the checked request while the gate reads the joined text", () => {
    const check = normalizeConsult({
      character: "MERRITT",
      situation: P.withSince("You sit on the crate in the dark service room.", "Riven crossed to the door."),
      since: "Riven crossed to the door.",
    }, [{ name: "MERRITT", cannot: ["sight"] }]);
    assert.equal(check.ok, true);
    if (check.ok) assert.equal(check.req.since, "Riven crossed to the door.");
  });
});

describe("stale refusal with --consult-since", () => {
  const draftFor = (n: number) => {
    const drafts = [
      { prose: "Riven crosses the corridor toward the steel door.", consult: { character: "MERRITT", situation: "Riven crosses the narrow corridor toward the steel service door, the heavy package held close at their side in the dark." }, scene_done: false },
      { prose: "The lock gives a faint metallic click.", scene_done: false },
      { prose: "The corridor falls quiet again.", scene_done: false },
      { prose: "Riven kneels by the door, working at the lock.", consult: { character: "MERRITT", situation: "Riven kneels by the steel service door in the dark corridor, working quietly at the mechanical lock." }, scene_done: false },
      { prose: "The tumblers turn inside the lock.", consult: { character: "MERRITT", situation: "Riven kneels by the steel service door in the dark corridor, working quietly at the mechanical lock.", since: "Riven reached the door and began working at the lock; the tumblers are turning." }, scene_done: false },
      { prose: "Merritt listens from the crate as the lock turns.", scene_done: true },
    ];
    return drafts[n] ?? { prose: "The corridor waits.", scene_done: true };
  };

  async function runWith(flag: boolean) {
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
    const events: RunEvent[] = [];
    const agents = new Map(sc.characters.map(def =>
      [def.name.toLowerCase(), newCharacterAgent(def, sc.scenes[0].place, sc.thinking.character)]));
    const routes = siteFetch({
      "judge.answer": { verdict: "accept" },
      "judge.narration": { ok: true },
      "judge.done": { ok: true },
      "writer.draft": (call) => draftFor(call.n),
      "character.consult": { thought: "They are at the door.", speech: "Who is there?" },
    });
    const origFetch = globalThis.fetch;
    const origStream = ENGINE.stream;
    const origRetries = NET.retries;
    const origFlag = ENGINE.consultSince;
    ENGINE.stream = false;
    NET.retries = 0;
    ENGINE.consultSince = flag;
    globalThis.fetch = routes.fetchMock;
    armRun();
    try {
      await writeScene(sceneRun(sc, { scene: sc.scenes[0], agents, log: (e: RunEvent) => events.push(e) }));
    } finally {
      globalThis.fetch = origFetch;
      ENGINE.stream = origStream;
      NET.retries = origRetries;
      ENGINE.consultSince = origFlag;
      armRun();
      resetLive();
    }
    return { events, routes };
  }

  it("refuses a stale consult without since, and sends it once since arrives", async () => {
    const { events, routes } = await runWith(true);
    const bad = events.filter(e => e.t === "bad_consult");
    assert.equal(bad.length, 1);
    assert.match((bad[0] as any).why, /no "since"/);
    assert.equal((bad[0] as any).character, "MERRITT");
    assert.equal(routes.count("character.consult"), 2, "fresh ask sent, stale ask refused, since ask sent");

    const consults = events.filter(e => e.t === "consult") as any[];
    assert.equal(consults.length, 2);
    assert.equal(consults[0].since, "");
    assert.equal(consults[1].since, "Riven reached the door and began working at the lock; the tumblers are turning.");
    assert.match(consults[1].situation, /Since you were last asked: Riven reached the door/);
  });

  it("sends a stale consult without since when the flag is off", async () => {
    const { events, routes } = await runWith(false);
    assert.deepEqual(events.filter(e => e.t === "bad_consult"), []);
    assert.equal(routes.count("character.consult"), 3, "every ask sent, no refusal");
    const consults = events.filter(e => e.t === "consult") as any[];
    assert.equal(consults[1].since, "");
    assert.doesNotMatch(consults[1].situation, /Since you were last asked/);
  });
});
