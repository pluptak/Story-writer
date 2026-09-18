/**
 * NEXT-CHAPTER ROUTES — `/next-chapter` and `/next-chapter/*`. Same shape as scaffold-routes.ts:
 * dispatch to `HandoffRoutesHost.handoff*()`, never the session. Contract: docs/GUI-SPEC.md ("The handoff").
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { json, readJsonBody, requireMethod } from "../infra/http-util.ts";
import { storyOr400, modelOr400 } from "./route-helpers.ts";
import type { HandoffRoutesHost } from "../route-hosts.ts";

/** Handles the request and returns true, or returns false if `path` is not one of its routes. */
export async function handleNextChapterRoutes(
  req: IncomingMessage, res: ServerResponse, path: string, host: HandoffRoutesHost,
): Promise<boolean> {
  if (path === "/next-chapter") {
    if (requireMethod(res, req, "GET")) return true;
    json(res, 200, host.handoffState());
    return true;
  }
  if (path.startsWith("/next-chapter/")) {
    if (requireMethod(res, req, "POST")) return true;
  } else return false;

  const o = await readJsonBody(req);
  const what = path.slice("/next-chapter/".length);

  if (what === "abandon") {
    host.handoffAbandon();
    json(res, 200, { ok: true });
    return true;
  }

  if (what === "start") {
    const dir = await storyOr400(res, host, String(o.dir ?? ""), `no such story: ${String(o.dir ?? "")}`);
    if (!dir) return true;
    const model = String(o.model ?? "").trim();
    if (!(await modelOr400(res, host, model))) return true;
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

  if (what === "regenerate") {
    const r = await host.handoffRegenerate();
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
