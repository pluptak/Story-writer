/**
 * STORY WRITER — a writer agent that drafts prose and consults character agents about the choices
 * their characters make. A character answers from its own persona and only what the writer told it;
 * a rejected answer is re-asked of a FRESH instance that never learns it was rejected.
 *
 * The composition root: import-time engine wiring, the console entry points (--preflight and
 * --consult), and the handoff of the run loop to app.ts. The run itself lives in run-and-save.ts;
 * the ServerHost the viewer talks to lives in host.ts.
 */

import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { C } from "./ansi.ts";
import { ENGINE } from "./engine/engine-state.ts";
import { LMSTUDIO_URL, lmUrlsDerivable } from "./engine/llm-client.ts";
import { discoverStories, type StoryConfig } from "./engine/story-format.ts";
import { runPreflight, contextFit } from "./engine/preflight.ts";
import { canonWants, consult, type ConsultRequest } from "./engine/consult.ts";
import { configureArchitectDebug } from "./engine/architect.ts";
import { newCharacterAgent } from "./engine/scene-loop.ts";
import { setFitWarning } from "./engine/agent.ts";
import { setDebugWrite } from "./engine/json-extract.ts";
import { warn } from "./engine/warnings.ts";
import { appMain } from "./app.ts";
import { PREFLIGHT, SERVE, HEADLESS, PORT, ARCHITECT_DEBUG, ARCHITECT_DEBUG_LOG, STORY_DIR, flag, retiredFlagUsed } from "./cli-flags.ts";

// json-extract stays engine-free; its debug lines follow ENGINE.debug from here, at call time.
setDebugWrite(msg => { if (ENGINE.debug) process.stderr.write(msg); });

// The scene loop's context-fit check needs LM Studio's model info, which lives in preflight —
// a layer above agent.ts — so the same sink pattern as setDebugWrite wires it in from here.
setFitWarning(contextFit);

if (!lmUrlsDerivable(LMSTUDIO_URL))
  warn(`LM_STUDIO_URL (${LMSTUDIO_URL}) does not end in /chat/completions — the /models and `
    + `/api/v0/models endpoints derived from it will hit the wrong route, and model checks `
    + `will report "unreachable" no matter what is loaded`);

ENGINE.serve = SERVE || HEADLESS;
// Plain --serve goes quiet (the viewer is the monitor); headless serves AND echoes (its console is).
ENGINE.echoConsole = !SERVE || HEADLESS;
// --no-cast-echo trims just the characters' acts/reactions/answers from that echo; prose stays.
ENGINE.echoCast = flag("no-cast-echo") === undefined;
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

async function main() {
  const retired = retiredFlagUsed();
  if (retired) {
    console.error(`${retired} was removed — start the viewer with --serve and use the browser flow `
      + `(the shelf's new-story interview, or the handoff panel).`);
    process.exitCode = 1;
    return;
  }
  await appMain({
    serve: SERVE || HEADLESS,
    headless: HEADLESS,
    port: PORT,
    oneShot: !!STORY_DIR || !process.stdin.isTTY || flag("consult") !== undefined,
    storyDir: STORY_DIR,
    steps: flag("steps"),
    chapter: flag("chapter"),
    consult: flag("consult"),
    replace: flag("replace"),
    consultCli: runConsultCli,
  });
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
