/** Story read routes: read-only views of a story's authored definition. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LIVE, resetLive } from "../live.ts";
import { handleStoryReadRoutes } from "../server/story-read-routes.ts";
import type { ServerHost } from "../server/server.ts";
import { callGet } from "./helpers.ts";

let castFails = false;

function makeHost(overrides?: Partial<ServerHost>): ServerHost {
  return {
    selectableStory: async (d: string) => (d === "stories/doorway" || d === "doorway" ? "stories/doorway" : null),
    fullCast: async (dir: string) => {
      if (castFails) {
        return { ok: false, error: "cannot parse" };
      }
      if (dir !== "stories/doorway") return { ok: false, error: "not found" };
      return {
        ok: true,
        characters: [
          {
            name: "ASTER",
            persona: "Keeps the log.",
            knows: "The signal did not fire.",
            goal: "",
            skills: [{ text: "lockpicking", meaning: "" }],
            restrictions: [],
          },
          {
            name: "BRAE",
            persona: "Came up from the boats.",
            knows: "",
            goal: "",
            skills: [],
            restrictions: ["hearing"],
          },
        ],
      };
    },
    // Unused by these routes
    storyCards: async () => [],
    storyForEdit: async () => ({ ok: false, error: "unused" }),
    checkStory: () => ({ ok: true, warnings: [] }),
    saveStory: async () => ({ ok: true, warnings: [] }),
    suggestEdits: async () => ({ ok: false, error: "unused" }),
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

describe("/cast (GET)", () => {
  it("leaves other paths alone", async () => {
    const r = await callGet(handleStoryReadRoutes, "/nope?x=1", makeHost());
    assert.equal(r.handled, false);
  });

  it("refuses a story it did not discover", async () => {
    const r = await callGet(handleStoryReadRoutes, "/cast?dir=../elsewhere", makeHost());
    assert.equal(r.code, 400);
    assert.match(r.json().reason, /no such story/);
  });

  it("returns the full cast", async () => {
    const r = await callGet(handleStoryReadRoutes, "/cast?dir=doorway", makeHost());
    assert.equal(r.code, 200);
    assert.equal(r.json().ok, true);
    assert.equal(r.json().characters.length, 2);
    assert.equal(r.json().characters[0].name, "ASTER");
    assert.equal(r.json().characters[0].knows, "The signal did not fire.");
  });

  it("omits each character's model", async () => {
    const r = await callGet(handleStoryReadRoutes, "/cast?dir=doorway", makeHost());
    assert.equal(r.json().ok, true);
    for (const ch of r.json().characters) {
      assert.ok(!("model" in ch));
    }
  });

  it("shapes skills as {text, meaning}", async () => {
    const r = await callGet(handleStoryReadRoutes, "/cast?dir=doorway", makeHost());
    assert.equal(r.json().characters[0].skills[0].text, "lockpicking");
    assert.equal(typeof r.json().characters[0].skills[0].meaning, "string");
  });

  it("reports a story that will not load", async () => {
    castFails = true;
    try {
      const r = await callGet(handleStoryReadRoutes, "/cast?dir=doorway", makeHost());
      assert.equal(r.code, 200);
      assert.equal(r.json().ok, false);
      assert.ok(typeof r.json().error === "string" && r.json().error.length > 0);
    } finally {
      castFails = false;
    }
  });

  it("answers while a run is in flight", async () => {
    resetLive();
    LIVE.running = true;
    try {
      const r = await callGet(handleStoryReadRoutes, "/cast?dir=doorway", makeHost());
      assert.equal(r.code, 200);
      assert.equal(r.json().ok, true);
    } finally {
      LIVE.running = false;
      resetLive();
    }
  });
});

describe("/stories (GET)", () => {
  it("returns the story cards", async () => {
    const host = makeHost({ storyCards: async () => [{ dir: "stories/doorway", name: "Doorway", ok: true, warnings: [] }] as never });
    const r = await callGet(handleStoryReadRoutes, "/stories", host);
    assert.equal(r.code, 200);
    assert.equal(r.json().stories.length, 1);
    assert.equal(r.json().stories[0].name, "Doorway");
  });

  it("reflects whether the session is awaiting a pick", async () => {
    resetLive();
    LIVE.awaitingPick = true;
    try {
      const r = await callGet(handleStoryReadRoutes, "/stories", makeHost());
      assert.equal(r.json().picking, true);
    } finally {
      resetLive();
    }
  });
});

describe("/chapter (GET)", () => {
  it("refuses a story it did not discover", async () => {
    const r = await callGet(handleStoryReadRoutes, "/chapter?dir=../elsewhere&n=1", makeHost());
    assert.equal(r.code, 400);
    assert.match(r.json().reason, /no such story/);
  });

  it("refuses a chapter that is not written", async () => {
    const host = makeHost({ writtenChapters: async () => [1] });
    const r = await callGet(handleStoryReadRoutes, "/chapter?dir=doorway&n=2", host);
    assert.equal(r.code, 404);
    assert.match(r.json().reason, /no such chapter/);
  });

  it("serves a written chapter's markdown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chapter-"));
    try {
      await mkdir(join(dir, "chapters"), { recursive: true });
      await writeFile(join(dir, "chapters", "1.md"), "# Chapter one\n\nprose.", "utf8");
      const host = makeHost({ resolveStoryDir: () => dir, writtenChapters: async () => [1] });
      const r = await callGet(handleStoryReadRoutes, "/chapter?dir=doorway&n=1", host);
      assert.equal(r.code, 200);
      assert.equal(r.headers["Content-Type"], "text/markdown; charset=utf-8");
      assert.match(r.text, /Chapter one/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
