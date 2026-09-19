/**
 * SCAFFOLD ROUTES — `/scaffold` and `/scaffold/*`. Wire validation and dispatch to
 * `ScaffoldRoutesHost.scaffold*()`; the session and its bookkeeping are private to host/scaffold.ts.
 * Contract: docs/GUI-SPEC.md ("Scaffold").
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { LIVE, isPickAwaited, consumePick } from "../../live.ts";
import { json, readJsonBody, requireMethod } from "../infra/http-util.ts";
import { modelOr400, EMPTY_SAY } from "./route-helpers.ts";
import type { ScaffoldRoutesHost, Concept, RegenScope } from "../route-hosts.ts";

const MAX_TAGS = 8;
const MAX_TAG_LEN = 40;
const MAX_CAST_MEMBERS = 4; // the cast stage's own ceiling ("Four is the maximum") — cast size and imports alike
const MAX_ID_LEN = 200;  // a catalog id is a slug; this only stops an unbounded string

/** The concept goes verbatim into a prompt, so its size is bounded here. */
function readConcept(o: Record<string, unknown>): { ok: true; concept: Concept } | { ok: false; reason: string } {
  const rawTags = Array.isArray(o.tags) ? o.tags : [];
  const tags = rawTags.map(t => String(t ?? "").trim()).filter(Boolean);
  if (tags.length > MAX_TAGS) return { ok: false, reason: `at most ${MAX_TAGS} tags` };
  const tooLong = tags.find(t => t.length > MAX_TAG_LEN);
  if (tooLong) return { ok: false, reason: `tag "${tooLong.slice(0, 20)}…" is longer than ${MAX_TAG_LEN} characters` };
  const castSize = Number(o.castSize ?? 0);
  if (!Number.isInteger(castSize) || castSize < 0 || castSize > MAX_CAST_MEMBERS)
    return { ok: false, reason: `castSize must be a whole number from 0 to ${MAX_CAST_MEMBERS}` };
  const styleId = String(o.styleId ?? "").trim();
  if (styleId.length > MAX_ID_LEN) return { ok: false, reason: `styleId is longer than ${MAX_ID_LEN} characters` };
  return { ok: true, concept: { tags, castSize, styleId } };
}

/** The import tray as ids. Resolving them needs the host, so this only checks the shape. */
function readImportIds(o: Record<string, unknown>): { ok: true; ids: string[] } | { ok: false; reason: string } {
  const raw = Array.isArray(o.importIds) ? o.importIds : [];
  const ids = raw.map(x => String(x ?? "").trim()).filter(Boolean);
  if (ids.length > MAX_CAST_MEMBERS) return { ok: false, reason: `at most ${MAX_CAST_MEMBERS} imported characters` };
  return { ok: true, ids };
}

/** A scoped regenerate ("just this character"); resolving the name needs the host. */
function readRegenScope(o: Record<string, unknown>): { ok: true; scope?: RegenScope } | { ok: false; reason: string } {
  if (o.scope === undefined) return { ok: true };
  const s = o.scope;
  if (typeof s !== "object" || s === null) return { ok: false, reason: "scope must be an object" };
  const kind = (s as Record<string, unknown>).kind, name = (s as Record<string, unknown>).name;
  if (kind !== "character") return { ok: false, reason: `unknown regenerate scope "${String(kind)}"` };
  if (typeof name !== "string" || !name.trim()) return { ok: false, reason: "a scoped regenerate names a character" };
  if (name.trim().length > MAX_ID_LEN) return { ok: false, reason: `that name is longer than ${MAX_ID_LEN} characters` };
  return { ok: true, scope: { kind: "character", name: name.trim() } };
}

/** Handles the request and returns true, or returns false if `path` is not one of its routes. */
export async function handleScaffoldRoutes(
  req: IncomingMessage, res: ServerResponse, path: string, host: ScaffoldRoutesHost,
): Promise<boolean> {
  if (path === "/scaffold") {
    if (requireMethod(res, req, "GET")) return true;
    json(res, 200, host.scaffoldState());
    return true;
  }
  if (path.startsWith("/scaffold/")) {
    if (requireMethod(res, req, "POST")) return true;
  } else return false;

  const o = await readJsonBody(req);
  const what = path.slice("/scaffold/".length);

  if (what === "abandon") {
    host.scaffoldAbandon();
    json(res, 200, { ok: true });
    return true;
  }

  if (what === "start") {
    // The shelf-phase flag only: start needs no resolver, just a session waiting for a story.
    if (!LIVE.awaitingPick) { json(res, 400, { ok: false, reason: "the session is not waiting for a story" }); return true; }
    const idea = String(o.idea ?? "").trim();
    if (!idea) { json(res, 400, { ok: false, reason: "nothing to work with" }); return true; }
    const model = String(o.model ?? "").trim();
    if (!(await modelOr400(res, host, model))) return true;
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
    const r = host.scaffoldSet({ story: o.story, field: o.field, value: o.value, source: o.source });
    if (!r.ok) { json(res, r.status ?? 400, { ok: false, reason: r.reason }); return true; }
    json(res, 200, r.state);
    return true;
  }

  if (what === "say") {
    const text = String(o.text ?? "").trim();
    if (!text) { json(res, 400, { ok: false, reason: EMPTY_SAY }); return true; }
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

  if (what === "regenerate") {
    const scoped = readRegenScope(o);
    if (!scoped.ok) { json(res, 400, { ok: false, reason: scoped.reason }); return true; }
    const r = await host.scaffoldRegenerate(scoped.scope);
    if (!r.ok) { json(res, r.status ?? 400, { ok: false, reason: r.reason }); return true; }
    json(res, 200, r.state);
    return true;
  }

  if (what === "accept") {
    // Both the flag and the resolver: refusing before the host call means a story is never
    // written when there is no pick to resolve it with (cf. start, which needs the flag only).
    if (!isPickAwaited()) { json(res, 400, { ok: false, reason: "the session is not waiting for a story" }); return true; }
    const r = await host.scaffoldAccept(String(o.folder ?? "").trim());
    if (!r.ok) {
      const { status, ok: _ok, ...body } = r;
      json(res, status, { ok: false, ...body });
      return true;
    }
    const resolve = consumePick();
    // consumePick answers null only when no resolver was armed — start already refused that,
    // and nothing runs between the guard and here, so this is unreachable in practice.
    if (!resolve) { json(res, 400, { ok: false, reason: "the session is not waiting for a story" }); return true; }
    const { status: _status, ok: _ok2, ...body } = r;
    json(res, 200, { ok: true, ...body });
    resolve({ dir: r.dir, chapter: 1 });   // a story that did not exist a moment ago starts at its first chapter
    return true;
  }

  json(res, 404, { ok: false, reason: `no such scaffold action: ${what}` });
  return true;
}
