/** Routes for the HTTP server: next-chapter handoff and run control. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";

import { normalizeSpec } from "../engine/story-spec.ts";
import { NextChapterSession } from "../engine/architect.ts";
import { Agent } from "../engine/agent.ts";
import type { Defaults } from "../engine/story-format.ts";
import { LIVE, resetLive, armRun } from "../live.ts";
import { handleNextChapterRoutes } from "../server/next-chapter-routes.ts";
import { handleRunControl } from "../server/run-control-routes.ts";
import { handleRunLogRoutes } from "../server/run-log-routes.ts";
import { HttpError, readJsonBody } from "../server/http-util.ts";
import type { ServerHost } from "../server/server.ts";
import { callRoute, callGet, fakeRequest, fakeRawRequest, quiet, ScriptedAgent, makeHost } from "./helpers.ts";

// Constants needed by tests
const SCAFFOLD_DEFAULTS: Defaults = {
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

  const host = (open?: () => Promise<NextChapterSession>): ServerHost => makeHost({
    storyCards: async () => [],
    selectableStory: async (dir: string) => (dir === "stories/doorway" ? "stories/doorway" : null),
    resolveStoryDir: (dir: string) => dir,
    runDirs: async () => [],
    availableModelIds: async () => null,
    architectModel: async () => "none",
    newScaffoldSession: async () => { throw new Error("not in this test"); },
    newHandoffSession: async (dir: string) => { opened.push(dir); return open ? open() : session([]); },
    directEdit: () => ({ ok: false, reason: "not in this test" }),
    specView: (s: unknown) => s,
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

// -- ABANDON VERSUS WORK IN FLIGHT -----------------------------------------
// An abandon landing while a handoff round is still awaiting must strip that round of its
// right to commit: no resurrected session, no success report, no lock left behind.
  const yieldMicrotasks = () => new Promise(r => setTimeout(r, 0));

  it("abandon during start means the arriving session is discarded, not resurrected", async () => {
    let release!: (s: NextChapterSession) => void;
    const gated = new Promise<NextChapterSession>(r => { release = r; });
    const h = host(() => gated);
    try {
      const startP = callRoute(handleNextChapterRoutes, "/next-chapter/start", { dir: "stories/doorway" }, h);
      await yieldMicrotasks();
      await callRoute(handleNextChapterRoutes, "/next-chapter/abandon", {}, h);
      release(session([]));
      const started = await startP;

      assert.equal(started.code, 409);
      assert.match(started.body.reason, /abandoned/);
      const state = await callRoute(handleNextChapterRoutes, "/next-chapter", {}, h, "GET");
      assert.equal(state.body.active, false);
    } finally { LIVE.storyLock = null; }
  });

  it("abandon during accept neither claims success nor leaves the story locked", async () => {
    let fireAccept!: (r: unknown) => void;
    const gated = new Promise(r => { fireAccept = r; });
    const hanging = {
      dir: "stories/doorway", chapter: 2, edited: true, pendingAsk: null, problems: [],
      defaults: SCAFFOLD_DEFAULTS, spec,
      propose: async () => ({ kind: "edits" }),
      say: async () => ({ kind: "edits" }),
      accept: () => gated,
    } as unknown as NextChapterSession;
    const h = host(async () => hanging);
    try {
      const opened = await quiet(() => callRoute(handleNextChapterRoutes, "/next-chapter/start", { dir: "stories/doorway" }, h));
      assert.equal(opened.body.active, true);
      assert.match(String(LIVE.storyLock), /handoff is open/, "an open handoff holds the story");

      const acceptP = callRoute(handleNextChapterRoutes, "/next-chapter/accept", {}, h);
      await yieldMicrotasks();
      await callRoute(handleNextChapterRoutes, "/next-chapter/abandon", {}, h);
      fireAccept({ kind: "written", chapter: 2, dir: "stories/doorway", files: [], warnings: [] });
      const accepted = await acceptP;

      assert.equal(accepted.code, 409);
      assert.match(accepted.body.reason, /abandoned while accepting/);
      assert.equal(LIVE.storyLock, null);
      const state = await callRoute(handleNextChapterRoutes, "/next-chapter", {}, h, "GET");
      assert.equal(state.body.active, false);
    } finally { LIVE.storyLock = null; }
  });

  it("keeps the story locked through an accept that an abandon overtook", async () => {
    // The write is what the lock is for. Abandon must not release it under an accept still inside
    // writeFile/preflight/restore, or an editor save could land in that window and the
    // restore-on-failure would erase it. The abandoned accept releases the lock on its way out.
    let fireAccept!: (r: unknown) => void;
    const gated = new Promise(r => { fireAccept = r; });
    const hanging = {
      dir: "stories/doorway", chapter: 2, edited: true, pendingAsk: null, problems: [],
      defaults: SCAFFOLD_DEFAULTS, spec,
      propose: async () => ({ kind: "edits" }),
      say: async () => ({ kind: "edits" }),
      accept: () => gated,
    } as unknown as NextChapterSession;
    const h = host(async () => hanging);
    try {
      await quiet(() => callRoute(handleNextChapterRoutes, "/next-chapter/start", { dir: "stories/doorway" }, h));
      const acceptP = callRoute(handleNextChapterRoutes, "/next-chapter/accept", {}, h);
      await yieldMicrotasks();
      await callRoute(handleNextChapterRoutes, "/next-chapter/abandon", {}, h);

      // Sampled, not asserted, while the write is still gated: asserting here would leave `acceptP`
      // pending forever on failure and hang the runner instead of reporting it.
      const lockedMidWrite = LIVE.storyLock;
      fireAccept({ kind: "written", chapter: 2, dir: "stories/doorway", files: [], warnings: [] });
      await acceptP;

      assert.ok(lockedMidWrite, "abandon must not unlock a story an accept is still writing");
      assert.equal(LIVE.storyLock, null, "the abandoned accept releases the lock when its write is done");
    } finally { LIVE.storyLock = null; }
  });

  it("an open handoff blocks the story editor's save until it ends", async () => {
    const h = host(async () => session([{ edits: [{ field: "characters.ASTER.goal", value: "Leave." }] }]));
    const { handleStoryEditRoutes } = await import("../server/story-edit-routes.ts");
    const editHost = makeHost({
      selectableStory: h.selectableStory,
      saveStory: async () => ({ ok: true, warnings: [] }),
    });
    try {
      await quiet(() => callRoute(handleNextChapterRoutes, "/next-chapter/start", { dir: "stories/doorway" }, h));
      assert.ok(LIVE.storyLock);

      const save = await callRoute(handleStoryEditRoutes, "/story/save",
        { dir: "stories/doorway", story: {} }, editHost);
      assert.equal(save.code, 409);
      assert.match(save.body.reason, /handoff is open/);

      await callRoute(handleNextChapterRoutes, "/next-chapter/abandon", {}, h);
      const after = await callRoute(handleStoryEditRoutes, "/story/save",
        { dir: "stories/doorway", story: {} }, editHost);
      assert.equal(after.code, 200, "abandoning the handoff releases the lock");
    } finally { LIVE.storyLock = null; }
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

  it("reassembles a multi-byte UTF-8 char split across Buffer chunks", async () => {
    // "é" is 0xC3 0xA9; split the body so one byte lands in each chunk, as a socket can.
    const bytes = Buffer.from(JSON.stringify({ s: "é" }), "utf8");
    const cut = bytes.indexOf(0xa9);
    const req = Readable.from([bytes.subarray(0, cut), bytes.subarray(cut)]) as unknown as IncomingMessage;
    (req as { method?: string }).method = "POST";
    const result = await readJsonBody(req);
    assert.deepEqual(result, { s: "é" });
  });
});

// -- SECTION ----
describe("handleRunControl", () => {
  const host: ServerHost = makeHost({
    availableModelIds: async () => ["qwen-new", "qwen-test", "qwen-old"],
  });

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

  describe("/continue", () => {
    it("refuses when nothing is waiting on a budget decision", async () => {
      resetLive();
      const r = await callRoute(handleRunControl, "/continue", { steps: 8 }, host);
      assert.equal(r.code, 400);
      assert.equal(r.body.reason, "no run is waiting on a budget decision");
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

// -- SECTION ----
describe("/runs/llm routes", () => {
  const host: ServerHost = makeHost({
    selectableStory: async (d: string) => d.startsWith("stories/") ? d : null,
    resolveStoryDir: (d: string) => "/resolved/" + d,
    runDirs: async () => ["run-1"],
    runLlmLogs: async () => [{ file: "writer.jsonl", agent: "WRITER", role: "writer", models: ["m1"], calls: 3, promptChars: 100, responseChars: 20 }],
    readLlmLog: async (_dir: string, _id: string, file: string) => file === "writer.jsonl" ? '{"ts":"t1"}\n{"ts":"t2"}' : null,
  });

  it("is not one of its routes", async () => {
    const r = await callGet(handleRunLogRoutes, "/nope?dir=stories/x&id=run-1", host);
    assert.equal(r.handled, false);
  });

  it("refuses a story it did not discover", async () => {
    const r = await callGet(handleRunLogRoutes, "/runs/llm?dir=../elsewhere&id=run-1", host);
    assert.equal(r.code, 400);
    assert.match(r.json().reason, /no such story/);
  });

  it("refuses a run the story does not have", async () => {
    const r = await callGet(handleRunLogRoutes, "/runs/llm?dir=stories/doorway&id=nope", host);
    assert.equal(r.code, 404);
    assert.match(r.json().reason, /no such run/);
  });

  it("lists a run's transcripts", async () => {
    const r = await callGet(handleRunLogRoutes, "/runs/llm?dir=stories/doorway&id=run-1", host);
    assert.equal(r.code, 200);
    const body = r.json();
    assert.equal(body.logs.length, 1);
    assert.equal(body.logs[0].agent, "WRITER");
    assert.equal(body.logs[0].calls, 3);
  });

  it("serves one transcript as ndjson", async () => {
    const r = await callGet(handleRunLogRoutes, "/runs/llm/file?dir=stories/doorway&id=run-1&file=writer.jsonl", host);
    assert.equal(r.code, 200);
    assert.equal(r.headers["Content-Type"], "application/x-ndjson");
    assert.equal(r.text.split("\n").filter((l: string) => l).length, 2);
  });

  it("refuses a transcript the run does not have", async () => {
    // The engine's listing is the allowlist; the route never validates the name itself.
    const r = await callGet(handleRunLogRoutes, "/runs/llm/file?dir=stories/doorway&id=run-1&file=../writing-log.jsonl", host);
    assert.equal(r.code, 404);
    assert.match(r.json().reason, /no such transcript/);
  });
});

// -- SECTION ----
describe("/runs/log", () => {
  const hostAt = (base: string): ServerHost => makeHost({
    selectableStory: async (d: string) => d.startsWith("stories/") ? d : null,
    resolveStoryDir: () => base,
    runDirs: async () => ["run-1"],
  });

  it("refuses a story it did not discover", async () => {
    const r = await callGet(handleRunLogRoutes, "/runs/log?dir=../elsewhere&id=run-1", hostAt("/nowhere"));
    assert.equal(r.code, 400);
    assert.match(r.json().reason, /no such story/);
  });

  it("refuses a run the story does not have", async () => {
    const r = await callGet(handleRunLogRoutes, "/runs/log?dir=stories/doorway&id=nope", hostAt("/nowhere"));
    assert.equal(r.code, 404);
    assert.match(r.json().reason, /no such run/);
  });

  it("serves a retained run's writing log as ndjson", async () => {
    const base = await mkdtemp(join(tmpdir(), "runslog-"));
    try {
      await mkdir(join(base, "out", "run-1"), { recursive: true });
      await writeFile(join(base, "out", "run-1", "writing-log.jsonl"), '{"a":1}\n{"a":2}', "utf8");
      const r = await callGet(handleRunLogRoutes, "/runs/log?dir=stories/doorway&id=run-1", hostAt(base));
      assert.equal(r.code, 200);
      assert.equal(r.headers["Content-Type"], "application/x-ndjson");
      assert.equal(r.text.split("\n").filter((l: string) => l).length, 2);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("404s when the run folder has no writing log", async () => {
    const base = await mkdtemp(join(tmpdir(), "runslog-"));
    try {
      await mkdir(join(base, "out", "run-1"), { recursive: true });
      const r = await callGet(handleRunLogRoutes, "/runs/log?dir=stories/doorway&id=run-1", hostAt(base));
      assert.equal(r.code, 404);
      assert.match(r.json().reason, /no writing log/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

// -- SECTION ----
describe("/log.jsonl", () => {
  it("404s before a run has an output folder", async () => {
    const host = makeHost({ outDir: () => "" });
    const r = await callGet(handleRunLogRoutes, "/log.jsonl", host);
    assert.equal(r.code, 404);
    assert.match(r.json().reason, /no run yet/);
  });

  it("serves the in-progress run's writing log as ndjson", async () => {
    const out = await mkdtemp(join(tmpdir(), "logjsonl-"));
    try {
      await writeFile(join(out, "writing-log.jsonl"), '{"a":1}\n{"a":2}\n{"a":3}', "utf8");
      const host = makeHost({ outDir: () => out });
      const r = await callGet(handleRunLogRoutes, "/log.jsonl", host);
      assert.equal(r.code, 200);
      assert.equal(r.headers["Content-Type"], "application/x-ndjson");
      assert.equal(r.text.split("\n").filter((l: string) => l).length, 3);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});
