/** PRE-FLIGHT — checking a story loads and its models are available, and the story-card listing. */
import { readFile, readdir, stat } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { LMSTUDIO_MODELS_URL, LMSTUDIO_REST_MODELS_URL, estimateTokens, type Msg } from "./llm-client.ts";
import { loadStory, discoverStories, resolveStoryDir, writtenChapters, type SceneDef } from "./story-format.ts";
import { bibleMeaningOf, type BibleLookup } from "./skills.ts";
import { ENGINE } from "./engine-state.ts";
import { WARN } from "./warnings.ts";

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
    title: string;
    premise: string;
    characters: { name: string; skills: number; added: string[]; restrictions: string[] }[];
    scene: { place: string; question: string; pov: string; length: number };
    scenes: SceneDef[];
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

export interface ModelInfo { loaded: boolean; loadedContext: number; maxContext: number; }

/** Parse LM Studio's /api/v0/models body. Pure, so the fit rules below can be tested without a server. */
export function parseModelInfo(body: unknown): Map<string, ModelInfo> {
  const out = new Map<string, ModelInfo>();
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return out;
  for (const m of data) {
    const id = String((m as any)?.id ?? "");
    if (!id) continue;
    out.set(id, {
      loaded: (m as any)?.state === "loaded",
      loadedContext: Number((m as any)?.loaded_context_length) || 0,
      maxContext: Number((m as any)?.max_context_length) || 0,
    });
  }
  return out;
}

/** Whether a prompt of this size fits the window the model is actually loaded with, given the reply
 *  the request also reserves. Returns null when it fits, or when nothing is known about the model --
 *  an unknown model must not be reported as too small. */
export function contextShortfall(info: ModelInfo | undefined, promptTokens: number, replyTokens: number):
  { needs: number; has: number } | null {
  if (!info || !info.loaded || !info.loadedContext) return null;
  const needs = promptTokens + replyTokens;
  return needs > info.loadedContext ? { needs, has: info.loadedContext } : null;
}

/** The scene loop's early-warning version of the architect's fit check (architect.ts fails its
 *  round outright; a running scene can only be warned about). Estimates the whole outgoing message
 *  list against the context the model is actually loaded with, reserving room for the reply.
 *  Returns null when nothing is known or it fits — an unknown model must not warn. */
export async function contextFit(model: string, msgs: Msg[]):
  Promise<{ message: string; needs: number; has: number } | null> {
  const info = await modelInfo();
  const short = info && contextShortfall(info.get(model),
    estimateTokens(msgs.map(m => m.content).join("\n")), ENGINE.maxTokens);
  if (!short) return null;
  return {
    message: `${model} is loaded with ${short.has} tokens of context and this call needs about `
      + `${short.needs} — expect empty completions or truncation; raise its context length in LM Studio`,
    needs: short.needs,
    has: short.has,
  };
}

