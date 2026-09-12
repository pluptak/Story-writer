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
import { PROVIDER } from "./engine/provider.ts";
import { discoverStories, resolveCliStoryDir, type StoryConfig } from "./engine/story-format.ts";
import { runPreflight, contextFit } from "./engine/preflight.ts";
import { persistedCatalogs } from "./engine/catalog.ts";
import { canonWants, consult, type ConsultRequest } from "./engine/consult.ts";
import { runOpenConsult, type OpenParticipant } from "./engine/open-consult.ts";
import { lintPressure, openCharacterSystem, openConsultSystem } from "./prompts/open-consult.ts";
import { configureArchitectDebug } from "./engine/architect.ts";
import { newCharacterAgent } from "./engine/scene-loop.ts";
import { setFitWarning } from "./engine/agent.ts";
import { setDebugWrite } from "./engine/json-extract.ts";
import { warn } from "./engine/warnings.ts";
import { appMain } from "./app.ts";
import { PREFLIGHT, SERVE, HEADLESS, PORT, ARCHITECT_DEBUG, ARCHITECT_DEBUG_LOG, STORY_DIR, flag, retiredFlagUsed, parseError } from "./cli-flags.ts";

// json-extract stays engine-free; its debug lines follow ENGINE.debug from here, at call time.
setDebugWrite(msg => { if (ENGINE.debug) process.stderr.write(msg); });

// The scene loop's context-fit check needs LM Studio's model info, which lives in preflight —
// a layer above agent.ts — so the same sink pattern as setDebugWrite wires it in from here.
setFitWarning(contextFit);

// The old env variable named the full chat-completions URL; the provider layer wants the base.
// The alias still works — normalizeBaseUrl strips the suffix — but say so once, at startup only.
if (process.env.LM_STUDIO_URL && !process.env.LLM_BASE_URL)
  warn(`LM_STUDIO_URL is deprecated — use LLM_BASE_URL (a base URL such as ${PROVIDER.baseUrl})`);

ENGINE.serve = SERVE || HEADLESS;
// Plain --serve goes quiet (the viewer is the monitor); headless serves AND echoes (its console is).
ENGINE.echoConsole = !SERVE || HEADLESS;
// --no-cast-echo trims just the characters' acts/reactions/answers from that echo; prose stays.
ENGINE.echoCast = flag("no-cast-echo") === undefined;
// --free-consult / --free-consult-v2 / --free-consult-v3: run-level CLI toggle only (like
// --open-consult), never persisted to story.json. v3 wins if more than one is passed.
ENGINE.freeConsult = flag("free-consult-v3") !== undefined ? "v3"
  : flag("free-consult-v2") !== undefined ? "v2"
  : flag("free-consult") !== undefined ? "v1" : false;
// --split-judge: same run-level-toggle-only rule; the gated path is byte-identical without it.
ENGINE.splitJudge = flag("split-judge") !== undefined;
// --cannot-meaning / --cannot-none / --cannot-testimony: same rule again, one flag per arm so a
// measured delta can be attributed to one of them. Every prompt is byte-identical with all off.
ENGINE.cannotMeaning = flag("cannot-meaning") !== undefined;
ENGINE.cannotNone = flag("cannot-none") !== undefined;
ENGINE.cannotTestimony = flag("cannot-testimony") !== undefined;
configureArchitectDebug(ARCHITECT_DEBUG || !!ARCHITECT_DEBUG_LOG, ARCHITECT_DEBUG_LOG);

