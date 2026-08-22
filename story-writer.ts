/**
 * STORY WRITER — a writer agent that drafts prose and consults character agents about the choices
 * their characters make. A character answers from its own persona and only what the writer told it;
 * a rejected answer is re-asked of a FRESH instance that never learns it was rejected.
 */

import { writeFile, mkdir, rm, readFile, rename } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { join as joinPath } from "node:path";
import { C } from "./ansi.ts";
import { LIVE, resetLive, setWhere, publish, sseWrite } from "./live.ts";
import { startServer, type ServerHost } from "./server/server.ts";
import { ENGINE } from "./engine/engine-state.ts";
import { restrictionsOf, splitMeaning } from "./engine/skills.ts";
import { NET } from "./engine/llm-client.ts";
import { resolveStoryDir, loadStory, discoverStories, chooseStory, selectableStory, NEW_STORY,
  loadDefaults, writtenChapters, type StoryConfig, type Defaults,
} from "./engine/story-format.ts";
import { directEdit, renderSpec, specView, characterPsychologyWarnings, type StorySpec } from "./engine/story-spec.ts";
import { StoryJson } from "./engine/story-schema.ts";
import { runDirs, runPreflight, loadedModelIds, storyCards, runLlmLogs, readLlmLog } from "./engine/preflight.ts";
import { canonWants, consult, type ConsultRequest } from "./engine/consult.ts";
import {
  buildArchitect, ScaffoldSession, openNextChapter, suggestEdits as statelessSuggest,
  type ScaffoldRound, type NextChapterSession, type AutoStage, type AutoPass,
} from "./engine/architect.ts";
import { newCharacterAgent, runChapter, type RunEvent } from "./engine/scene-loop.ts";

// -- CONFIG ----------------------------------------------------------------
const CLI = process.argv.slice(2);
const PREFLIGHT = CLI.includes("--preflight");
const SERVE = CLI.includes("--serve");
const PORT = Number(CLI.find(a => a.startsWith("--port="))?.slice(7)) || 8080;
let STORY_DIR = CLI.find(a => !a.startsWith("--")) ?? "";
ENGINE.serve = SERVE;

const CHARACTER_PALETTE = [C.cyan, C.yellow, C.green, C.magenta];

async function runPreflightCli() {
  const dirs = STORY_DIR ? [STORY_DIR] : await discoverStories();
  if (!dirs.length) { console.error("No stories found under stories/."); process.exitCode = 1; return; }
  let failed = 0;
  for (const dir of dirs) {
    const r = await runPreflight(dir);
    const head = r.ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
    const titleSuffix = r.summary?.title ? ` ${C.dim}${r.summary.title}${C.reset}` : "";
    console.log(`\n${head} ${C.bold}${dir}${C.reset}${titleSuffix}`);
    if (!r.ok) { failed++; console.log(`   ${C.red}${r.error}${C.reset}`); }
    else if (r.summary) {
      const s = r.summary;
      for (const c of s.characters)
        console.log(`   ${c.name}: ${c.skills} skills`
          + (c.added.length ? ` (+${c.added.join(", ")})` : "")
          + (c.restrictions.length ? ` ${C.dim}(no ${c.restrictions.join(", ")})${C.reset}` : ""));
      console.log(`   steps ${s.maxSteps} · retries ${s.retries} · clarifications ${s.clarifications}`
        + ` · ≤${s.maxProseWords} words/piece`
        + (s.scene.pov ? ` · pov ${s.scene.pov}` : "")
        + ` · ~${s.scene.length} words · models ${s.modelCheck}`);
    }
    for (const w of r.warnings) console.log(`   ${C.yellow}⚠${C.reset} ${w.trim()}`);
    if (r.ok && !r.warnings.length) console.log(`   ${C.dim}no warnings${C.reset}`);
  }
  if (failed) process.exitCode = 1;
}

// -- ENTRY POINT -----------------------------------------------------------
const flag = (name: string): string | undefined => {
  const hit = CLI.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (hit === undefined) return undefined;
  const eq = hit.indexOf("=");
  return eq < 0 ? "" : hit.slice(eq + 1);
};

