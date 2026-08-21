/**
 * LIVE — the state one session shares between the scene loop and the HTTP server, plus the event bus
 * that fans a run out to attached viewers.
 */

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

// -- LIVE EVENT BUS --------------------------------------------------------
export interface RunMeta {
  story: string;
  chapter: number;
  chapters: number;
  characters: Array<{ name: string; skills: string[]; restrictions: string[] }>;
  target: number;
  question: string;
}

export type LiveFrame =
  | ({ seq: number } & RunEvent)
  | { t: "composing"; who: string; secs: number; chars: number }
  | { t: "idle" }
  | { t: "agent_stats"; who: string; model: string; durationMs: number;
      promptTokens: number | null; completionTokens: number | null }
  | { t: "continue_prompt"; steps: number; budget: number; suggested: number }
  | { t: "run_state"; running: boolean; stopping: boolean; where: string; picking: boolean; armed: boolean;
      paused: boolean; pausing: boolean; model: string | null; awaitingContinue: boolean;
      interactive: boolean }
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

/** History + SSE. The JSONL file is the caller's, so a run logs whether or not anyone is watching. */
/** Stamp a run event with a sequence number, keep it in history, and stream it to viewers. */
export function publish(ev: RunEvent): { seq: number } & RunEvent {
  const stamped = { seq: ++liveSeq, ...ev };
  liveHistory.push(stamped);
  sseWrite(stamped);
  return stamped;
}

// -- THE SESSION -----------------------------------------------------------
export const LIVE = {
  running: false,
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
  pickResolve: null as ((pick: { dir: string; chapter: number }) => void) | null,
};

/** A snapshot of the session's run state, for /run, SSE, and the viewer's header. */
export function runState(): LiveFrame {
  return {
    t: "run_state", running: LIVE.running, stopping: RUN.stopped && LIVE.running,
    where: LIVE.where, picking: LIVE.awaitingPick, armed: LIVE.readerArmed,
    paused: LIVE.paused, pausing: LIVE.pausing && !LIVE.paused, model: LIVE.modelOverride,
    awaitingContinue: !!LIVE.awaitingContinue,
    interactive: LIVE.interactive,
  };
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
  LIVE.awaitingContinue = null; LIVE.continueResolve = null;
  LIVE.readerArmed = false; LIVE.readerResolve = null;
  LIVE.pausing = false; LIVE.paused = false; LIVE.pauseResolve = null;
  LIVE.writer = null; LIVE.agents = null; LIVE.log = null;
  armRun();
  sseWrite({ t: "run_reset" });
}
