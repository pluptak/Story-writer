/**
 * SCAFFOLD ROUTES — the new-story interview, server side: `/scaffold` and `/scaffold/*`.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { LIVE, sseWrite, setWhere } from "../live.ts";
import { json, readJsonBody } from "./http-util.ts";
import type { ServerHost, Concept } from "./server.ts";
import type { ScaffoldSession, ScaffoldRound, ScaffoldAccept } from "../engine/architect.ts";

let SCAFFOLD: ScaffoldSession | null = null;
let scaffoldBusy = false;                  // one architect at a time
// Bumped by abandon. Every async action captures the counter when it starts and re-checks it after
// each await; a stale value means the session was abandoned out from under this request, so
// nothing it brought back may be committed or published.
let scaffoldGen = 0;
let scaffoldLast: ScaffoldRound | null = null;
let scaffoldFolderAsk = "";                // why accept() would not derive a folder name
let scaffoldStage: "" | "fillGaps" | "verify" = "";   // which automatic pass is running, if any
let scaffoldUnknownTags: string[] = [];    // tags the catalog does not hold; allowed, but reported
let scaffoldMissingImports: string[] = [];   // ids the catalog no longer holds

const ABANDONED = "the interview was abandoned";
const ABANDONED_WHILE_ACCEPTING =
  "the interview was abandoned while accepting — the story folder may exist on disk";

const MAX_TAGS = 8;
const MAX_TAG_LEN = 40;
const MAX_CAST = 4;      // the cast stage's own ceiling: "Four is the maximum"
const MAX_IMPORTS = 4;   // the cast stage's ceiling, same as MAX_CAST

/** The concept goes verbatim into a prompt, so its size is bounded here rather than trusted. Returns
 *  the cleaned concept, or a reason it was refused. */
function readConcept(o: Record<string, unknown>): { ok: true; concept: Concept } | { ok: false; reason: string } {
  const rawTags = Array.isArray(o.tags) ? o.tags : [];
  const tags = rawTags.map(t => String(t ?? "").trim()).filter(Boolean);
  if (tags.length > MAX_TAGS) return { ok: false, reason: `at most ${MAX_TAGS} tags` };
  const tooLong = tags.find(t => t.length > MAX_TAG_LEN);
  if (tooLong) return { ok: false, reason: `tag "${tooLong.slice(0, 20)}…" is longer than ${MAX_TAG_LEN} characters` };
  const castSize = Number(o.castSize ?? 0);
  if (!Number.isInteger(castSize) || castSize < 0 || castSize > MAX_CAST)
    return { ok: false, reason: `castSize must be a whole number from 0 to ${MAX_CAST}` };
  return { ok: true, concept: { tags, castSize } };
}

/** The import tray as ids. Resolving them needs the host, so this only checks the shape. */
function readImportIds(o: Record<string, unknown>): { ok: true; ids: string[] } | { ok: false; reason: string } {
  const raw = Array.isArray(o.importIds) ? o.importIds : [];
  const ids = raw.map(x => String(x ?? "").trim()).filter(Boolean);
  if (ids.length > MAX_IMPORTS) return { ok: false, reason: `at most ${MAX_IMPORTS} imported characters` };
  return { ok: true, ids };
}