async function runConsultCli(sc: StoryConfig, who: string) {
  const def = sc.characters.find(c => c.name.toLowerCase() === who.trim().toLowerCase());
  if (!def) throw new Error(`No character "${who}" in ${sc.dir}. Known: ${sc.characters.map(c => c.name).join(", ")}`);
  const agent = newCharacterAgent(def, sc.scenes[0].place, sc.thinking.character);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (label: string, preset?: string) => {
    if (preset) return preset;
    return (await rl.question(`${label}: `)).trim();
  };
  const situation = await ask("Situation", flag("situation"));
  const question  = await ask("Question", flag("question"));
  const wants     = canonWants(flag("wants")) ?? "";
  const req: ConsultRequest = { character: def.name, situation, question, wants };

  console.log(`\n${C.bold}${def.name}${C.reset} ${C.dim}(${def.skills.length} skills, ${def.model})${C.reset}`);
  const reply = await consult(agent, req, def.skills, {
    clarifications: sc.clarifications,
    clarify: async (q) => {
      console.log(`\n${C.yellow}${def.name} asks:${C.reset} ${q}`);
      return (await rl.question(`${C.dim}your answer: ${C.reset}`)).trim();
    },
  });
  rl.close();

  console.log(`\n${C.dim}--- ${def.name} ---${C.reset}`);
  if (reply.thought) console.log(`${C.gray}thought:${C.reset} ${reply.thought}`);
  if (reply.speech)  console.log(`${C.cyan}speech: ${C.reset} "${reply.speech}"`);
  if (reply.action)  console.log(`${C.green}action: ${C.reset} ${reply.action}`);
  if (reply.note)    console.log(`${C.dim}note:    ${reply.note}${C.reset}`);
  console.log(`${C.dim}skills:  ${reply.skillsUsed.join(", ") || "(none listed)"}${C.reset}`);
  if (reply.unverified.length) console.log(`${C.red}unverified skills: ${reply.unverified.join(", ")}${C.reset}`);
  if (reply.forced) console.log(`${C.yellow}(answered without the detail it asked for)${C.reset}`);
}

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

async function readParagraph(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
  console.log(prompt);
  const lines: string[] = [];
  for (;;) {
    const line = await rl.question(lines.length ? `${C.dim}… ${C.reset}` : `${C.dim}> ${C.reset}`);
    if (!line.trim()) { if (lines.length) break; else continue; }
    lines.push(line.trim());
  }
  return lines.join("\n");
}

/** Print a proposal and whatever the engine has to say about it. */
function showSpec(spec: StorySpec, problems: string[], note = "", full = false) {
  console.log(`\n${"─".repeat(60)}\n${renderSpec(spec, full)}\n${"─".repeat(60)}`);
  if (note) console.log(`${C.dim}note: ${note}${C.reset}`);
  for (const p of problems) console.log(`${C.yellow}⚠${C.reset} ${p}`);
}

const SCAFFOLD_HINT = "Try saying more about who is in the scene and what is at stake.";

/** What each automatic pass is doing, for the CLI to print while it's in flight. This text is never
 *  sent to a model, so it does not belong in prompts.ts. */
const STAGE_LABEL: Record<AutoStage, string> = {
  fillGaps: "Filling in roster and facts…",
  verify: "Verifying consistency…",
};

/** The staged checklist as text: passed gates ticked, the open gate bold, the rest dim.
 *  Console-only decoration — nothing here is ever said to a model. */
const CHECKLIST_ORDER = ["story", "cast", "settings", "scene"] as const;

function checklistLine(stage: string | null): string {
  const cur = stage ? CHECKLIST_ORDER.indexOf(stage as typeof CHECKLIST_ORDER[number]) : -1;
  return CHECKLIST_ORDER.map((s, i) =>
    i < cur ? `${C.green}✓ ${s}${C.reset}`
    : i === cur ? `${C.bold}${s}${C.reset}`
    : `${C.dim}${s}${C.reset}`
  ).join(` ${C.dim}·${C.reset} `);
}

/** Print what each automatic fill-gaps/verify pass did, before the round's own outcome. */
function showAuto(auto?: AutoPass[]) {
  for (const a of auto ?? []) {
    const label = a.stage === "fillGaps" ? "fill-in" : "verify";
    if (a.outcome !== "edits") {
      console.log(`${C.dim}${label}: ${a.outcome === "failed" ? a.note : "nothing to add"}${C.reset}`);
      continue;
    }
    if (a.applied.length) console.log(`${C.dim}${label} changed:${C.reset} ${a.applied.map(x => x.field).join(", ")}`);
    for (const ig of a.ignored) console.log(`${C.yellow}⚠${C.reset} ${label} ignored ${ig}`);
  }
}

