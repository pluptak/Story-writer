/**
 * HOST DEFAULTS — the --model override and the defaults.json knobs every stateless or
 * session-opening author-side call runs under. One home so the scaffold, handoff, suggest and
 * catalog-assist paths apply and restore the same engine knobs.
 */

import { ENGINE } from "../engine/engine-state.ts";
import { NET } from "../engine/llm-client.ts";
import { loadDefaults, type Defaults } from "../engine/story-format.ts";

/** The --model override for this process, set once by the composition root (story-writer.ts)
 *  from the parsed CLI options. host/ never reads process.argv itself. */
let modelOverride: string | undefined;
export function setHostModelOverride(model?: string): void {
  modelOverride = model;
}
export function hostModel(): string {
  return modelOverride ?? "";
}

/** The defaults.json knobs every stateless or session-opening author-side call runs under — the
 *  architect's (scaffold, handoff, suggest) and the catalog assistant's alike — never any one
 *  story's. */
export async function loadHostDefaults(model = ""): Promise<Defaults> {
  const d = await loadDefaults(model || hostModel() || "");
  ENGINE.stream = d.stream; ENGINE.debug = d.debug;
  NET.timeoutMs = d.requestTimeout * 1000;
  NET.retries = d.attempts - 1;
  ENGINE.maxTokens = d.maxTokens;
  return d;
}

/** Apply the defaults' knobs for the length of `fn`, then restore the engine knobs it touched.
 *  Keeps a stateless call (a suggestion, a catalog-assist proposal) from leaving its token
 *  cap/timeouts behind — unlike a scaffold or handoff session, which owns the console until it
 *  hands off to a run that re-applies the story's own config. `architectModel` is pure for the same
 *  reason; so is this. */
export async function withHostDefaults<T>(model: string, fn: (d: Defaults) => Promise<T>): Promise<T> {
  const saved = { stream: ENGINE.stream, debug: ENGINE.debug, maxTokens: ENGINE.maxTokens,
                  timeoutMs: NET.timeoutMs, retries: NET.retries };
  try {
    return await fn(await loadHostDefaults(model));
  } finally {
    ENGINE.stream = saved.stream; ENGINE.debug = saved.debug; ENGINE.maxTokens = saved.maxTokens;
    NET.timeoutMs = saved.timeoutMs; NET.retries = saved.retries;
  }
}
