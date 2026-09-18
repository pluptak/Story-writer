/**
 * ROUTE HELPERS — the wire validation every route module repeats: resolving an outside-process
 * story dir, refusing while story.json is held, checking a caller-named model, and reading a
 * catalog kind/id off the wire. Answering here keeps the status/reason shapes identical across
 * modules (tests/route-contract.test.ts pins them); a route that needs a different shape keeps
 * its own lines instead of bending these.
 */

import type { ServerResponse } from "node:http";

import { storyWriteBlocked } from "../../live.ts";
import { json } from "../infra/http-util.ts";
import type { ModelAvailability, StorySelection } from "../route-hosts.ts";

/** Resolve an outside-process dir to a discovered story, answering 400 when unknown. */
export async function storyOr400(
  res: ServerResponse, host: StorySelection, raw: string, reason = "no such story",
): Promise<string | null> {
  const dir = await host.selectableStory(raw);
  if (!dir) json(res, 400, { ok: false, reason });
  return dir;
}

/** Answer 409 while story.json is held (a run, the loading window, or a handoff).
 *  Returns true when it answered. */
export function refuseWrite(res: ServerResponse, action: string): boolean {
  const blocked = storyWriteBlocked();
  if (!blocked) return false;
  json(res, 409, { ok: false, reason: `cannot ${action} while ${blocked}` });
  return true;
}

/** Answer 400 when a caller-named model is unknown to the provider. Blank means "no override"
 *  and passes untouched. Returns true when the caller may proceed. */
export async function modelOr400(
  res: ServerResponse, host: ModelAvailability, model: string,
): Promise<boolean> {
  if (!model) return true;
  const ids = await host.availableModelIds();
  if (ids !== null && !ids.includes(model)) {
    json(res, 400, { ok: false, reason: `"${model}" is not available in ${host.providerName}` });
    return false;
  }
  return true;
}

/** A catalog kind off the wire. Defaults to "characters"; an unknown kind is the host's 400,
 *  not this one's, since kind arrives from the wire and is validated there. */
export function kindOf(o: { kind?: unknown }): string {
  return String(o.kind ?? "characters");
}

/** A wire-supplied entry id, answering 400 when absent. */
export function idOr400(res: ServerResponse, raw: unknown): string | null {
  const id = String(raw ?? "").trim();
  if (!id) { json(res, 400, { ok: false, reason: "no id" }); return null; }
  return id;
}
