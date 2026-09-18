/**
 * HOST HANDOFF — the between-chapters interview: the open NextChapterSession, its busy/
 * abandon-generation bookkeeping, and the handoff*() operations HOST exposes. Private here;
 * routes only call these through HOST. Lifecycle contract: docs/GUI-SPEC.md ("The handoff").
 */

import { LIVE, storyWriteBlocked, sseWrite, setWhere } from "../live.ts";
import { openNextChapter, type NextChapterSession, type ScaffoldRound, type HandoffAccept, type AutoStage } from "../engine/architect.ts";
import { skillBibleEntries, generalSkillEntries } from "../engine/catalog.ts";
import { specView } from "../engine/story-spec.ts";
import type { HandoffRoutesHost, HandoffState, HandoffActionResult, HandoffAcceptResult } from "../server/route-hosts.ts";
import { loadHostDefaults } from "./defaults.ts";

async function newHandoffSession(dir: string, model = ""): Promise<NextChapterSession> {
  const entries = await skillBibleEntries();
  return openNextChapter(await loadHostDefaults(model), dir, entries, await generalSkillEntries());
}

// Mirrors host/scaffold.ts. LIVE.storyLock is tied 1:1 to HANDOFF's lifecycle, so it lives here.
let HANDOFF: NextChapterSession | null = null;
let handoffBusy = false;
let handoffGen = 0;
let handoffLast: ScaffoldRound | null = null;
let handoffStage: "" | "fillGaps" | "verify" = "";

const HANDOFF_ABANDONED = "the handoff was abandoned";
const HANDOFF_ABANDONED_WHILE_ACCEPTING =
  "the handoff was abandoned while accepting — story.json may have been rewritten";

function handoffSnapshot(): HandoffState {
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
    spec: specView(HANDOFF.spec),
  };
}

function publishHandoffState(): void {
  sseWrite({ t: "handoff", state: handoffSnapshot() });
}

/** The exit for a round abandoned mid-flight. Always releases the story-write lock, which
 *  `handoffAbandon()` leaves in place while a round (e.g. a mid-write accept) still needs it. */
function handoffAbandonedResult(reason: string): { ok: false; reason: string; status: 409 } {
  LIVE.storyLock = null;
  publishHandoffState();
  return { ok: false, reason, status: 409 };
}

/** Test-only seam for handoffStart's model/story-file dependencies (cf. scaffoldTestHooks). */
let handoffTestHooks: { session?: typeof newHandoffSession } | null = null;
export function setHandoffTestHooks(hooks: typeof handoffTestHooks): void {
  handoffTestHooks = hooks;
}

export const handoffState: HandoffRoutesHost["handoffState"] = () => handoffSnapshot();

/** The stage callback every handoff round hands its session. */
function onHandoffStage(stage: AutoStage): void {
  handoffStage = stage; publishHandoffState();
}

/** The ok-tail every handoff op answers with: publish, then hand back a full snapshot. */
function handoffOk(): HandoffActionResult {
  publishHandoffState();
  return { ok: true, state: handoffSnapshot() };
}

/** One model round behind the handoff lock. Start/accept keep bespoke flows; say/regenerate
 *  share this one — except say leaves the auto-pass stage marker alone (resetStage: false). */
async function runHandoffRound(
  resetStage: boolean,
  run: (session: NextChapterSession) => Promise<ScaffoldRound>,
): Promise<HandoffActionResult> {
  if (handoffBusy) return { ok: false, reason: "a round is already in flight", status: 409 };
  const blocked = storyWriteBlocked(LIVE.storyLock);
  if (blocked) return { ok: false, reason: blocked, status: 409 };
  if (!HANDOFF) return { ok: false, reason: "no handoff is open", status: 400 };
  const gen = handoffGen;
  const session = HANDOFF;
  handoffBusy = true; publishHandoffState();
  try {
    const r = await run(session);
    if (gen === handoffGen) handoffLast = r;
  } catch (e) {
    if (gen === handoffGen) handoffLast = { kind: "failed", error: (e as Error).message };
  } finally { handoffBusy = false; if (resetStage) handoffStage = ""; }
  if (gen !== handoffGen) return handoffAbandonedResult(HANDOFF_ABANDONED);
  return handoffOk();
}

