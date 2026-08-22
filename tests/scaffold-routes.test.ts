/** Routes for the scaffold interview: the staged checklist (start/approve/say) and cleanup. */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { ScaffoldSession } from "../engine/architect.ts";
import type { Defaults } from "../engine/story-format.ts";
import { LIVE, resetLive } from "../live.ts";
import { handleScaffoldRoutes } from "../server/scaffold-routes.ts";
import type { ServerHost } from "../server/server.ts";
import { callRoute, quiet, ScriptedAgent } from "./helpers.ts";

const DEFAULTS: Defaults = {
  models: { default: "none", architect: "none" },
  thinking: { architect: "low" },
  requestTimeout: 120, attempts: 3, maxTokens: 2000, stream: false, debug: false,
};

const STORY_STAGE = {
  title: "The Fog Signal",
  premise: "Two keepers, one lamp.",
  tension: "Aster wants the log kept honest; Brae wants the night buried.",
};
const CAST_STAGE = {
  characters: [
    { name: "ASTER", persona: "Keeps the log.", knows: "It did not fire.", goal: "An honest log",
      belief: "Logs are sacred.", impulse: "when doubted, quotes the book", voice: ["The log is the log."],
      skills: [], restrictions: [] },
    { name: "BRAE", persona: "From the boats.", knows: "", goal: "A quiet winter", belief: "Paper sinks men",
      impulse: "when cornered, gets friendlier", voice: ["Weather beats paperwork."], skills: [],
      restrictions: ["hearing"] },
  ],
};

describe("/scaffold routes", () => {
  afterEach(() => resetLive());

  const host = (script: unknown[]): ServerHost => ({
    loadedModelIds: async () => null,
    specView: (s) => s,
    newScaffoldSession: async (idea, _model, mode) =>
      new ScaffoldSession(new ScriptedAgent(script.map(s => JSON.stringify(s))),
                          DEFAULTS, idea, undefined, mode ?? "staged"),
  }) as unknown as ServerHost;

  const post = (path: string, body?: unknown, h: ServerHost = host([])) =>
    quiet(() => callRoute(handleScaffoldRoutes, path, body ?? {}, h));

  it("opens a staged checklist and passes one approved gate at a time", async () => {
    const h = host([STORY_STAGE, CAST_STAGE]);
    LIVE.awaitingPick = true;
    const opened = await post("/scaffold/start", { idea: "two lighthouse keepers" }, h);
    assert.equal(opened.handled, true);
    assert.equal(opened.body.active, true);
    assert.equal(opened.body.mode, "staged");
    assert.equal(opened.body.gate, "story");
    assert.equal(opened.body.spec, null, "no cast yet -- nothing for the editor to review");
    assert.equal(opened.body.haveStory, false);

    const next = await post("/scaffold/approve", {}, h);
    assert.equal(next.body.gate, "cast");
    assert.equal(next.body.spec.characters.length, 2);
    assert.equal(next.body.spec.title, "The Fog Signal", "earlier stages survive the merge");
    assert.equal(next.body.haveStory, true);

    const state = await callRoute(handleScaffoldRoutes, "/scaffold", {}, h, "GET");
    assert.equal(state.body.gate, "cast", "GET reports where the checklist stands");
  });

  it("defaults to the staged walk when no mode is named", async () => {
    LIVE.awaitingPick = true;
    const opened = await post("/scaffold/start", { idea: "two lighthouse keepers" }, host([STORY_STAGE]));
    assert.equal(opened.body.mode, "staged");
  });

  it("approve on a one-shot session is a failed round, not a crash", async () => {
    LIVE.awaitingPick = true;
    const opened = await post("/scaffold/start",
                              { idea: "two lighthouse keepers", mode: "oneshot" }, host([{ ask: "?" }]));
    assert.equal(opened.body.mode, "oneshot");
    assert.equal(opened.body.gate, null, "a one-shot session has no gate");
    const r = await post("/scaffold/approve", {});
    assert.equal(r.body.last.kind, "failed");
    assert.match(r.body.last.error, /not running the staged checklist/);
  });

  it("an empty gate cannot be waved through", async () => {
    const h = host([STORY_STAGE, { note: "thinking about it" }]);
    LIVE.awaitingPick = true;
    await post("/scaffold/start", { idea: "two lighthouse keepers" }, h);
    const first = await post("/scaffold/approve", {}, h);   // the cast round lands as nothing
    assert.equal(first.body.gate, "cast");
    const blocked = await post("/scaffold/approve", {}, h); // the gate is still empty
    assert.equal(blocked.body.last.kind, "nothing");
    assert.match(blocked.body.last.why, /has not landed/);
    assert.equal(blocked.body.gate, "cast");
  });
});
