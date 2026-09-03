/**
 * APP — the application layer between the entry points and the engine: run setup (story load, the
 * knob application, the chapter-start guard), the story pick (browser-driven when a viewer is
 * watching, the console picker otherwise), and the pick → run → pick loop. The CLI entry points
 * (--preflight, --consult) stay in story-writer.ts; everything one chapter run does around the
 * scene loop lives in run-and-save.ts; the ServerHost the viewer talks to lives in host.ts.
 */

import { C } from "./ansi.ts";
import { LIVE, setWhere, sseWrite, runState, stopRun, releaseForStop } from "./live.ts";
import { startServer, type ServerHandle } from "./server/server.ts";
import { ENGINE } from "./engine/engine-state.ts";
import { NET } from "./engine/llm-client.ts";
import { loadStory, chooseStory, writtenChapters, type StoryConfig } from "./engine/story-format.ts";
import { startupRefusal } from "./engine/run-gate.ts";
import { warn } from "./engine/warnings.ts";
import { runAndSave } from "./run-and-save.ts";
import { skillBible } from "./engine/catalog.ts";
import { HOST } from "./host.ts";

/** What one process invocation passes down from the command line: the run's knobs and the console
 *  entry points. app.ts itself never reads process.argv — cli-flags.ts stays the one place that
 *  does, and story-writer.ts flattens what it read into this. */
export interface CliConfig {
  /** --serve: start the viewer's HTTP server alongside the run loop. */
  serve: boolean;
  /** --headless: serve only — no story argument, no console picker, no one-shot; the browser drives
   *  everything and SIGINT/SIGTERM shut the process down gracefully. Implies serve. */
  headless: boolean;
  /** --port=N, defaulted in cli-flags.ts. */
  port: number;
  /** One run and exit — a story directory argument, a non-TTY stdin, or --consult. */
  oneShot: boolean;
  /** The story directory argument, when one was given. */
  storyDir: string;
  /** --steps=N: override the story's maxSteps for this run. */
  steps?: string;
  /** --chapter=N: which scene to write, overriding the pick's default of 1. */
  chapter?: string;
  /** --consult=NAME: answer one consult in the console instead of writing a scene. */
  consult?: string;
  /** --replace: authorize writing over an existing chapter or skipping past an unwritten one. */
  replace?: string;
  /** The console consult runner. --consult is a console entry point, so the app loop calls back
   *  into story-writer.ts for it rather than growing a readline UI of its own. */
  consultCli: (sc: StoryConfig, who: string) => Promise<void>;
}

/** The durability guard behind starting a chapter run: why the run may not start, or null when it
 *  may. `replace` is the one explicit authorization covering both deviations — writing over an
 *  existing chapter, or skipping past one never written. Exported because its refusals are exactly
 *  what the CLI prints and the viewer relays, and they are testable without a run behind them. */
export async function chapterStartRefusal(dir: string, chapter: number, replace: boolean): Promise<string | null> {
  if (replace) return null;
  const written = await writtenChapters(dir);
  if (written.includes(chapter))
    return `chapter ${chapter} is already written in ${dir}/chapters — pass --replace to write over it`;
  if (chapter > 1 && !written.includes(chapter - 1))
    return `chapter ${chapter - 1} was never written — write the chapters in order, or pass --replace to skip ahead`;
  return null;
}

/** Load one story, apply the debug flags and the CLI knobs, and either write its scene or hand a
 *  consult to the console. `replace` authorizes writing over an existing chapter or skipping ahead
 *  past an unwritten one — the same explicit authorization the CLI's --replace flag gives. */
export async function startChapterRun(dir: string, chapter = 1, cli: CliConfig,
                                      opts: { replace?: boolean } = {}) {
  try {
    // The run resolves against the author's own bible, so a skill they promoted into it means in a
    // scene what it means in the editor.
    const sc = await loadStory(dir, LIVE.modelOverride ?? undefined, await skillBible());
    ENGINE.stream = sc.stream; ENGINE.debug = sc.debug;
    NET.timeoutMs = sc.requestTimeout * 1000;
    NET.retries = sc.attempts - 1;
    ENGINE.maxTokens = sc.maxTokens;

    if (cli.steps) {
      const n = Number(cli.steps);
      if (Number.isInteger(n) && n > 0) sc.maxSteps = n;
      else warn(`   (--steps=${cli.steps} is not a whole number — using ${sc.maxSteps})`);
    }

    const who = cli.consult;
    if (who !== undefined) {
      if (!who) throw new Error(`--consult needs a character name, e.g. --consult=${sc.characters[0].name}`);
      return cli.consultCli(sc, who);
    }

    const chapterFlag = cli.chapter;
    if (chapterFlag) chapter = Number(chapterFlag);
    if (!Number.isInteger(chapter) || chapter < 1 || chapter > sc.scenes.length) {
      console.error(`${C.red}chapter must be a whole number in 1..${sc.scenes.length}, not ${chapterFlag ?? chapter}${C.reset}`);
      process.exitCode = 1;
      return;
    }

    // The files under chapters/ are the engine's durable record — the one artifact with no protection
    // would be the one everything else treats as authoritative.
    const refusal = await chapterStartRefusal(sc.dir, chapter,
                                              opts.replace === true || cli.replace !== undefined);
    if (refusal) throw new Error(refusal);

    // Then the provider gate: refusing beats failing call-by-call three minutes in. A model the
    // provider has but has not loaded only warns (the transport waits out the JIT load); a model
    // it does not know at all stops the run here, naming what it could not find.
    const gate = await startupRefusal([sc.models.default, sc.models.writer, sc.models.summary,
                                       ...sc.characters.map(c => c.model)]);
    if (gate) throw new Error(gate);

    return runAndSave(sc, dir, chapter, { serving: cli.serve, serve: () => startServer(cli.port, HOST) });
  } finally {
    // The run loop's catch closes the loading window on a run that threw, and resetLive() closes it
    // on one that started. Neither covers a run that REFUSED before starting — an out-of-range
    // chapter returns without throwing — and a window left open blocks every story-mutating route
    // for the rest of the session, so close it here, on the way out, no matter which path got here.
    LIVE.loading = false;
  }
}

