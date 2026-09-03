/** REQ-QUEUE — the process-wide coordinator for model requests. One request at a time by default:
 *  a local server with one GPU serializes anyway, and some servers drop the in-flight prompt when a
 *  second one arrives, so the engine holds the line itself rather than trusting the server to. Every
 *  model call the process makes — the scene loop, the architect, the reader's consult seat — waits
 *  here, FIFO, and a call that cannot get its turn within its budget gives up instead of queueing
 *  behind a request that may never finish. The slot covers ONE transport attempt: a retry releases
 *  the slot during its backoff and re-enters the queue at the back, fairly.
 *
 *  What this cannot do: reserve the server against other clients (LM Studio's own chat, another
 *  app). A stalled call while QUEUE looks idle is that case — say so, when asked. */
import { RUN, StoppedError } from "../live.ts";
import { warn } from "./warnings.ts";
import type { CallSite } from "./llm-client.ts";

/** Raised when a queued call's wait budget ran out. Deliberately NOT retryable: the holder of
 *  the slot was stuck for the whole budget, and re-queueing would just wait again. */
export class QueueGaveUpError extends Error {
  constructor(message: string) { super(message); this.name = "QueueGaveUpError"; }
}

/** One env integer, warning and falling back rather than refusing to start — these are tuning
 *  knobs, not identities. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    warn(`   (${name}="${raw}" is not a whole number ≥ 1 — using ${fallback})`);
    return fallback;
  }
  return n;
}

/** Mutable so tests can shorten the budget; nothing else should write these. */
export const QUEUE_LIMITS = {
  /** LLM_MAX_IN_FLIGHT — how many requests may be on the wire at once. 1 is the honest default
   *  for a local box; raising it is the operator's bet that their server parallelizes safely. */
  maxInFlight: envInt("LLM_MAX_IN_FLIGHT", 1),
  /** LLM_QUEUE_TIMEOUT_MS — how long a queued call waits for its turn before giving up. */
  waitMs: envInt("LLM_QUEUE_TIMEOUT_MS", 600_000),
};

/** What the transport is doing right now, for status lines and (later) the viewer. */
export const QUEUE = {
  inFlight: 0,
  /** Callers waiting for a slot — the queue's visible length. */
  depth: 0,
  /** Who holds the slot: agent and call site, or "" when idle. */
  current: "",
};

interface Waiter {
  settle: () => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  onStop: () => void;
}

const waiters: Waiter[] = [];
let inFlight = 0;

const label = (what: string, call?: CallSite) =>
  call?.agent ? `${call.agent} — ${call.site}` : call?.site ?? what;

function take(label_: string) {
  inFlight++;
  QUEUE.inFlight = inFlight;
  QUEUE.depth = waiters.length;
  QUEUE.current = label_;
}

/** Wait for a slot. Resolves when one is held; rejects with StoppedError when the run stops
 *  first, or QueueGaveUpError when the wait budget runs out. */
function acquire(what: string, call?: CallSite): Promise<void> {
  const who = label(what, call);
  if (inFlight < QUEUE_LIMITS.maxInFlight) { take(who); return Promise.resolve(); }
  return new Promise<void>((resolve, reject) => {
    const entry = {} as Waiter;
    const remove = () => {
      const i = waiters.indexOf(entry);
      if (i >= 0) waiters.splice(i, 1);
      clearTimeout(entry.timer);
      RUN.abort.signal.removeEventListener("abort", entry.onStop);
      QUEUE.depth = waiters.length;
    };
    entry.settle = () => { remove(); take(who); resolve(); };
    entry.reject = (e) => { remove(); reject(e); };
    entry.timer = setTimeout(() => {
      entry.reject(new QueueGaveUpError(
        `gave up after ${Math.round(QUEUE_LIMITS.waitMs / 1000)}s waiting for its turn — `
        + `"${QUEUE.current}" still holds the model request; the server may be stuck or shared `
        + `with another client`));
    }, QUEUE_LIMITS.waitMs);
    entry.onStop = () => entry.reject(new StoppedError());
    waiters.push(entry);
    QUEUE.depth = waiters.length;
    RUN.abort.signal.addEventListener("abort", entry.onStop, { once: true });
  });
}

function release() {
  inFlight--;
  QUEUE.inFlight = inFlight;
  QUEUE.current = "";
  const next = waiters[0];
  if (next && inFlight < QUEUE_LIMITS.maxInFlight) {
    waiters.shift();
    next.settle();
  }
}

/** Run `fn` while holding a slot. The transport's withRetry calls this once per attempt, so a
 *  retry's backoff happens OFF the slot and its next attempt queues again from the back. */
export async function onceAdmitted<T>(what: string, call: CallSite | undefined,
                                      fn: () => Promise<T>): Promise<T> {
  await acquire(what, call);
  try {
    return await fn();
  } finally {
    release();
  }
}
