/**
 * SCAFFOLD ROUTES — the new-story interview, server side: `/scaffold` and `/scaffold/*`.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { LIVE, sseWrite, setWhere } from "../live.ts";
import { json, readJsonBody } from "./http-util.ts";
import type { ServerHost } from "./server.ts";
import type { ScaffoldSession, ScaffoldRound, ScaffoldAccept } from "../engine/architect.ts";

let SCAFFOLD: ScaffoldSession | null = null;
let scaffoldBusy = false;                  // one architect at a time
let scaffoldLast: ScaffoldRound | null = null;
let scaffoldFolderAsk = "";                // why accept() would not derive a folder name
let scaffoldStage: "" | "fillGaps" | "verify" = "";   // which automatic pass is running, if any

function scaffoldState(host: ServerHost) {
  if (!SCAFFOLD) return { active: false };
  return {
    active: true,
    idea: SCAFFOLD.idea,
    mode: SCAFFOLD.mode,
    busy: scaffoldBusy,
    stage: scaffoldStage,
    gate: SCAFFOLD.stage,          // staged mode only: the checklist gate that is open
    haveStory: SCAFFOLD.haveStory(),
    pendingAsk: SCAFFOLD.pendingAsk,
    problems: SCAFFOLD.problems,
    last: scaffoldLast,
    needsFolder: scaffoldFolderAsk,
    model: SCAFFOLD.defaults.models.architect,
    spec: SCAFFOLD.haveStory() ? host.specView(SCAFFOLD.spec) : null,
  };
}

function publishScaffold(host: ServerHost) {
  sseWrite({ t: "scaffold", state: scaffoldState(host) });
}

/** Handles the request and returns true, or returns false if `path` is not one of its routes. */
export async function handleScaffoldRoutes(
  req: IncomingMessage, res: ServerResponse, path: string, host: ServerHost,
): Promise<boolean> {
  if (path === "/scaffold" && req.method !== "POST") {
    json(res, 200, scaffoldState(host));
    return true;
  }
  if (!(path.startsWith("/scaffold/") && req.method === "POST")) return false;

  const o = await readJsonBody(req);
  const what = path.slice("/scaffold/".length);
  if (!["start", "say", "approve", "accept", "abandon", "set"].includes(what)) {
    json(res, 404, { ok: false, reason: `no such scaffold action: ${what}` });

  } else if (what === "abandon") {
    SCAFFOLD = null; scaffoldLast = null; scaffoldFolderAsk = ""; scaffoldBusy = false;
    publishScaffold(host);
    json(res, 200, { ok: true });

  } else if (scaffoldBusy) { json(res, 409, { ok: false, reason: "a round is already in flight" });

  } else if (what === "start") {
    if (!LIVE.awaitingPick) { json(res, 400, { ok: false, reason: "the session is not waiting for a story" }); return true; }
    const idea = String(o.idea ?? "").trim();
    if (!idea) { json(res, 400, { ok: false, reason: "nothing to work with" }); return true; }
    const model = String(o.model ?? "").trim();
    if (model) {
      const ids = await host.loadedModelIds();
      if (ids !== null && !ids.includes(model)) {
        json(res, 400, { ok: false, reason: `"${model}" is not loaded in LM Studio` }); return true;
      }
    }
    scaffoldBusy = true; scaffoldLast = null; scaffoldFolderAsk = "";
    try {
      const mode = o.mode === "oneshot" ? "oneshot" : "staged";
      SCAFFOLD = await host.newScaffoldSession(idea, model, mode);
      setWhere("building a new story", false);
      publishScaffold(host);
      scaffoldLast = await SCAFFOLD.propose(stage => { scaffoldStage = stage; publishScaffold(host); });
    } catch (e) {
      scaffoldLast = { kind: "failed", error: (e as Error).message };
    } finally { scaffoldBusy = false; scaffoldStage = ""; }
    publishScaffold(host);
    json(res, 200, scaffoldState(host));

  } else if (!SCAFFOLD) { json(res, 400, { ok: false, reason: "no interview is open" });

  } else if (what === "set") {
    if (!SCAFFOLD.haveStory()) { json(res, 400, { ok: false, reason: "there is no story to change yet" }); return true; }
    if (o.story && typeof o.story === "object") {
      const r = SCAFFOLD.setSpec(o.story);
      scaffoldLast = { kind: "edits", applied: r.applied, ignored: [], flags: [], note: "updated from the story editor" };
      publishScaffold(host);
      json(res, 200, scaffoldState(host));
      return true;
    }
    const r = host.directEdit(SCAFFOLD.spec, String(o.field ?? ""), o.value);
    if (!r.ok) { json(res, 400, { ok: false, reason: r.reason }); return true; }
    SCAFFOLD.spec = r.spec; SCAFFOLD.problems = r.problems;
    scaffoldLast = { kind: "edits", applied: r.applied, ignored: [], flags: [], note: "" };
    publishScaffold(host);
    json(res, 200, scaffoldState(host));

  } else if (what === "say") {
    const text = String(o.text ?? "").trim();
    if (!text) { json(res, 400, { ok: false, reason: "say something" }); return true; }
    scaffoldBusy = true; scaffoldFolderAsk = ""; publishScaffold(host);
    try { scaffoldLast = await SCAFFOLD.say(text, stage => { scaffoldStage = stage; publishScaffold(host); }); }
    catch (e) { scaffoldLast = { kind: "failed", error: (e as Error).message }; }
    finally { scaffoldBusy = false; scaffoldStage = ""; }
    publishScaffold(host);
    json(res, 200, scaffoldState(host));

  } else if (what === "approve") {
    // Pass the open checklist gate and propose the next stage's content. The engine refuses on a
    // one-shot session and while the gate is empty or a question stands; those come back as rounds.
    scaffoldBusy = true; scaffoldFolderAsk = ""; publishScaffold(host);
    try { scaffoldLast = await SCAFFOLD.approve(stage => { scaffoldStage = stage; publishScaffold(host); }); }
    catch (e) { scaffoldLast = { kind: "failed", error: (e as Error).message }; }
    finally { scaffoldBusy = false; scaffoldStage = ""; }
    publishScaffold(host);
    json(res, 200, scaffoldState(host));

  } else if (what === "accept") {
    if (!LIVE.awaitingPick || !LIVE.pickResolve) { json(res, 400, { ok: false, reason: "the session is not waiting for a story" }); return true; }
    scaffoldBusy = true; publishScaffold(host);
    let r: ScaffoldAccept;
    try { r = await SCAFFOLD.accept(String(o.folder ?? "").trim()); }
    catch (e) {
      scaffoldBusy = false; publishScaffold(host);
      json(res, 500, { ok: false, reason: (e as Error).message }); return true;
    }
    scaffoldBusy = false;
    if (r.kind !== "written") {
      scaffoldFolderAsk = r.kind === "needs_folder" ? r.reason : "";
      publishScaffold(host);
      json(res, r.kind === "no_story" ? 400 : 200, { ok: false, ...r });
      return true;
    }
    SCAFFOLD = null; scaffoldLast = null; scaffoldFolderAsk = "";
    publishScaffold(host);
    const resolve = LIVE.pickResolve; LIVE.pickResolve = null; LIVE.awaitingPick = false;
    json(res, 200, { ok: true, ...r });
    resolve({ dir: r.dir, chapter: 1 });   // a story that did not exist a moment ago starts at its first chapter
  }

  return true;
}
