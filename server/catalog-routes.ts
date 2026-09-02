/**
 * CATALOG ROUTES — reusable character templates stored globally beside defaults.json,
 * not within any story. Routes: `/catalog` (GET), `/catalog/entry` (GET), `/catalog/check` (POST),
 * `/catalog/save` (POST), `/catalog/delete` (POST).
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { json, readJsonBody } from "./http-util.ts";
import type { ServerHost } from "./server.ts";

/** Handles the request and returns true, or returns false if `path` is not one of its routes. */
export async function handleCatalogRoutes(
  req: IncomingMessage, res: ServerResponse, path: string, host: ServerHost,
): Promise<boolean> {
  if (path === "/catalog" && req.method === "GET") {
    const query = new URLSearchParams((req.url || "").split("?")[1] || "");
    const kind = query.get("kind") || "characters";
    const r = await host.catalogEntries(kind);
    if (!r.ok) {
      json(res, 400, { ok: false, reason: r.reason });
    } else {
      json(res, 200, { ok: true, entries: r.entries });
    }
    return true;
  }

  if (path === "/catalog/entry" && req.method === "GET") {
    const query = new URLSearchParams((req.url || "").split("?")[1] || "");
    const kind = query.get("kind") || "characters";
    const id = query.get("id");
    if (!id) { json(res, 400, { ok: false, reason: "no id" }); return true; }

    const r = await host.catalogEntries(kind);
    if (!r.ok) {
      json(res, 400, { ok: false, reason: r.reason });
      return true;
    }

    const entry = r.entries.find((e) => (e as { id?: unknown }).id === id);
    if (!entry) {
      json(res, 404, { ok: false, reason: "no such entry" });
    } else {
      json(res, 200, { ok: true, entry });
    }
    return true;
  }

  if (path === "/catalog/check" && req.method === "POST") {
    const o = await readJsonBody(req);
    const kind = String(o.kind ?? "characters");
    const r = host.catalogCheck(kind, o.entry);
    if (!r.ok) {
      if ("reason" in r) {
        json(res, 400, { ok: false, reason: r.reason });
      } else {
        json(res, 200, { ok: false, issues: r.issues });
      }
    } else {
      json(res, 200, { ok: true, problems: r.problems });
    }
    return true;
  }

  if (path === "/catalog/save" && req.method === "POST") {
    const o = await readJsonBody(req);
    const kind = String(o.kind ?? "characters");
    const r = await host.catalogSave(kind, o.entry);
    if (!r.ok) {
      json(res, r.status ?? 400, { ok: false, reason: r.reason, issues: r.issues });
    } else {
      json(res, 200, { ok: true, entry: r.entry, problems: r.problems });
    }
    return true;
  }

  if (path === "/catalog/delete" && req.method === "POST") {
    const o = await readJsonBody(req);
    const kind = String(o.kind ?? "characters");
    const id = String(o.id ?? "").trim();
    if (!id) { json(res, 400, { ok: false, reason: "no id" }); return true; }

    const r = await host.catalogDelete(kind, id);
    if (!r.ok) {
      json(res, r.status ?? 400, { ok: false, reason: r.reason });
    } else {
      json(res, 200, { ok: true });
    }
    return true;
  }

  return false;
}
