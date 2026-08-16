/** STORY FORMAT — parsing story.md, loading a full StoryConfig, and discovering stories on disk. */
import { readFile, readdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, join as joinPath, resolve as resolvePath } from "node:path";
import { C } from "../ansi.ts";
import { num, bool, enumOf } from "./config-util.ts";
import { resolveSkills, type Skill } from "./skills.ts";
import { THINK_LEVELS, type ThinkLevel } from "./llm-client.ts";

// -- STORY FORMAT ------------------------------------------------------------
export interface ParsedStory {
  kv: Record<string, string>;                    // "section.key" -> value
  characters: Array<Record<string, string>>;     // one map per ### block under ## Characters
  premise: string;
}
export function parseStoryMd(src: string): ParsedStory {
  const kv: Record<string, string> = {};
  const characters: Array<Record<string, string>> = [];
  let premise = "";
  let section = "";
  let character: Record<string, string> | null = null;

  for (const raw of src.split("\n")) {
    const line = raw.trimEnd();
    const h2 = line.match(/^##\s+(.+)/);
    const h3 = line.match(/^###\s+(.+)/);
    if (h3 && section === "characters") {
      character = { name: h3[1].trim() };
      characters.push(character);
      continue;
    }
    if (h2) { section = h2[1].trim().toLowerCase(); character = null; continue; }
    if (line.startsWith("#")) continue;

    if (section === "premise") {
      // Authors hand-wrap premise prose at some column for readability in the source file; a single
      // newline there is not a real line break, so it is joined with a space (a blank line still
      // starts a new paragraph) -- otherwise the viewer's pre-wrap rendering forces those same breaks
      // at whatever width the modal happens to be, fragmenting the text once it narrows.
      const trimmed = line.trim();
      if (!trimmed) premise += "\n\n";
      else premise += (premise && !premise.endsWith("\n") ? " " : "") + trimmed;
      continue;
    }

    const kvm = line.match(/^(\w[\w\s]*?)\s*:\s*(.+)/);
    if (!kvm) continue;
    const key = kvm[1].trim().toLowerCase();
    const val = kvm[2].trim();
    // Character fields are free-text prose; only structured sections lose a trailing "# comment".
    if (section === "characters" && character) character[key] = val;
    else kv[`${section}.${key}`] = val.replace(/\s+#.*$/, "").trim();
  }
  return { kv, characters, premise: premise.replace(/\n{3,}/g, "\n\n").trim() };
}

export interface CharacterDef {
  name: string;
  file: string;
  model: string;
  persona: string;      // raw persona markdown
  knows: string;        // what they know entering the scene
  goal: string;         // what they want tonight — theirs alone to weigh progress against
  skills: Skill[];      // effective set (catalog − lacks + skills)
}
export interface StoryConfig {
  dir: string;
  premise: string;
  scene: { place: string; question: string; pov: string; length: number };
  writerStyle: string;             // optional ## Writer / file: markdown, "" when undeclared
  retries: number;                 // writer rewrites per consult
  clarifications: number;          // questions a character may ask before it must answer
  maxSteps: number;                // soft budget of writer draft calls
  maxProseWords: number;           // ceiling on ONE draft's prose — the scene's pacing dial
  stream: boolean;
  debug: boolean;
  thinking: { writer: ThinkLevel; character: ThinkLevel; summary: ThinkLevel };
  requestTimeout: number;          // seconds before a model call is abandoned and retried
  attempts: number;                // TOTAL tries per model call (1 = never retry)
  maxTokens: number;
  models: { default: string; writer: string; summary: string };
  characters: CharacterDef[];
}

// Story dirs resolve against the repo root (one level up from engine/), not the cwd, so a run
// behaves the same anywhere.
export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const resolveStoryDir = (dir: string) => (isAbsolute(dir) ? dir : resolvePath(ROOT, dir));

export async function loadStory(dir: string, modelOverride?: string): Promise<StoryConfig> {
  const base = resolveStoryDir(dir);
  const read = (file: string) => readFile(joinPath(base, file), "utf8");
  const parsed = parseStoryMd(await read("story.md"));
  const kv = parsed.kv;

  const thinkingDefault = enumOf(kv, "config.thinking", THINK_LEVELS, "low");
  const thinking = {
    writer:    enumOf(kv, "config.thinking_writer",    THINK_LEVELS, thinkingDefault),
    character: enumOf(kv, "config.thinking_character", THINK_LEVELS, thinkingDefault),
    summary:   enumOf(kv, "config.thinking_summary",   THINK_LEVELS, thinkingDefault),
  };
  const requestTimeout = num(kv, "config.request_timeout", 120);   // seconds
  const attempts       = num(kv, "config.attempts", 3);
  const maxTokens      = num(kv, "config.max_tokens", 2000);
  const retries        = num(kv, "config.retries", 2);
  const clarifications = num(kv, "config.clarifications", 2);
  const maxSteps       = num(kv, "config.max_steps", 24);
  const maxProseWords  = num(kv, "config.max_prose_words", 140);
  const stream         = bool(kv, "config.stream", true);
  const debug          = bool(kv, "config.debug", false);

  const defaultModel = modelOverride || kv["models.default"] || "qwen3.6-35b-a3b";
  const models = {
    default: defaultModel,
    writer:  kv["models.writer"]  ?? defaultModel,
    summary: kv["models.summary"] ?? defaultModel,
  };

  const premise = parsed.premise.trim();
  if (!premise) throw new Error(`## Premise is empty in ${dir}/story.md — there is nothing to write.`);

  const scene = {
    place:    kv["scene.place"] ?? "",
    question: kv["scene.question"] ?? "",
    pov:      kv["scene.pov"] ?? "",
    length:   num(kv, "scene.length", 700),
  };
  if (!scene.question)
    console.warn(`   (## Scene has no "question:" — the writer has no dramatic question to close, so it decides alone when the scene is done)`);

  // Declared-but-unreadable is a hard failure, as every file reference is; undeclared is fine.
  const writerFile = kv["writer.file"];
  const writerStyle = writerFile
    ? await read(writerFile).catch(() => { throw new Error(`Writer style file "${writerFile}" (## Writer → file:) could not be read in ${dir}.`); })
    : "";

  if (!parsed.characters.length)
    throw new Error(`## Characters has no "### NAME" blocks in ${dir}/story.md — the writer would have nobody to consult.`);

  const characters: CharacterDef[] = [];
  const seen = new Set<string>();
  for (const c of parsed.characters) {
    const name = (c.name ?? "").trim();
    if (!name) throw new Error(`A ### character block in ${dir}/story.md has no name.`);
    if (seen.has(name.toLowerCase())) throw new Error(`Duplicate character "${name}" in ${dir}/story.md.`);
    seen.add(name.toLowerCase());
    if (!c.file) throw new Error(`Character "${name}" has no "file:" in ${dir}/story.md.`);
    const persona = await read(c.file).catch(() => {
      throw new Error(`Persona file "${c.file}" for ${name} could not be read in ${dir}.`);
    });
    characters.push({
      name, file: c.file,
      model: c.model ?? models.default,
      persona,
      knows: (c.knows ?? "").trim(),
      goal: (c.goal ?? "").trim(),
      skills: resolveSkills(name, c.skills ?? "", c.lacks ?? ""),
    });
  }

  if (scene.pov && !characters.some(c => c.name.toLowerCase() === scene.pov.trim().toLowerCase()))
    console.warn(`   (## Scene pov: "${scene.pov}" is not one of the characters — ignored)`);

  return {
    dir: base, premise, scene, writerStyle,
    retries, clarifications, maxSteps, maxProseWords, stream, debug, thinking,
    requestTimeout, attempts, maxTokens, models, characters,
  };
}

// -- DISCOVERY -------------------------------------------------------------
export async function discoverStories(): Promise<string[]> {
  const choices: string[] = [];
  try {
    const dirents = await readdir(joinPath(ROOT, "stories"), { withFileTypes: true });
    for (const d of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!d.isDirectory()) continue;
      try { await readFile(joinPath(ROOT, "stories", d.name, "story.md"), "utf8"); choices.push(`stories/${d.name}`); } catch {}
    }
  } catch {}
  return choices;
}

export const NEW_STORY = "\0new";
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

export async function selectableStory(dir: string): Promise<string | null> {
  const want = String(dir ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!want) return null;
  const choices = await discoverStories();
  return choices.find(c => c === want || c === `stories/${want}`) ?? null;
}

const BUILTIN_MODEL = "qwen3.6-35b-a3b";
export interface Defaults {
  models: { default: string; architect: string };
  thinking: { architect: ThinkLevel };
  requestTimeout: number; attempts: number; maxTokens: number; stream: boolean; debug: boolean;
}
export async function loadDefaults(override = ""): Promise<Defaults> {
  let kv: Record<string, string> = {};
  try { kv = parseStoryMd(await readFile(joinPath(ROOT, "defaults.md"), "utf8")).kv; } catch { }
  const def = override || kv["models.default"] || BUILTIN_MODEL;
  const thinkingDefault = enumOf(kv, "config.thinking", THINK_LEVELS, "low");
  return {
    models: { default: def, architect: override || kv["models.architect"] || def },
    thinking: { architect: enumOf(kv, "config.thinking_architect", THINK_LEVELS, thinkingDefault) },
    requestTimeout: num(kv, "config.request_timeout", 120),
    attempts: num(kv, "config.attempts", 3),
    maxTokens: num(kv, "config.max_tokens", 2000),
    stream: bool(kv, "config.stream", true),
    debug: bool(kv, "config.debug", false),
  };
}