/** Print whatever a round did. The session decided it; this only says it out loud. */
function showRound(s: { spec: StorySpec; problems: string[] }, r: ScaffoldRound, hint = SCAFFOLD_HINT) {
  showAuto((r as { auto?: AutoPass[] }).auto);
  switch (r.kind) {
    case "failed":
      console.log(`${C.red}That round failed (${r.error}) — nothing changed.${C.reset}`); return;
    case "question":
      console.log(`\n${C.yellow}It needs to know:${C.reset} ${r.ask}`); return;
    case "nothing":
      if (/review the draft and accept/.test(r.why))
        console.log(`\n${C.green}Checklist complete — review the draft above, then [enter] or "accept".${C.reset}`);
      else
        console.log(`\n${C.yellow}Nothing came back to apply — ${r.why}.${C.reset} `
          + `${C.dim}${hint}${C.reset}`);
      return;
    case "proposal":
      showSpec(s.spec, s.problems, r.note); return;
    case "edits":
      if (!r.applied.length && !r.ignored.length) console.log(`${C.yellow}It changed nothing.${C.reset}`);
      else console.log(`${C.green}changed:${C.reset} ${r.applied.map(a => a.field).join(", ") || "(nothing)"}`);
      for (const ig of r.ignored) console.log(`${C.yellow}⚠${C.reset} ignored ${ig}`);
      showSpec(s.spec, s.problems, r.note); return;
  }
}

async function acceptAtConsole(session: ScaffoldSession,
                               rl: ReturnType<typeof createInterface>): Promise<string> {
  for (let folder = "";;) {
    const r = await session.accept(folder);
    if (r.kind === "no_story") { console.log(`${C.dim}Nothing to accept yet.${C.reset}`); return ""; }
    if (r.kind === "needs_folder") {
      // Never overwrite an authored story, and never invent a name when the title yields none.
      console.log(`${C.yellow}${r.reason}${C.reset}`);
      const said = (await rl.question(`${C.dim}folder name (blank to go back): ${C.reset}`)).trim();
      if (!said) return "";
      folder = said;
      continue;
    }
    if (r.kind === "unloadable") {
      console.log(`\n${C.red}The story was written to ${r.dir}/, but it does not load: ${r.error}${C.reset}`);
      console.log(`${C.dim}Nothing was kept — keep refining and accept again.${C.reset}`);
      return "";
    }
    console.log(`\n${C.green}Written:${C.reset} ${r.dir}/ ${C.dim}(${r.files.join(", ")})${C.reset}`);
    for (const w of r.warnings) console.log(`   ${C.yellow}⚠${C.reset} ${w}`);
    return r.dir;
  }
}

