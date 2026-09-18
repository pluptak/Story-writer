/**
 * RUN CONTROL ROUTES — stop, pause/resume, model override, interactive mode, reader seat, and the
 * lint/continue decisions. Contract: docs/GUI-SPEC.md ("Run control").
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { C } from "../../ansi.ts";
import { LIVE, stopRun, releaseForStop, sseWrite, runState } from "../../live.ts";
import { json, readJsonBody } from "../infra/http-util.ts";
import { modelOr400 } from "./route-helpers.ts";
import type { RunControlHost } from "../route-hosts.ts";

/** Shared reason so viewer matching cannot split on a typo in one copy. */
const NO_RUN = "no run in progress";

/** Handles the request and returns true, or returns false if `path` is not one of its routes. */
export async function handleRunControl(
  req: IncomingMessage, res: ServerResponse, path: string, host: RunControlHost,
): Promise<boolean> {
  if (path === "/stop" && req.method === "POST") {
    if (!LIVE.running) { json(res, 400, { ok: false, reason: NO_RUN }); return true; }
    const first = stopRun();
    releaseForStop();
    if (first) console.log(`\n${C.yellow}Stop requested from the viewer — ending the scene.${C.reset}`);
    sseWrite(runState());
    json(res, 200, { ok: true, already: !first });
    return true;

  } else if (path === "/consult-me" && req.method === "POST") {
    if (!LIVE.running) { json(res, 400, { ok: false, reason: NO_RUN }); return true; }
    if (!LIVE.interactive) { json(res, 400, { ok: false, reason: "interactive is off" }); return true; }
    if (LIVE.readerArmed || LIVE.readerResolve) { json(res, 200, { ok: true, already: true }); return true; }
    LIVE.readerArmed = true;
    sseWrite(runState());
    json(res, 200, { ok: true });
    return true;

  } else if (path === "/reader-answer" && req.method === "POST") {
    const o = await readJsonBody(req);
    if (!LIVE.readerResolve) { json(res, 400, { ok: false, reason: "no reader prompt pending" }); return true; }
    const answer = String(o.answer ?? "").trim();
    if (!answer) { json(res, 400, { ok: false, reason: "empty answer" }); return true; }
    const r = LIVE.readerResolve; LIVE.readerResolve = null;
    json(res, 200, { ok: true });
    r(answer);
    return true;

  } else if (path === "/model" && req.method === "POST") {
    const o = await readJsonBody(req);
    if (LIVE.running && !LIVE.paused) { json(res, 400, { ok: false, reason: "pause the run before changing its model" }); return true; }
    const model = String(o.model ?? "").trim();
    if (!model) { LIVE.modelOverride = null; json(res, 200, { ok: true }); return true; }
    if (!(await modelOr400(res, host, model))) return true;
    LIVE.modelOverride = model;
    if (LIVE.paused && LIVE.writer && LIVE.agents) {
      LIVE.writer.model = model;
      for (const a of LIVE.agents.values()) a.model = model;
      LIVE.log?.({ t: "model_changed", model });
    }
    sseWrite(runState());
    json(res, 200, { ok: true });
    return true;

  } else if (path === "/interactive" && req.method === "POST") {
    const o = await readJsonBody(req);
    LIVE.interactive = !!o.on;
    if (!LIVE.interactive && LIVE.readerArmed) LIVE.readerArmed = false;
    const lintResolve = !LIVE.interactive && LIVE.awaitingLint ? LIVE.lintResolve : null;
    if (lintResolve) { LIVE.awaitingLint = null; LIVE.lintResolve = null; }
    sseWrite(runState());
    lintResolve?.("stop");
    json(res, 200, { ok: true });
    return true;

  } else if (path === "/pause" && req.method === "POST") {
    if (!LIVE.running) { json(res, 400, { ok: false, reason: NO_RUN }); return true; }
    if (LIVE.pausing || LIVE.paused) { json(res, 200, { ok: true, already: true }); return true; }
    LIVE.pausing = true;
    sseWrite(runState());
    json(res, 200, { ok: true });
    return true;

  } else if (path === "/resume" && req.method === "POST") {
    if (!LIVE.pausing && !LIVE.paused) { json(res, 400, { ok: false, reason: "not paused" }); return true; }
    LIVE.pausing = false;
    if (LIVE.pauseResolve) { const r = LIVE.pauseResolve; LIVE.pauseResolve = null; LIVE.paused = false; r(); }
    sseWrite(runState());
    json(res, 200, { ok: true });
    return true;

  } else if (path === "/lint-decision" && req.method === "POST") {
    const o = await readJsonBody(req);
    const choice = o?.choice;
    if (choice !== "redraft" && choice !== "publish" && choice !== "stop") {
      json(res, 400, { ok: false, reason: "choice must be redraft, publish, or stop" }); return true;
    }
    if (!LIVE.awaitingLint || !LIVE.lintResolve) {
      json(res, 400, { ok: false, reason: "no lint decision pending" }); return true;
    }
    const r = LIVE.lintResolve; LIVE.lintResolve = null; LIVE.awaitingLint = null;
    sseWrite(runState());
    r(choice);
    json(res, 200, { ok: true });
    return true;

  } else if (path === "/continue" && req.method === "POST") {
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
