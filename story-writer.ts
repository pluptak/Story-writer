/**
 * STORY WRITER — a writer agent that drafts prose and consults character agents about the choices
 * their characters make. A character answers from its own persona and only what the writer told it;
 * a rejected answer is re-asked of a FRESH instance that never learns it was rejected.
 *
 * The composition root: CLI wiring, the story picker, and the console entry points. The run itself
 * lives in run-and-save.ts; the ServerHost the viewer talks to lives in host.ts.
 */

import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { C } from "./ansi.ts";
import { LIVE, setWhere, sseWrite } from "./live.ts";
import { startServer } from "./server/server.ts";
import { ENGINE } from "./engine/engine-state.ts";
import { LMSTUDIO_URL, NET, lmUrlsDerivable } from "./engine/llm-client.ts";
import { loadStory, discoverStories, chooseStory, type StoryConfig } from "./engine/story-format.ts";
import { runPreflight, contextFit } from "./engine/preflight.ts";
import { canonWants, consult, type ConsultRequest } from "./engine/consult.ts";
import { configureArchitectDebug } from "./engine/architect.ts";
import { newCharacterAgent } from "./engine/scene-loop.ts";
import { setFitWarning } from "./engine/agent.ts";
import { setDebugWrite } from "./engine/json-extract.ts";
import { warn } from "./engine/warnings.ts";
import { runAndSave } from "./run-and-save.ts";
import { HOST } from "./host.ts";
import { PREFLIGHT, SERVE, PORT, ARCHITECT_DEBUG, ARCHITECT_DEBUG_LOG, STORY_DIR, flag, retiredFlagUsed } from "./cli-flags.ts";

// json-extract stays engine-free; its debug lines follow ENGINE.debug from here, at call time.
setDebugWrite(msg => { if (ENGINE.debug) process.stderr.write(msg); });

// The scene loop's context-fit check needs LM Studio's model info, which lives in preflight —
// a layer above agent.ts — so the same sink pattern as setDebugWrite wires it in from here.
setFitWarning(contextFit);

if (!lmUrlsDerivable(LMSTUDIO_URL))
  warn(`LM_STUDIO_URL (${LMSTUDIO_URL}) does not end in /chat/completions — the /models and `
    + `/api/v0/models endpoints derived from it will hit the wrong route, and model checks `
    + `will report "unreachable" no matter what is loaded`);

ENGINE.serve = SERVE;
configureArchitectDebug(ARCHITECT_DEBUG || !!ARCHITECT_DEBUG_LOG, ARCHITECT_DEBUG_LOG);

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
  const reply = await consult(agent, req, {
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
  if (reply.forced) console.log(`${C.yellow}(answered without the detail it asked for)${C.reset}`);
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
    else warn(`   (--steps=${stepsFlag} is not a whole number — using ${sc.maxSteps})`);
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

  return runAndSave(sc, dir, chapter, { serving: SERVE, serve });
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

const serve = () => startServer(PORT, HOST);

async function main() {
  const retired = retiredFlagUsed();
  if (retired) {
    console.error(`${retired} was removed — start the viewer with --serve and use the browser flow `
      + `(the shelf's new-story interview, or the handoff panel).`);
    process.exitCode = 1;
    return;
  }
  if (SERVE) serve();            // before the picker, so the viewer is up while you are still choosing
  const oneShot = !!STORY_DIR || !process.stdin.isTTY || flag("consult") !== undefined;
  BROWSER_DRIVES = SERVE && !oneShot;

  let next: { dir: string; chapter: number } =
    STORY_DIR ? { dir: STORY_DIR, chapter: 1 }
    : await pickStory();
  for (;;) {
    try {
      await runOne(next.dir, next.chapter);
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
