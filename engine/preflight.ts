/** PRE-FLIGHT — checking a story loads and its models are available, and the story-card listing. */
import { readFile, readdir, stat } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { SKILL_CATALOG, canonSkill } from "./skills.ts";
import { LMSTUDIO_MODELS_URL } from "./llm-client.ts";
import { loadStory, discoverStories, resolveStoryDir } from "./story-format.ts";

export async function runDirs(storyDir: string): Promise<string[]> {
  try {
    const ents = await readdir(joinPath(storyDir, "out"), { withFileTypes: true });
    return ents.filter(e => e.isDirectory()).map(e => e.name).sort();
  } catch { return []; }
}

let preflightChain: Promise<unknown> = Promise.resolve();
export interface PreflightResult {
  ok: boolean; error?: string; warnings: string[];
  summary?: {
    premise: string;
    characters: { name: string; skills: number; added: string[]; lacking: string[] }[];
    scene: { place: string; question: string; pov: string; length: number };
    maxSteps: number; retries: number; clarifications: number; maxProseWords: number;
    models: { default: string; writer: string; summary: string };
    modelCheck: "ok" | "missing" | "unreachable";
    missingModels: string[];
  };
}

let modelIdCache: { at: number; ids: Promise<string[] | null> } | null = null;
export async function loadedModelIds(timeoutMs = 1500): Promise<string[] | null> {
  if (modelIdCache && Date.now() - modelIdCache.at < 5000) return modelIdCache.ids;
  const ids = fetchModelIds(timeoutMs);
  modelIdCache = { at: Date.now(), ids };
  return ids;
}
async function fetchModelIds(timeoutMs: number): Promise<string[] | null> {
  try {
    const res = await fetch(LMSTUDIO_MODELS_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const j = await res.json() as { data?: Array<{ id?: unknown }> };
    const ids = (j.data ?? []).map(m => String(m.id ?? "")).filter(Boolean);
    return ids.length ? ids : null;
  } catch { return null; }
}

export function runPreflight(dir: string): Promise<PreflightResult> {
  const task = preflightChain.then(async (): Promise<PreflightResult> => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(" ")); };
    try {
      const sc = await loadStory(dir);

      const wanted = [...new Set([sc.models.default, sc.models.writer, sc.models.summary,
                                  ...sc.characters.map(c => c.model)])].filter(Boolean);
      const loaded = await loadedModelIds();
      let modelCheck: "ok" | "missing" | "unreachable" = "ok";
      let missingModels: string[] = [];
      if (loaded === null) {
        modelCheck = "unreachable";
        warnings.push(`   (model check skipped: no model list from LM Studio at ${LMSTUDIO_MODELS_URL})`);
      } else {
        missingModels = wanted.filter(m => !loaded.includes(m));
        if (missingModels.length) {
          modelCheck = "missing";
          warnings.push(`   (not loaded in LM Studio: ${missingModels.join(", ")} — every call using `
            + `${missingModels.length > 1 ? "these" : "this"} will error)`);
        }
      }

      return {
        ok: true, warnings,
        summary: {
          premise: sc.premise,
          characters: sc.characters.map(c => ({
            name: c.name,
            skills: c.skills.length,
            added: c.skills.filter(s => s.source === "story").map(s => s.name),
            lacking: Object.keys(SKILL_CATALOG).filter(g => !c.skills.some(s => canonSkill(s.name) === canonSkill(g))),
          })),
          scene: sc.scene,
          maxSteps: sc.maxSteps, retries: sc.retries, clarifications: sc.clarifications,
          maxProseWords: sc.maxProseWords,
          models: sc.models, modelCheck, missingModels,
        },
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message, warnings };
    } finally { console.warn = origWarn; }
  });
  preflightChain = task.catch(() => {});   // the chain must survive a check that throws
  return task;
}

export interface StoryCard {
  dir: string; name: string; ok: boolean; error?: string; warnings: string[];
  premise?: string;
  scene?: { place: string; question: string; pov: string; length: number };
  characters?: { name: string; can: string[]; cannot: string[] }[];
  maxSteps?: number;
  defaultModel?: string;
  runs: RunSummary[];
}

export interface RunSummary {
  id: string; mtimeMs: number;
  steps?: number; words?: number; done?: boolean; stopped?: boolean;
}
export async function retainedRuns(storyDir: string): Promise<RunSummary[]> {
  const ids = await runDirs(storyDir);
  const out: RunSummary[] = [];
  for (const id of ids) {
    const runPath = joinPath(storyDir, "out", id);
    let mtimeMs: number;
    try { mtimeMs = (await stat(runPath)).mtimeMs; } catch { continue; }
    const summary: RunSummary = { id, mtimeMs };
    try {
      const lines = (await readFile(joinPath(runPath, "writing-log.jsonl"), "utf8")).trim().split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const ev = JSON.parse(lines[i]);
        if (ev.t === "scene_end") {
          summary.steps = ev.steps; summary.words = ev.words; summary.done = ev.done; summary.stopped = ev.stopped;
          break;
        }
      }
    } catch { }
    out.push(summary);
  }
  return out.reverse();   // newest first
}

export async function storyCards(): Promise<StoryCard[]> {
  const dirs = await discoverStories();
  const out: StoryCard[] = [];
  for (const dir of dirs) {
    const r = await runPreflight(dir);
    const s = r.summary;
    out.push({
      dir, name: dir.replace(/^stories\//, ""), ok: r.ok, error: r.error,
      warnings: r.warnings.map(w => w.trim()),
      runs: await retainedRuns(resolveStoryDir(dir)),
      ...(s ? {
        premise: s.premise,
        scene: s.scene,
        characters: s.characters.map(c => ({ name: c.name, can: c.added, cannot: c.lacking })),
        maxSteps: s.maxSteps,
        defaultModel: s.models.default,
      } : {}),
    });
  }
  return out;
}
