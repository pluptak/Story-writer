/** STORY FORMAT — loads and validates story.json, and discovers stories on disk. */
import { readFile, readdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, join as joinPath, resolve as resolvePath } from "node:path";
import { C } from "../ansi.ts";
import { removedCapabilities, resolveSkills, type Skill } from "./skills.ts";
import { warn as emitWarn } from "./warnings.ts";
import { StoryJson, type SceneDef, type CharacterDef as SchemaCharacterDef, type ThinkLevel } from "./story-schema.ts";

export type { SceneDef } from "./story-schema.ts";

/** A loaded character: everything the agents need, with skills already resolved to the final list,
 *  and `limits` carrying what the authored restrictions took away as explicit negative facts —
 *  general AND special skills, so a removed lockpicking is nameable, not merely absent. */
export interface CharacterDef {
  name: string;
  model: string;
  persona: string;
  knows: string;
  goal: string;
  belief: string;
  impulse: string;
  voice: string[];
  skills: Skill[];
  limits: string[];
  maxRetries?: number;
}

/** A story as loaded and validated: the engine's view of story.json, with defaults filled in. */
export interface StoryConfig {
  dir: string;
  title: string;
  premise: string;
  scenes: SceneDef[];
  writerStyle: string;
  facts: string[];
  retries: number;
  clarifications: number;
  maxSteps: number;
  maxProseWords: number;
  stream: boolean;
  debug: boolean;
  thinking: { writer: ThinkLevel; character: ThinkLevel; summary: ThinkLevel };
  requestTimeout: number;
  attempts: number;
  maxTokens: number;
  models: { default: string; writer: string; summary: string };
  characters: CharacterDef[];
  maxCharacterRetries?: number;
}

/** The repo root, resolved from this file so relative paths work no matter where the process starts. */
export const ROOT = fileURLToPath(new URL("..", import.meta.url));
/** Resolve a story directory against the repo root (an absolute path passes through unchanged). */
export const resolveStoryDir = (dir: string) => (isAbsolute(dir) ? dir : resolvePath(ROOT, dir));

/** Validate and load a story into a StoryConfig; a model override beats the story's own default. */
export async function loadStory(dir: string, modelOverride?: string): Promise<StoryConfig> {
  const base = resolveStoryDir(dir);
  const storyPath = joinPath(base, "story.json");
  const raw = JSON.parse(await readFile(storyPath, "utf8"));
  const result = StoryJson.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map(i => `${i.path.join(".") || "story"}: ${i.message}`);
    throw new Error(`${storyPath}\n${lines.join("\n")}`);
  }
  const parsed = result.data;

  if (!parsed.premise.trim())
    throw new Error(`Premise is empty in ${base}/story.json — there is nothing to write.`);

  const warn = (msg: string) => emitWarn(`  (${msg})`);

  const defaultModel = modelOverride || parsed.models.default;
  const models = {
    default: defaultModel,
    writer:  parsed.models.writer ?? defaultModel,
    summary: parsed.models.summary ?? defaultModel,
  };

  const characters: CharacterDef[] = [];
  const seen = new Set<string>();
  for (const c of parsed.characters) {
    const name = c.name.trim();
    if (!name) { warn("a character has no name — skipped"); continue; }
    if (seen.has(name.toLowerCase())) { warn(`Duplicate character "${name}" — skipped`); continue; }
    seen.add(name.toLowerCase());
    const skillsRaw = c.skills.join(" | "), restrictionsRaw = c.restrictions.join(" | ");
    characters.push({
      name,
      model: c.model || defaultModel,
      persona: c.persona,
      knows: c.knows,
      goal: c.goal,
      belief: c.belief,
      impulse: c.impulse,
      voice: c.voice,
      skills: resolveSkills(name, skillsRaw, restrictionsRaw),
      limits: removedCapabilities(name, skillsRaw, restrictionsRaw),
      maxRetries: c.maxRetries,
    });
  }

  if (!characters.length)
    throw new Error(`No characters defined in ${base}/story.json — the writer would have nobody to consult.`);

  for (const [i, s] of parsed.scenes.entries()) {
    if (!s.question)
      warn(`Scene ${i + 1} has no "question" — the writer has no dramatic question to close, so it decides alone when the scene is done`);
    if (s.pov && !characters.some(c => c.name.toLowerCase() === s.pov.trim().toLowerCase()))
      warn(`Scene ${i + 1} pov "${s.pov}" is not one of the characters — ignored`);
    for (const r of s.roster) {
      if (!characters.some(c => c.name.toLowerCase() === r.trim().toLowerCase()))
        warn(`Scene ${i + 1} roster "${r}" is not one of the characters — ignored`);
    }
    // Reach is scene-scoped (I1), so it is only ever checked for well-formedness here; the character
    // base above resolves with reach empty (I4). A grant to nobody who can receive it is dead weight.
    for (const [who] of Object.entries(s.reach ?? {})) {
      const ch = characters.find(c => c.name.toLowerCase() === who.trim().toLowerCase());
      if (!ch) warn(`Scene ${i + 1} grants reach to "${who}", who is not one of the characters — ignored`);
      else if (s.roster.length && !s.roster.some(r => r.trim().toLowerCase() === who.toLowerCase()))
        warn(`Scene ${i + 1} grants reach to "${who}", who is not in its roster — the grant never reaches a run`);
    }
  }

  const config = parsed.config;

  return {
    dir: base,
    title: parsed.title,
    premise: parsed.premise,
    scenes: parsed.scenes,
    writerStyle: parsed.writerStyle,
    facts: parsed.facts,
    retries: config.retries,
    clarifications: config.clarifications,
    maxSteps: config.maxSteps,
    maxProseWords: config.maxProseWords,
    stream: config.stream,
    debug: config.debug,
    thinking: {
      writer: config.thinking.writer as ThinkLevel,
      character: config.thinking.character as ThinkLevel,
      summary: config.thinking.summary as ThinkLevel,
    },
    requestTimeout: config.requestTimeout,
    attempts: config.attempts,
    maxTokens: config.maxTokens,
    models,
    characters,
    maxCharacterRetries: config.maxCharacterRetries,
  };
}

