/** The GUI harness: the real server (server/server.ts) bound in-process over a fixture
 *  ServerHost, so the browser exercises the genuine HTTP surface, static modules, and SSE bus
 *  against a deterministic backend — no LM Studio, no child process, nothing in stories/.
 *
 *  The fixture story is tests/fixtures/doorway (the committed worked example): its card, cast and
 *  scenes are read straight from its story.json, and dirs resolve there through the engine's own
 *  resolveStoryDir. Host methods no test has scripted yet throw, loudly, rather than pretend. */
import { readFile } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, expect, type Page } from "@playwright/test";

import { startServer, type ServerHandle, type ServerHost } from "../../server/server.ts";
import { LIVE, resetLive } from "../../live.ts";
import { resolveStoryDir } from "../../engine/story-format.ts";
import type { StoryCard } from "../../engine/preflight.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const FIXTURE_DIR = "tests/fixtures/doorway";

type FixtureStory = {
  title: string; premise: string; writerStyle: string;
  scenes: { place: string; question: string; pov: string; length: number; roster: string[]; reach?: Record<string, string[]> }[];
  characters: { name: string; persona: string; knows: string; goal: string; belief: string;
                impulse: string; voice: string[]; skills: string[]; restrictions: string[] }[];
  config: { maxSteps: number };
};

let cached: FixtureStory | null = null;
async function fixtureStory(): Promise<FixtureStory> {
  if (!cached) {
    const raw = await readFile(joinPath(ROOT, FIXTURE_DIR, "story.json"), "utf8");
    cached = JSON.parse(raw) as FixtureStory;
  }
  return cached;
}

/** `skill :: meaning` is the authored form; a card's chip shows the name only. */
const skillName = (s: string) => s.split("::")[0].trim();

async function fixtureHost(): Promise<ServerHost> {
  const story = await fixtureStory();
  const notScripted = (what: string): never => { throw new Error(`the GUI harness has no behaviour for ${what}`); };
  return {
    storyCards: async (): Promise<StoryCard[]> => [{
      dir: FIXTURE_DIR, name: FIXTURE_DIR, ok: true, warnings: [],
      title: story.title, premise: story.premise,
      scene: {
        place: story.scenes[0].place, question: story.scenes[0].question,
        pov: story.scenes[0].pov, length: story.scenes[0].length,
      },
      scenes: story.scenes.map(s => ({
        place: s.place, question: s.question, pov: s.pov, length: s.length,
        roster: s.roster, reach: s.reach ?? {},
      })),
      characters: story.characters.map(c => ({
        name: c.name, skills: c.skills.map(skillName), restrictions: c.restrictions,
      })),
      maxSteps: story.config.maxSteps,
      runs: [], chapters: [],
    }],
    selectableStory: async dir => (dir === FIXTURE_DIR ? FIXTURE_DIR : null),
    resolveStoryDir: dir => (dir === FIXTURE_DIR ? resolveStoryDir(FIXTURE_DIR) : dir),
    runDirs: async () => [],
    runLlmLogs: async () => notScripted("runLlmLogs"),
    readLlmLog: async () => notScripted("readLlmLog"),
    writtenChapters: async () => [],
    loadedModelIds: async () => null,          // no LM Studio behind the harness — on purpose
    architectModel: async () => "none",
    newScaffoldSession: async () => notScripted("newScaffoldSession"),
    newHandoffSession: async () => notScripted("newHandoffSession"),
    directEdit: () => notScripted("directEdit"),
    specView: () => notScripted("specView"),
    outDir: () => "",
    storyForEdit: async () => notScripted("storyForEdit"),
    fullCast: async () => ({
      ok: true,
      characters: story.characters.map(c => ({
        name: c.name, persona: c.persona, knows: c.knows, goal: c.goal,
        belief: c.belief, impulse: c.impulse, voice: c.voice,
        skills: c.skills.map(s => {
          const i = s.indexOf("::");
          return i < 0 ? { text: s.trim(), meaning: "" } : { text: s.slice(0, i).trim(), meaning: s.slice(i + 2).trim() };
        }),
        restrictions: c.restrictions,
      })),
      scenes: story.scenes.map((s, i) => ({ n: i + 1, reach: s.reach ?? {} })),
    }),
    checkStory: () => notScripted("checkStory"),
    saveStory: async () => notScripted("saveStory"),
    discardScene: async () => notScripted("discardScene"),
    suggestEdits: async () => notScripted("suggestEdits"),
    catalogEntries: async () => notScripted("catalogEntries"),
    catalogCheck: () => notScripted("catalogCheck"),
    catalogSave: async () => notScripted("catalogSave"),
    catalogDelete: async () => notScripted("catalogDelete"),
  };
}

/** The one fixture every GUI test builds on: a fresh server (ephemeral port — module singletons
 *  make sharing one across tests unsound), a page already pointed at it, and a cleared session
 *  on both sides of the test. `served` is the port, for tests that navigate deeper. */
export const test = base.extend<{ served: number }>({
  served: [async ({ page }: { page: Page }, use: (port: number) => Promise<void>) => {
    resetLive();
    const handle: ServerHandle = startServer(0, await fixtureHost());
    const port = await handle.bound;
    await page.goto(`http://127.0.0.1:${port}/`);
    await use(port);
    await handle.close();
    // A scripted run may have set the session fields publish()/run_state() read; a real process
    // leaves them behind between runs too, so the next test starts from the same clean slate.
    LIVE.running = false; LIVE.where = "idle"; LIVE.meta = null;
    resetLive();
  }, { auto: true }],
});

export { expect };
