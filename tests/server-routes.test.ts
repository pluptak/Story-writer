/** Routes for the HTTP server: next-chapter handoff and run control. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { normalizeSpec } from "../engine/story-spec.ts";
import { NextChapterSession } from "../engine/architect.ts";
import { Agent } from "../engine/agent.ts";
import { LIVE, resetLive, armRun } from "../live.ts";
import { handleNextChapterRoutes } from "../server/next-chapter-routes.ts";
import { handleRunControl } from "../server/run-control-routes.ts";
import { HttpError, readJsonBody } from "../server/http-util.ts";
import type { ServerHost } from "../server/server.ts";
import { callRoute, fakeRequest, fakeRawRequest, quiet, ScriptedAgent } from "./helpers.ts";

// Constants needed by tests
const SCAFFOLD_DEFAULTS = {
  models: { default: "none", architect: "none" },
  thinking: { architect: "low" },
  requestTimeout: 120, attempts: 3, maxTokens: 2000, stream: false, debug: false,
};

const STORY = {
  title: "The Fog Signal",
  premise: "Two keepers, one lamp, and a night that did not happen the way the log says it did.",
  scene: { place: "the lamp room", question: "Does Aster admit the signal never fired?", pov: "ASTER", length: 700 },
  writer_style: "Plain sentences. No weather as metaphor.",
  characters: [
    { name: "ASTER", persona: "Keeps the log in a small clear hand and has never once falsified it.",
      knows: "The signal did not fire.", skills: ["lamp-tending :: trimming and lighting the great lens"], restrictions: [] },
    { name: "BRAE", persona: "Came up from the boats and trusts the weather over anyone's paperwork.",
      knows: "", skills: [], restrictions: ["hearing"] },
  ],
};

// -- SECTION ----
describe("/next-chapter routes", () => {
  const spec = normalizeSpec(STORY).spec;
  const opened: string[] = [];

  const host = (open?: () => Promise<NextChapterSession>): ServerHost => ({
    storyCards: async () => [],
    selectableStory: async (dir: string) => (dir === "stories/doorway" ? "stories/doorway" : null),
    resolveStoryDir: (dir: string) => dir,
    runDirs: async () => [],
    loadedModelIds: async () => null,
    architectModel: async () => "none",
    newScaffoldSession: async () => { throw new Error("not in this test"); },
    newHandoffSession: async (dir: string) => { opened.push(dir); return open ? open() : session([]); },
    directEdit: () => ({ ok: false, reason: "not in this test" }),
    specView: (s) => s,
    outDir: () => "",
  });

  const session = (script: unknown[]) =>
    new NextChapterSession(new ScriptedAgent(script.map(x => JSON.stringify(x))), SCAFFOLD_DEFAULTS,
                           "stories/doorway", spec, [{ n: 1, text: "It happened." }]);

  it("leaves a path that is not one of its own to the rest of the server", async () => {
    assert.equal((await callRoute(handleNextChapterRoutes, "/scaffold/say", {}, host())).handled, false);
    assert.equal((await callRoute(handleNextChapterRoutes, "/next-chapter", {}, host(), "GET")).body.active, false);
  });

  it("refuses a story it did not discover, and never opens a session for it", async () => {
    opened.length = 0;
    const r = await callRoute(handleNextChapterRoutes, "/next-chapter/start", { dir: "../elsewhere" }, host());
    assert.equal(r.code, 400);
    assert.match(r.body.reason, /no such story/);
    assert.deepEqual(opened, []);
  });

  it("reports why a story cannot be handed off, and stays closed", async () => {
    const h = host(async () => { throw new Error("No chapters written yet in stories/doorway"); });
    const r = await callRoute(handleNextChapterRoutes, "/next-chapter/start", { dir: "stories/doorway" }, h);
    assert.equal(r.code, 400);
    assert.match(r.body.reason, /No chapters written yet/);
    assert.equal((await callRoute(handleNextChapterRoutes, "/next-chapter", {}, h, "GET")).body.active, false);
    assert.equal((await callRoute(handleNextChapterRoutes, "/next-chapter/say", { text: "go on" }, h)).body.reason, "no handoff is open");
  });

  it("will not rewrite the story a run is reading", async () => {
    LIVE.running = true;
    try {
      const r = await callRoute(handleNextChapterRoutes, "/next-chapter/start", { dir: "stories/doorway" }, host());
      assert.equal(r.code, 409);
      assert.match(r.body.reason, /a run is in flight/);
    } finally { LIVE.running = false; }
  });

  it("opens, proposes, and publishes the chapter it is preparing", async () => {
    const h = host(async () => session([{ edits: [{ field: "characters.ASTER.goal", value: "Leave." }] }]));
    const r = await quiet(() => callRoute(handleNextChapterRoutes, "/next-chapter/start", { dir: "stories/doorway" }, h));
    assert.equal(r.code, 200);
    assert.equal(r.body.active, true);
    assert.equal(r.body.chapter, 2);
    assert.equal(r.body.dir, "stories/doorway");
    assert.equal(r.body.edited, true);
    assert.equal(r.body.last.kind, "edits");
    assert.equal(r.body.spec.characters[0].goal, "Leave.");

    assert.equal((await callRoute(handleNextChapterRoutes, "/next-chapter/abandon", {}, h)).body.ok, true);
    assert.equal((await callRoute(handleNextChapterRoutes, "/next-chapter", {}, h, "GET")).body.active, false);
  });

  it("names an action it does not have instead of silently doing nothing", async () => {
    const r = await callRoute(handleNextChapterRoutes, "/next-chapter/write", {}, host());
    assert.equal(r.code, 404);
    assert.match(r.body.reason, /no such handoff action/);
  });
});

// -- SECTION ----
describe("readJsonBody", () => {
  it("resolves to {} when the body is empty", async () => {
    const req = fakeRequest(undefined);
    const result = await readJsonBody(req);
    assert.deepEqual(result, {});
  });

  it("parses valid JSON", async () => {
    const req = fakeRequest({ key: "value", num: 42 });
    const result = await readJsonBody(req);
    assert.deepEqual(result, { key: "value", num: 42 });
  });

  it("rejects malformed JSON with HttpError status 400", async () => {
    const req = fakeRawRequest("{invalid json");
    await assert.rejects(
      () => readJsonBody(req),
      (e: Error) => e instanceof HttpError && (e as HttpError).status === 400);
  });

  it("rejects a body over 1 MiB with HttpError status 413", async () => {
    const oversized = "x".repeat(1024 * 1024 + 1);
    const req = fakeRawRequest(oversized);
    await assert.rejects(
      () => readJsonBody(req),
      (e: Error) => e instanceof HttpError && (e as HttpError).status === 413);
  });

  it("accepts a missing Content-Type header (viewer's no-body POSTs send none)", async () => {
    const req = fakeRequest({ data: "test" });
    const result = await readJsonBody(req);
    assert.deepEqual(result, { data: "test" });
  });

  it("accepts Content-Type: application/json", async () => {
    const req = fakeRequest({ ok: true }, "POST", { "content-type": "application/json" });
    const result = await readJsonBody(req);
    assert.deepEqual(result, { ok: true });
  });

  it("rejects unsupported Content-Type like text/plain with HttpError status 400", async () => {
    const req = fakeRequest({ data: "test" }, "POST", { "content-type": "text/plain" });
    await assert.rejects(
      () => readJsonBody(req),
      (e: Error) => e instanceof HttpError && (e as HttpError).status === 400);
  });
});

// -- SECTION ----
describe("handleRunControl", () => {
  const host: ServerHost = {
    loadedModelIds: async () => ["qwen-new", "qwen-test", "qwen-old"],
  } as unknown as ServerHost;

  describe("/stop", () => {
    it("refuses when no run is in progress", async () => {
      resetLive(); LIVE.running = false;
      const r = await callRoute(handleRunControl, "/stop", {}, host);
      assert.equal(r.code, 400);
      assert.equal(r.body.reason, "no run in progress");
    });

    it("stops the first call and marks it as the first stop", async () => {
      resetLive(); LIVE.running = true; armRun();
      const r = await callRoute(handleRunControl, "/stop", {}, host);
      assert.equal(r.code, 200);
      assert.equal(r.body.ok, true);
      assert.equal(r.body.already, false, "first stop should return already: false");
      resetLive(); LIVE.running = false;
    });

    it("refuses a second stop rather than being a second stop", async () => {
      resetLive(); LIVE.running = true; armRun();
      await callRoute(handleRunControl, "/stop", {}, host);
      const r2 = await callRoute(handleRunControl, "/stop", {}, host);
      assert.equal(r2.code, 200);
      assert.equal(r2.body.ok, true);
      assert.equal(r2.body.already, true, "second stop should return already: true");
      resetLive(); LIVE.running = false;
    });

    it("clears pause-related state when stopping", async () => {
      resetLive(); LIVE.running = true; armRun(); LIVE.pausing = true; LIVE.paused = true;
      await callRoute(handleRunControl, "/stop", {}, host);
      assert.equal(LIVE.pausing, false);
      assert.equal(LIVE.paused, false);
      resetLive(); LIVE.running = false;
    });
  });

  describe("/pause", () => {
    it("refuses when no run is in progress", async () => {
      resetLive(); LIVE.running = false;
      const r = await callRoute(handleRunControl, "/pause", {}, host);
      assert.equal(r.code, 400);
      assert.equal(r.body.reason, "no run in progress");
    });

    it("sets pausing flag when run is in progress", async () => {
      resetLive(); LIVE.running = true; armRun();
      const r = await callRoute(handleRunControl, "/pause", {}, host);
      assert.equal(r.code, 200);
      assert.equal(r.body.ok, true);
      assert.equal(LIVE.pausing, true);
      resetLive(); LIVE.running = false;
    });

    it("returns already: true when already pausing", async () => {
      resetLive(); LIVE.running = true; armRun(); LIVE.pausing = true;
      const r = await callRoute(handleRunControl, "/pause", {}, host);
      assert.equal(r.code, 200);
      assert.equal(r.body.already, true);
      resetLive(); LIVE.running = false;
    });

    it("returns already: true when already paused", async () => {
      resetLive(); LIVE.running = true; armRun(); LIVE.paused = true;
      const r = await callRoute(handleRunControl, "/pause", {}, host);
      assert.equal(r.code, 200);
      assert.equal(r.body.already, true);
      resetLive(); LIVE.running = false;
    });
  });

  describe("/resume", () => {
    it("refuses when not paused", async () => {
      resetLive(); LIVE.running = false;
      const r = await callRoute(handleRunControl, "/resume", {}, host);
      assert.equal(r.code, 400);
      assert.equal(r.body.reason, "not paused");
    });

    it("clears the pausing flag when pausing", async () => {
      resetLive(); LIVE.pausing = true;
      const r = await callRoute(handleRunControl, "/resume", {}, host);
      assert.equal(r.code, 200);
      assert.equal(r.body.ok, true);
      assert.equal(LIVE.pausing, false);
      resetLive(); LIVE.running = false;
    });

    it("clears the paused flag and calls pauseResolve when paused", async () => {
      resetLive();
      let resolved = false;
      LIVE.paused = true;
      LIVE.pauseResolve = () => { resolved = true; };
      const r = await callRoute(handleRunControl, "/resume", {}, host);
      assert.equal(r.code, 200);
      assert.equal(LIVE.paused, false);
      assert.equal(resolved, true);
      resetLive(); LIVE.running = false;
    });
  });

  describe("/model", () => {
    it("sets modelOverride when no run is in progress", async () => {
      resetLive(); LIVE.running = false;
      const r = await callRoute(handleRunControl, "/model", { model: "qwen-test" }, host);
      assert.equal(r.code, 200);
      assert.equal(r.body.ok, true);
      assert.equal(LIVE.modelOverride, "qwen-test");
      LIVE.modelOverride = null;
    });

    it("clears modelOverride when given an empty model string", async () => {
      resetLive(); LIVE.running = false; LIVE.modelOverride = "qwen-test";
      const r = await callRoute(handleRunControl, "/model", { model: "" }, host);
      assert.equal(r.code, 200);
      assert.equal(r.body.ok, true);
      assert.equal(LIVE.modelOverride, null);
    });

    it("refuses to change model while run is active and not paused", async () => {
      resetLive(); LIVE.running = true; armRun();
      const r = await callRoute(handleRunControl, "/model", { model: "qwen-test" }, host);
      assert.equal(r.code, 400);
      assert.match(r.body.reason, /pause the run before/);
      resetLive(); LIVE.running = false;
    });

    it("allows model change when run is paused", async () => {
      resetLive(); LIVE.running = true; LIVE.paused = true; armRun();
      const r = await callRoute(handleRunControl, "/model", { model: "qwen-test" }, host);
      assert.equal(r.code, 200);
      assert.equal(r.body.ok, true);
      LIVE.modelOverride = null;
      resetLive(); LIVE.running = false;
    });

    it("updates writer and agents models when paused with live writer/agents", async () => {
      resetLive(); LIVE.running = true; LIVE.paused = true; armRun();
      const writer = new Agent("writer", "qwen-old", "system", 0.8);
      LIVE.writer = writer;
      LIVE.agents = new Map([["char", new Agent("char", "qwen-old", "system", 0.9)]]);
      const r = await callRoute(handleRunControl, "/model", { model: "qwen-new" }, host);
      assert.equal(r.code, 200);
      assert.equal(writer.model, "qwen-new");
      assert.equal(LIVE.agents.get("char")!.model, "qwen-new");
      LIVE.modelOverride = null;
      resetLive(); LIVE.running = false;
    });
  });

  describe("/interactive", () => {
    it("toggles interactive on", async () => {
      resetLive(); LIVE.interactive = false;
      const r = await callRoute(handleRunControl, "/interactive", { on: true }, host);
      assert.equal(r.code, 200);
      assert.equal(LIVE.interactive, true);
      resetLive(); LIVE.interactive = true;
    });

    it("toggles interactive off", async () => {
      resetLive(); LIVE.interactive = true;
      const r = await callRoute(handleRunControl, "/interactive", { on: false }, host);
      assert.equal(r.code, 200);
      assert.equal(LIVE.interactive, false);
      resetLive(); LIVE.interactive = true;
    });

    it("disarms reader when interactive is turned off", async () => {
      resetLive(); LIVE.interactive = true; LIVE.readerArmed = true;
      const r = await callRoute(handleRunControl, "/interactive", { on: false }, host);
      assert.equal(r.code, 200);
      assert.equal(LIVE.readerArmed, false);
      resetLive(); LIVE.interactive = true;
    });
  });

  describe("/consult-me (reader consult seat)", () => {
    it("refuses when no run is in progress", async () => {
      resetLive(); LIVE.running = false;
      const r = await callRoute(handleRunControl, "/consult-me", {}, host);
      assert.equal(r.code, 400);
      assert.equal(r.body.reason, "no run in progress");
    });

    it("refuses when interactive is off", async () => {
      resetLive(); LIVE.running = true; armRun(); LIVE.interactive = false;
      const r = await callRoute(handleRunControl, "/consult-me", {}, host);
      assert.equal(r.code, 400);
      assert.equal(r.body.reason, "interactive is off");
      LIVE.interactive = true;
      resetLive(); LIVE.running = false;
    });

    it("arms the reader when run is active and interactive", async () => {
      resetLive(); LIVE.running = true; armRun();
      const r = await callRoute(handleRunControl, "/consult-me", {}, host);
      assert.equal(r.code, 200);
      assert.equal(r.body.ok, true);
      assert.equal(LIVE.readerArmed, true);
      resetLive(); LIVE.running = false;
    });

    it("returns already: true if reader is already armed", async () => {
      resetLive(); LIVE.running = true; armRun(); LIVE.readerArmed = true;
      const r = await callRoute(handleRunControl, "/consult-me", {}, host);
      assert.equal(r.code, 200);
      assert.equal(r.body.already, true);
      resetLive(); LIVE.running = false;
    });

    it("returns already: true if reader has a resolve callback", async () => {
      resetLive(); LIVE.running = true; armRun(); LIVE.readerResolve = () => {};
      const r = await callRoute(handleRunControl, "/consult-me", {}, host);
      assert.equal(r.code, 200);
      assert.equal(r.body.already, true);
      LIVE.readerResolve = null;
      resetLive(); LIVE.running = false;
    });
  });

  describe("/reader-answer", () => {
    it("refuses when no reader prompt is pending", async () => {
      resetLive();
      const r = await callRoute(handleRunControl, "/reader-answer", { answer: "test" }, host);
      assert.equal(r.code, 400);
      assert.equal(r.body.reason, "no reader prompt pending");
    });

    it("refuses an empty answer", async () => {
      resetLive();
      let answered = false;
      LIVE.readerResolve = () => { answered = true; };
      const r = await callRoute(handleRunControl, "/reader-answer", { answer: "" }, host);
      assert.equal(r.code, 400);
      assert.equal(r.body.reason, "empty answer");
      assert.equal(answered, false);
      resetLive();
    });

    it("accepts and resolves a non-empty answer", async () => {
      resetLive();
      let answer = "";
      LIVE.readerResolve = (a: string) => { answer = a; };
      const r = await callRoute(handleRunControl, "/reader-answer", { answer: "  the answer  " }, host);
      assert.equal(r.code, 200);
      assert.equal(r.body.ok, true);
      assert.equal(answer, "the answer");
      assert.equal(LIVE.readerResolve, null, "readerResolve should be cleared after resolving");
      resetLive();
    });
  });

  it("returns false for routes it does not handle", async () => {
    const r = await callRoute(handleRunControl, "/unknown-route", {}, host);
    assert.equal(r.handled, false);
  });

  it("only handles POST and GET methods", async () => {
    resetLive(); LIVE.running = true; armRun();
    const rPut = await callRoute(handleRunControl, "/stop", {}, host, "PUT");
    assert.equal(rPut.handled, false);
    resetLive();
  });
});