let BROWSER_DRIVES = false;

type Picked = { dir: string; chapter: number; replace?: boolean };

function awaitPick(): Promise<Picked> {
  LIVE.awaitingPick = true;
  setWhere("choosing a story", false);
  console.log(`\n${C.dim}Waiting for a story to be chosen at ${C.reset}http://localhost:${LIVE.port}/`
    + `${C.dim} — Ctrl-C to quit.${C.reset}`);
  return new Promise<Picked>(r => { LIVE.pickResolve = r; }).then(picked => {
    // From here until the run either starts (resetLive) or fails (the run loop's catch), story.json
    // is about to be read — every mutating route must stand down, not just while running is true.
    LIVE.loading = true;
    sseWrite(runState());
    setWhere("loading", false);
    return picked;
  });
}

/** Wait for the next story: the browser when it is driving, the console picker otherwise. */
async function pickStory(): Promise<Picked> {
  if (BROWSER_DRIVES) return awaitPick();
  setWhere("choosing a story", false);
  return { dir: await chooseStory(""), chapter: 1 };
}

/** The response to SIGINT/SIGTERM in headless mode, factored out of appMain so tests can drive it
 *  against fake state. First signal: tell the run loop to stop. With a run in flight, take the /stop
 *  path — release whatever the loop is parked on, abort the model calls — and let the loop unwind so
 *  runAndSave's finally can flush before the viewer closes; otherwise close and exit at once. A
 *  second signal exits immediately: graceful once, forced after that. */
export function createShutdownSignal(opts: {
  closeServer: () => Promise<void>;
  onShutdown: () => void;
  exit?: (code: number) => void;
}): () => void {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let first = true;
  return () => {
    if (!first) { exit(1); return; }
    first = false;
    opts.onShutdown();
    if (!LIVE.running) {
      console.log(`\n${C.dim}Shutting down.${C.reset}`);
      void opts.closeServer().then(() => exit(0));
      return;
    }
    console.log(`\n${C.yellow}Shutting down — stopping the run. Ctrl-C again to exit now.${C.reset}`);
    stopRun();
    releaseForStop();
  };
}

/** The pick → run → pick loop: the process's whole life once the entry points have been dispatched. */
export async function appMain(cli: CliConfig): Promise<void> {
  const handle: ServerHandle | null = cli.serve ? startServer(cli.port, HOST) : null;
  // server.ts has already said why a bind failed. Headless has nothing left to be — no browser can
  // reach a port that never opened — so exit instead of waiting on a pick. Every other mode keeps
  // its console path: a one-shot run still writes its chapter with the viewer gone.
  void handle?.bound.catch(() => { if (cli.headless) process.exit(1); });
  const closeServer = async () => { await handle?.close(); };
  const oneShot = cli.oneShot && !cli.headless;
  BROWSER_DRIVES = cli.serve && !oneShot;

  // Headless only. Outside it the console owns Ctrl-C (the pickers' readline), so nothing is installed.
  let shuttingDown = false;
  if (cli.headless) {
    const onSignal = createShutdownSignal({ closeServer, onShutdown: () => { shuttingDown = true; } });
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }

  let next: Picked =
    cli.storyDir ? { dir: cli.storyDir, chapter: 1 }
    : await pickStory();
  for (;;) {
    try {
      await startChapterRun(next.dir, next.chapter, cli, { replace: next.replace });
      if (oneShot) return;
    } catch (e) {
      const msg = (e as Error).message;
      sseWrite({ t: "run_error", message: msg });   // a --serve viewer is watching either way
      if (oneShot) throw e;                         // main().catch() says it, with the LM Studio hint
      console.error(`${C.red}${msg}${C.reset}`);
      setWhere("choosing a story", false);
      LIVE.awaitingPick = false;
    }
    if (shuttingDown) { await closeServer(); return; }
    next = await pickStory();
  }
}
