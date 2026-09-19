/**
 * Stage tests — the live scene stage: seeded from the scene's own staging, accreted onto by
 * the writer's reply, never written back to story.json. Deterministic, no model involved;
 * the writeScene half runs on the faked transport like every other loop test.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { seedStage, parseStageEntry, applyStageEntry, observe } from "../../engine/stage.ts";
import type { StagedEntity } from "../../engine/scene-loop.ts";
import { parseDraftReply } from "../../engine/scene-loop.ts";
import { WARN } from "../../engine/warnings.ts";
import { loadStory } from "../../engine/story-format.ts";
import { newCharacterAgent, writeScene, type RunEvent } from "../../engine/scene-loop.ts";
import { Agent } from "../../engine/agent.ts";
import { NET } from "../../engine/llm-client.ts";
import { ENGINE } from "../../engine/engine-state.ts";
import { armRun, resetLive } from "../../live.ts";
import { quiet, siteFetch, sceneRun } from "../helpers.ts";

describe("seedStage", () => {
  it("copies the seed — the room is worked, never the story file's own list", () => {
    const seed: StagedEntity[] = [{ entity: "door", position: "shut", fixed: true }];
    const room = seedStage(seed);
    room[0].position = "open";
    assert.equal(seed[0].position, "shut");
  });
});

describe("parseStageEntry", () => {
  it("reads name and position, stripping a writer-sent marker", () => {
    assert.deepEqual(parseStageEntry("lamp :: on the desk, lit"),
      { entity: "lamp", position: "on the desk, lit" });
    assert.deepEqual(parseStageEntry("!door :: open"),
      { entity: "door", position: "open" });
  });

  it("drops what places nothing", () => {
    assert.equal(parseStageEntry("lamp"), null);
    assert.equal(parseStageEntry("  "), null);
    assert.equal(parseStageEntry("! :: nowhere"), null);
  });
});

describe("applyStageEntry", () => {
  it("adds what is new, and never fixes a writer entry", () => {
    const room: StagedEntity[] = [];
    const added = applyStageEntry(room, "lamp", "on the desk");
    assert.deepEqual(added, { type: "added", entity: "lamp", position: "on the desk" });
    assert.deepEqual(room, [{ entity: "lamp", position: "on the desk", fixed: false }]);
  });

  it("re-adding the same placement is a silent noop", () => {
    const room: StagedEntity[] = [{ entity: "lamp", position: "on the desk", fixed: false }];
    assert.deepEqual(applyStageEntry(room, "lamp", "on the desk"), { type: "noop" });
    assert.equal(room.length, 1);
  });

  it("moves what is not fixed, case-insensitively", () => {
    const room: StagedEntity[] = [{ entity: "lamp", position: "on the desk", fixed: false }];
    const moved = applyStageEntry(room, "LAMP", "on the floor");
    assert.deepEqual(moved, { type: "moved", entity: "lamp", from: "on the desk", to: "on the floor" });
    assert.equal(room[0].position, "on the floor");
  });

  it("refuses a move against a fixed entry, keeping the old placement", () => {
    const room: StagedEntity[] = [{ entity: "door", position: "shut fast", fixed: true }];
    const refused = applyStageEntry(room, "door", "open now");
    assert.deepEqual(refused,
      { type: "refused", entity: "door", position: "open now", fixed: "shut fast" });
    assert.equal(room[0].position, "shut fast");
  });
});

describe("observe", () => {
  const ROOM: StagedEntity[] = [
    { entity: "RIVEN", position: "by the steel door", fixed: false },
    { entity: "MERRITT", position: "on the upturned crate", fixed: false },
    { entity: "steel door", position: "shut fast", fixed: true },
  ];
  const riven = { name: "RIVEN", limits: [] as string[], presence: null, reach: [] };
  const merritt = { name: "MERRITT", limits: ["sight"], presence: null, reach: [] };

  it("gives the whole room to a character who can perceive it", () => {
    assert.deepEqual(observe(riven, ROOM), ROOM);
  });

  it("withholds the visible list from a character who cannot see, keeping only where they are", () => {
    assert.deepEqual(observe(merritt, ROOM),
      [{ entity: "MERRITT", position: "on the upturned crate", fixed: false }]);
  });

  it("withholds the room from a character who is not in it", () => {
    const remote = { ...riven, presence: { mode: "remote" as const, via: "the phone line" } };
    assert.deepEqual(observe(remote, ROOM), []);
  });

  it("never lets reach smuggle visibility past a CANNOT", () => {
    const camera = { name: "cameras", meaning: "perceiving through the lobby cameras", source: "reach" as const };
    assert.deepEqual(observe({ ...merritt, reach: [camera] }, ROOM),
      [{ entity: "MERRITT", position: "on the upturned crate", fixed: false }]);
  });

  it("drops entries that place nothing", () => {
    const room: StagedEntity[] = [...ROOM, { entity: "crate", position: "", fixed: false }];
    assert.deepEqual(observe(riven, room), ROOM);
  });
});

describe("parseDraftReply stage", () => {
  it("applies a proper array", () => {
    const r = parseDraftReply(JSON.stringify({ prose: "x", stage: ["lamp :: on the desk"] }));
    assert.deepEqual(r.stage, ["lamp :: on the desk"]);
  });

  it("warns and ignores a present-but-not-array stage", () => {
    const seen: string[] = [];
    const orig = WARN.sink;
    WARN.sink = (m: string) => { seen.push(m); };
    try {
      const r = parseDraftReply(JSON.stringify({ prose: "x", stage: { lamp: "on the desk" } }));
      assert.equal(r.stage, null);
    } finally { WARN.sink = orig; }
    assert.equal(seen.length, 1);
    assert.match(seen[0], /"stage" is not a list/);
  });

  it("an absent stage warns about nothing", () => {
    const seen: string[] = [];
    const orig = WARN.sink;
    WARN.sink = (m: string) => { seen.push(m); };
    try {
      const r = parseDraftReply(JSON.stringify({ prose: "x" }));
      assert.equal(r.stage, null);
    } finally { WARN.sink = orig; }
    assert.deepEqual(seen, []);
  });
});

describe("the writer accreting onto the room", () => {
  async function runScene(opts: { staging: string[]; drafts: Record<string, unknown>[] }) {
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
    const sd = { ...sc.scenes[0], staging: opts.staging };
    const events: RunEvent[] = [];
    const log = (e: RunEvent) => events.push(e);
    const agents = new Map(sc.characters.map(def =>
      [def.name.toLowerCase(), newCharacterAgent(def, sc.scenes[0].place, sc.thinking.character)]));

    const { fetchMock, messagesOf } = siteFetch({
      "judge.answer": { verdict: "accept" },
      "judge.narration": { ok: true },
      "judge.done": { ok: true },
      "writer.draft": (call) => opts.drafts[call.n],
      "character.consult": { thought: "Steady.", speech: "", action: "" },
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
      return { r, events, messagesOf };
    } finally {
      globalThis.fetch = origFetch;
      ENGINE.stream = origStream;
      NET.retries = origRetries;
      armRun();
      resetLive();
    }
  }

  it("records what the prose places, once — a repeat is not a second addition", async () => {
    const { r, events } = await runScene({
      staging: [],
      drafts: [
        { prose: "Riven sets the lamp on the desk.", consult: null, scene_done: false,
          stage: ["lamp :: on the desk, lit"] },
        { prose: "The lamp burns on.", consult: null, scene_done: true,
          stage: ["lamp :: on the desk, lit"] },
      ],
    });
    assert.equal(r.done, true);
    const added = events.filter(e => e.t === "stage_added") as any[];
    assert.equal(added.length, 1);
    assert.equal(added[0].entity, "lamp");
    assert.equal(added[0].position, "on the desk, lit");
  });

  it("refuses a move against a fixed entry and tells the writer the old placement stands", async () => {
    const { r, events, messagesOf } = await runScene({
      staging: ["!door :: shut fast"],
      drafts: [
        { prose: "Riven shoulders the door.", consult: null, scene_done: false,
          stage: ["door :: open now"] },
        { prose: "The door holds.", consult: null, scene_done: true },
      ],
    });
    assert.equal(r.done, true);
    const refused = events.filter(e => e.t === "stage_refused") as any[];
    assert.equal(refused.length, 1);
    assert.equal(refused[0].entity, "door");
    assert.equal(refused[0].fixed, "shut fast");
    assert.equal(events.filter(e => e.t === "stage_moved").length, 0);

    const secondDraft = messagesOf("writer.draft", 1).join("\n");
    assert.match(secondDraft, /\[STAGE REFUSED\]/);
    assert.match(secondDraft, /shut fast/);
  });
});

describe("the projection beside the situation", () => {
  // The doorway fixture carries its own staged scene; the negative assertion is the one
  // that matters — a character who cannot see must not receive the visible list.
  async function consultedAs(character: string, situation: string) {
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
    const events: RunEvent[] = [];
    const agents = new Map(sc.characters.map(def =>
      [def.name.toLowerCase(), newCharacterAgent(def, sc.scenes[0].place, sc.thinking.character)]));

    const { fetchMock, messagesOf } = siteFetch({
      "judge.answer": { verdict: "accept" },
      "judge.narration": { ok: true },
      "judge.done": { ok: true },
      "writer.draft": (call) => call.n === 0 ? {
        prose: "The corridor holds its breath.",
        consult: { character, situation, question: "", wants: "" },
        scene_done: false,
      } : {
        prose: "Nothing moves.",
        consult: null,
        scene_done: true,
      },
      "character.consult": { thought: "Steady.", speech: "Easy.", action: "" },
    });

    const origFetch = globalThis.fetch;
    const origStream = ENGINE.stream;
    const origRetries = NET.retries;
    ENGINE.stream = false;
    NET.retries = 0;
    globalThis.fetch = fetchMock;
    armRun();

    try {
      await writeScene(sceneRun(sc, { scene: sc.scenes[0], agents, log: (e) => events.push(e) }));
      return messagesOf("character.consult", 0).join("\n");
    } finally {
      globalThis.fetch = origFetch;
      ENGINE.stream = origStream;
      NET.retries = origRetries;
      armRun();
      resetLive();
    }
  }

  it("hands a sighted character the room beside the situation", async () => {
    const ask = await consultedAs("RIVEN",
      "You stand by the steel door turning a small pick over in your fingers, listening hard.");
    assert.match(ask, /\[THE ROOM AS YOU KNOW IT\]/);
    assert.match(ask, /RIVEN :: by the steel door/);
    assert.match(ask, /steel door :: shut fast/);
  });

  it("withholds the visible list from a character who cannot see", async () => {
    const ask = await consultedAs("MERRITT",
      "You sit on the upturned crate while something small and metallic ticks nearby in Riven's hands.");
    assert.match(ask, /MERRITT :: on the upturned crate/,
      "where they themselves are is proprioception, not sight");
    assert.doesNotMatch(ask, /RIVEN :: by the steel door/);
    assert.doesNotMatch(ask, /steel door :: shut fast/);
    assert.match(ask, /ticks nearby/, "the situation itself still arrives untouched");
  });
});