async function runScaffoldCli() {
  // Staged is the default walk; --oneshot keeps the whole-story proposal in one round.
  const stagedMode = !CLI.includes("--oneshot");
  const preset = flag("idea");
  if (!preset && !process.stdin.isTTY) throw new Error("--new needs a terminal, or an --idea=\"...\" to work from.");
  setWhere(stagedMode ? "building a new story — gated checklist at the console" : "building a new story — at the console", false);

  let idea = preset ?? "";
  if (!idea) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    idea = await readParagraph(rl,
      `\n${C.bold}What's the idea?${C.reset} ${C.dim}(as much or as little as you like; blank line when done)${C.reset}`);
    rl.close();
  }
  if (!idea.trim()) { console.log("Nothing to work with."); return; }

  const session = await newScaffoldSession(idea, "", stagedMode ? "staged" : "oneshot");
  const onStage = (stage: AutoStage) => console.log(`${C.dim}${STAGE_LABEL[stage]}${C.reset}`);

  console.log(`${C.dim}\nthinking about it (${session.defaults.models.architect})…${C.reset}`);
  showRound(session, await session.propose(onStage));

  if (!process.stdin.isTTY) {
    // A scripted run has no one to pass gates, so a staged session walks the whole checklist.
    if (session.mode === "staged")
      while (session.stage && !session.pendingAsk)
        showRound(session, await session.approve(onStage));
    return;
  }

  const rl2 = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const isStaged = session.mode === "staged";
      // Every stage landed and nothing is asked: the checklist's job is done, so [enter] now means
      // accept -- the same bare-enter the one-shot flow has always used at this point.
      const stagedComplete = isStaged && session.stage === "scene" && !session.pendingAsk
        && Boolean(session.spec.scenes[0]?.question.trim());
      if (isStaged) console.log(`\n${C.dim}checklist:${C.reset} ${checklistLine(session.stage)}`);
      const prompt = session.pendingAsk
        ? `\n${C.dim}your answer (or "q" to abort): ${C.reset}`
        : isStaged
          ? stagedComplete
            ? `\n${C.dim}[enter] accept & write story.json · "?" full detail · "q" abort · or say what to change${C.reset}\n${C.dim}> ${C.reset}`
            : `\n${C.dim}[enter] approve & continue · accept: write story.json · "?" full detail · "q" abort`
              + `\n${C.dim}or say what to change${C.reset}\n${C.dim}> ${C.reset}`
          : session.haveStory()
            ? `\n${C.dim}[enter] accept · "?" personas in full · "q" abort · or say what to change${C.reset}\n${C.dim}> ${C.reset}`
            : `\n${C.dim}say more about it, or "q" to abort${C.reset}\n${C.dim}> ${C.reset}`;
      const said = (await rl2.question(prompt)).trim();

      if (said.toLowerCase() === "q") { console.log("Abandoned. Nothing written."); return; }
      if (said === "?") {
        // Don't spend a model call showing nothing.
        if (session.haveStory()) showSpec(session.spec, [], "", true);
        else console.log(`${C.dim}Nothing to show yet.${C.reset}`);
        continue;
      }
      if (isStaged && session.pendingAsk) {
        // The architect's question stands: whatever is typed IS the answer to it.
        showRound(session, await session.say(said, onStage));
        continue;
      }
      let accepting = false;
      if (!said) {
        if (isStaged && !stagedComplete) {
          // Approval is never inferred from anything but the bare enter.
          console.log(`${C.dim}\npassing the gate (${session.defaults.models.architect})…${C.reset}`);
          showRound(session, await session.approve(onStage));
          continue;
        }
        if (!isStaged) {
          if (!session.haveStory()) continue;   // nothing to accept, and silence answers nothing
          if (session.pendingAsk) continue;     // it asked; silence is not an answer
        }
        accepting = true;
      } else if (isStaged && said.toLowerCase() === "accept") {
        accepting = true;
        if (!session.haveStory()) { console.log(`${C.dim}Nothing to accept yet.${C.reset}`); continue; }
        if (session.stage !== "scene")
          console.log(`${C.dim}(the checklist is not finished — accepting what exists so far)${C.reset}`);
      } else {
        showRound(session, await session.say(said, onStage));
        continue;
      }

      if (session.problems.length) {
        const sure = (await rl2.question(`${C.yellow}${session.problems.length} thing(s) flagged above. `
          + `Accept anyway? [y/N] ${C.reset}`)).trim().toLowerCase();
        if (sure !== "y") continue;
      }
      const dir = await acceptAtConsole(session, rl2);
      if (!dir) continue;                       // could not settle on a folder; back to refining
      rl2.close();
      const sc = await loadStory(dir, LIVE.modelOverride ?? undefined);
      ENGINE.stream = sc.stream; ENGINE.debug = sc.debug;
      NET.timeoutMs = sc.requestTimeout * 1000;
      NET.retries = sc.attempts - 1;
      ENGINE.maxTokens = sc.maxTokens;
      return runAndSave(sc, dir, 1);
    }
  } finally { rl2.close(); }
}

const HANDOFF_HINT = `Say what should be different about the next chapter.`;

