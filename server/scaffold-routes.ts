/**
 * SCAFFOLD ROUTES — the new-story interview, server side: `/scaffold` and `/scaffold/*`.
 *
 * A thin dispatcher: validates wire shape and bounds, calls the matching ServerHost.scaffold*()
 * method, and forwards whatever it returns. Never touches the architect's own session object —
 * that, and every piece of its bookkeeping (busy, the abandon generation counter, the session
 * itself), is private to host.ts, which also does all of this route's SSE publishing internally as
 * part of being the domain layer.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { LIVE } from "../live.ts";
import { json, readJsonBody } from "./http-util.ts";
import type { ServerHost, Concept } from "./server.ts";

const MAX_TAGS = 8;
const MAX_TAG_LEN = 40;
const MAX_CAST = 4;      // the cast stage's own ceiling: "Four is the maximum"
const MAX_IMPORTS = 4;   // the cast stage's ceiling, same as MAX_CAST
const MAX_ID_LEN = 200;  // a catalog id is a slug; this only stops an unbounded string

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
  const styleId = String(o.styleId ?? "").trim();
  if (styleId.length > MAX_ID_LEN) return { ok: false, reason: `styleId is longer than ${MAX_ID_LEN} characters` };
  return { ok: true, concept: { tags, castSize, styleId } };
}

/** The import tray as ids. Resolving them needs the host, so this only checks the shape. */
function readImportIds(o: Record<string, unknown>): { ok: true; ids: string[] } | { ok: false; reason: string } {
  const raw = Array.isArray(o.importIds) ? o.importIds : [];
  const ids = raw.map(x => String(x ?? "").trim()).filter(Boolean);
  if (ids.length > MAX_IMPORTS) return { ok: false, reason: `at most ${MAX_IMPORTS} imported characters` };
  return { ok: true, ids };
}

/** Handles the request and returns true, or returns false if `path` is not one of its routes. */
export async function handleScaffoldRoutes(
  req: IncomingMessage, res: ServerResponse, path: string, host: ServerHost,
): Promise<boolean> {
  if (path === "/scaffold" && req.method !== "POST") {
    json(res, 200, host.scaffoldState());
    return true;
  }
  if (!(path.startsWith("/scaffold/") && req.method === "POST")) return false;

  const o = await readJsonBody(req);
  const what = path.slice("/scaffold/".length);

  if (what === "abandon") {
    host.scaffoldAbandon();
    json(res, 200, { ok: true });
    return true;
  }

  if (what === "start") {
    if (!LIVE.awaitingPick) { json(res, 400, { ok: false, reason: "the session is not waiting for a story" }); return true; }
    const idea = String(o.idea ?? "").trim();
    if (!idea) { json(res, 400, { ok: false, reason: "nothing to work with" }); return true; }
    const model = String(o.model ?? "").trim();
    if (model) {
      const ids = await host.availableModelIds();
      if (ids !== null && !ids.includes(model)) {
        json(res, 400, { ok: false, reason: `"${model}" is not available in ${host.providerName}` }); return true;
      }
    }
    const c = readConcept(o);
    if (!c.ok) { json(res, 400, { ok: false, reason: c.reason }); return true; }
    const tray = readImportIds(o);
    if (!tray.ok) { json(res, 400, { ok: false, reason: tray.reason }); return true; }
    const mode = o.mode === "oneshot" ? "oneshot" : "staged";
    const r = await host.scaffoldStart({ idea, model, mode, concept: c.concept, importIds: tray.ids });
    if (!r.ok) { json(res, r.status ?? 400, { ok: false, reason: r.reason }); return true; }
    json(res, 200, r.state);
    return true;
  }

  if (what === "concept") {
    const c = readConcept(o);
    if (!c.ok) { json(res, 400, { ok: false, reason: c.reason }); return true; }
    const r = await host.scaffoldConcept(c.concept);
    if (!r.ok) { json(res, r.status ?? 400, { ok: false, reason: r.reason }); return true; }
    json(res, 200, r.state);
    return true;
  }

  if (what === "import") {
    const tray = readImportIds(o);
    if (!tray.ok) { json(res, 400, { ok: false, reason: tray.reason }); return true; }
    const r = await host.scaffoldImport(tray.ids);
    if (!r.ok) { json(res, r.status ?? 400, { ok: false, reason: r.reason }); return true; }
    json(res, 200, r.state);
    return true;
  }

  if (what === "promote") {
    const name = String(o.name ?? "").trim();
    const r = await host.scaffoldPromote(name);
    if (!r.ok) { json(res, r.status ?? 400, { ok: false, reason: r.reason, issues: r.issues }); return true; }
    json(res, 200, r.state);
    return true;
  }

  if (what === "set") {
    const r = host.scaffoldSet({ story: o.story, field: o.field, value: o.value });
    if (!r.ok) { json(res, r.status ?? 400, { ok: false, reason: r.reason }); return true; }
    json(res, 200, r.state);
    return true;
  }

  if (what === "say") {
    const text = String(o.text ?? "").trim();
    if (!text) { json(res, 400, { ok: false, reason: "say something" }); return true; }
    const r = await host.scaffoldSay(text);
    if (!r.ok) { json(res, r.status ?? 400, { ok: false, reason: r.reason }); return true; }
    json(res, 200, r.state);
    return true;
  }

  if (what === "approve") {
    // `override` is the author overruling a gate that came back `blocked` — sent by the viewer's
    // confirming second click, and the only way past the cast gate's asymmetry judgement.
    const r = await host.scaffoldApprove(Boolean(o.override));
    if (!r.ok) { json(res, r.status ?? 400, { ok: false, reason: r.reason }); return true; }
    json(res, 200, r.state);
    return true;
  }

  if (what === "accept") {
    if (!LIVE.awaitingPick || !LIVE.pickResolve) { json(res, 400, { ok: false, reason: "the session is not waiting for a story" }); return true; }
    const r = await host.scaffoldAccept(String(o.folder ?? "").trim());
    if (!r.ok) {
      const { status, ok: _ok, ...body } = r;
      json(res, status, { ok: false, ...body });
      return true;
    }
    const resolve = LIVE.pickResolve; LIVE.pickResolve = null; LIVE.awaitingPick = false;
    const { status: _status, ok: _ok2, ...body } = r;
    json(res, 200, { ok: true, ...body });
    resolve({ dir: r.dir, chapter: 1 });   // a story that did not exist a moment ago starts at its first chapter
    return true;
  }

  json(res, 404, { ok: false, reason: `no such scaffold action: ${what}` });
  return true;
}
