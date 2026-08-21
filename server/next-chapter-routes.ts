/**
 * NEXT-CHAPTER ROUTES — the architect handoff, server side: `/next-chapter` and `/next-chapter/*`.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { LIVE, sseWrite, setWhere } from "../live.ts";
import { json, readJsonBody } from "./http-util.ts";
import type { ServerHost } from "./server.ts";
import type { NextChapterSession, ScaffoldRound, HandoffAccept } from "../engine/architect.ts";

let HANDOFF: NextChapterSession | null = null;
let handoffBusy = false;                   // one architect at a time
let handoffLast: ScaffoldRound | null = null;
let handoffStage: "" | "fillGaps" | "verify" = "";   // which automatic pass is running, if any

function handoffState(host: ServerHost) {
  if (!HANDOFF) return { active: false };
  return {
    active: true,
    dir: HANDOFF.dir,
    chapter: HANDOFF.chapter,
    busy: handoffBusy,
    stage: handoffStage,
    edited: HANDOFF.edited,
    pendingAsk: HANDOFF.pendingAsk,
    problems: HANDOFF.problems,
    last: handoffLast,
    model: HANDOFF.defaults.models.architect,
    spec: host.specView(HANDOFF.spec),
  };
}

function publishHandoff(host: ServerHost) {
  sseWrite({ t: "handoff", state: handoffState(host) });
}

/** Handles the request and returns true, or returns false if `path` is not one of its routes. */
export async function handleNextChapterRoutes(
  req: IncomingMessage, res: ServerResponse, path: string, host: ServerHost,
): Promise<boolean> {
  if (path === "/next-chapter" && req.method !== "POST") {
    json(res, 200, handoffState(host));
    return true;
  }
  if (!(path.startsWith("/next-chapter/") && req.method === "POST")) return false;

  const o = await readJsonBody(req);
  const what = path.slice("/next-chapter/".length);
  if (!["start", "say", "accept", "abandon"].includes(what)) {
    json(res, 404, { ok: false, reason: `no such handoff action: ${what}` });

  } else if (what === "abandon") {
    HANDOFF = null; handoffLast = null; handoffBusy = false;
    publishHandoff(host);
    json(res, 200, { ok: true });

  } else if (handoffBusy) { json(res, 409, { ok: false, reason: "a round is already in flight" });

  // The handoff rewrites story.json; a run in flight is reading the story it would rewrite.
  } else if (LIVE.running) { json(res, 409, { ok: false, reason: "a run is in flight" });

  } else if (what === "start") {
    const dir = await host.selectableStory(String(o.dir ?? ""));
    if (!dir) { json(res, 400, { ok: false, reason: `no such story: ${String(o.dir ?? "")}` }); return true; }
    const model = String(o.model ?? "").trim();
    if (model) {
      const ids = await host.loadedModelIds();
      if (ids !== null && !ids.includes(model)) {
        json(res, 400, { ok: false, reason: `"${model}" is not loaded in LM Studio` }); return true;
      }
    }
    handoffBusy = true; handoffLast = null;
    try {
      HANDOFF = await host.newHandoffSession(dir, model);
      setWhere(`preparing chapter ${HANDOFF.chapter} of ${dir}`, false);
      publishHandoff(host);
      handoffLast = await HANDOFF.propose(stage => { handoffStage = stage; publishHandoff(host); });
    } catch (e) {
      HANDOFF = null;
      handoffBusy = false; handoffStage = ""; publishHandoff(host);
      json(res, 400, { ok: false, reason: (e as Error).message }); return true;
    } finally { handoffBusy = false; handoffStage = ""; }
    publishHandoff(host);
    json(res, 200, handoffState(host));

  } else if (!HANDOFF) { json(res, 400, { ok: false, reason: "no handoff is open" });

  } else if (what === "say") {
    const text = String(o.text ?? "").trim();
    if (!text) { json(res, 400, { ok: false, reason: "say something" }); return true; }
    handoffBusy = true; publishHandoff(host);
    try { handoffLast = await HANDOFF.say(text); }
    catch (e) { handoffLast = { kind: "failed", error: (e as Error).message }; }
    finally { handoffBusy = false; }
    publishHandoff(host);
    json(res, 200, handoffState(host));

  } else if (what === "accept") {
    handoffBusy = true; publishHandoff(host);
    let r: HandoffAccept;
    try { r = await HANDOFF.accept(); }
    catch (e) {
      handoffBusy = false; publishHandoff(host);
      json(res, 500, { ok: false, reason: (e as Error).message }); return true;
    }
    handoffBusy = false;
    if (r.kind !== "written") {
      publishHandoff(host);
      json(res, r.kind === "nothing" ? 400 : 200, { ok: false, ...r });
      return true;
    }
    const chapter = HANDOFF.chapter;
    HANDOFF = null; handoffLast = null;
    setWhere("idle", false);
    publishHandoff(host);
    json(res, 200, { ok: true, chapter, ...r });
  }

  return true;
}
