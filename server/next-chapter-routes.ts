/**
 * NEXT-CHAPTER ROUTES — the architect handoff, server side: `/next-chapter` and `/next-chapter/*`.
 *
 * A thin dispatcher, mirroring scaffold-routes.ts: validates the story and model before opening a
 * session, calls the matching ServerHost.handoff*() method, and forwards whatever it returns.
 * Never touches the architect's own session object or the story-write lock directly — both are
 * private to host.ts now, which also does all of this route's SSE publishing internally.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { json, readJsonBody } from "./http-util.ts";
import type { ServerHost } from "./server.ts";

/** Handles the request and returns true, or returns false if `path` is not one of its routes. */
export async function handleNextChapterRoutes(
  req: IncomingMessage, res: ServerResponse, path: string, host: ServerHost,
): Promise<boolean> {
  if (path === "/next-chapter" && req.method !== "POST") {
    json(res, 200, host.handoffState());
    return true;
  }
  if (!(path.startsWith("/next-chapter/") && req.method === "POST")) return false;

  const o = await readJsonBody(req);
  const what = path.slice("/next-chapter/".length);

  if (what === "abandon") {
    host.handoffAbandon();
    json(res, 200, { ok: true });
    return true;
  }

  if (what === "start") {
    const dir = await host.selectableStory(String(o.dir ?? ""));
    if (!dir) { json(res, 400, { ok: false, reason: `no such story: ${String(o.dir ?? "")}` }); return true; }
    const model = String(o.model ?? "").trim();
    if (model) {
      const ids = await host.availableModelIds();
      if (ids !== null && !ids.includes(model)) {
        json(res, 400, { ok: false, reason: `"${model}" is not available in ${host.providerName}` }); return true;
      }
    }
    const r = await host.handoffStart(dir, model);
    if (!r.ok) { json(res, r.status ?? 400, { ok: false, reason: r.reason }); return true; }
    json(res, 200, r.state);
    return true;
  }

  if (what === "say") {
    const text = String(o.text ?? "").trim();
    if (!text) { json(res, 400, { ok: false, reason: "say something" }); return true; }
    const r = await host.handoffSay(text);
    if (!r.ok) { json(res, r.status ?? 400, { ok: false, reason: r.reason }); return true; }
    json(res, 200, r.state);
    return true;
  }

  if (what === "accept") {
    const r = await host.handoffAccept();
    if (!r.ok) {
      const { status, ok: _ok, ...body } = r;
      json(res, status, { ok: false, ...body });
      return true;
    }
    const { status: _status, ok: _ok2, ...body } = r;
    json(res, 200, { ok: true, ...body });
    return true;
  }

  json(res, 404, { ok: false, reason: `no such handoff action: ${what}` });
  return true;
}