function scaffoldState(host: ServerHost) {
  if (!SCAFFOLD) return { active: false };
  const haveDraft = Boolean(
    SCAFFOLD.spec.title || SCAFFOLD.spec.premise || SCAFFOLD.spec.characters.length
    || SCAFFOLD.spec.writerStyle || SCAFFOLD.spec.facts.length
    || SCAFFOLD.spec.scenes.some(scene => scene.place || scene.question || scene.pov),
  );
  return {
    active: true,
    idea: SCAFFOLD.idea,
    mode: SCAFFOLD.mode,
    busy: scaffoldBusy,
    stage: scaffoldStage,
    gate: SCAFFOLD.stage,          // staged mode only: the checklist gate that is open
    tension: SCAFFOLD.tension,     // the load-bearing conflict the story stage coined; session state,
                                   // never a story.json field, so it reaches the GUI only through here
    concept: {
      tags: SCAFFOLD.tags,
      castSize: SCAFFOLD.castSize,
      unknownTags: scaffoldUnknownTags,
      imported: SCAFFOLD.imported.map(i => ({ libraryId: i.libraryId, version: i.version, name: i.name })),
      missingImports: scaffoldMissingImports,
      // Each half steers exactly one gate and is spent once that gate has produced its content.
      // Saying so is the point: a control that has stopped doing anything must not keep looking
      // live. Both are asked as "would the next build of that stage's prompt read this?" — which
      // is why cast size is measured against the cast, not against the open gate: it is at its most
      // live during the STORY gate, before the cast prompt has ever been built.
      tagsSteer: SCAFFOLD.mode !== "oneshot" && SCAFFOLD.stage === "story",
      // An imported tray IS the cast size, so the number stops being an answer to anything.
      castSizeSteers: SCAFFOLD.mode !== "oneshot" && !SCAFFOLD.imported.length && SCAFFOLD.spec.characters.length === 0,
      importsSteer: SCAFFOLD.mode !== "oneshot" && SCAFFOLD.spec.characters.length === 0,
    },
    haveDraft,
    haveStory: SCAFFOLD.haveStory(),
    pendingAsk: SCAFFOLD.pendingAsk,
    problems: SCAFFOLD.problems,
    // Derived from the spec each time rather than stored: a candidate stops being one the moment it
    // is promoted or the cast stops holding it, and a stored list would go stale in both directions.
    bibleCandidates: SCAFFOLD.bibleCandidates(),
    last: scaffoldLast,
    needsFolder: scaffoldFolderAsk,
    model: SCAFFOLD.defaults.models.architect,
    spec: haveDraft ? host.specView(SCAFFOLD.spec) : null,
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
  if (!["start", "say", "approve", "accept", "abandon", "set", "concept", "import", "promote"].includes(what)) {
    json(res, 404, { ok: false, reason: `no such scaffold action: ${what}` });

  } else if (what === "abandon") {
    // The session dies here, but `scaffoldBusy` is left alone: if a round is in flight it must
    // keep the lock until its own finally clears it, so a second start cannot overlap it. The
    // round itself finds a stale `scaffoldGen` on return and drops everything it produced.
    SCAFFOLD = null; scaffoldLast = null; scaffoldFolderAsk = ""; scaffoldUnknownTags = []; scaffoldMissingImports = [];
    scaffoldGen++;
    publishScaffold(host);
    json(res, 200, { ok: true });

  } else if (scaffoldBusy) { json(res, 409, { ok: false, reason: "a round is already in flight" });

  } else if (what === "start") {
    const gen = scaffoldGen;
    if (!LIVE.awaitingPick) { json(res, 400, { ok: false, reason: "the session is not waiting for a story" }); return true; }
    const idea = String(o.idea ?? "").trim();
    if (!idea) { json(res, 400, { ok: false, reason: "nothing to work with" }); return true; }
    const model = String(o.model ?? "").trim();
    if (model) {
      const ids = await host.loadedModelIds();
      if (ids !== null && !ids.includes(model)) {
        json(res, 400, { ok: false, reason: `"${model}" is not loaded in ${host.providerName}` }); return true;
      }
    }
    const c = readConcept(o);
    if (!c.ok) { json(res, 400, { ok: false, reason: c.reason }); return true; }
    const tray = readImportIds(o);
    if (!tray.ok) { json(res, 400, { ok: false, reason: tray.reason }); return true; }
    scaffoldBusy = true; scaffoldLast = null; scaffoldFolderAsk = "";
    try {
      const mode = o.mode === "oneshot" ? "oneshot" : "staged";
      const session = await host.newScaffoldSession(idea, model, mode, c.concept);
      // Abandoned while the session was being built: it must not resurrect itself.
      if (gen !== scaffoldGen) { json(res, 409, { ok: false, reason: ABANDONED }); return true; }
      SCAFFOLD = session;
      scaffoldUnknownTags = c.concept.tags.length ? await host.unknownTags(c.concept.tags) : [];
      if (gen !== scaffoldGen) { json(res, 409, { ok: false, reason: ABANDONED }); return true; }
      // Assigned whether or not there are ids: a start that imports nothing must clear what the
      // last session could not find, or the new interview reports a loss it never had.
      const resolved = tray.ids.length ? await host.importCharacters(tray.ids) : { imported: [], missing: [] };
      if (gen !== scaffoldGen) { json(res, 409, { ok: false, reason: ABANDONED }); return true; }
      SCAFFOLD.imported = resolved.imported;
      scaffoldMissingImports = resolved.missing;
      setWhere("building a new story", false);
      publishScaffold(host);
      const last = await SCAFFOLD.propose(stage => { scaffoldStage = stage; publishScaffold(host); });
      if (gen !== scaffoldGen) { json(res, 409, { ok: false, reason: ABANDONED }); return true; }
      scaffoldLast = last;
    } catch (e) {
      scaffoldLast = { kind: "failed", error: (e as Error).message };
    } finally { scaffoldBusy = false; scaffoldStage = ""; }
    publishScaffold(host);
    json(res, 200, scaffoldState(host));

  } else if (!SCAFFOLD) { json(res, 400, { ok: false, reason: "no interview is open" });

  } else if (what === "concept") {
    // Revising the concept never re-runs a gate: it changes what the NEXT build of a stage prompt
    // says. `tagsSteer` / `castSizeSteers` in the state is what tells the author whether that is
    // still any gate at all.
    const c = readConcept(o);
    if (!c.ok) { json(res, 400, { ok: false, reason: c.reason }); return true; }
    SCAFFOLD.tags = c.concept.tags;
    SCAFFOLD.castSize = c.concept.castSize;
    scaffoldUnknownTags = c.concept.tags.length ? await host.unknownTags(c.concept.tags) : [];
    publishScaffold(host);
    json(res, 200, scaffoldState(host));

  } else if (what === "import") {
    // Replaces the tray wholesale rather than adding to it: the author's pick is a set, and a
    // partial update would need a second answer for "what does absence mean".
    const tray = readImportIds(o);
    if (!tray.ok) { json(res, 400, { ok: false, reason: tray.reason }); return true; }
    const resolved = await host.importCharacters(tray.ids);
    SCAFFOLD.imported = resolved.imported;
    scaffoldMissingImports = resolved.missing;
    publishScaffold(host);
    json(res, 200, scaffoldState(host));

  } else if (what === "promote") {
    // The owner's approval, and a gate distinct from accepting the story: a skill lands in the
    // bible here or not at all, and accepting a story never writes one.
    const name = String(o.name ?? "").trim();
    const found = SCAFFOLD.bibleCandidates().find(c => c.name === name);
    if (!found) { json(res, 400, { ok: false, reason: `"${name}" is not a promotion candidate` }); return true; }
    const r = await host.promoteSkill(found.name, found.meaning);
    if (!r.ok) { json(res, 400, r); return true; }
    SCAFFOLD.bible = r.bible;
    publishScaffold(host);
    json(res, 200, scaffoldState(host));

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
    const gen = scaffoldGen;
    const session = SCAFFOLD;
    scaffoldBusy = true; scaffoldFolderAsk = ""; publishScaffold(host);
    try { const r = await session.say(text, stage => { scaffoldStage = stage; publishScaffold(host); });
          if (gen === scaffoldGen) scaffoldLast = r; }
    catch (e) { if (gen === scaffoldGen) scaffoldLast = { kind: "failed", error: (e as Error).message }; }
    finally { scaffoldBusy = false; scaffoldStage = ""; }
    if (gen !== scaffoldGen) { json(res, 409, { ok: false, reason: ABANDONED }); return true; }
    publishScaffold(host);
    json(res, 200, scaffoldState(host));

  } else if (what === "approve") {
    // Pass the open checklist gate and propose the next stage's content. The engine refuses on a
    // one-shot session and while the gate is empty or a question stands; those come back as rounds.
    // `override` is the author overruling a gate that came back `blocked` — sent by the viewer's
    // confirming second click, and the only way past the cast gate's asymmetry judgement.
    const gen = scaffoldGen;
    const session = SCAFFOLD;
    scaffoldBusy = true; scaffoldFolderAsk = ""; publishScaffold(host);
    try { const r = await session.approve(stage => { scaffoldStage = stage; publishScaffold(host); },
                                          Boolean(o.override));
          if (gen === scaffoldGen) scaffoldLast = r; }
    catch (e) { if (gen === scaffoldGen) scaffoldLast = { kind: "failed", error: (e as Error).message }; }
    finally { scaffoldBusy = false; scaffoldStage = ""; }
    if (gen !== scaffoldGen) { json(res, 409, { ok: false, reason: ABANDONED }); return true; }
    publishScaffold(host);
    json(res, 200, scaffoldState(host));

  } else if (what === "accept") {
    if (!LIVE.awaitingPick || !LIVE.pickResolve) { json(res, 400, { ok: false, reason: "the session is not waiting for a story" }); return true; }
    const gen = scaffoldGen;
    const session = SCAFFOLD;
    scaffoldBusy = true; publishScaffold(host);
    let r: ScaffoldAccept;
    try { r = await session.accept(String(o.folder ?? "").trim()); }
    catch (e) {
      scaffoldBusy = false; publishScaffold(host);
      json(res, 500, { ok: false, reason: (e as Error).message }); return true;
    }
    scaffoldBusy = false;
    if (gen !== scaffoldGen) {
      // Abandoned while the write was in flight. The story folder may exist on disk either way,
      // but nothing is resolved and no run starts.
      publishScaffold(host);
      json(res, 409, { ok: false, reason: ABANDONED_WHILE_ACCEPTING });
      return true;
    }
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
