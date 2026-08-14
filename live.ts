/**
 * LIVE — the state one session shares between the scene loop and the HTTP server, plus the event bus
 * that fans a run out to attached viewers.
 *
 * It exists because the two halves genuinely write the same variables: `/pause` sets `pausing` and
 * the loop reads it at its next boundary; `writeScene()` sets `writer`/`agents` and `/model` reaches
 * through them to swap a model mid-run. ESM cannot share a writable `let` across modules, so those
 * live as fields on the single `LIVE` object below and both sides assign to them.
 *
 * Imports nothing at run time — `Agent` and `RunEvent` are type-only — so `story-writer.ts` and
 * `server.ts` can both depend on it without a cycle.
 */

import type { Agent, RunEvent } from "./story-writer.ts";

// -- STOPPING A RUN --------------------------------------------------------
// Two halves, since a run spends nearly all its wall time inside ONE model call: the flag the loop
// checks at each boundary, and the AbortController that cuts the call in flight.
// A stop is NOT a failure — never retried, never salvaged, never reported as the model going wrong.
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
// Every RunEvent is stamped with `seq` and fanned out three ways: the JSONL file, an in-memory
// history for replay to late viewers, and any attached SSE clients. Inert with nothing attached.
// Frames that are UI state rather than record go to SSE only, so the log stays a record of what
// happened rather than of what a browser was showing.
export interface RunMeta {
  story: string;
  characters: Array<{ name: string; skills: string[]; lacks: string[] }>;
  target: number;
  question: string;
}

export type LiveFrame =
  | ({ seq: number } & RunEvent)
  | { t: "composing"; who: string; secs: number; chars: number }
  | { t: "idle" }
  | { t: "continue_prompt"; steps: number; budget: number; suggested: number }
  | { t: "run_state"; running: boolean; stopping: boolean; where: string; picking: boolean; armed: boolean;
      paused: boolean; pausing: boolean; model: string | null; awaitingContinue: boolean;
      interactive: boolean }
  | { t: "run_reset" }
  | { t: "scaffold"; state: unknown };

export const sseClients = new Set<{ write: (s: string) => void }>();
export const liveHistory: Array<{ seq: number } & RunEvent> = [];
let liveSeq = 0;

export function sseWrite(frame: LiveFrame) {
  if (!sseClients.size) return;
  const line = `data: ${JSON.stringify(frame)}\n\n`;
  for (const c of sseClients) { try { c.write(line); } catch { } }
}

/** History + SSE. The JSONL file is the caller's, so a run logs whether or not anyone is watching. */
export function publish(ev: RunEvent): { seq: number } & RunEvent {
  const stamped = { seq: ++liveSeq, ...ev };
  liveHistory.push(stamped);
  sseWrite(stamped);
  return stamped;
}

// -- THE SESSION -----------------------------------------------------------
export const LIVE = {
  // UI state, not record: what the SESSION is doing, which is a different question from what
  // happened in the story. A viewer that loads mid-session reads them from GET /run.
  running: false,
  where: "idle",
  meta: null as RunMeta | null,
  port: 8080,                 // the port actually bound, which is what any message should name

  // The out-of-budget prompt: a viewer connecting while one is pending learns of it from GET /run
  // rather than from the ephemeral frame it missed.
  awaitingContinue: null as { steps: number; budget: number } | null,
  continueResolve: null as ((n: number) => void) | null,

  // The model the viewer picked, for the NEXT `loadStory()` (idle) or the run in progress (paused).
  // Null means "whatever the story authors". Picking requires a viewer; there is no console
  // equivalent.
  modelOverride: null as string | null,

  // A session preference, not run state — like `modelOverride`, `resetLive()` must leave it alone.
  // Off means the run never waits on a human: the step budget stops rather than prompting, and the
  // reader-consult arm cannot fire. On is the default so an unattended `--serve` behaves as it always
  // has.
  interactive: true,

  // A pause never aborts a call in flight, unlike a stop — it only keeps the loop from STARTING the
  // next one, so the model can be swapped without losing the piece being generated. `pausing` from
  // the click, `paused` only once the loop is actually sitting at a boundary, which `/model` checks.
  pausing: false,
  paused: false,
  pauseResolve: null as (() => void) | null,

  // The running scene's agents, so `/model` can reach them while `paused`; `writeScene()` owns them.
  writer: null as Agent | null,
  agents: null as Map<string, Agent> | null,
  // `writeScene()`'s own `log`, so `/model` can record a swap in the run rather than only over SSE.
  log: null as ((e: RunEvent) => void) | null,

  // Fires once, on the next [WRITE] step, then clears itself. `reader_ask`/`reader_answer` are real
  // RunEvents rather than UI state: a reader consult is part of the story, so late viewers get it.
  readerArmed: false,
  readerResolve: null as ((answer: string) => void) | null,

  // Parked waiting for the browser to choose the next story. Exposed like the budget prompt and for
  // the same reason: a viewer that connects — or reloads — while one is outstanding must learn of it.
  awaitingPick: false,
  pickResolve: null as ((dir: string) => void) | null,
};

export function runState(): LiveFrame {
  return {
    t: "run_state", running: LIVE.running, stopping: RUN.stopped && LIVE.running,
    where: LIVE.where, picking: LIVE.awaitingPick, armed: LIVE.readerArmed,
    paused: LIVE.paused, pausing: LIVE.pausing && !LIVE.paused, model: LIVE.modelOverride,
    // `continue_prompt` is one-shot, so a viewer that did not answer it — the console did, or a stop
    // cleared it — otherwise keeps a live-looking prompt whose buttons only 400.
    awaitingContinue: !!LIVE.awaitingContinue,
    interactive: LIVE.interactive,
  };
}

/** Never logged — a run's log records the story, not which screen a browser was on. */
export function setWhere(where: string, running = LIVE.running) {
  LIVE.where = where; LIVE.running = running;
  sseWrite(runState());
}

/** Clear the live history and arm a fresh stop signal. Called at the top of every run, so a second
 *  story in the same process starts from an empty page instead of appending to the last one's — and
 *  an already-attached viewer is told to drop what it is holding, since replay only helps the
 *  clients that connect afterwards. */
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