let modelInfoCache: { at: number; info: Promise<Map<string, ModelInfo> | null> } | null = null;
/** Cached fetcher for model info from LM Studio's native API. Returns null when the endpoint is unreachable or not LM Studio. */
export async function modelInfo(timeoutMs = 1500): Promise<Map<string, ModelInfo> | null> {
  if (modelInfoCache && Date.now() - modelInfoCache.at < 5000) return modelInfoCache.info;
  const info = fetchModelInfo(timeoutMs);
  modelInfoCache = { at: Date.now(), info };
  return info;
}
async function fetchModelInfo(timeoutMs: number): Promise<Map<string, ModelInfo> | null> {
  try {
    const res = await fetch(LMSTUDIO_REST_MODELS_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return parseModelInfo(await res.json());
  } catch { return null; }
}

export function runPreflight(dir: string, bible: BibleLookup = bibleMeaningOf): Promise<PreflightResult> {
  const task = preflightChain.then(async (): Promise<PreflightResult> => {
    const warnings: string[] = [];
    // The chain serializes checks, so swapping the sink here cannot capture another story's
    // warnings — and because it is the engine's own sink, nothing outside a load window is touched.
    const origSink = WARN.sink;
    WARN.sink = (...a: unknown[]) => { warnings.push(a.map(String).join(" ")); };
    try {
      const sc = await loadStory(dir, undefined, bible);

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

      // A window this small does not stop a run, but it is what an empty completion usually turns
      // out to be, and nothing else says so before the model returns nothing three times.
      const info = await modelInfo();
      for (const m of info ? wanted : []) {
        const mi = info!.get(m);
        if (mi?.loaded && mi.loadedContext && mi.loadedContext < 8192)
          warnings.push(`   (${m} is loaded with only ${mi.loadedContext} tokens of context — `
            + `the architect's opening handoff round alone is about 7,000)`);
      }

      return {
        ok: true, warnings,
        summary: {
          title: sc.title,
          premise: sc.premise,
          characters: sc.characters.map(c => ({
            name: c.name,
            skills: c.skills.length,
            added: c.skills.filter(s => s.source !== "general").map(s => s.name),
            restrictions: c.limits,
          })),
          scene: sc.scenes[0],
          scenes: sc.scenes,
          maxSteps: sc.maxSteps, retries: sc.retries, clarifications: sc.clarifications,
          maxProseWords: sc.maxProseWords,
          models: sc.models, modelCheck, missingModels,
        },
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message, warnings };
    } finally { WARN.sink = origSink; }
  });
  preflightChain = task.catch(() => {});   // the chain must survive a check that throws
  return task;
}

export interface StoryCard {
  dir: string; name: string; ok: boolean; error?: string; warnings: string[];
  title?: string;
  premise?: string;
  scene?: { place: string; question: string; pov: string; length: number };
  scenes?: SceneDef[];
  characters?: { name: string; skills: string[]; restrictions: string[] }[];
  maxSteps?: number;
  defaultModel?: string;
  runs: RunSummary[];
  chapters: number[];
}

export interface RunSummary {
  id: string; mtimeMs: number; chapter?: number;
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
        if (summary.chapter === undefined && typeof ev.chapter === "number") summary.chapter = ev.chapter;
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

export async function storyCards(bible: BibleLookup = bibleMeaningOf): Promise<StoryCard[]> {
  const dirs = await discoverStories();
  const out: StoryCard[] = [];
  for (const dir of dirs) {
    const r = await runPreflight(dir, bible);
    const s = r.summary;
    const [runs, chapters] = await Promise.all([retainedRuns(resolveStoryDir(dir)), writtenChapters(dir)]);
    out.push({
      dir, name: dir.replace(/^stories\//, ""), ok: r.ok, error: r.error,
      warnings: r.warnings.map(w => w.trim()),
      runs, chapters,
      ...(s ? {
        title: s.title,
        premise: s.premise,
        scene: s.scene,
        scenes: s.scenes,
        characters: s.characters.map(c => ({ name: c.name, skills: c.added, restrictions: c.restrictions })),
        maxSteps: s.maxSteps,
        defaultModel: s.models.default,
      } : {}),
    });
  }
  return out;
}

/** One agent's transcript within a run: what it was, how much it said, and under which model(s).
 *  `models` is a list because `/model` can swap the model mid-run. */
export interface LlmLogSummary {
  file: string; agent: string; role: string;
  models: string[]; calls: number; promptChars: number; responseChars: number;
}

/** Every per-agent transcript in one run, by filename. A run that never opened one -- killed before
 *  its first generation, or old enough to predate them -- lists nothing rather than failing. A line
 *  that will not parse is skipped, the same tolerance `retainedRuns` gives a truncated log. */
export async function runLlmLogs(storyDir: string, id: string): Promise<LlmLogSummary[]> {
  const dir = joinPath(storyDir, "out", id, "llm");
  let files: string[];
  try {
    files = (await readdir(dir, { withFileTypes: true }))
      .filter(e => e.isFile() && e.name.endsWith(".jsonl")).map(e => e.name).sort();
  } catch { return []; }

  const out: LlmLogSummary[] = [];
  for (const file of files) {
    const summary: LlmLogSummary = {
      file, agent: "", role: "", models: [], calls: 0, promptChars: 0, responseChars: 0,
    };
    try {
      for (const line of (await readFile(joinPath(dir, file), "utf8")).trim().split("\n")) {
        if (!line) continue;
        let ev: any;
        try { ev = JSON.parse(line); } catch { continue; }
        summary.calls++;
        if (!summary.agent && typeof ev.agent === "string") summary.agent = ev.agent;
        if (!summary.role && typeof ev.role === "string") summary.role = ev.role;
        if (typeof ev.model === "string" && !summary.models.includes(ev.model)) summary.models.push(ev.model);
        for (const m of Array.isArray(ev.prompt) ? ev.prompt : [])
          summary.promptChars += String(m?.content ?? "").length;
        summary.responseChars += String(ev.response ?? "").length;
      }
    } catch { continue; }
    out.push(summary);
  }
  return out;
}

/** One transcript's raw NDJSON, or null. `file` comes from outside the process, so it is checked
 *  against what `runLlmLogs` actually found rather than against a pattern -- the listing is the
 *  allowlist, and no caller-supplied text ever reaches a path join unvalidated. */
export async function readLlmLog(storyDir: string, id: string, file: string): Promise<string | null> {
  if (!(await runLlmLogs(storyDir, id)).some(l => l.file === file)) return null;
  try { return await readFile(joinPath(storyDir, "out", id, "llm", file), "utf8"); }
  catch { return null; }
}