/** The architect handoff at the console: re-author the cast between chapters, and write it on accept. */
async function runHandoffCli(dir: string) {
  let s: NextChapterSession;
  // A story with no chapters written is the ordinary first case, not a crash worth a stack trace.
  try { s = await newHandoffSession(dir); }
  catch (e) { console.error(`${C.red}${(e as Error).message}${C.reset}`); process.exitCode = 1; return; }
  setWhere(`preparing chapter ${s.chapter} of ${dir}`, false);
  console.log(`\n${C.bold}${dir}${C.reset} ${C.dim}— ${s.chapters.length} chapter(s) written · `
    + `preparing chapter ${s.chapter} (${s.defaults.models.architect})…${C.reset}`);
  const onStage = (stage: AutoStage) => console.log(`${C.dim}${STAGE_LABEL[stage]}${C.reset}`);
  showRound(s, await s.propose(onStage), HANDOFF_HINT);

  if (!process.stdin.isTTY) return;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const said = (await rl.question(s.pendingAsk
        ? `\n${C.dim}your answer (or "q" to leave it alone): ${C.reset}`
        : `\n${C.dim}[enter] accept · "?" personas in full · "q" abort · or say what to change${C.reset}`
          + `\n${C.dim}> ${C.reset}`)).trim();

      if (said.toLowerCase() === "q") { console.log(`${C.dim}Left alone. ${dir}/story.json is as it was.${C.reset}`); return; }
      if (said === "?") { showSpec(s.spec, [], "", true); continue; }
      if (said) { showRound(s, await s.say(said), HANDOFF_HINT); continue; }
      if (s.pendingAsk) continue;                  // it asked; silence is not an answer
      if (!s.edited) { console.log(`${C.dim}Nothing has changed yet, so there is nothing to accept.${C.reset}`); continue; }

      if (s.problems.length) {
        const sure = (await rl.question(`${C.yellow}${s.problems.length} thing(s) flagged above. `
          + `Accept anyway? [y/N] ${C.reset}`)).trim().toLowerCase();
        if (sure !== "y") continue;
      }
      const r = await s.accept();
      if (r.kind === "nothing") { console.log(`${C.dim}Nothing to accept yet.${C.reset}`); continue; }
      if (r.kind === "unloadable") {
        console.log(`${C.red}That story does not load: ${r.error}${C.reset}`);
        console.log(`${C.dim}${dir}/story.json was put back as it was. Keep refining, or "q".${C.reset}`);
        continue;
      }
      console.log(`\n${C.green}Written:${C.reset} ${r.dir}/ ${C.dim}(${r.files.join(", ")})${C.reset}`);
      for (const w of r.warnings) console.log(`   ${C.yellow}⚠${C.reset} ${w}`);
      console.log(`${C.dim}Write it with: npx tsx story-writer.ts ${dir} --chapter=${s.chapter}${C.reset}`);
      return;
    }
  } finally { rl.close(); }
}

/** Load one story, apply the debug flags, and either write its scene or answer one consult. */
async function runOne(dir: string, chapter = 1) {
  const sc = await loadStory(dir, LIVE.modelOverride ?? undefined);
  ENGINE.stream = sc.stream; ENGINE.debug = sc.debug;
  NET.timeoutMs = sc.requestTimeout * 1000;
  NET.retries = sc.attempts - 1;
  ENGINE.maxTokens = sc.maxTokens;

  const stepsFlag = flag("steps");
  if (stepsFlag) {
    const n = Number(stepsFlag);
    if (Number.isInteger(n) && n > 0) sc.maxSteps = n;
    else console.warn(`   (--steps=${stepsFlag} is not a whole number — using ${sc.maxSteps})`);
  }

  const who = flag("consult");
  if (who !== undefined) {
    if (!who) throw new Error(`--consult needs a character name, e.g. --consult=${sc.characters[0].name}`);
    return runConsultCli(sc, who);
  }

  const chapterFlag = flag("chapter");
  if (chapterFlag) chapter = Number(chapterFlag);
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > sc.scenes.length) {
    console.error(`${C.red}chapter must be a whole number in 1..${sc.scenes.length}, not ${chapterFlag ?? chapter}${C.reset}`);
    process.exitCode = 1;
    return;
  }

  return runAndSave(sc, dir, chapter);
}

let BROWSER_DRIVES = false;

function awaitPick(): Promise<{ dir: string; chapter: number }> {
  LIVE.awaitingPick = true;
  setWhere("choosing a story", false);
  console.log(`\n${C.dim}Waiting for a story to be chosen at ${C.reset}http://localhost:${LIVE.port}/`
    + `${C.dim} — Ctrl-C to quit.${C.reset}`);
  return new Promise<{ dir: string; chapter: number }>(r => { LIVE.pickResolve = r; }).then(picked => {
    setWhere("loading", false);
    return picked;
  });
}