async function runPreflightCli() {
  const dirs = STORY_DIR ? [resolveCliStoryDir(STORY_DIR)] : await discoverStories();
  if (!dirs.length) { console.error("No stories found under data/stories/."); process.exitCode = 1; return; }
  let failed = 0;
  const catalogs = await persistedCatalogs();   // one read for the whole listing, not one per story
  for (const dir of dirs) {
    const r = await runPreflight(dir, catalogs);
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

  // --open-consult: freetext pressure-test chat (spike). The gated path below
  // is untouched; this branch forks the character, builds an author-side
  // consult agent from a pressure brief (problem + stakes, never an outcome),
  // and prints the full verbatim transcript plus the coercion tallies.
  if (flag("open-consult") !== undefined) {
    const pressure = await ask("Pressure (problem + stakes, not an outcome)", flag("pressure"));
    const pressureWhy = lintPressure(pressure, def.name);
    if (pressureWhy) {
      console.log(`\n${C.yellow}(pressure refused — ${pressureWhy})${C.reset}`);
      rl.close();
      return;
    }
    const skillNames = def.skills.map(s => s.name).filter(Boolean);
    const character: OpenParticipant = {
      name: def.name, model: def.model,
      system: openCharacterSystem({
        persona: def.persona, place: sc.scenes[0].place, skills: def.skills,
        knows: def.knows, goal: def.goal, belief: def.belief, impulse: def.impulse,
        voice: def.voice, situation,
      }),
      temperature: 0.9, think: sc.thinking.character,
    };
    const consultAgent: OpenParticipant = {
      name: "CONSULT", model: def.model,
      system: openConsultSystem({
        characterName: def.name, situation, pressure,
        premise: sc.premise, place: sc.scenes[0]?.place,
        skills: skillNames, limits: def.limits,
      }),
      temperature: 0.7, think: sc.thinking.writer,
    };
    // Production skill lint: the character's own CANNOT list, substring
    // match. What it cannot see (invented facts) is the consult agent's job
    // and the transcript review's — this only evidences the blatant breaks.
    const cannots = def.limits.map(l => l.toLowerCase()).filter(Boolean);
    console.log(`\n${C.bold}${def.name}${C.reset} ${C.dim}× CONSULT (open-chat spike, budget 10)${C.reset}`);
    const result = await runOpenConsult({
      character, consult: consultAgent, situation, pressure,
      lintCharacter: cannots.length
        ? (text) => {
            const t = text.toLowerCase();
            const hit = cannots.find(c => c && t.includes(c));
            return hit ? `reached through CANNOT: "${hit}"` : null;
          }
        : undefined,
    });
    rl.close();

    for (const turn of result.transcript) {
      const who = turn.from === "consult" ? `${C.magenta}CONSULT${C.reset}` : `${C.cyan}${def.name}${C.reset}`;
      console.log(`\n${C.dim}[round ${turn.round}]${C.reset} ${who}\n${turn.text}`);
    }
    console.log(`\n${C.dim}--- close: ${result.endedBy}${result.forced ? " (forced, budget spent)" : ""} `
      + `· rounds ${result.roundsUsed} · vetoes ${result.vetoes} · skill flags ${result.skillFlags.length} ---${C.reset}`);
    const s = result.stance;
    if (s.thought) console.log(`${C.gray}thought:${C.reset} ${s.thought}`);
    if (s.speech)  console.log(`${C.cyan}speech: ${C.reset} "${s.speech}"`);
    if (s.action)  console.log(`${C.green}action: ${C.reset} ${s.action}`);
    if (s.note)    console.log(`${C.dim}note:    ${s.note}${C.reset}`);
    for (const f of result.skillFlags) console.log(`${C.yellow}skill flag:${C.reset} ${f}`);
    const c = result.coercion;
    console.log(`${C.dim}coercion: suggestions ${c.suggestions} · stance-shifts ${c.stanceShifts} `
      + `· veto-over-divergence ${c.vetoOverDivergence} · missed-violations ${c.missedViolations}${C.reset}`);
    return;
  }

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
  // A flag the CLI does not define. Refusing beats the old silence: a mistyped --serv started no
  // viewer and said nothing about why.
  if (parseError) {
    console.error(parseError);
    process.exitCode = 1;
    return;
  }
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
      console.error(`Check that ${PROVIDER.displayName}'s server is running at ${PROVIDER.baseUrl} `
        + `and the model identifiers are correct.`);
      process.exitCode = 1;
    });
  }
}
