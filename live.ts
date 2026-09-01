/**
 * LIVE — the state one session shares between the scene loop and the HTTP server, plus the event bus
 * that fans a run out to attached viewers, and the run's human-interaction port.
 */

import { createInterface } from "node:readline/promises";
import { C } from "./ansi.ts";
import { progressDone } from "./engine/engine-state.ts";
import type { Agent } from "./engine/agent.ts";
import type { RunEvent } from "./engine/scene-loop.ts";

// -- STOPPING A RUN --------------------------------------------------------.
export class StoppedError extends Error {
  constructor() { super("stopped"); this.name = "StoppedError"; }
}
export const RUN = { stopped: false, abort: new AbortController() };

/** Returns false when a stop was already asked for, so a second click is not a second stop. */
export function stopRun(): boolean {
  if (RUN.stopped) return false;
  RUN.stopped = true;
  RUN.abort.abort();
  return true;
}

/** The abort controller is single-use, so a stopped session would otherwise refuse the next story. */
export function armRun() {
  RUN.stopped = false;
  RUN.abort = new AbortController();
}

/** Release whatever the loop is currently parked on — a pending /continue decision, an armed reader
 *  consult, a pause — so a stop never leaves the process hung waiting on an answer nobody will send.
 *  Shared by the /stop route and the headless shutdown's graceful path. */
export function releaseForStop() {
  if (LIVE.awaitingContinue && LIVE.continueResolve) {
    const r = LIVE.continueResolve; LIVE.continueResolve = null; LIVE.awaitingContinue = null; r(0);
  }
  if (LIVE.readerResolve) { const r = LIVE.readerResolve; LIVE.readerResolve = null; r(""); }
  LIVE.readerArmed = false;
  if (LIVE.pauseResolve) { const r = LIVE.pauseResolve; LIVE.pauseResolve = null; r(); }
  LIVE.pausing = false; LIVE.paused = false;
}

// -- LIVE EVENT BUS --------------------------------------------------------
export interface RunMeta {
  story: string;
  chapter: number;
  chapters: number;
  characters: Array<{ name: string; skills: string[]; restrictions: string[] }>;
  target: number;
  question: string;
}

export type RunStateFrame =
  { t: "run_state"; running: boolean; stopping: boolean; where: string; picking: boolean; loading: boolean;
    armed: boolean; paused: boolean; pausing: boolean; model: string | null; awaitingContinue: boolean;
    interactive: boolean };

export type LiveFrame =
  | ({ seq: number } & RunEvent)
  | { t: "composing"; who: string; secs: number; chars: number }
  | { t: "idle" }
  | { t: "agent_stats"; who: string; model: string; durationMs: number;
      promptTokens: number | null; completionTokens: number | null }
  | { t: "continue_prompt"; steps: number; budget: number; suggested: number }
  | RunStateFrame
  | { t: "run_reset" }
  | { t: "run_error"; message: string }
  | { t: "scaffold"; state: unknown }
  | { t: "handoff"; state: unknown };

export const sseClients = new Set<{ write: (s: string) => void }>();
export const liveHistory: Array<{ seq: number } & RunEvent> = [];
let liveSeq = 0;

/** Fan one frame out to every attached viewer; silently ignored when nobody is watching. */
export function sseWrite(frame: LiveFrame) {
  if (!sseClients.size) return;
  const line = `data: ${JSON.stringify(frame)}\n\n`;
  for (const c of sseClients) { try { c.write(line); } catch { } }
}

/** Stamp a run event with a sequence number, keep it in history, and stream it to viewers. The
 *  JSONL file is the caller's, so a run logs whether or not anyone is watching. */
export function publish(ev: RunEvent): { seq: number } & RunEvent {
  const stamped = { seq: ++liveSeq, ...ev };
  liveHistory.push(stamped);
  sseWrite(stamped);
  return stamped;
}

// -- THE SESSION -----------------------------------------------------------
export const LIVE = {
  running: false,
  loading: false,             // a story was picked and is being read; story.json must not change
  storyLock: null as string | null,   // an open handoff holds the story it will rewrite
  where: "idle",
  meta: null as RunMeta | null,
  port: 8080,                 // the port actually bound, which is what any message should name

  awaitingContinue: null as { steps: number; budget: number } | null,
  continueResolve: null as ((n: number) => void) | null,

  modelOverride: null as string | null,
  interactive: true,
  pausing: false,
  paused: false,
  pauseResolve: null as (() => void) | null,

  writer: null as Agent | null,
  agents: null as Map<string, Agent> | null,
  log: null as ((e: RunEvent) => void) | null,

  readerArmed: false,
  readerResolve: null as ((answer: string) => void) | null,
  awaitingPick: false,
  pickResolve: null as ((pick: { dir: string; chapter: number; replace?: boolean }) => void) | null,
};

