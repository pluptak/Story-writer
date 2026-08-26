/** Story edit routes: read, validate, and save story.json through the HTTP surface.
 *  Also tests the /story/suggest endpoint and edge cases from plan 5. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { LIVE, resetLive, armRun } from "../live.ts";
import { handleStoryEditRoutes } from "../server/story-edit-routes.ts";
import type { ServerHost } from "../server/server.ts";
import { callRoute, callGet } from "./helpers.ts";

const DOORWAY = {
  title: "The Fog Signal",
  premise: "Two keepers, one lamp, and a night that did not happen the way the log says it did.",
  scenes: [{ place: "the lamp room", question: "Does Aster admit the signal never fired?", pov: "ASTER", length: 700, roster: [] as string[], reach: {} as Record<string, string[]> }],
  writerStyle: "Plain sentences.",
  facts: [] as string[],
  characters: [
    { name: "ASTER", model: "", persona: "Keeps the log.", knows: "The signal did not fire.", goal: "", belief: "", impulse: "", voice: [] as string[], skills: [] as string[], restrictions: [] },
    { name: "BRAE", model: "", persona: "Came up from the boats.", knows: "", goal: "", belief: "", impulse: "", voice: [] as string[], skills: [] as string[], restrictions: ["hearing"] },
  ],
  config: { retries: 2, clarifications: 2, maxSteps: 24, maxProseWords: 140, stream: true, debug: false,
            requestTimeout: 120, attempts: 3, maxTokens: 2000,
            thinking: { writer: "default", character: "default", summary: "default" } } as const,
  models: { default: "none" },
};

let suggestCalls = 0;

function makeHost(overrides?: Partial<ServerHost>): ServerHost {
  return {
    selectableStory: async (d: string) => (d === "stories/doorway" || d === "doorway" ? "stories/doorway" : null),
    storyForEdit: async (dir: string) => {
      if (dir !== "stories/doorway") return { ok: false, error: "not found" };
      const parsed = {
        title: DOORWAY.title,
        premise: DOORWAY.premise,
        scenes: DOORWAY.scenes,
        writerStyle: DOORWAY.writerStyle,
        facts: DOORWAY.facts,
        characters: DOORWAY.characters,
        config: {},
        models: {},
      };
      return { ok: true, story: parsed, warnings: [] };
    },
    checkStory: (story: any) => {
      if (story.simulatedError) return { ok: false, error: "validation failed", issues: [{ path: "title", message: "Required" }] };
      return { ok: true, warnings: [] };
    },
    saveStory: async (dir: string, _story: any) => {
      if (dir !== "stories/doorway") return { ok: false, reason: "not found" };
      if (_story._simulateWriteFailure) return { ok: false, reason: "write failed: disk full" };
      if (_story._simulateCorruptWrite) return { ok: false, reason: "saved but does not load: Premise is empty" };
      return { ok: true, warnings: [] };
    },
    suggestEdits: async (_spec: unknown, text: string) => {
      suggestCalls++;
      if (text === "fail") return { ok: false, error: "architect error" };
      if (text.startsWith("ask")) return { ok: true, kind: "question", ask: "What do you mean?" };
      return {
        ok: true, kind: "edits",
        applied: [{ field: "title", before: "old", after: "new" }],
        ignored: [],
        problems: [],
        note: "",
      };
    },
    // Unused by these routes
    storyCards: async () => [],
    resolveStoryDir: (d: string) => d,
    runDirs: async () => [],
    runLlmLogs: async () => [],
    readLlmLog: async () => null,
    writtenChapters: async () => [],
    loadedModelIds: async () => null,
    architectModel: async () => "none",
    newScaffoldSession: async () => { throw new Error("unused"); },
    newHandoffSession: async () => { throw new Error("unused"); },
    directEdit: () => ({ ok: false, reason: "unused" }),
    specView: (s: unknown) => s,
    outDir: () => "",
    ...overrides,
  } as unknown as ServerHost;
}

// -- SECTION ----
describe("/story/edit (GET)", () => {
  it("leaves other paths alone", async () => {
    const r = await callGet(handleStoryEditRoutes, "/stories?x=1", makeHost());
    assert.equal(r.handled, false);
  });

  it("refuses a story it did not discover", async () => {
    const r = await callGet(handleStoryEditRoutes, "/story/edit?dir=../elsewhere", makeHost());
    assert.equal(r.code, 400);
    assert.match(r.json().reason, /no such story/);
  });

  it("refuses while a run is in flight", async () => {
    resetLive(); LIVE.running = true; armRun();
    try {
      const r = await callGet(handleStoryEditRoutes, "/story/edit?dir=doorway", makeHost());
      assert.equal(r.code, 409);
      assert.match(r.json().reason, /run is in flight/);
    } finally { LIVE.running = false; resetLive(); }
  });

  it("refuses while a story is loading, not only while a run is in flight", async () => {
    // The window between /select and the run actually starting: running is still false here.
    resetLive(); LIVE.loading = true;
    try {
      const edit = await callGet(handleStoryEditRoutes, "/story/edit?dir=doorway", makeHost());
      assert.equal(edit.code, 409);
      assert.match(edit.json().reason, /story is loading/);

      const save = await callRoute(handleStoryEditRoutes, "/story/save", { dir: "doorway", story: DOORWAY }, makeHost());
      assert.equal(save.code, 409);
      assert.match(save.body.reason, /story is loading/);

      const discard = await callRoute(handleStoryEditRoutes, "/story/discard", { dir: "doorway", n: 1 }, makeHost());
      assert.equal(discard.code, 409);
      assert.match(discard.body.reason, /story is loading/);

      const suggest = await callRoute(handleStoryEditRoutes, "/story/suggest", { spec: DOORWAY, text: "x" }, makeHost());
      assert.equal(suggest.code, 409);
      assert.match(suggest.body.reason, /story is loading/);
    } finally { LIVE.loading = false; resetLive(); }
  });

  it("loads a valid story", async () => {
    const r = await callGet(handleStoryEditRoutes, "/story/edit?dir=doorway", makeHost());
    assert.equal(r.code, 200);
    const body = r.json();
    assert.equal(body.ok, true);
    assert.equal(body.story.title, "The Fog Signal");
    assert.equal(body.story.characters.length, 2);
  });

  it("returns warnings alongside the story", async () => {
    const h = makeHost({
      storyForEdit: async (_dir: string) => ({
        ok: true as const,
        story: DOORWAY,
        warnings: ["Scene 1 has no question"],
      }),
    });
    const r = await callGet(handleStoryEditRoutes, "/story/edit?dir=doorway", h);
    const body = r.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.warnings, ["Scene 1 has no question"]);
  });

  it("returns a malformed story with raw content for the editor to show", async () => {
    const h = makeHost({
      storyForEdit: async () => ({ ok: false as const, error: "could not read", raw: { title: "broken" } }),
    });
    const r = await callGet(handleStoryEditRoutes, "/story/edit?dir=doorway", h);
    const body = r.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, "could not read");
    assert.deepEqual(body.raw, { title: "broken" });
  });
});

// -- SECTION ----
describe("/story/check (POST)", () => {
  it("validates a good story", async () => {
    const r = await callRoute(handleStoryEditRoutes, "/story/check", { story: DOORWAY }, makeHost());
    assert.equal(r.code, 200);
    assert.equal(r.body.ok, true);
  });

  it("reports validation failures", async () => {
    const r = await callRoute(handleStoryEditRoutes, "/story/check", { story: { simulatedError: true } }, makeHost());
    assert.equal(r.code, 200);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error, "validation failed");
    assert.equal(r.body.issues[0].path, "title");
  });

  it("accepts missing scenes array (Zod prefault creates one)", async () => {
    const r = await callRoute(handleStoryEditRoutes, "/story/check", {
      story: { premise: "test", characters: [{ name: "X" }] },
    }, makeHost());
    assert.equal(r.code, 200);
    assert.equal(r.body.ok, true);
  });

  it("validates and saves a scene carrying reach", async () => {
    const withReach = {
      ...structuredClone(DOORWAY),
      scenes: [{ ...DOORWAY.scenes[0],
        reach: { ASTER: ["cameras :: perceiving through the lamp room cameras", "doors"] } }],
    };
    const check = await callRoute(handleStoryEditRoutes, "/story/check", { story: withReach }, makeHost());
    assert.equal(check.code, 200);
    assert.equal(check.body.ok, true);

    const saved = await callRoute(handleStoryEditRoutes, "/story/save",
      { dir: "doorway", story: withReach }, makeHost());
    assert.equal(saved.code, 200);
    assert.equal(saved.body.ok, true);
  });
});

// -- SECTION ----
describe("/story/save (POST)", () => {
  it("refuses a story it did not discover", async () => {
    const r = await callRoute(handleStoryEditRoutes, "/story/save", { dir: "../elsewhere", story: DOORWAY }, makeHost());
    assert.equal(r.code, 400);
    assert.match(r.body.reason, /no such story/);
  });

  it("refuses while a run is in flight", async () => {
    resetLive(); LIVE.running = true; armRun();
    try {
      const r = await callRoute(handleStoryEditRoutes, "/story/save", { dir: "doorway", story: DOORWAY }, makeHost());
      assert.equal(r.code, 409);
      assert.match(r.body.reason, /run is in flight/);
    } finally { LIVE.running = false; resetLive(); }
  });

  it("saves a valid story", async () => {
    const r = await callRoute(handleStoryEditRoutes, "/story/save", { dir: "doorway", story: DOORWAY }, makeHost());
    assert.equal(r.code, 200);
    assert.equal(r.body.ok, true);
  });

  it("rejects save of invalid data at the host level", async () => {
    const h = makeHost({
      saveStory: async () => ({ ok: false, reason: "validation failed" }),
    });
    const r = await callRoute(handleStoryEditRoutes, "/story/save", { dir: "doorway", story: { bad: true } }, h);
    assert.equal(r.code, 400);
    assert.equal(r.body.ok, false);
    assert.match(r.body.reason, /validation/);
  });

  it("rejects save with empty premise", async () => {
    const h = makeHost({
      saveStory: async () => ({ ok: false, reason: "Premise is empty" }),
    });
    const r = await callRoute(handleStoryEditRoutes, "/story/save", { dir: "doorway", story: { ...DOORWAY, premise: "" } }, h);
    assert.equal(r.code, 400);
    assert.equal(r.body.ok, false);
    assert.match(r.body.reason, /Premise is empty/);
  });

  it("rejects save with no characters", async () => {
    const h = makeHost({
      saveStory: async () => ({ ok: false, reason: "No characters defined" }),
    });
    const r = await callRoute(handleStoryEditRoutes, "/story/save", { dir: "doorway", story: { ...DOORWAY, characters: [] } }, h);
    assert.equal(r.code, 400);
    assert.equal(r.body.ok, false);
    assert.match(r.body.reason, /No characters/);
  });

  it("reports write failures", async () => {
    const h = makeHost({
      saveStory: async () => ({ ok: false, reason: "write failed: disk full" }),
    });
    const r = await callRoute(handleStoryEditRoutes, "/story/save", { dir: "doorway", story: { ...DOORWAY, _simulateWriteFailure: true } }, h);
    assert.equal(r.code, 400);
    assert.equal(r.body.ok, false);
    assert.match(r.body.reason, /write failed/);
  });

  it("reports corrupt write (write succeeds but re-load fails)", async () => {
    const h = makeHost({
      saveStory: async () => ({ ok: false, reason: "saved but does not load: Premise is empty" }),
    });
    const r = await callRoute(handleStoryEditRoutes, "/story/save", { dir: "doorway", story: { ...DOORWAY, _simulateCorruptWrite: true } }, h);
    assert.equal(r.code, 400);
    assert.equal(r.body.ok, false);
    assert.match(r.body.reason, /does not load/);
  });

  it("warnings accompany a successful save", async () => {
    const h = makeHost({
      saveStory: async () => ({ ok: true, warnings: ["Scene 1 has no question"] }),
    });
    const r = await callRoute(handleStoryEditRoutes, "/story/save", { dir: "doorway", story: DOORWAY }, h);
    assert.equal(r.code, 200);
    assert.equal(r.body.ok, true);
    assert.deepEqual(r.body.warnings, ["Scene 1 has no question"]);
  });
});

// -- SECTION ----
describe("/story/suggest (POST)", () => {
  it("returns edits from the architect", async () => {
    suggestCalls = 0;
    const r = await callRoute(handleStoryEditRoutes, "/story/suggest",
      { spec: DOORWAY, text: "make it darker" }, makeHost());
    assert.equal(r.code, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.kind, "edits");
    assert.equal(r.body.applied[0].field, "title");
  });

  it("returns a question when the architect needs more", async () => {
    const r = await callRoute(handleStoryEditRoutes, "/story/suggest",
      { spec: DOORWAY, text: "ask something" }, makeHost());
    assert.equal(r.code, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.kind, "question");
    assert.equal(r.body.ask, "What do you mean?");
  });

  it("returns an error when the architect fails", async () => {
    const r = await callRoute(handleStoryEditRoutes, "/story/suggest",
      { spec: DOORWAY, text: "fail" }, makeHost());
    assert.equal(r.code, 200);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error, "architect error");
  });

  it("passes an empty text safely", async () => {
    suggestCalls = 0;
    const r = await callRoute(handleStoryEditRoutes, "/story/suggest",
      { spec: DOORWAY, text: "" }, makeHost());
    assert.equal(r.code, 200);
    assert.equal(r.body.ok, true);
    // Host side treats empty string as valid input
    assert.equal(suggestCalls, 1);
  });

  it("refuses while a run is in flight, without touching the architect", async () => {
    resetLive(); LIVE.running = true; armRun(); suggestCalls = 0;
    try {
      const r = await callRoute(handleStoryEditRoutes, "/story/suggest",
        { spec: DOORWAY, text: "make it darker" }, makeHost());
      assert.equal(r.code, 409);
      assert.match(r.body.reason, /run is in flight/);
      assert.equal(suggestCalls, 0);
    } finally { LIVE.running = false; resetLive(); }
  });
});

// -- SECTION ----
describe("route dispatch edge cases", () => {
  it("returns false for routes it does not handle", async () => {
    const r = await callRoute(handleStoryEditRoutes, "/scaffold/say", {}, makeHost());
    assert.equal(r.handled, false);
  });

  it("returns false for /story/save GET (not POST)", async () => {
    const r = await callGet(handleStoryEditRoutes, "/story/save?dir=doorway", makeHost());
    assert.equal(r.handled, false);
  });

  it("returns false for /story/edit POST (not GET)", async () => {
    const r = await callRoute(handleStoryEditRoutes, "/story/edit", {}, makeHost(), "POST");
    assert.equal(r.handled, false);
  });
});