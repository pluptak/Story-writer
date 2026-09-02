/** HOST — the ServerHost handed to server/server.ts, plus everything only it needs: the story.json
 *  read/persist helpers (exactly one place reads the file, one place commits it) and the architect
 *  session factories with their defaults-scoped engine knobs. Built here so server/ never imports
 *  engine/ — routes receive behaviour through this object. */
import { writeFile, readFile, rename } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { storyWriteBlocked } from "./live.ts";
import { ENGINE } from "./engine/engine-state.ts";
import { splitMeaning } from "./engine/skills.ts";
import { sameName } from "./engine/config-util.ts";
import { NET } from "./engine/llm-client.ts";
import { resolveStoryDir, loadStory, loadDefaults, writtenChapters, selectableStory, type Defaults } from "./engine/story-format.ts";
import { directEdit, specView, characterPsychologyWarnings, timelineBeatProblems, timelineOrderProblems, type StorySpec } from "./engine/story-spec.ts";
import { StoryJson } from "./engine/story-schema.ts";
import { runDirs, loadedModelIds, storyCards, runLlmLogs, readLlmLog } from "./engine/preflight.ts";
import {
  buildArchitect, ScaffoldSession, openNextChapter, suggestEdits as statelessSuggest,
  type NextChapterSession,
} from "./engine/architect.ts";
import { loadCatalog, checkEntry, saveEntry, deleteEntry, skillBible } from "./engine/catalog.ts";
import { CATALOG_KINDS, type CatalogKind } from "./engine/catalog-schema.ts";
import type { ServerHost } from "./server/server.ts";
import { flag } from "./cli-flags.ts";

/** The architect's own knobs, which are the defaults' — not any one story's. */
async function architectDefaults(model = ""): Promise<Defaults> {
  const d = await loadDefaults(model || flag("model") || "");
  ENGINE.stream = d.stream; ENGINE.debug = d.debug;
  NET.timeoutMs = d.requestTimeout * 1000;
  NET.retries = d.attempts - 1;
  ENGINE.maxTokens = d.maxTokens;
  return d;
}

/** Apply the architect's knobs for the length of `fn`, then restore the engine knobs it touched.
 *  Keeps a stateless suggestion from leaving the architect's token cap/timeouts behind — unlike a
 *  scaffold or handoff session, which owns the console until it hands off to a run that re-applies
 *  the story's own config. `architectModel` is pure for the same reason; so is this. */
async function withArchitectDefaults<T>(model: string, fn: (d: Defaults) => Promise<T>): Promise<T> {
  const saved = { stream: ENGINE.stream, debug: ENGINE.debug, maxTokens: ENGINE.maxTokens,
                  timeoutMs: NET.timeoutMs, retries: NET.retries };
  try {
    return await fn(await architectDefaults(model));
  } finally {
    ENGINE.stream = saved.stream; ENGINE.debug = saved.debug; ENGINE.maxTokens = saved.maxTokens;
    NET.timeoutMs = saved.timeoutMs; NET.retries = saved.retries;
  }
}

async function newScaffoldSession(idea: string, model = "",
                                  mode: "oneshot" | "staged" = "oneshot"): Promise<ScaffoldSession> {
  const d = await architectDefaults(model);
  return new ScaffoldSession(await buildArchitect(d), d, idea, undefined, mode);
}

async function newHandoffSession(dir: string, model = ""): Promise<NextChapterSession> {
  return openNextChapter(await architectDefaults(model), dir);
}

/** Read and Zod-parse a story's story.json. Shared by storyForEdit and fullCast so there is exactly
 *  one place that reads the file. On parse failure returns the raw object for the editor to show. */
async function loadStoryJson(dir: string): Promise<
  { ok: true; story: StoryJson } | { ok: false; error: string; raw?: object }
> {
  const base = resolveStoryDir(dir);
  const storyPath = joinPath(base, "story.json");
  let raw: unknown;
  try { raw = JSON.parse(await readFile(storyPath, "utf8")); }
  catch (e) { return { ok: false, error: `could not read story.json: ${(e as Error).message}` }; }
  const result = StoryJson.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      error: result.error.issues.map(i => `${i.path.join(".") || "story"}: ${i.message}`).join("\n"),
      raw: raw as object,
    };
  }
  return { ok: true, story: result.data };
}

/** Write a validated story.json atomically (write .tmp, rename over) and confirm it still loads.
 *  Shared by saveStory (a full form save) and discardScene (dropping one scene) so there is exactly
 *  one place that commits story.json to disk. */
