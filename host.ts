/** HOST — the ServerHost handed to server/server.ts, plus everything only it needs: the story.json
 *  read/persist helpers (exactly one place reads the file, one place commits it) and the architect
 *  session factories with their defaults-scoped engine knobs. Built here so server/ never imports
 *  engine/ — routes receive behaviour through this object. */
import { writeFile, readFile, rename } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { storyWriteBlocked } from "./live.ts";
import { ENGINE } from "./engine/engine-state.ts";
import { splitMeaning, bibleFrom, canonSkill } from "./engine/skills.ts";
import { sameName } from "./engine/config-util.ts";
import { NET } from "./engine/llm-client.ts";
import { PROVIDER } from "./engine/provider.ts";
import { resolveStoryDir, loadStory, loadDefaults, writtenChapters, selectableStory, type Defaults } from "./engine/story-format.ts";
import { directEdit, specView, characterPsychologyWarnings, timelineBeatProblems, timelineOrderProblems, type StorySpec } from "./engine/story-spec.ts";
import { StoryJson } from "./engine/story-schema.ts";
import { runDirs, loadedModelIds, storyCards, runLlmLogs, readLlmLog } from "./engine/preflight.ts";
import {
  buildArchitect, ScaffoldSession, openNextChapter, suggestEdits as statelessSuggest,
  type NextChapterSession, type ImportedCharacter,
} from "./engine/architect.ts";
import { loadCatalog, checkEntry, saveEntry, deleteEntry, skillBible, skillBibleEntries } from "./engine/catalog.ts";
import { CATALOG_KINDS, type CatalogKind, type LibraryCharacter } from "./engine/catalog-schema.ts";
import type { ServerHost, Concept, CatalogUsage } from "./server/server.ts";
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
                                  mode: "oneshot" | "staged" = "oneshot",
                                  concept?: Concept): Promise<ScaffoldSession> {
  const d = await architectDefaults(model);
  const entries = await skillBibleEntries();
  const session = new ScaffoldSession(await buildArchitect(d, true, entries), d, idea, undefined, mode, undefined,
                             concept?.tags ?? [], concept?.castSize ?? 0);
  session.bible = bibleFrom(entries);
  return session;
}

/** The tag catalog is the author's own file, so an unknown tag is news rather than an error: it is
 *  still passed to the architect, and reported so a typo does not quietly become a steering word.
 *  Matching is by trimmed lowercase label, the same key the catalog's own duplicate check uses. */
async function unknownTags(tags: string[]): Promise<string[]> {
  const cat = await loadCatalog("tags");
  const known = new Set<string>((cat?.entries ?? []).map((e: { label?: unknown }) =>
    String(e?.label ?? "").trim().toLowerCase()));
  return tags.filter(t => !known.has(t.trim().toLowerCase()));
}

/** Ids in, tray entries out, in the order the author chose them. Only the portable half travels:
 *  goal and knows are story-positional and the library does not carry them, and the cast gate is
 *  where they get resolved. */
/** Promotion writes through the same validated path the skill editor uses -- one way into the
 *  catalog, one set of rules. The id is derived from the canonical name so promoting the same skill
 *  twice is an update rather than a duplicate. */
async function promoteSkill(name: string, meaning: string) {
  const entry = { id: `skill-${canonSkill(name)}`, version: 1, name, meaning, tags: [] };
  const result = await saveEntry("skills", entry, undefined, await skillBible());
  if (!result.ok) {
    return result;
  }
  return { ok: true as const, bible: bibleFrom(await skillBibleEntries()), problems: result.problems };
}

async function importCharacters(ids: string[]): Promise<{ imported: ImportedCharacter[]; missing: string[] }> {
  const cat = await loadCatalog("characters");
  const byId = new Map<string, LibraryCharacter>((cat?.entries ?? []).map((e: LibraryCharacter) => [e.id, e]));
  const imported: ImportedCharacter[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const e = byId.get(id);
    if (!e) { missing.push(id); continue; }
    imported.push({
      libraryId: e.id, version: e.version, name: e.name, portablePersona: e.portablePersona,
      belief: e.belief, impulse: e.impulse,
      voice: [...e.voice], skills: [...e.skills], restrictions: [...e.restrictions],
    });
  }
  return { imported, missing };
}

async function newHandoffSession(dir: string, model = ""): Promise<NextChapterSession> {
  const entries = await skillBibleEntries();
  return openNextChapter(await architectDefaults(model), dir, entries);
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
  providerName: PROVIDER.displayName,
  // The shelf's cards resolve capabilities against the author's own bible, so a card and the run it
  // starts report the same skills.
  storyCards: async () => storyCards(await skillBible()),
  newScaffoldSession, newHandoffSession, directEdit, specView, unknownTags, importCharacters, promoteSkill,
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
      const entries = await skillBibleEntries();
      return await withArchitectDefaults(flag("model") ?? "", async d => {
        const r = await statelessSuggest(d, specObj, String(text ?? ""), entries);
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
  catalogUsage: async () => {
    const [characters, styles, skills] = await Promise.all(
      (["characters", "styles", "skills"] as const).map(k => loadCatalog(k)));
    const usage: CatalogUsage = { tags: {}, skills: {} };
    const tagFor = (label: unknown) => {
      const key = String(label ?? "").trim().toLowerCase();
      if (!key) return null;
      return usage.tags[key] ?? (usage.tags[key] = { characters: 0, styles: [], skills: 0 });
    };
    for (const c of characters.entries as { tags?: string[] }[])
      for (const t of c.tags ?? []) { const u = tagFor(t); if (u) u.characters++; }
    for (const s of styles.entries as { name?: string; tags?: string[] }[])
      for (const t of s.tags ?? []) { const u = tagFor(t); if (u) u.styles.push(String(s.name || "")); }
    for (const k of skills.entries as { tags?: string[] }[])
      for (const t of k.tags ?? []) { const u = tagFor(t); if (u) u.skills++; }
    // A skill is "used by" a character when resolution would find it: the name a character's
    // `name :: meaning` line holds, matched the way every identity comparison is (sameName).
    for (const c of characters.entries as { skills?: string[] }[])
      for (const raw of c.skills ?? []) {
        const name = splitMeaning(String(raw)).text;
        const key = Object.keys(usage.skills).find(k => sameName(k, name)) ?? name;
        usage.skills[key] = (usage.skills[key] ?? 0) + 1;
      }
    return usage;
  },
};
