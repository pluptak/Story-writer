/**
 * Stage tests — the live scene stage: seeded from the scene's own staging, accreted onto by
 * the writer's reply, never written back to story.json. Deterministic, no model involved;
 * the writeScene half runs on the faked transport like every other loop test.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { seedStage, parseStageEntry, applyStageEntry, observe, resolveTarget } from "../../engine/stage.ts";
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

  it("keeps the standing placement when a restatement only loses — the live run's erasure, verbatim", () => {
    const room: StagedEntity[] = [{
      entity: "interview form", position: "on the table in front of VALE, unsigned", fixed: false,
    }];
    const kept = applyStageEntry(room, "interview form", "on the table, in front of VALE");
    assert.deepEqual(kept, {
      type: "kept", entity: "interview form",
      kept: "on the table in front of VALE, unsigned", offered: "on the table, in front of VALE",
    });
    assert.equal(room[0].position, "on the table in front of VALE, unsigned",
      "whether the form is signed is what the scene's question turns on");
  });

  it("a shorter position that names anything new is still a move", () => {
    const room: StagedEntity[] = [{ entity: "form", position: "on the table, unsigned", fixed: false }];
    assert.deepEqual(applyStageEntry(room, "form", "on the floor"),
      { type: "moved", entity: "form", from: "on the table, unsigned", to: "on the floor" });
  });

  it("the same scene's real move is untouched — different words, not fewer", () => {
    const room: StagedEntity[] = [{
      entity: "receipt", position: "destination and recipient blank", fixed: false,
    }];
    assert.deepEqual(applyStageEntry(room, "receipt", "turned toward MARA"),
      { type: "moved", entity: "receipt",
        from: "destination and recipient blank", to: "turned toward MARA" });
  });

  it("a keep changes nothing — the next genuine move still moves from the standing placement", () => {
    const room: StagedEntity[] = [{
      entity: "interview form", position: "on the table in front of VALE, unsigned", fixed: false,
    }];
    applyStageEntry(room, "interview form", "on the table, in front of VALE");
    const moved = applyStageEntry(room, "interview form", "in MARA's hands");
    assert.deepEqual(moved, { type: "moved", entity: "interview form",
      from: "on the table in front of VALE, unsigned", to: "in MARA's hands" });
  });

  it("re-listing a fixed entry with less is a keep, not a refusal — nothing was attempted", () => {
    const room: StagedEntity[] = [{ entity: "steel door", position: "shut fast", fixed: true }];
    const kept = applyStageEntry(room, "steel door", "shut");
    assert.deepEqual(kept, {
      type: "kept", entity: "steel door", kept: "shut fast", offered: "shut",
    });
    assert.equal(room[0].position, "shut fast");
  });

  it("a position with no words at all keeps the standing placement", () => {
    const room: StagedEntity[] = [{ entity: "form", position: "on the table, unsigned", fixed: false }];
    assert.equal(applyStageEntry(room, "form", "...").type, "kept");
    assert.equal(room[0].position, "on the table, unsigned");
  });
});

describe("resolveTarget", () => {
  const ROOM: StagedEntity[] = [{ entity: "steel door", position: "shut fast", fixed: true }];

  it("resolves a case-different spelling to the stage's own name and position", () => {
    assert.deepEqual(resolveTarget(ROOM, "Steel Door"),
      { matched: true, entity: "steel door", position: "shut fast" });
  });

  it("permits an unmatched name and leaves the stage alone — naming is not placing", () => {
    const room: StagedEntity[] = [...ROOM];
    assert.deepEqual(resolveTarget(room, "the window"),
      { matched: false, entity: "the window", position: "" });
    assert.equal(room.length, 1, "the length is the assertion: an unmatched target accretes nothing");
  });

  it("an empty target resolves to nothing", () => {
    assert.deepEqual(resolveTarget(ROOM, ""), { matched: false, entity: "", position: "" });
    assert.deepEqual(resolveTarget(ROOM, "   "), { matched: false, entity: "", position: "" });
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

  it("with nothing adjacent, a blind character receives only where they themselves are", () => {
    assert.deepEqual(observe(merritt, ROOM),
      [{ entity: "MERRITT", position: "on the upturned crate", fixed: false }]);
  });

  it("touch adjacency: what their own placement names arrives — what they sit on", () => {
    const room: StagedEntity[] = [
      ...ROOM,
      { entity: "upturned crate", position: "under the high window", fixed: false },
    ];
    assert.deepEqual(observe(merritt, room), [
      { entity: "MERRITT", position: "on the upturned crate", fixed: false },
      { entity: "upturned crate", position: "under the high window", fixed: false },
    ]);
  });

  it("touch adjacency: whoever the room places at them arrives, by the position naming them", () => {
    const room: StagedEntity[] = [
      { entity: "RIVEN", position: "at MERRITT's shoulder", fixed: false },
      { entity: "MERRITT", position: "on the upturned crate", fixed: false },
      { entity: "steel door", position: "shut fast", fixed: true },
    ];
    assert.deepEqual(observe(merritt, room), [
      { entity: "RIVEN", position: "at MERRITT's shoulder", fixed: false },
      { entity: "MERRITT", position: "on the upturned crate", fixed: false },
    ]);
  });

  it("a blind character with no entry of their own still receives whoever is placed at them", () => {
    const room: StagedEntity[] = [
      { entity: "RIVEN", position: "beside MERRITT", fixed: false },
      { entity: "steel door", position: "shut fast", fixed: true },
    ];
    assert.deepEqual(observe(merritt, room),
      [{ entity: "RIVEN", position: "beside MERRITT", fixed: false }]);
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

  it("a lossy restatement keeps the authored placement, logged and silent; a later real move still moves", async () => {
    const { r, events, messagesOf } = await runScene({
      staging: ["interview form :: on the table in front of VALE, unsigned"],
      drafts: [
        { prose: "The form waits where it has waited all along.", consult: null, scene_done: false,
          stage: ["interview form :: on the table, in front of VALE"] },
        { prose: "Riven takes the form.", consult: null, scene_done: false,
          stage: ["interview form :: in Riven's hands"] },
        { prose: "She reads it twice.", consult: null, scene_done: true },
      ],
    });
    assert.equal(r.done, true);
    const kept = events.filter(e => e.t === "stage_kept") as any[];
    assert.equal(kept.length, 1);
    assert.equal(kept[0].kept, "on the table in front of VALE, unsigned");
    assert.equal(kept[0].offered, "on the table, in front of VALE");

    const secondDraft = messagesOf("writer.draft", 1).join("\n");
    assert.doesNotMatch(secondDraft, /\[STAGE /,
      "a keep reaches no prompt — the gloss owns the rule");
    const moved = events.filter(e => e.t === "stage_moved") as any[];
    assert.equal(moved.length, 1);
    assert.equal(moved[0].from, "on the table in front of VALE, unsigned",
      "the move leaves the fuller placement, not the restatement");
    assert.equal(moved[0].to, "in Riven's hands");
  });
});

describe("the projection beside the situation", () => {
  // The doorway fixture carries its own staged scene; the negative assertion is the one
  // that matters — a character who cannot see must not receive the visible list.
  async function consultedAs(character: string, situation: string, staging?: string[]) {
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
    const events: RunEvent[] = [];
    const agents = new Map(sc.characters.map(def =>
      [def.name.toLowerCase(), newCharacterAgent(def, sc.scenes[0].place, sc.thinking.character)]));
    const sd = staging ? { ...sc.scenes[0], staging } : sc.scenes[0];

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
      await writeScene(sceneRun(sc, { scene: sd, agents, log: (e) => events.push(e) }));
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

  it("adjacency reaches a blind character beside the situation: what they sit on, staged", async () => {
    const ask = await consultedAs("MERRITT",
      "You sit on the upturned crate while something small and metallic ticks nearby in Riven's hands.",
      ["RIVEN :: by the steel door",
       "MERRITT :: on the upturned crate",
       "upturned crate :: under the high window",
       "!steel door :: shut fast"]);
    assert.match(ask, /MERRITT :: on the upturned crate/);
    assert.match(ask, /upturned crate :: under the high window/,
      "their own placement names what they sit on");
    assert.doesNotMatch(ask, /RIVEN ::/, "nothing places RIVEN at them in this staging");
    assert.doesNotMatch(ask, /steel door/, "the fixed door stays out of adjacency's reach");
  });
});
