/**
 * HOST STORY-STORE — story.json read/persist plus the story-editor and catalog domains HOST
 * exposes: load/validate/save/discard/suggest and the global catalog ops. The single read path
 * (loadStoryJson) and single write path (persistStoryJson) live here so every surface words the
 * same warnings identically.
 */

import { writeFile, readFile, rename } from "node:fs/promises";
import { join as joinPath } from "node:path";

import { storyWriteBlocked } from "../live.ts";
import { splitMeaning } from "../engine/skills.ts";
import { sameName } from "../engine/config-util.ts";
import { resolveStoryDir, loadStory, writtenChapters } from "../engine/story-format.ts";
import { characterPsychologyWarnings, timelineBeatProblems, timelineOrderProblems, timelineMemoryWarnings, type StorySpec } from "../engine/story-spec.ts";
import { StoryJson, THINK_LEVELS, VOICE_SAMPLE_CAP } from "../engine/story-schema.ts";
import { suggestEdits as statelessSuggest } from "../engine/architect.ts";
import { loadCatalog, checkEntry, saveEntry, deleteEntry, setVisibility, skillBibleEntries, originSkillGroups, persistedCatalogs, generalSkillEntries } from "../engine/catalog.ts";
import { CATALOG_KINDS, TAG_FACETS, type CatalogKind } from "../engine/catalog-schema.ts";
import { assistCharacter, ASSIST_FIELDS, type AssistField, type AssistMode } from "../engine/catalog-assist.ts";
import type { StoryEditHost, StoryReadHost, CatalogRoutesHost, CatalogUsage } from "../server/route-hosts.ts";
import { withHostDefaults, hostModel } from "./defaults.ts";

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
  // catalogs a run would use — a story that saves clean should load clean where it will be written.
  try { await loadStory(dir, undefined, await persistedCatalogs()); }
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
    // Constraint is reach's negative twin and gets the same orphan check.
    ...Object.keys(s.constraint ?? {})
      .filter(who => !parsed.characters.some(c => sameName(c.name, who)))
      .map(who => `Scene ${i + 1} sets a constraint for "${who}", who is not one of the characters — ignored`),
  ]),
  ...parsed.timeline.flatMap((beat, i) =>
    timelineBeatProblems(`timeline beat ${i + 1}`, beat, parsed.characters.map(c => c.name), parsed.scenes)),
  ...timelineOrderProblems(parsed.timeline),
  ...timelineMemoryWarnings(parsed),
  ...characterCardWarnings(parsed),
];

/** Validate a catalog kind that arrived from the wire — returns the validated kind or null. */
const validateCatalogKind = (kind: string): CatalogKind | null =>
  CATALOG_KINDS.includes(kind as CatalogKind) ? (kind as CatalogKind) : null;

export const editorConfig: StoryEditHost["editorConfig"] = () => {
  const d = StoryJson.parse({});
  return {
    defaults: {
      retries: d.config.retries, clarifications: d.config.clarifications, maxSteps: d.config.maxSteps,
      maxProseWords: d.config.maxProseWords, requestTimeout: d.config.requestTimeout,
      attempts: d.config.attempts, maxTokens: d.config.maxTokens,
      stream: d.config.stream, debug: d.config.debug, thinking: d.config.thinking,
      sceneLength: d.scenes[0].length,
    },
    thinkingLevels: THINK_LEVELS,
    caps: { voiceSamples: VOICE_SAMPLE_CAP },
  };
};

export const storyForEdit: StoryEditHost["storyForEdit"] = async (dir) => {
  const loaded = await loadStoryJson(dir);
  if (!loaded.ok) return { ok: false, error: loaded.error, raw: loaded.raw };
  return { ok: true, story: loaded.story, warnings: storyWarnings(loaded.story) };
};

export const fullCast: StoryReadHost["fullCast"] = async (dir) => {
  const loaded = await loadStoryJson(dir);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  return {
    ok: true,
    characters: loaded.story.characters.map(c => ({
      name: c.name, persona: c.persona, knows: c.knows, goal: c.goal,
      belief: c.belief, impulse: c.impulse, voice: c.voice, origin: c.origin,
      skills: c.skills.map(s => splitMeaning(s)),
      restrictions: c.restrictions,
      pronouns: c.pronouns,
    })),
    // Reach, presence and constraint stay per scene and never merge into a character's skills or
    // any other character-level field (I4): the GUI labels each with the scene it comes from so
    // none of them can ever read as intrinsic. A missing presence or constraint entry means
    // "unaffected", the unmarked default, and travels as absence — never as a value.
    scenes: loaded.story.scenes.map((s, i) => ({ n: i + 1, reach: s.reach ?? {}, presence: s.presence ?? {}, constraint: s.constraint ?? {} })),
  };
};

export const checkStory: StoryEditHost["checkStory"] = (story) => {
  const result = StoryJson.safeParse(story);
  if (!result.success) {
    return {
      ok: false, error: "validation failed",
      issues: result.error.issues.map(i => ({ path: i.path.join(".") || "story", message: i.message })),
    };
  }
  return { ok: true, warnings: storyWarnings(result.data) };
};

export const saveStory: StoryEditHost["saveStory"] = async (dir, story) => {
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
};

export const discardScene: StoryEditHost["discardScene"] = async (dir, n) => {
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
};

