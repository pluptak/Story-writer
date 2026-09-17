/** The pure heard-speech module: what one character heard since they were last asked.
 *  Pure function — no engine imports, no model, no fetch, no loop. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { heardBlock, type GrantedLine } from "../engine/heard.ts";

import * as P from "../prompts.ts";
import { loadStory, type StoryConfig } from "../engine/story-format.ts";
import { newCharacterAgent, writeScene, type RunEvent } from "../engine/scene-loop.ts";
import { ENGINE } from "../engine/engine-state.ts";
import { NET } from "../engine/llm-client.ts";
import { armRun, resetLive } from "../live.ts";
import { quiet, sceneRun, siteFetch, type SiteHandler } from "./helpers.ts";
import { reviseConsult } from "../engine/consult.ts";

const situation = "You are beside the locked door in the narrow corridor; the delivery deadline is approaching and the package remains outside.";
const ask = (character: string, extra = {}) => ({ prose: "", consult: { character, situation, ...extra } });
const close = { prose: "The corridor falls quiet as dawn reaches the building.", scene_done: true };

async function runHeard(drafts: Record<string, unknown>[], options: {
  enabled?: boolean;
  configure?: (sc: StoryConfig) => void;
  character?: SiteHandler;
  judge?: SiteHandler;
} = {}) {
  const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
  options.configure?.(sc);
  const agents = new Map(sc.characters.map(def =>
    [def.name.toLowerCase(), newCharacterAgent(def, sc.scenes[0].place, sc.thinking.character)]));
  const events: RunEvent[] = [];
  const fake = siteFetch({
    "writer.draft": ({ n }) => drafts[n] ?? close,
    "judge.narration": { ok: true },
    "judge.done": { ok: true },
    "judge.answer": options.judge ?? { verdict: "accept" },
    "judge.batch": { verdicts: [] },
    "character.consult": options.character ?? (({ n }) => ({ thought: "Private thought.", speech: `Line ${n}.`, action: "" })),
  });
  const original = { stream: ENGINE.stream, heardChannel: ENGINE.heardChannel, consultSince: ENGINE.consultSince };
  const fetch = globalThis.fetch, retries = NET.retries;
  Object.assign(ENGINE, { stream: false, heardChannel: options.enabled ?? true, consultSince: true });
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
  return { fake, events, agents };
}

const currentAsk = (fake: ReturnType<typeof siteFetch>, n: number) =>
  fake.messagesOf("character.consult", n).filter(m => m.startsWith("[THE AUTHOR ASKS]")).at(-1) ?? "";

describe("heard integration", () => {
  it("delivers speech across empty-prose turns and advances each listener's window", async () => {
    const { fake, events, agents } = await runHeard([
      ask("RIVEN"), ask("MERRITT", { since: "WRITER RECAP MUST NOT ARRIVE" }),
      ask("RIVEN"), ask("MERRITT"), ask("MERRITT"), close,
    ]);
    assert.equal(fake.count("character.consult"), 5);
    assert.deepEqual(events.filter(e => e.t === "bad_consult"), []);
    assert.match(currentAsk(fake, 1), /\[WHAT YOU HEARD\]\nRIVEN: "Line 0\."/);
    assert.doesNotMatch(currentAsk(fake, 1), /Private thought|WRITER RECAP/);
    assert.match(currentAsk(fake, 3), /RIVEN: "Line 2\."/);
    assert.doesNotMatch(currentAsk(fake, 3), /Line 0/);
    assert.doesNotMatch(currentAsk(fake, 4), /WHAT YOU HEARD/);
    assert.ok(JSON.stringify(agents.get("merritt")!.history).includes("WHAT YOU HEARD"));
    assert.match(fake.messagesOf("writer.draft")[0], /CIRCUMSTANCE ONLY/);
    assert.doesNotMatch(fake.messagesOf("writer.draft")[0], /SINCE -- a consult/);
  });

  it("takes all fan-out snapshots before any reaction and retains same-beat speech for the next ask", async () => {
    const { fake } = await runHeard([
      ask("RIVEN"),
      { prose: "", consult: { situation, reactors: [{ name: "RIVEN" }, { name: "MERRITT" }] } },
      ask("MERRITT"), close,
    ]);
    assert.equal(fake.count("character.consult"), 4);
    assert.match(currentAsk(fake, 2), /RIVEN: "Line 0\."/);
    assert.doesNotMatch(currentAsk(fake, 2), /Line 1/);
    assert.match(currentAsk(fake, 3), /RIVEN: "Line 1\."/);
    assert.doesNotMatch(currentAsk(fake, 3), /Line 0/);
  });

  for (const variant of ["deaf", "remote speaker", "remote listener", "partial", "off"] as const) {
    it(`respects ${variant}`, async () => {
      const { fake } = await runHeard([ask("RIVEN"), ask("MERRITT"), close], {
        enabled: variant !== "off",
        configure: sc => {
          if (variant === "deaf") sc.characters.find(c => c.name === "MERRITT")!.limits.push("HEARING");
          if (variant === "remote speaker") sc.scenes[0].presence = { RIVEN: "remote :: phone" };
          if (variant === "remote listener") sc.scenes[0].presence = { MERRITT: "remote :: phone" };
          if (variant === "partial") sc.scenes[0].presence = { MERRITT: "partial :: doorway" };
        },
      });
      assert.equal(fake.count("character.consult"), 2);
      assert.equal(currentAsk(fake, 1).includes("[WHAT YOU HEARD]"), variant === "partial");
    });
  }

  it("keeps the heard snapshot across a judged retry without rejected speech", async () => {
    const { fake } = await runHeard([ask("RIVEN"), ask("MERRITT"), close], {
      judge: ({ n }) => n === 1 ? {
        verdict: "retry", note: "The door remains locked.",
        revised: { situation: situation + " The lock remains firmly shut.", question: "How do you address the locked door?" },
      } : { verdict: "accept" },
    });
    assert.equal(fake.count("character.consult"), 3);
    assert.match(currentAsk(fake, 2), /RIVEN: "Line 0\."/);
    assert.doesNotMatch(fake.messagesOf("character.consult", 2).join("\n"), /Line 1/);
    assert.match(fake.messagesOf("judge.answer", 1).join("\n"), /WHAT YOU HEARD/);
  });

  it("does not advance a refused listener or relay speech from an exited speaker", async () => {
    const { fake, events } = await runHeard([
      ask("RIVEN"), ask("MERRITT", { situation: "Too short." }), ask("MERRITT"), ask("RIVEN"),
      { prose: "The corridor darkens as the outer door closes.", exit: "RIVEN" },
      ask("MERRITT"), close,
    ], { configure: sc => { sc.scenes[0].pov = "MERRITT"; } });
    assert.equal(events.filter(e => e.t === "bad_consult").length, 1);
    assert.match(currentAsk(fake, 1), /RIVEN: "Line 0\."/);
    assert.equal(fake.count("character.consult"), 4);
    assert.doesNotMatch(currentAsk(fake, 3), /WHAT YOU HEARD/);
  });

  it("does not send to an unrostered character", async () => {
    const { fake } = await runHeard([ask("RIVEN"), ask("MERRITT"), close], {
      configure: sc => { sc.scenes[0].roster = ["MERRITT"]; sc.scenes[0].pov = "MERRITT"; },
    });
    assert.equal(fake.count("character.consult"), 1);
    assert.doesNotMatch(currentAsk(fake, 0), /WHAT YOU HEARD/);
  });

  it("does not require since after multiple prose pieces", async () => {
    const { fake, events } = await runHeard([
      ask("MERRITT"), { prose: "Rain gathers along the threshold." },
      { prose: "The lamp dims above the doorway." }, ask("MERRITT"), close,
    ]);
    assert.equal(fake.count("character.consult"), 2);
    assert.deepEqual(events.filter(e => e.t === "bad_consult"), []);
  });

  it("renders speech in plain double quotes in every ask variant and preserves engine data on revision", () => {
    const heard: { lines: [string, string][] } = { lines: [["RIVEN", 'No. "Not yet."\nWait.']] };
    const req = { character: "MERRITT", situation, question: "", wants: "" as const, heard };
    const expectedSpeech = `RIVEN: "${heard.lines[0][1]}"`;
    for (const render of [P.askBlock, P.freeAskBlock, P.freeAskBlockV3, P.foldedAsk]) {
      assert.ok(render(req).includes(expectedSpeech));
      assert.doesNotMatch(render({ ...req, heard: { lines: [] } }), /WHAT YOU HEARD/);
    }
    const revised = reviseConsult(req, { situation: situation + " The lock is shut.", question: "How do you address the locked door?", heard: { lines: [["GHOST", "fake"]] } });
    assert.ok(revised.ok);
    if (revised.ok) assert.deepEqual(revised.req.heard, heard);
  });
});

describe("heardBlock", () => {
  it("preserves granted speech verbatim, in ledger order", () => {
    const ledger: GrantedLine[] = [
      { character: "MERRITT", speech: "I open it." },
      { character: "RIVEN", speech: "Say your name first." },
      { character: "MERRITT", speech: "No. Say yours." },
    ];
    const b = heardBlock(
      { name: "RIVEN", present: ["RIVEN", "MERRITT"], cannotHear: false },
      ledger,
    );
    assert.deepEqual(b.lines, [
      ["MERRITT", "I open it."],
      ["MERRITT", "No. Say yours."],
    ]);
  });

  it("excludes a deaf listener's own would-heard block entirely", () => {
    // Merritt's restriction removes hearing itself; the whole block is gone, not the lines that
    // name him. The block is what the ask renders as [WHAT YOU HEARD]; a deaf listener gets none.
    const ledger: GrantedLine[] = [
      { character: "RIVEN", speech: "Say your name first." },
    ];
    const b = heardBlock(
      { name: "MERRITT", present: ["RIVEN", "MERRITT"], cannotHear: true },
      ledger,
    );
    assert.deepEqual(b.lines, []);
  });

  it("excludes a remote speaker — presence decides, not the ledger", () => {
    // RIVEN is "remote" in this scene, so their speech never reaches MERRITT even though the
    // ledger carries it. The caller owns the presence resolution; this only reads it.
    const ledger: GrantedLine[] = [
      { character: "RIVEN", speech: "Say your name first." },
    ];
    const b = heardBlock(
      { name: "MERRITT", present: ["MERRITT"], cannotHear: false },
      ledger,
    );
    assert.deepEqual(b.lines, []);
  });

  it("excludes the asked character's own speech", () => {
    const ledger: GrantedLine[] = [
      { character: "MERRITT", speech: "Say your name first." },
    ];
    const b = heardBlock(
      { name: "MERRITT", present: ["RIVEN", "MERRITT"], cannotHear: false },
      ledger,
    );
    assert.deepEqual(b.lines, []);
  });

  it("returns an empty block when nothing qualifies", () => {
    const ledger: GrantedLine[] = [
      { character: "RIVEN", speech: "" },
    ];
    const b = heardBlock(
      { name: "MERRITT", present: ["RIVEN", "MERRITT"], cannotHear: false },
      ledger,
    );
    assert.deepEqual(b.lines, []);
  });
});
