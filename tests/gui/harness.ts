/** The GUI harness: the real server (server/server.ts) bound in-process over a fixture
 *  ServerHost, so the browser exercises the genuine HTTP surface, static modules, and SSE bus
 *  against a deterministic backend — no LM Studio, no child process, nothing in stories/.
 *
 *  The fixture story is tests/fixtures/doorway (the committed worked example). Everything that
 *  touches story.json — the editor's load/check/save/discard, the handoff's accept — is delegated
 *  to the REAL host (host.ts), so those paths run the engine's own logic against temp copies of
 *  the fixture. Only what must differ is overridden: model discovery (none), the story registry
 *  (temp dirs instead of stories/ discovery), the handoff session (scripted), and the catalog
 *  (engine logic, temp files). Host methods no test has scripted yet throw, loudly. */
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test as base, expect, type Page } from "@playwright/test";

import { startServer, type ServerHandle, type ServerHost } from "../../server/server.ts";
import { LIVE, resetLive } from "../../live.ts";
import { loadCatalog, checkEntry, saveEntry, deleteEntry, skillBible } from "../../engine/catalog.ts";
import { CATALOG_KINDS, type CatalogKind, type LibraryCharacter, type LibraryStyle,
         type TagEntry } from "../../engine/catalog-schema.ts";
import { canonSkill } from "../../engine/skills.ts";
import { HOST, setScaffoldTestHooks } from "../../host.ts";
import type { StoryCard } from "../../engine/preflight.ts";
import type { ImportedCharacter, NextChapterSession, ScaffoldSession } from "../../engine/architect.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const FIXTURE_DIR = "tests/fixtures/doorway";