export const suggestEdits: StoryEditHost["suggestEdits"] = async (spec, text) => {
  const specObj = spec as StorySpec;
  try {
    const entries = await skillBibleEntries();
    return await withHostDefaults(hostModel() ?? "", async d => {
      const r = await statelessSuggest(d, specObj, String(text ?? ""), entries);
      if (r.kind === "failed") return { ok: false as const, error: r.error };
      if (r.kind === "question") return { ok: true as const, kind: "question" as const, ask: r.ask };
      return { ok: true as const, kind: "edits" as const, spec: r.spec, applied: r.applied, ignored: r.ignored, problems: r.problems, note: r.note };
    });
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }
};

export const catalogConfig: CatalogRoutesHost["catalogConfig"] = async () => ({
  tagFacets: TAG_FACETS,
  caps: { voiceSamples: VOICE_SAMPLE_CAP },
  assistFields: ASSIST_FIELDS,
  originSkills: await originSkillGroups(),
  generalSkills: await generalSkillEntries(),
});

export const catalogEntries: CatalogRoutesHost["catalogEntries"] = async (kind, opts) => {
  const validated = validateCatalogKind(kind);
  if (!validated) return { ok: false, reason: `no such catalog "${kind}"` };
  const catalog = await loadCatalog(validated);
  const entries = opts?.includeHidden ? catalog.entries : catalog.entries.filter((e: { hidden?: boolean }) => !e.hidden);
  return { ok: true, entries };
};

export const catalogCheck: CatalogRoutesHost["catalogCheck"] = async (kind, entry) => {
  const validated = validateCatalogKind(kind);
  if (!validated) return { ok: false, reason: `no such catalog "${kind}"` };
  const catalogs = await persistedCatalogs();
  const result = checkEntry(validated, entry, catalogs);
  if (!result.ok) return { ok: false, issues: result.issues };
  return { ok: true, problems: result.problems };
};

export const catalogSave: CatalogRoutesHost["catalogSave"] = async (kind, entry) => {
  const validated = validateCatalogKind(kind);
  if (!validated) return { ok: false, reason: `no such catalog "${kind}"` };
  const catalogs = await persistedCatalogs();
  return await saveEntry(validated, entry, undefined, catalogs);
};

export const catalogDelete: CatalogRoutesHost["catalogDelete"] = async (kind, id) => {
  const validated = validateCatalogKind(kind);
  if (!validated) return { ok: false, reason: `no such catalog "${kind}"` };
  const result = await deleteEntry(validated, id);
  // Engine says *what happened* (missing: true); host says *what that means over HTTP* (404).
  if (!result.ok && result.missing) {
    return { ok: false, reason: result.reason, status: 404 };
  }
  return result;
};

export const catalogSetVisibility: CatalogRoutesHost["catalogSetVisibility"] = async (kind, id, hidden) => {
  const validated = validateCatalogKind(kind);
  if (!validated) return { ok: false, reason: `no such catalog "${kind}"` };
  const result = await setVisibility(validated, id, hidden);
  // Engine says *what happened* (missing: true); host says *what that means over HTTP* (404).
  if (!result.ok && result.missing) {
    return { ok: false, reason: result.reason, status: 404 };
  }
  return result;
};

export const catalogUsage: CatalogRoutesHost["catalogUsage"] = async () => {
  const [characters, styles, skills] = await Promise.all(
    (["characters", "styles", "skills"] as const).map(k => loadCatalog(k)));
  const usage: CatalogUsage = { tags: {}, skills: {} };
  const tagFor = (label: unknown) => {
    const key = String(label ?? "").trim().toLowerCase();
    if (!key) return null;
    return usage.tags[key] ?? (usage.tags[key] = { styles: [] });
  };
  for (const s of styles.entries as { name?: string; tags?: string[] }[])
    for (const t of s.tags ?? []) { const u = tagFor(t); if (u) u.styles.push(String(s.name || "")); }
  // A skill is "used by" a character when resolution would find it: the name a character's
  // `name :: meaning` line holds, matched the way every identity comparison is (sameName).
  for (const c of characters.entries as { skills?: string[] }[])
    for (const raw of c.skills ?? []) {
      const name = splitMeaning(String(raw)).text;
      const key = Object.keys(usage.skills).find(k => sameName(k, name)) ?? name;
      usage.skills[key] = (usage.skills[key] ?? 0) + 1;
    }
  void skills;
  return usage;
};

export const catalogAssist: CatalogRoutesHost["catalogAssist"] = async (mode, fields, instruction, character) => {
  try {
    const catalogs = await persistedCatalogs();
    return await withHostDefaults(hostModel() ?? "", async d => {
      const r = await assistCharacter(d, {
        mode: mode as AssistMode, fields: fields as AssistField[], instruction,
        character: character as { id: string; name: string; portablePersona: string; belief: string;
                                   impulse: string; voice: string[]; origin: string; skills: string[];
                                   restrictions: string[] },
      }, catalogs);
      if (!r.ok) return { ok: false as const, kind: r.kind, reason: r.reason, issues: r.issues };
      return { ok: true as const, proposal: { draft: r.draft, changes: r.changes, warnings: r.warnings } };
    });
  } catch (e) {
    return { ok: false as const, kind: "provider_error" as const, reason: (e as Error).message };
  }
};
