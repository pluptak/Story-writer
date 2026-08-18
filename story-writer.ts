/**
 * STORY WRITER — a writer agent that drafts prose and consults character agents about the choices
 * their characters make. A character answers from its own persona and only what the writer told it;
 * a rejected answer is re-asked of a FRESH instance that never learns it was rejected.
 */

import { writeFile, mkdir, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { join as joinPath } from "node:path";
import { C } from "./ansi.ts";
import { LIVE, resetLive, setWhere, publish } from "./live.ts";
import { startServer, type ServerHost } from "./server/server.ts";
import { ENGINE } from "./engine/engine-state.ts";
import { restrictionsOf } from "./engine/skills.ts";
import { NET } from "./engine/llm-client.ts";
import {
  resolveStoryDir, loadStory, discoverStories, chooseStory, selectableStory, NEW_STORY,
  loadDefaults, type StoryConfig,
} from "./engine/story-format.ts";
import { directEdit, renderSpec, specView, type StorySpec } from "./engine/story-spec.ts";
import { runDirs, runPreflight, loadedModelIds, storyCards } from "./engine/preflight.ts";
import { canonWants, consult, type ConsultRequest } from "./engine/consult.ts";
import { buildArchitect, ScaffoldSession, type ScaffoldRound } from "./engine/architect.ts";
import { buildCharacterAgents, writeScenes, type RunEvent } from "./engine/scene-loop.ts";

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
    console.log(`\n${head} ${C.bold}${dir}${C.reset}`);
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
  const agents = buildCharacterAgents(sc.characters, sc.scene.place, "", { character: sc.thinking.character }, []);
  const def = sc.characters.find(c => c.name.toLowerCase() === who.trim().toLowerCase());
  const agent = agents.get(who.trim().toLowerCase());
  if (!def || !agent) throw new Error(`No character "${who}" in ${sc.dir}. Known: ${sc.characters.map(c => c.name).join(", ")}`);

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

async function newScaffoldSession(idea: string, model = ""): Promise<ScaffoldSession> {
  const d = await loadDefaults(model || flag("model") || "");
  ENGINE.stream = d.stream; ENGINE.debug = d.debug;
  NET.timeoutMs = d.requestTimeout * 1000;
  NET.retries = d.attempts - 1;
  ENGINE.maxTokens = d.maxTokens;
  return new ScaffoldSession(await buildArchitect(d), d, idea);
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

/** Print whatever a round did. The session decided it; this only says it out loud. */
function showRound(s: ScaffoldSession, r: ScaffoldRound) {
  switch (r.kind) {
    case "failed":
      console.log(`${C.red}That round failed (${r.error}) — nothing changed.${C.reset}`); return;
    case "question":
      console.log(`\n${C.yellow}It needs to know:${C.reset} ${r.ask}`); return;
    case "nothing":
      console.log(`\n${C.yellow}It didn't come back with a story.${C.reset} `
        + `${C.dim}Try saying more about who is in the scene and what is at stake.${C.reset}`); return;
    case "proposal":
      showSpec(s.spec, s.problems, r.note); return;
    case "edits":
      if (!r.applied.length && !r.ignored.length) console.log(`${C.yellow}It changed nothing.${C.reset}`);
      else console.log(`${C.green}changed:${C.reset} ${r.applied.join(", ") || "(nothing)"}`);
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
    console.log(`\n${C.green}Written:${C.reset} ${r.dir}/ ${C.dim}(${r.files.join(", ")})${C.reset}`);
    for (const w of r.warnings) console.log(`   ${C.yellow}⚠${C.reset} ${w}`);
    if (r.kind === "unloadable") {
      console.log(`${C.red}It was written, but it does not load: ${r.error}${C.reset}`);
      console.log(`${C.dim}Fix it by hand in ${r.dir}/, or keep refining and accept again.${C.reset}`);
      return "";
    }
    return r.dir;
  }
}

async function runScaffoldCli() {
  const preset = flag("idea");
  if (!preset && !process.stdin.isTTY) throw new Error("--new needs a terminal, or an --idea=\"...\" to work from.");
  setWhere("building a new story — at the console", false);

  let idea = preset ?? "";
  if (!idea) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    idea = await readParagraph(rl,
      `\n${C.bold}What's the idea?${C.reset} ${C.dim}(as much or as little as you like; blank line when done)${C.reset}`);
    rl.close();
  }
  if (!idea.trim()) { console.log("Nothing to work with."); return; }

  const session = await newScaffoldSession(idea);

  console.log(`${C.dim}\nthinking about it (${session.defaults.models.architect})…${C.reset}`);
  showRound(session, await session.propose());

  if (!process.stdin.isTTY) return;

  const rl2 = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const prompt = session.pendingAsk
        ? `\n${C.dim}your answer (or "q" to abort): ${C.reset}`
        : session.haveStory()
          ? `\n${C.dim}[enter] accept · "?" personas in full · "q" abort · or say what to change${C.reset}\n${C.dim}> ${C.reset}`
          : `\n${C.dim}say more about it, or "q" to abort${C.reset}\n${C.dim}> ${C.reset}`;
      const said = (await rl2.question(prompt)).trim();

      if (said.toLowerCase() === "q") { console.log("Abandoned. Nothing written."); return; }
      if (!said && !session.haveStory()) continue;   // nothing to accept, and silence answers nothing
      if (!said && session.pendingAsk) continue;     // it asked; silence is not an answer
      if (!said) {
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
        return runAndSave(sc, dir);
      }
      if (said === "?") {
        // Don't spend a model call showing nothing.
        if (session.haveStory()) showSpec(session.spec, [], "", true);
        else console.log(`${C.dim}Nothing to show yet.${C.reset}`);
        continue;
      }

      showRound(session, await session.say(said));
    }
  } finally { rl2.close(); }
}