async function persistStoryJson(dir: string, parsed: StoryJson): Promise<{ ok: true } | { ok: false; reason: string }> {
  const base = resolveStoryDir(dir);
  const storyPath = joinPath(base, "story.json");
  const tmpPath = storyPath + ".tmp";
  const content = JSON.stringify(parsed, null, 2) + "\n";
  try {
    await writeFile(tmpPath, content, "utf8");
    await rename(tmpPath, storyPath);
  } catch (e) {
    return { ok: false, reason: `write failed: ${(e as Error).message}` };
  }
  // Re-load to confirm (catches silently-corrupt writes on constrained filesystems), under the same
  // bible a run would use — a story that saves clean should load clean where it will be written.
  try { await loadStory(dir, undefined, await skillBible()); }
  catch (e) { return { ok: false, reason: `saved but does not load: ${(e as Error).message}` }; }
  return { ok: true };
}

/** The psychology fields are REQUIRED on every character: surfaced as editor/check warnings so an
 *  old or hand-edited story is told what its cards are missing. Shares its wording with normalizeSpec. */
const characterCardWarnings = (parsed: StoryJson): string[] =>
  parsed.characters.flatMap(c => characterPsychologyWarnings(c.name, c.belief, c.impulse, c.voice));

/** The two problems that are advisory warnings on load and check but a refused save, named once so
 *  every surface words them identically. */
const EMPTY_PREMISE = "Premise is empty — there is nothing to write.";
const NO_CHARACTERS = "No characters defined — the writer would have nobody to consult.";

/** The engine's advisory warnings about a parsed story. The editor's load view, the in-memory
 *  checker and the save confirmation all return this same list, worded identically. */
const storyWarnings = (parsed: StoryJson): string[] => [
  ...(!parsed.premise.trim() ? [EMPTY_PREMISE] : []),
  ...(!parsed.characters.length ? [NO_CHARACTERS] : []),
  ...parsed.scenes.flatMap((s, i) => [
    ...(!s.question ? [`Scene ${i + 1} has no question — the writer decides alone when the scene is done`] : []),
    // The same case-insensitive orphan test loadStory applies (wording shared with it): sceneReach
    // resolves the grant key case-insensitively, so only a key matching NO character is dead.
    ...Object.keys(s.reach ?? {})
      .filter(who => !parsed.characters.some(c => sameName(c.name, who)))
      .map(who => `Scene ${i + 1} grants reach to "${who}", who is not one of the characters — ignored`),
  ]),
  ...parsed.timeline.flatMap((beat, i) =>
    timelineBeatProblems(`timeline beat ${i + 1}`, beat, parsed.characters.map(c => c.name), parsed.scenes)),
  ...timelineOrderProblems(parsed.timeline),
  ...characterCardWarnings(parsed),
];

/** Validate a catalog kind that arrived from the wire — returns the validated kind or null. */
const validateCatalogKind = (kind: string): CatalogKind | null =>
  CATALOG_KINDS.includes(kind as CatalogKind) ? (kind as CatalogKind) : null;

