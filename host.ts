/** HOST — the ServerHost handed to server/server.ts, plus everything only it needs: the story.json
 *  read/persist helpers (exactly one place reads the file, one place commits it) and the architect
 *  session factories with their defaults-scoped engine knobs. Built here so server/ never imports
 *  engine/ — routes receive behaviour through this object. */
import { writeFile, readFile, rename } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { LIVE } from "./live.ts";
import { ENGINE } from "./engine/engine-state.ts";
import { splitMeaning } from "./engine/skills.ts";
import { NET } from "./engine/llm-client.ts";
import { resolveStoryDir, loadStory, loadDefaults, writtenChapters, selectableStory, type Defaults } from "./engine/story-format.ts";
import { directEdit, specView, characterPsychologyWarnings, type StorySpec } from "./engine/story-spec.ts";
import { StoryJson } from "./engine/story-schema.ts";
import { runDirs, loadedModelIds, storyCards, runLlmLogs, readLlmLog } from "./engine/preflight.ts";
import {
  buildArchitect, ScaffoldSession, openNextChapter, suggestEdits as statelessSuggest,
  type NextChapterSession,
} from "./engine/architect.ts";
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
  // Re-load to confirm (catches silently-corrupt writes on constrained filesystems).
  try { await loadStory(dir); }
  catch (e) { return { ok: false, reason: `saved but does not load: ${(e as Error).message}` }; }
  return { ok: true };
}

/** The psychology fields are REQUIRED on every character: surfaced as editor/check warnings so an
 *  old or hand-edited story is told what its cards are missing. Shares its wording with normalizeSpec. */
const characterCardWarnings = (parsed: StoryJson): string[] =>
  parsed.characters.flatMap(c => characterPsychologyWarnings(c.name, c.belief, c.impulse, c.voice));

export const HOST: ServerHost = {
  storyCards, selectableStory, resolveStoryDir, runDirs, runLlmLogs, readLlmLog, writtenChapters, loadedModelIds,
  newScaffoldSession, newHandoffSession, directEdit, specView,
  architectModel: async () => (await loadDefaults(flag("model") ?? "")).models.architect,
  outDir: () => ENGINE.outDir,
  storyForEdit: async (dir) => {
    const loaded = await loadStoryJson(dir);
    if (!loaded.ok) return { ok: false, error: loaded.error, raw: loaded.raw };
    const parsed = loaded.story;
    const warnings: string[] = [];
    if (!parsed.premise.trim()) warnings.push("Premise is empty — there is nothing to write.");
    if (!parsed.characters.length) warnings.push("No characters defined — the writer would have nobody to consult.");
    for (const [i, s] of parsed.scenes.entries()) {
      if (!s.question) warnings.push(`Scene ${i + 1} has no question — the writer decides alone when the scene is done`);
    }
    warnings.push(...characterCardWarnings(parsed));
    return { ok: true, story: parsed, warnings };
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
    const parsed = result.data;
    const warnings: string[] = [];
    if (!parsed.premise.trim()) warnings.push("Premise is empty — there is nothing to write.");
    if (!parsed.characters.length) warnings.push("No characters defined — the writer would have nobody to consult.");
    for (const [i, s] of parsed.scenes.entries()) {
      if (!s.question) warnings.push(`Scene ${i + 1} has no question — the writer decides alone when the scene is done`);
    }
    warnings.push(...characterCardWarnings(parsed));
    return { ok: true, warnings };
  },
  saveStory: async (dir, story) => {
    // Validate first
    const check = StoryJson.safeParse(story);
    if (!check.success) {
      return { ok: false, reason: "validation failed" };
    }
    const parsed = check.data;
    if (!parsed.premise.trim()) return { ok: false, reason: "Premise is empty — there is nothing to write." };
    if (!parsed.characters.length) return { ok: false, reason: "No characters defined — the writer would have nobody to consult." };

    // Guard: run must not be in flight (already checked by route, but double-check)
    if (LIVE.running) return { ok: false, reason: "a run is in flight", status: 409 };

    const w = await persistStoryJson(dir, parsed);
    if (!w.ok) return { ok: false, reason: w.reason };

    const warnings: string[] = [];
    for (const [i, s] of parsed.scenes.entries()) {
      if (!s.question) warnings.push(`Scene ${i + 1} has no question — the writer decides alone when the scene is done`);
    }
    return { ok: true, warnings };
  },
  discardScene: async (dir, n) => {
    if (LIVE.running) return { ok: false, reason: "a run is in flight", status: 409 };
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
        return { ok: true as const, kind: "edits" as const, applied: r.applied, ignored: r.ignored, problems: r.problems, note: r.note };
      });
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
};