/** Load one story, apply the debug flags, and either write its scene or answer one consult. */
async function runOne(dir: string) {
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

  return runAndSave(sc, dir);
}

let BROWSER_DRIVES = false;

function awaitPick(): Promise<string> {
  LIVE.awaitingPick = true;
  setWhere("choosing a story", false);
  console.log(`\n${C.dim}Waiting for a story to be chosen at ${C.reset}http://localhost:${LIVE.port}/`
    + `${C.dim} — Ctrl-C to quit.${C.reset}`);
  return new Promise<string>(r => { LIVE.pickResolve = r; }).then(picked => {
    setWhere("loading", false);
    return picked;
  });
}

/** Wait for the next story: the browser when it is driving, the console picker otherwise. */
async function pickStory(): Promise<string> {
  if (BROWSER_DRIVES) return awaitPick();
  setWhere("choosing a story", false);
  return chooseStory("");
}

const HOST: ServerHost = {
  storyCards, selectableStory, resolveStoryDir, runDirs, loadedModelIds,
  newScaffoldSession, directEdit, specView,
  architectModel: async () => (await loadDefaults(flag("model") ?? "")).models.architect,
  outDir: () => ENGINE.outDir,
};
const serve = () => startServer(PORT, HOST);

async function main() {
  if (SERVE) serve();            // before the picker, so the viewer is up while you are still choosing
  const oneShot = !!STORY_DIR || !process.stdin.isTTY || flag("consult") !== undefined;
  BROWSER_DRIVES = SERVE && !oneShot;

  let next: string = CLI.includes("--new") ? NEW_STORY
                   : STORY_DIR ? STORY_DIR
                   : await pickStory();
  for (;;) {
    if (next === NEW_STORY) await runScaffoldCli();
    else await runOne(next);
    if (oneShot) return;
    next = await pickStory();
  }
}

const MAX_RUNS = 3;

async function runAndSave(sc: StoryConfig, dir: string) {
  const sceneCount = sc.scenes.length;
  const firstScene = sc.scenes[0];
  console.log(`${C.bold}${dir}${C.reset} ${C.dim}— ${sc.characters.map(c => c.name).join(", ")} `
    + `· ~${firstScene.length} words ${sceneCount > 1 ? `(${sceneCount} scenes) ` : ""}· up to ${sc.maxSteps} steps per scene${C.reset}`);

  LIVE.meta = {
    story: dir, target: firstScene.length, question: firstScene.question,
    characters: sc.characters.map(c => ({
      name: c.name,
      skills: c.skills.filter(s => s.source === "story").map(s => s.name),
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

  const events: RunEvent[] = [];
  const allPieces: string[] = [];
  let sceneWrites: Promise<unknown> = Promise.resolve();
  let currentChapter = 0;

  const r = await writeScenes(sc, e => {
    events.push(e);
    logStream.write(JSON.stringify(publish(e)) + "\n");
    if (e.t === "draft" && e.prose) {
      allPieces.push(e.prose);
      sceneWrites = sceneWrites.then(() => {
        const sep = e.chapter > 1 && currentChapter !== e.chapter
          ? `\n\n---\n*Chapter ${e.chapter}*\n\n` : "";
        currentChapter = e.chapter;
        return writeFile(scenePath, allPieces.join("\n\n") + "\n", "utf8");
      }).catch(() => {});
    }
  });
  await sceneWrites;
  await new Promise<void>(res => logStream.end(res));
  await Promise.all([...ENGINE.llmStreams.values()].map(s => new Promise<void>(res => s.end(res))));

  // Rotate: keep only the last MAX_RUNS folders, including the one just written.
  const kept = await runDirs(sc.dir);
  for (const stale of kept.slice(0, Math.max(0, kept.length - MAX_RUNS))) {
    await rm(joinPath(sc.dir, "out", stale), { recursive: true, force: true }).catch(() => {});
  }

  setWhere(r.stopped ? `stopped ${dir}` : `finished ${dir}`, false);

  if (!SERVE) {
    console.log(`\n${C.bold}${"=".repeat(60)}${C.reset}`);
    for (const s of r.scenes) console.log(s.prose.join("\n\n"));
    console.log(`${C.bold}${"=".repeat(60)}${C.reset}`);
  }
  const consults = events.filter(e => e.t === "consult").length;
  const retries  = events.filter(e => e.t === "retry").length;
  const needs    = events.filter(e => e.t === "need").length;
  const flags    = events.filter(e => e.t === "skill_flag").length;
  console.log(`${C.dim}${r.words} words · ${r.steps} steps · ${consults} consult(s) · `
    + `${needs} clarification(s) · ${retries} retry/retries · ${flags} skill flag(s) · `
    + `${r.stopped ? "stopped by request" : "scene finished"}${C.reset}`);
  console.log(`${C.dim}${scenePath}\n${logPath}${C.reset}`);
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