/** Wait for the next story: the browser when it is driving, the console picker otherwise. */
async function pickStory(): Promise<{ dir: string; chapter: number }> {
  if (BROWSER_DRIVES) return awaitPick();
  setWhere("choosing a story", false);
  return { dir: await chooseStory(""), chapter: 1 };
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

/** The psychology fields are REQUIRED on every character: surfaced as editor/check warnings so an
 *  old or hand-edited story is told what its cards are missing. Shares its wording with normalizeSpec. */
const characterCardWarnings = (parsed: StoryJson): string[] =>
  parsed.characters.flatMap(c => characterPsychologyWarnings(c.name, c.belief, c.impulse, c.voice));

const HOST: ServerHost = {
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

    // Atomic write: write to .tmp, then rename over story.json
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

    // Re-load to confirm (catches silently-corrupt writes on constrained filesystems)
    try {
      await loadStory(dir);
    } catch (e) {
      return { ok: false, reason: `saved but does not load: ${(e as Error).message}` };
    }

    const warnings: string[] = [];
    for (const [i, s] of parsed.scenes.entries()) {
      if (!s.question) warnings.push(`Scene ${i + 1} has no question — the writer decides alone when the scene is done`);
    }
    return { ok: true, warnings };
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
const serve = () => startServer(PORT, HOST);

async function main() {
  if (SERVE) serve();            // before the picker, so the viewer is up while you are still choosing
  const oneShot = !!STORY_DIR || !process.stdin.isTTY || flag("consult") !== undefined;
  BROWSER_DRIVES = SERVE && !oneShot;

  let next: { dir: string; chapter: number } =
    CLI.includes("--new") ? { dir: NEW_STORY, chapter: 1 }
    : STORY_DIR ? { dir: STORY_DIR, chapter: 1 }
    : await pickStory();
  const handoff = flag("next-chapter") !== undefined;
  for (;;) {
    try {
      if (next.dir === NEW_STORY) await runScaffoldCli();
      else if (handoff) await runHandoffCli(next.dir);
      else await runOne(next.dir, next.chapter);
      if (oneShot) return;
    } catch (e) {
      const msg = (e as Error).message;
      sseWrite({ t: "run_error", message: msg });   // a --serve viewer is watching either way
      if (oneShot) throw e;                         // main().catch() says it, with the LM Studio hint
      console.error(`${C.red}${msg}${C.reset}`);
      setWhere("choosing a story", false);
      LIVE.awaitingPick = false;
    }
    next = await pickStory();
  }
}

const MAX_RUNS = 3;

async function runAndSave(sc: StoryConfig, dir: string, chapter: number = 1) {
  const sceneCount = sc.scenes.length;
  const targetScene = sc.scenes[chapter - 1];
  const chapterDisplay = sceneCount > 1 ? ` · chapter ${chapter} of ${sceneCount}` : "";
  console.log(`${C.bold}${dir}${C.reset} ${C.dim}— ${sc.characters.map(c => c.name).join(", ")} `
    + `${chapterDisplay} · ~${targetScene.length} words · up to ${sc.maxSteps} steps${C.reset}`);

  LIVE.meta = {
    story: dir, chapter, chapters: sceneCount, target: targetScene.length, question: targetScene.question,
    characters: sc.characters.map(c => ({
      name: c.name,
      skills: c.skills.filter(s => s.source !== "general").map(s => s.name),
      restrictions: restrictionsOf(c.skills),
    })),
  };
  resetLive();
  if (SERVE) serve();
  setWhere(`writing ${dir}`, true);

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  ENGINE.outDir = joinPath(sc.dir, "out", runId);
  await mkdir(ENGINE.outDir, { recursive: true });
  await mkdir(joinPath(ENGINE.outDir, "llm"), { recursive: true });
  ENGINE.llmStreams = new Map();
  ENGINE.llmFilenames = new Set();
  const scenePath = joinPath(ENGINE.outDir, "scene.md");
  const logPath = joinPath(ENGINE.outDir, "writing-log.jsonl");
  const logStream = createWriteStream(logPath, { flags: "w" });
  logStream.on("error", () => {});   // an async write failure must not crash the run

  const events: RunEvent[] = [];
  const allPieces: string[] = [];
  let sceneWrites: Promise<unknown> = Promise.resolve();
  let sceneWriteError: Error | null = null;

  // Safe stream closing: never throws, never hangs; errors are reported but don't displace the original exception
  const endStream = (stream: NodeJS.WritableStream): Promise<void> => {
    return new Promise<void>((resolve) => {
      stream.on("error", () => resolve());
      stream.end(() => resolve());
    });
  };

  let r: { prose: string[]; steps: number; words: number; done: boolean; stopped: boolean };
  let cleanupError: Error | null = null;
  try {
    r = await runChapter(sc, chapter, e => {
      events.push(e);
      logStream.write(JSON.stringify(publish(e)) + "\n");
      if (e.t === "draft" && e.prose) {
        allPieces.push(e.prose);
        sceneWrites = sceneWrites.then(() => writeFile(scenePath, allPieces.join("\n\n") + "\n", "utf8")).catch((err: unknown) => {
          if (!sceneWriteError) sceneWriteError = err instanceof Error ? err : new Error(String(err));
        });
      }
    });
  } finally {
    try {
      await sceneWrites;
      await endStream(logStream);
      await Promise.all([...ENGINE.llmStreams.values()].map(s => endStream(s)));
    } catch (e) {
      cleanupError = e as Error;
    }
  }

  if (sceneWriteError) {
    console.error(`${C.red}Failed to write scene.md: ${(sceneWriteError as Error).message}${C.reset}`);
    process.exitCode = 1;
  }
  if (cleanupError) {
    console.error(`${C.red}Error closing streams: ${cleanupError.message}${C.reset}`);
  }

  // Rotate: keep only the last MAX_RUNS folders, including the one just written.
  const kept = await runDirs(sc.dir);
  for (const stale of kept.slice(0, Math.max(0, kept.length - MAX_RUNS))) {
    await rm(joinPath(sc.dir, "out", stale), { recursive: true, force: true }).catch(() => {});
  }

  let chapterPath = "";
  if (r.done) {
    const chaptersDir = joinPath(sc.dir, "chapters");
    await mkdir(chaptersDir, { recursive: true });
    chapterPath = joinPath(chaptersDir, `${chapter}.md`);
    await writeFile(chapterPath, r.prose.join("\n\n") + "\n", "utf8");

    // The definition this chapter was written from, beside the prose rather than in out/, which is
    // rotated. The handoff rewrites story.json between chapters; without this, what produced an
    // older chapter is gone. Copied verbatim: re-rendering would record a normalised story, not the
    // authored one. Losing it must never cost the chapter that is already safely written.
    try {
      await writeFile(joinPath(chaptersDir, `${chapter}.json`),
                      await readFile(joinPath(sc.dir, "story.json"), "utf8"), "utf8");
    } catch (e) {
      console.log(`${C.dim}chapter ${chapter}'s definition was not snapshotted — ${(e as Error).message}${C.reset}`);
    }
  } else if (!r.stopped) {
    console.log(`${C.dim}chapter ${chapter} not saved — the run did not finish${C.reset}`);
  }

  setWhere(r.stopped ? `stopped ${dir}` : `finished ${dir}`, false);

  if (!SERVE) {
    console.log(`\n${C.bold}${"=".repeat(60)}${C.reset}`);
    console.log(r.prose.join("\n\n"));
    console.log(`${C.bold}${"=".repeat(60)}${C.reset}`);
  }
  const consults = events.filter(e => e.t === "consult").length;
  const retries  = events.filter(e => e.t === "retry").length;
  const needs    = events.filter(e => e.t === "need").length;
  const flags    = events.filter(e => e.t === "skill_flag").length;
  console.log(`${C.dim}${r.words} words · ${r.steps} steps · ${consults} consult(s) · `
    + `${needs} clarification(s) · ${retries} retry/retries · ${flags} skill flag(s) · `
    + `${r.stopped ? "stopped by request" : r.done ? "chapter finished" : "stopped early"}${C.reset}`);
  console.log(`${C.dim}${scenePath}\n${logPath}${chapterPath ? "\n" + chapterPath : ""}${C.reset}`);
}

const IS_MAIN = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (IS_MAIN) {
  if (PREFLIGHT) {
    runPreflightCli().catch(e => { console.error("\n[preflight error]", e.message); process.exitCode = 1; });
  } else {
    main().catch(e => {
      console.error("\n[story-writer error]", e.message);
      console.error("Check that LM Studio's server is running and the model identifiers are correct.");
      process.exitCode = 1;
    });
  }
}