export const HOST: ServerHost = {
  selectableStory, resolveStoryDir, runDirs, runLlmLogs, readLlmLog, writtenChapters, loadedModelIds,
  // The shelf's cards resolve capabilities against the author's own bible, so a card and the run it
  // starts report the same skills.
  storyCards: async () => storyCards(await skillBible()),
  newScaffoldSession, newHandoffSession, directEdit, specView,
  architectModel: async () => (await loadDefaults(flag("model") ?? "")).models.architect,
  outDir: () => ENGINE.outDir,
  storyForEdit: async (dir) => {
    const loaded = await loadStoryJson(dir);
    if (!loaded.ok) return { ok: false, error: loaded.error, raw: loaded.raw };
    return { ok: true, story: loaded.story, warnings: storyWarnings(loaded.story) };
  },
  fullCast: async (dir) => {
    const loaded = await loadStoryJson(dir);
    if (!loaded.ok) return { ok: false, error: loaded.error };
    return {
      ok: true,
      characters: loaded.story.characters.map(c => ({
        name: c.name, persona: c.persona, knows: c.knows, goal: c.goal,
        belief: c.belief, impulse: c.impulse, voice: c.voice,
        skills: c.skills.map(s => splitMeaning(s)),
        restrictions: c.restrictions,
      })),
      // Reach stays per scene and never merges into a character's skills (I4): the GUI labels it
      // with the scene it comes from so it can never read as intrinsic.
      scenes: loaded.story.scenes.map((s, i) => ({ n: i + 1, reach: s.reach ?? {} })),
    };
  },
  checkStory: (story) => {
    const result = StoryJson.safeParse(story);
    if (!result.success) {
      return {
        ok: false, error: "validation failed",
        issues: result.error.issues.map(i => ({ path: i.path.join(".") || "story", message: i.message })),
      };
    }
    return { ok: true, warnings: storyWarnings(result.data) };
  },
  saveStory: async (dir, story) => {
    // Validate first
    const check = StoryJson.safeParse(story);
    if (!check.success) {
      return { ok: false, reason: "validation failed" };
    }
    const parsed = check.data;
    if (!parsed.premise.trim()) return { ok: false, reason: EMPTY_PREMISE };
    if (!parsed.characters.length) return { ok: false, reason: NO_CHARACTERS };

    // Guard: nothing else may be reading or writing this story (route already checked; double-check)
    const blocked = storyWriteBlocked();
    if (blocked) return { ok: false, reason: blocked, status: 409 };

    const w = await persistStoryJson(dir, parsed);
    if (!w.ok) return { ok: false, reason: w.reason };

    return { ok: true, warnings: storyWarnings(parsed) };
  },
  discardScene: async (dir, n) => {
    const blocked = storyWriteBlocked();
    if (blocked) return { ok: false, reason: blocked, status: 409 };
    const loaded = await loadStoryJson(dir);
    if (!loaded.ok) return { ok: false, reason: `story.json does not load: ${loaded.error}` };
    const parsed = loaded.story;
    // Only the last authored scene, and only while unwritten: a written chapter's scene defines its
    // prose, and removing a middle scene would renumber the chapters after it. `scenes.min(1)` in the
    // schema means the sole scene can never go.
    if (parsed.scenes.length <= 1) return { ok: false, reason: "a story must keep at least one scene" };
    if (n !== parsed.scenes.length) return { ok: false, reason: `only chapter ${parsed.scenes.length} (the last authored scene) can be discarded` };
    if ((await writtenChapters(dir)).includes(n)) return { ok: false, reason: `chapter ${n} is already written — discarding it would orphan the prose` };

    parsed.scenes = parsed.scenes.slice(0, -1);
    const w = await persistStoryJson(dir, parsed);
    if (!w.ok) return { ok: false, reason: w.reason };
    return { ok: true, chapter: n, scenes: parsed.scenes.length };
  },
  suggestEdits: async (spec, text) => {
    const specObj = spec as StorySpec;
    try {
      return await withArchitectDefaults(flag("model") ?? "", async d => {
        const r = await statelessSuggest(d, specObj, String(text ?? ""));
        if (r.kind === "failed") return { ok: false as const, error: r.error };
        if (r.kind === "question") return { ok: true as const, kind: "question" as const, ask: r.ask };
        return { ok: true as const, kind: "edits" as const, spec: r.spec, applied: r.applied, ignored: r.ignored, problems: r.problems, note: r.note };
      });
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  catalogEntries: async (kind) => {
    const validated = validateCatalogKind(kind);
    if (!validated) return { ok: false, reason: `no such catalog "${kind}"` };
    const catalog = await loadCatalog(validated);
    return { ok: true, entries: catalog.entries };
  },
  catalogCheck: async (kind, entry) => {
    const validated = validateCatalogKind(kind);
    if (!validated) return { ok: false, reason: `no such catalog "${kind}"` };
    const bible = await skillBible();
    const result = checkEntry(validated, entry, bible);
    if (!result.ok) return { ok: false, issues: result.issues };
    return { ok: true, problems: result.problems };
  },
  catalogSave: async (kind, entry) => {
    const validated = validateCatalogKind(kind);
    if (!validated) return { ok: false, reason: `no such catalog "${kind}"` };
    const bible = await skillBible();
    return await saveEntry(validated, entry, undefined, bible);
  },
  catalogDelete: async (kind, id) => {
    const validated = validateCatalogKind(kind);
    if (!validated) return { ok: false, reason: `no such catalog "${kind}"` };
    const result = await deleteEntry(validated, id);
    // Engine says *what happened* (missing: true); host says *what that means over HTTP* (404).
    if (!result.ok && result.missing) {
      return { ok: false, reason: result.reason, status: 404 };
    }
    return result;
  },
};
