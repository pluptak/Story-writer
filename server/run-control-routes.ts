/**
 * RUN CONTROL ROUTES — everything that steers a scene already in flight:
 * stop, pause/resume, the model override, interactive mode, and the reader's consult seat.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { C } from "../ansi.ts";
import { LIVE, stopRun, releaseForStop, sseWrite, runState } from "../live.ts";
import { json, readJsonBody, requireMethod } from "./http-util.ts";
import type { ServerHost } from "./server.ts";

/** Shared reason so viewer matching cannot split on a typo in one copy. */
const NO_RUN = "no run in progress";

/** Handles the request and returns true, or returns false if `path` is not one of its routes. */
export async function handleRunControl(
  req: IncomingMessage, res: ServerResponse, path: string, host: ServerHost,
): Promise<boolean> {
  if (path === "/stop") {
    if (requireMethod(res, req, "POST")) return true;
    if (!LIVE.running) { json(res, 400, { ok: false, reason: "no run in progress" }); return true; }
    const first = stopRun();
    releaseForStop();
    if (first) console.log(`\n${C.yellow}Stop requested from the viewer — ending the scene.${C.reset}`);
    sseWrite(runState());
    json(res, 200, { ok: true, already: !first });
    return true;

  } else if (path === "/consult-me") {
    if (requireMethod(res, req, "POST")) return true;
    if (!LIVE.running) { json(res, 400, { ok: false, reason: "no run in progress" }); return true; }
    if (!LIVE.interactive) { json(res, 400, { ok: false, reason: "interactive is off" }); return true; }
    if (LIVE.readerArmed || LIVE.readerResolve) { json(res, 200, { ok: true, already: true }); return true; }
    LIVE.readerArmed = true;
    sseWrite(runState());
    json(res, 200, { ok: true });
    return true;

  } else if (path === "/reader-answer") {
    if (requireMethod(res, req, "POST")) return true;
    const o = await readJsonBody(req);
    if (!LIVE.readerResolve) { json(res, 400, { ok: false, reason: "no reader prompt pending" }); return true; }
    const answer = String(o.answer ?? "").trim();
    if (!answer) { json(res, 400, { ok: false, reason: "empty answer" }); return true; }
    const r = LIVE.readerResolve; LIVE.readerResolve = null;
    json(res, 200, { ok: true });
    r(answer);
    return true;

  } else if (path === "/model") {
    if (requireMethod(res, req, "POST")) return true;
    const o = await readJsonBody(req);
    if (LIVE.running && !LIVE.paused) { json(res, 400, { ok: false, reason: "pause the run before changing its model" }); return true; }
    const model = String(o.model ?? "").trim();
    if (!model) { LIVE.modelOverride = null; json(res, 200, { ok: true }); return true; }
    const ids = await host.availableModelIds();
    if (ids !== null && !ids.includes(model)) {
      json(res, 400, { ok: false, reason: `"${model}" is not available in ${host.providerName}` }); return true;
    }
    LIVE.modelOverride = model;
    if (LIVE.paused && LIVE.writer && LIVE.agents) {
      LIVE.writer.model = model;
      for (const a of LIVE.agents.values()) a.model = model;
      LIVE.log?.({ t: "model_changed", model });
    }
    sseWrite(runState());
    json(res, 200, { ok: true });
    return true;

  } else if (path === "/interactive") {
    if (requireMethod(res, req, "POST")) return true;
    const o = await readJsonBody(req);
    LIVE.interactive = !!o.on;
    if (!LIVE.interactive && LIVE.readerArmed) LIVE.readerArmed = false;
    sseWrite(runState());
    json(res, 200, { ok: true });
    return true;

  } else if (path === "/pause") {
    if (requireMethod(res, req, "POST")) return true;
    if (!LIVE.running) { json(res, 400, { ok: false, reason: "no run in progress" }); return true; }
    if (LIVE.pausing || LIVE.paused) { json(res, 200, { ok: true, already: true }); return true; }
    LIVE.pausing = true;
    sseWrite(runState());
    json(res, 200, { ok: true });
    return true;

  } else if (path === "/resume") {
    if (requireMethod(res, req, "POST")) return true;
    if (!LIVE.pausing && !LIVE.paused) { json(res, 400, { ok: false, reason: "not paused" }); return true; }
    LIVE.pausing = false;
    if (LIVE.pauseResolve) { const r = LIVE.pauseResolve; LIVE.pauseResolve = null; LIVE.paused = false; r(); }
    sseWrite(runState());
    json(res, 200, { ok: true });
    return true;

  } else if (path === "/continue") {
    if (requireMethod(res, req, "POST")) return true;
    const o = await readJsonBody(req);
    const steps = Number(o.steps) || 0;
    if (LIVE.awaitingContinue && LIVE.continueResolve) {
      const r = LIVE.continueResolve; LIVE.continueResolve = null; LIVE.awaitingContinue = null;
      json(res, 200, { ok: true });
      r(Math.max(0, Math.floor(steps)));
    } else json(res, 400, { ok: false, reason: "no run is waiting on a budget decision" });
    return true;
  }

  return false;
}