export const handoffStart: HandoffRoutesHost["handoffStart"] = async (dir, model) => {
  if (handoffBusy) return { ok: false, reason: "a round is already in flight", status: 409 };
  const blocked = storyWriteBlocked();
  if (blocked) return { ok: false, reason: blocked, status: 409 };
  const gen = handoffGen;
  handoffBusy = true; handoffLast = null;
  LIVE.storyLock = `a chapter handoff is open for ${dir}`;
  // The lock is taken before the session build (which awaits) so no second handoff or editor
  // save can interleave before the session holds its snapshot.
  try {
    const session = await (handoffTestHooks?.session ?? newHandoffSession)(dir, model);
    // Abandoned while the session was being built: it must not resurrect itself.
    if (gen !== handoffGen) return handoffAbandonedResult(HANDOFF_ABANDONED);
    HANDOFF = session;
    setWhere(`preparing chapter ${HANDOFF.chapter} of ${dir}`, false);
    publishHandoffState();
    const last = await HANDOFF.propose(onHandoffStage);
    if (gen !== handoffGen) return handoffAbandonedResult(HANDOFF_ABANDONED);
    handoffLast = last;
  } catch (e) {
    HANDOFF = null;
    LIVE.storyLock = null;
    handoffBusy = false; handoffStage = "";
    publishHandoffState();
    return { ok: false, reason: (e as Error).message, status: 400 };
  } finally { handoffBusy = false; handoffStage = ""; }
  return handoffOk();
};

export const handoffSay: HandoffRoutesHost["handoffSay"] = async (text) => {
  // resetStage: false — say refines within the open round, so unlike regenerate it leaves the
  // auto-pass stage marker alone.
  return runHandoffRound(false, s => s.say(text));
};

export const handoffRegenerate: HandoffRoutesHost["handoffRegenerate"] = async () => {
  return runHandoffRound(true, s => s.propose(onHandoffStage));
};

export const handoffAccept: HandoffRoutesHost["handoffAccept"] = async () => {
  if (handoffBusy) return { ok: false, reason: "a round is already in flight", status: 409 };
  const blocked = storyWriteBlocked(LIVE.storyLock);
  if (blocked) return { ok: false, reason: blocked, status: 409 };
  if (!HANDOFF) return { ok: false, reason: "no handoff is open", status: 400 };
  const gen = handoffGen;
  const session = HANDOFF;
  handoffBusy = true; publishHandoffState();
  let r: HandoffAccept;
  try { r = await session.accept(); }
  catch (e) {
    handoffBusy = false;
    // A throwing accept that was also abandoned owns the lock abandon left behind.
    if (gen !== handoffGen) LIVE.storyLock = null;
    publishHandoffState();
    return { ok: false, reason: (e as Error).message, status: 500 };
  }
  handoffBusy = false;
  // Abandoned while the write was in flight. story.json may or may not have been rewritten, but
  // this call commits nothing further -- not even its success -- and releases the story lock
  // abandon held open for the duration of that write.
  if (gen !== handoffGen) return handoffAbandonedResult(HANDOFF_ABANDONED_WHILE_ACCEPTING);
  if (r.kind !== "written") {
    publishHandoffState();
    return r.kind === "nothing"
      ? { ok: false, kind: "nothing", status: 400 }
      : { ok: false, kind: "unloadable", dir: r.dir, error: r.error, status: 200 };
  }
  const chapter = session.chapter;
  HANDOFF = null; handoffLast = null; LIVE.storyLock = null;
  setWhere("idle", false);
  publishHandoffState();
  return { ok: true, kind: "written", chapter, dir: r.dir, files: r.files, warnings: r.warnings, status: 200 };
};

export const handoffAbandon: HandoffRoutesHost["handoffAbandon"] = () => {
  // Locks go the same way as the scaffold's: an in-flight round keeps them and releases them
  // itself via handoffAbandonedResult() — a mid-write accept still needs its guard.
  HANDOFF = null; handoffLast = null;
  if (!handoffBusy) LIVE.storyLock = null;
  handoffGen++;
  publishHandoffState();
};

/** Test-only reset for the handoff's private module state, mirroring resetScaffoldForTests(). */
export function resetHandoffForTests(): void {
  HANDOFF = null; handoffBusy = false; handoffGen++;
  handoffLast = null; handoffStage = ""; LIVE.storyLock = null;
}