// -- DISCOVERY -------------------------------------------------------------
/** Every story folder under stories/ that has a loadable story.json, sorted by name. An absent
 *  stories/ directory is a fresh checkout and stays silent; any other listing failure warns,
 *  since an empty shelf would otherwise be indistinguishable from "no stories". */
export async function discoverStories(): Promise<string[]> {
  const choices: string[] = [];
  try {
    const dirents = await readdir(joinPath(ROOT, "stories"), { withFileTypes: true });
    for (const d of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!d.isDirectory()) continue;
      try { await readFile(joinPath(ROOT, "stories", d.name, "story.json"), "utf8"); choices.push(`stories/${d.name}`); } catch {}
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      emitWarn(`could not list stories/: ${(e as Error).message}`);
  }
  return choices;
}

export const NEW_STORY = "\0new";
/** Ask the user to pick a story, or "n" for a new one; without a terminal, picks the first or errors. */
export async function chooseStory(arg: string): Promise<string> {
  if (arg) return arg;
  const choices = await discoverStories();
  if (!process.stdin.isTTY) {
    if (!choices.length) throw new Error("No stories found under stories/.");
    return choices[0];
  }
  if (!choices.length) {
    console.log(`\n${C.dim}No stories yet — let's build one.${C.reset}`);
    return NEW_STORY;
  }

  console.log("\nAvailable stories:");
  choices.forEach((c, i) => console.log(`  ${i + 1}. ${c.replace(/^stories\//, "")}`));
  console.log(`  n. ${C.green}new story…${C.reset} ${C.dim}(describe an idea and have one built)${C.reset}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question(`Pick a story [1-${choices.length}] or "n" (default 1): `)).trim();
  rl.close();
  if (/^n/i.test(ans)) return NEW_STORY;
  const idx = parseInt(ans, 10) - 1;
  return choices[Number.isInteger(idx) && idx >= 0 && idx < choices.length ? idx : 0];
}

/** Resolve a directory that came from OUTSIDE the process to a discovered story, or null if it is not one. */
export async function selectableStory(dir: string): Promise<string | null> {
  const want = String(dir ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!want) return null;
  const choices = await discoverStories();
  return choices.find(c => c === want || c === `stories/${want}`) ?? null;
}

const BUILTIN_MODEL = "qwen3.6-35b-a3b";
/** The scaffold interview's knobs: models, architect thinking, and the request retry settings. */
export interface Defaults {
  models: { default: string; architect: string };
  thinking: { architect: ThinkLevel };
  requestTimeout: number; attempts: number; maxTokens: number; stream: boolean; debug: boolean;
}
/** Read defaults.json, falling back to built-ins; `override` (e.g. --model) beats everything in it.
 *  A missing file is the ordinary first run and stays silent; a file that exists but cannot be
 *  read or parsed would otherwise silently swap the configured model for the built-in one, so it
 *  warns. `path` is injectable so tests can point this at their own file. */
export async function loadDefaults(override = "", path = joinPath(ROOT, "defaults.json")): Promise<Defaults> {
  let parsed: any = {};
  try { parsed = JSON.parse(await readFile(path, "utf8")); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      emitWarn(`defaults.json could not be read (${(e as Error).message}) — using built-in defaults`);
  }
  const def = override || parsed.models?.default || BUILTIN_MODEL;
  return {
    models: { default: def, architect: override || parsed.models?.architect || def },
    thinking: { architect: (parsed.config?.thinking_architect ?? parsed.config?.thinking ?? "low") as ThinkLevel },
    requestTimeout: parsed.config?.request_timeout ?? 120,
    attempts: parsed.config?.attempts ?? 3,
    maxTokens: parsed.config?.max_tokens ?? 2000,
    stream: parsed.config?.stream ?? true,
    debug: parsed.config?.debug ?? false,
  };
}

/** The chapter numbers already written to <storyDir>/chapters/, ordered. */
export async function writtenChapters(storyDir: string): Promise<number[]> {
  const chaptersDir = joinPath(resolveStoryDir(storyDir), "chapters");
  let dirents;
  try { dirents = await readdir(chaptersDir, { withFileTypes: true }); } catch { return []; }
  return dirents
    .filter(d => d.isFile() && /^\d+\.md$/.test(d.name))
    .map(d => Number(d.name.slice(0, -3)))
    .sort((a, b) => a - b);
}

/** Read all chapter files from <storyDir>/chapters/, returning chapter number and prose text ordered numerically. */
export async function readChapters(storyDir: string): Promise<{ n: number; text: string }[]> {
  const base = resolveStoryDir(storyDir);
  const chapters: { n: number; text: string }[] = [];
  for (const n of await writtenChapters(storyDir))
    chapters.push({ n, text: await readFile(joinPath(base, "chapters", `${n}.md`), "utf8") });
  return chapters;
}

/** The story definition a chapter was written from, or null for a chapter written before snapshots
 *  existed (or one whose snapshot will not parse). */
export async function readChapterSpec(storyDir: string, n: number): Promise<unknown | null> {
  const base = resolveStoryDir(storyDir);
  try {
    const text = await readFile(joinPath(base, "chapters", `${n}.json`), "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}
