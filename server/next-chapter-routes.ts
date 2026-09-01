/**
 * NEXT-CHAPTER ROUTES — the architect handoff, server side: `/next-chapter` and `/next-chapter/*`.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { LIVE, storyWriteBlocked, sseWrite, setWhere } from "../live.ts";
import { json, readJsonBody } from "./http-util.ts";
import type { ServerHost } from "./server.ts";
import type { NextChapterSession, ScaffoldRound, HandoffAccept } from "../engine/architect.ts";

let HANDOFF: NextChapterSession | null = null;
let handoffBusy = false;                   // one architect at a time
// Bumped by abandon. Every async action captures the counter when it starts and re-checks it after
// each await; a stale value means the session was abandoned out from under this request, so
// nothing it brought back may be committed or published.
let handoffGen = 0;
let handoffLast: ScaffoldRound | null = null;
let handoffStage: "" | "fillGaps" | "verify" = "";   // which automatic pass is running, if any

const ABANDONED = "the handoff was abandoned";
const ABANDONED_WHILE_ACCEPTING =
  "the handoff was abandoned while accepting — story.json may have been rewritten";

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

/** The one exit for a round that finds itself abandoned after an await. `abandon` deliberately
 *  leaves both locks alone while a round is in flight — `handoffBusy` so a second round cannot
 *  overlap it, and `LIVE.storyLock` so an `accept` already rewriting `story.json` keeps its guard
 *  until that write (and its restore-on-failure) is finished. Releasing the story lock is therefore
 *  the abandoned round's job, on its way out. */
function abandoned(res: ServerResponse, host: ServerHost, reason: string): true {
  LIVE.storyLock = null;
  publishHandoff(host);
  json(res, 409, { ok: false, reason });
  return true;
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
    // The session dies here, but `handoffBusy` is left alone: if a round is in flight it must keep
    // the lock until its own finally clears it. The round itself finds a stale `handoffGen` on
    // return and drops everything it produced. `LIVE.storyLock` goes the same way and for the same
    // reason — an `accept` mid-write still needs the guard that keeps an editor save from
    // interleaving with it — so an in-flight round releases it instead, via `abandoned()`.
    HANDOFF = null; handoffLast = null;
    if (!handoffBusy) LIVE.storyLock = null;
    handoffGen++;
    publishHandoff(host);
    json(res, 200, { ok: true });

  } else if (handoffBusy) { json(res, 409, { ok: false, reason: "a round is already in flight" });

  // The handoff rewrites story.json; refuse while anything else is reading or writing it — a run
  // in flight, a picked story still loading (the /select window), or another writer holding it.
  // The handoff's own lock does not count against the handoff, or accept could never go through.
  } else if (storyWriteBlocked(LIVE.storyLock)) {
    json(res, 409, { ok: false, reason: storyWriteBlocked(LIVE.storyLock) });

  } else if (what === "start") {
    const gen = handoffGen;
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
      const session = await host.newHandoffSession(dir, model);
      // Abandoned while the session was being built: it must not resurrect itself.
      if (gen !== handoffGen) return abandoned(res, host, ABANDONED);
      HANDOFF = session;
      // The session now holds a snapshot it will write back on accept: hold the story-write lock
      // until the handoff ends (accept, abandon, or failure), so an editor save cannot interleave.
      LIVE.storyLock = `a chapter handoff is open for ${dir}`;
      setWhere(`preparing chapter ${HANDOFF.chapter} of ${dir}`, false);
      publishHandoff(host);
      const last = await HANDOFF.propose(stage => { handoffStage = stage; publishHandoff(host); });
      if (gen !== handoffGen) return abandoned(res, host, ABANDONED);
      handoffLast = last;
    } catch (e) {
      HANDOFF = null;
      LIVE.storyLock = null;
      handoffBusy = false; handoffStage = ""; publishHandoff(host);
      json(res, 400, { ok: false, reason: (e as Error).message }); return true;
    } finally { handoffBusy = false; handoffStage = ""; }
    publishHandoff(host);
    json(res, 200, handoffState(host));

  } else if (!HANDOFF) { json(res, 400, { ok: false, reason: "no handoff is open" });

  } else if (what === "say") {
    const text = String(o.text ?? "").trim();
    if (!text) { json(res, 400, { ok: false, reason: "say something" }); return true; }
    const gen = handoffGen;
    const session = HANDOFF;
    handoffBusy = true; publishHandoff(host);
    try { const r = await session.say(text); if (gen === handoffGen) handoffLast = r; }
    catch (e) { if (gen === handoffGen) handoffLast = { kind: "failed", error: (e as Error).message }; }
    finally { handoffBusy = false; }
    if (gen !== handoffGen) return abandoned(res, host, ABANDONED);
    publishHandoff(host);
    json(res, 200, handoffState(host));

  } else if (what === "accept") {
    const gen = handoffGen;
    const session = HANDOFF;
    handoffBusy = true; publishHandoff(host);
    let r: HandoffAccept;
    try { r = await session.accept(); }
    catch (e) {
      handoffBusy = false;
      // A throwing accept that was also abandoned owns the lock abandon left behind.
      if (gen !== handoffGen) LIVE.storyLock = null;
      publishHandoff(host);
      json(res, 500, { ok: false, reason: (e as Error).message }); return true;
    }
    handoffBusy = false;
    // Abandoned while the write was in flight. story.json may or may not have been rewritten, but
    // this request commits nothing further — not even its success — and releases the story lock
    // abandon held open for the duration of that write.
    if (gen !== handoffGen) return abandoned(res, host, ABANDONED_WHILE_ACCEPTING);
    if (r.kind !== "written") {
      publishHandoff(host);
      json(res, r.kind === "nothing" ? 400 : 200, { ok: false, ...r });
      return true;
    }
    const chapter = session.chapter;
    HANDOFF = null; handoffLast = null; LIVE.storyLock = null;
    setWhere("idle", false);
    publishHandoff(host);
    json(res, 200, { ok: true, chapter, ...r });
  }

  return true;
}