/** A snapshot of the session's run state, for /run, SSE, and the viewer's header. */
export function runState(): RunStateFrame {
  return {
    t: "run_state", running: LIVE.running, stopping: RUN.stopped && LIVE.running,
    where: LIVE.where, picking: LIVE.awaitingPick, loading: LIVE.loading,
    armed: LIVE.readerArmed,
    paused: LIVE.paused, pausing: LIVE.pausing && !LIVE.paused, model: LIVE.modelOverride,
    awaitingContinue: !!LIVE.awaitingContinue,
    interactive: LIVE.interactive,
  };
}

/** Why story.json must not be mutated right now, or null when it may be. One shared answer for
 *  every route that would write a story: a run reading it, the window after a pick where the
 *  chosen story is still being read and its run has not started yet, or an open handoff holding a
 *  snapshot of the file it will write back on accept. Pass `ownLock` to see past your own lock —
 *  the handoff's accept must go through even though the handoff holds the story. */
export function storyWriteBlocked(ownLock: string | null = null): string | null {
  if (LIVE.running) return "a run is in flight";
  if (LIVE.loading) return "a story is loading";
  if (LIVE.storyLock && LIVE.storyLock !== ownLock) return LIVE.storyLock;
  return null;
}

/** Update where the session is and broadcast it; `running` says a run is in progress there. */
export function setWhere(where: string, running = LIVE.running) {
  LIVE.where = where; LIVE.running = running;
  sseWrite(runState());
}

/** Clear everything that belongs to one run, so a second story starts from a clean session. */
export function resetLive() {
  liveHistory.length = 0;
  liveSeq = 0;
  LIVE.loading = false;
  LIVE.awaitingContinue = null; LIVE.continueResolve = null;
  LIVE.readerArmed = false; LIVE.readerResolve = null;
  LIVE.pausing = false; LIVE.paused = false; LIVE.pauseResolve = null;
  LIVE.writer = null; LIVE.agents = null; LIVE.log = null;
  armRun();
  sseWrite({ t: "run_reset" });
}

// -- THE LOOP'S HUMAN-INTERACTION PORT -------------------------------------
/** How a running scene talks to the operator: the step budget, the pause handshake, and the
 *  reader's consult seat. `LIVE_IO` is the real implementation, wired to this session's LIVE
 *  state and SSE bus; a run that brings its own port (SceneRun's `io`) is driven without either. */
export interface SceneIo {
  /** The step budget is spent: ask how many more steps to take. 0 ends the scene. */
  moreSteps(steps: number, budget: number, chapter: number): Promise<number>;
  /** Park the scene while a pause is pending, until a resume arrives. True when it parked —
   *  the caller continues to the top of its loop, where the stop check lives. */
  pauseGate(): Promise<boolean>;
  /** Take a reader consult, when one is armed, interactive is on, and someone is watching.
   *  True when taken — the caller runs the writer's ask itself, then awaits `readerAnswer`. */
  readerTake(): boolean;
  /** Wait for the reader's answer to the consult just asked ("" when released without one). */
  readerAnswer(): Promise<string>;
}

export const LIVE_IO: SceneIo = {
  async moreSteps(steps, budget, chapter) {
    if (RUN.stopped) return 0;
    if (!LIVE.interactive) {
      console.log(`\n${C.yellow}Step budget (${budget}) spent on chapter ${chapter} and the scene is not finished. `
        + `Stopping — interactive is off.${C.reset}`);
      return 0;
    }
    if (sseClients.size) {
      LIVE.awaitingContinue = { steps, budget };
      progressDone();
      console.log(`\n${C.yellow}Budget spent on chapter ${chapter} — waiting on the viewer.${C.reset}`);
      sseWrite({ t: "continue_prompt", steps, budget, suggested: 8 });
      return new Promise<number>(resolve => { LIVE.continueResolve = resolve; });
    }
    if (!process.stdin.isTTY) {
      console.log(`\n${C.yellow}Step budget (${budget}) spent on chapter ${chapter} and the scene is not finished. `
        + `Stopping — nobody to ask.${C.reset}`);
      return 0;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = (await rl.question(`\n${C.yellow}${steps} steps used on chapter ${chapter} and the scene is not done. `
      + `How many more? [8, 0 to stop]: ${C.reset}`)).trim();
    rl.close();
    const n = ans === "" ? 8 : Number(ans);
    return Number.isInteger(n) && n > 0 ? n : 0;
  },

  async pauseGate() {
    if (!LIVE.pausing) return false;
    LIVE.paused = true;
    sseWrite(runState());
    await new Promise<void>(res => { LIVE.pauseResolve = res; });
    return true;
  },

  readerTake() {
    if (!(LIVE.readerArmed && LIVE.interactive && sseClients.size)) return false;
    LIVE.readerArmed = false;
    sseWrite(runState());
    return true;
  },

  readerAnswer() {
    return new Promise<string>(resolve => { LIVE.readerResolve = resolve; });
  },
};