export type FixtureStory = {
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

/** The StoryCard a story.json's raw object renders as on the shelf and story pages. */
export function cardFromStory(dir: string, raw: FixtureStory, name = dir): StoryCard {
  return {
    dir, name, ok: true, warnings: [],
    title: raw.title, premise: raw.premise,
    scene: {
      place: raw.scenes[0].place, question: raw.scenes[0].question,
      pov: raw.scenes[0].pov, length: raw.scenes[0].length,
    },
    scenes: raw.scenes.map(s => ({
      place: s.place, question: s.question, pov: s.pov, length: s.length,
      roster: s.roster, reach: s.reach ?? {},
    })),
    characters: raw.characters.map(c => ({
      name: c.name, skills: c.skills.map(skillName), restrictions: c.restrictions,
    })),
    maxSteps: raw.config.maxSteps,
    runs: [], chapters: [],
  };
}

/** A temp directory holding a copy of the fixture's story.json — the story a write-path test
 *  works on, so nothing committed or in stories/ is ever touched. */
export async function copyFixtureStory(): Promise<string> {
  const dir = await mkdtemp(joinPath(tmpdir(), "pw-story-"));
  await writeFile(joinPath(dir, "story.json"), await readFile(joinPath(ROOT, FIXTURE_DIR, "story.json"), "utf8"));
  return dir;
}

// -- PER-TEST REGISTRATION ----------------------------------------------------
/** Temp stories sit in a registry of card PROVIDERS, not static cards: the real story discovery
 *  re-reads the file on every /stories, so a card built from a snapshot would go stale the moment
 *  a test writes to the story. Providers keep the page and the disk in step. */
const extraStories = new Map<string, () => Promise<StoryCard> | StoryCard>();
/** Put a temp story on the fixture host's shelf, so /stories, the editor, and the handoff's start
 *  can name it — every route that guards a dir consults the same registry. Cleared per test. */
export function registerStory(dir: string, getCard: () => Promise<StoryCard> | StoryCard) {
  extraStories.set(dir, getCard);
}

let handoffFactory: ((dir: string) => Promise<NextChapterSession>) | null = null;
/** Install the scripted handoff session a handoff test drives; null restores the refusal. */
export function setHandoffFactory(f: ((dir: string) => Promise<NextChapterSession>) | null) { handoffFactory = f; }

type ScaffoldArgs = { idea: string; model: string; mode: "oneshot" | "staged"; tags: string[]; castSize: number; styleId: string };
let scaffoldFactory: ((args: ScaffoldArgs) => Promise<ScaffoldSession>) | null = null;

// The per-test temp catalog dir, module-scope so setScaffoldFactory's hooks (registered by the
// test BEFORE the `served` fixture creates it) and fixtureHost() (which creates it) agree on the
// same path -- reassigned fresh in fixtureHost() at the start of every test.
let catalogDir = "";
const catalogFile = (kind: string) => joinPath(catalogDir, `catalog-${kind}.json`);

/** Install the scripted scaffold session a scaffold test drives; null restores the refusal. Also
 *  wires host.ts's scaffold test hooks (setScaffoldTestHooks), the only way to script an interview
 *  when driving it through the real ServerHost — and to keep its tag/import/style/promote lookups
 *  off the author's real catalog at ROOT, the same reason every other catalog call here uses a temp
 *  file: newScaffoldSession and the three catalog lookups are no longer part of ServerHost at all
 *  (Block 5, PLANS.md), so overriding the returned host object can no longer reach them. */
export function setScaffoldFactory(f: ((args: ScaffoldArgs) => Promise<ScaffoldSession>) | null) {
  scaffoldFactory = f;
  if (!f) { setScaffoldTestHooks(null); return; }
  setScaffoldTestHooks({
    session: (idea, model, mode, concept) => {
      if (!scaffoldFactory) throw new Error("no scaffold scripted for this test");
      return scaffoldFactory({ idea, model: model ?? "", mode: mode ?? "oneshot",
                               tags: concept?.tags ?? [], castSize: concept?.castSize ?? 0,
                               styleId: concept?.styleId ?? "" });
    },
    tags: async (tags) => {
      const known = new Set(((await loadCatalog("tags", catalogFile("tags"))).entries as TagEntry[])
        .map(e => String(e.label ?? "").trim().toLowerCase()));
      return tags.filter(t => !known.has(t.trim().toLowerCase()));
    },
    imports: async (ids) => {
      const byId = new Map(((await loadCatalog("characters", catalogFile("characters"))).entries as LibraryCharacter[])
        .map(e => [e.id, e] as const));
      const imported: ImportedCharacter[] = [], missing: string[] = [];
      for (const id of ids) {
        const e = byId.get(id);
        if (!e) { missing.push(id); continue; }
        imported.push({ libraryId: e.id, version: e.version, name: e.name, portablePersona: e.portablePersona,
                        belief: e.belief, impulse: e.impulse,
                        voice: [...e.voice], skills: [...e.skills], restrictions: [...e.restrictions] });
      }
      return { imported, missing };
    },
    style: async (id) => {
      const entries = (await loadCatalog("styles", catalogFile("styles"))).entries as LibraryStyle[];
      const e = entries.find(x => x.id === id.trim());
      return e ? { id: e.id, name: e.name, voice: e.voice } : null;
    },
    promote: async (name, meaning) => {
      const entry = { id: `skill-${canonSkill(name)}`, version: 1, name, meaning, tags: [] };
      const bible = await skillBible(catalogFile("skills"));
      const result = await saveEntry("skills", entry, catalogFile("skills"), bible);
      if (!result.ok) return result;
      return { ok: true as const, bible: await skillBible(catalogFile("skills")), problems: result.problems };
    },
  });
}

async function fixtureHost(): Promise<ServerHost> {
  const story = await fixtureStory();
  const notScripted = (what: string): never => { throw new Error(`the GUI harness has no behaviour for ${what}`); };
  // The catalog is isolated through the engine's own optional path — real load/check/save/delete
  // logic, temp files. One dir per process; the tests leave it as they found it.
  catalogDir = await mkdtemp(joinPath(tmpdir(), "pw-catalog-"));
  const withKind = (kind: string): CatalogKind => {
    if (!CATALOG_KINDS.includes(kind as CatalogKind)) throw new Error(`no such catalog "${kind}"`);
    return kind as CatalogKind;
  };
  return {
    // The real host: every path that reads or writes story.json or validates a draft runs the
    // engine's own code — the editor and the handoff's accept are not lookalikes.
    ...HOST,
    storyCards: async () => [
      cardFromStory(FIXTURE_DIR, story),
      ...(await Promise.all([...extraStories.values()].map(f => f()))),
    ],
    selectableStory: async dir => (dir === FIXTURE_DIR || extraStories.has(dir) ? dir : null),
    availableModelIds: async () => null,          // no LM Studio behind the harness — on purpose
    runDirs: async () => [],
    runLlmLogs: async () => notScripted("runLlmLogs"),
    readLlmLog: async () => notScripted("readLlmLog"),
    newHandoffSession: async (dir) => {
      if (!handoffFactory) throw new Error("no handoff scripted for this test");
      return handoffFactory(dir);
    },
    outDir: () => "",
    catalogEntries: async (kind) => {
      const v = withKind(kind);
      const c = await loadCatalog(v, catalogFile(v));
      return { ok: true, entries: c.entries };
    },
    catalogCheck: async (kind, entry) => {
      const v = withKind(kind);
      // The harness must never read the user's real catalog at ROOT, which is why it passes its
      // own temp-scoped skills bible instead.
      const bible = await skillBible(catalogFile("skills"));
      const r = checkEntry(v, entry, bible);
      return r.ok ? { ok: true, problems: r.problems } : { ok: false, issues: r.issues };
    },
    catalogSave: async (kind, entry) => {
      const v = withKind(kind);
      // The harness must never read the user's real catalog at ROOT, which is why it passes its
      // own temp-scoped skills bible instead.
      const bible = await skillBible(catalogFile("skills"));
      return saveEntry(v, entry, catalogFile(v), bible);
    },
    catalogDelete: async (kind, id) => {
      const r = await deleteEntry(withKind(kind), id, catalogFile(withKind(kind)));
      return !r.ok && (r as { missing?: boolean }).missing
        ? { ok: false, reason: r.reason, status: 404 }
        : r;
    },
    // Usage is derived from the temp catalogs, which start empty — never from the author's real
    // files at ROOT, which the spread HOST would read.
    catalogUsage: async () => ({ tags: {}, skills: {} }),
  } as ServerHost;
}

/** Deep-link arrival. A hash-only goto is a same-document navigation whose hashchange makes the
 *  running app rewrite the URL from its own state — wiping any params. Going through about:blank
 *  is a fresh document load, which is what pasting a URL is. */
export const arrive = async (page: Page, port: number, hash: string) => {
  await page.goto("about:blank");
  await page.goto(`http://127.0.0.1:${port}/${hash}`);
};

/** The one fixture every GUI test builds on: a fresh server (ephemeral port — module singletons
 *  make sharing one across tests unsound), a page already pointed at it, and a cleared session
 *  on both sides of the test. `served` is the port, for tests that navigate deeper. */
export const test = base.extend<{ served: number }>({
  served: [async ({ page }: { page: Page }, use: (port: number) => Promise<void>) => {
    resetLive();
    extraStories.clear();
    handoffFactory = null;
    scaffoldFactory = null;
    const handle: ServerHandle = startServer(0, await fixtureHost());
    const port = await handle.bound;
    await page.goto(`http://127.0.0.1:${port}/`);
    await use(port);
    await handle.close();
    // A scripted run may have set the session fields publish()/run_state() read; a real process
    // leaves them behind between runs too, so the next test starts from the same clean slate.
    LIVE.running = false; LIVE.where = "idle"; LIVE.meta = null; LIVE.storyLock = null;
    resetLive();
  }, { auto: true }],
});

export { expect };
