/**
 * SESSION ROUTES — server.ts's own inline endpoints: `/run` (GET), `/select` (POST),
 * `/models` (GET). The pick handshake resolves through live.ts's consumePick; the directory and
 * model answers come from the host. Contract: docs/GUI-SPEC.md ("Session / run info").
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { LIVE, RUN, liveHistory, runState, isPickAwaited, consumePick } from "../../live.ts";
import { json, readJsonBody, requireMethod } from "../infra/http-util.ts";
import { storyOr400, refuseWrite } from "./route-helpers.ts";
import type { SessionRoutesHost } from "../route-hosts.ts";

/** Handles the request and returns true, or returns false if `path` is not one of its routes. */
export async function handleSessionRoutes(
  req: IncomingMessage, res: ServerResponse, path: string, host: SessionRoutesHost,
): Promise<boolean> {
  if (path === "/run") {
    if (requireMethod(res, req, "GET")) return true;
    json(res, 200, {
      run: LIVE.meta, awaitingContinue: LIVE.awaitingContinue, awaitingLint: LIVE.awaitingLint, events: liveHistory.length,
      running: LIVE.running, stopping: RUN.stopped && LIVE.running, where: LIVE.where,
      picking: LIVE.awaitingPick, loading: LIVE.loading, armed: LIVE.readerArmed,
      paused: LIVE.paused, pausing: LIVE.pausing && !LIVE.paused, model: LIVE.modelOverride,
      interactive: LIVE.interactive,
    });
    return true;
  }

  if (path === "/select" && req.method === "POST") {
    const o = await readJsonBody(req);
    if (!isPickAwaited()) { json(res, 400, { ok: false, reason: "the session is not waiting on a choice" }); return true; }
    if (refuseWrite(res, "pick")) return true;
    const dir = await storyOr400(res, host, String(o.dir ?? ""), `no such story: ${String(o.dir ?? "")}`);
    if (!dir) return true;
    const asked = Number(o.chapter ?? 1);
    const chapter = Number.isInteger(asked) && asked > 0 ? asked : 1;
    // Explicit authorization to write over an existing chapter or skip past an unwritten one —
    // the viewer's counterpart of the CLI's --replace. Absent, runOne's durability guard holds.
    const replace = o.replace === true;
    const r = consumePick();
    json(res, 200, { ok: true, dir });
    r!({ dir, chapter, replace });
    return true;
  }

  if (path === "/models" && req.method === "GET") {
    const ids = await host.availableModelIds();
    json(res, 200, {
      ids: ids ?? [], reachable: ids !== null,
      current: LIVE.modelOverride, architect: await host.architectModel(),
    });
    return true;
  }

  return false;
}
