/**
 * CATALOG ROUTES — reusable character templates stored globally beside defaults.json,
 * not within any story. Routes: `/catalog` (GET), `/catalog/usage` (GET), `/catalog/entry` (GET),
 * `/catalog/check` (POST), `/catalog/save` (POST), `/catalog/delete` (POST),
 * `/catalog/visibility` (POST), `/catalog/assist` (POST).
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
    const r = await host.catalogEntries(kind, { includeHidden: query.get("includeHidden") === "1" });
    if (!r.ok) {
      json(res, 400, { ok: false, reason: r.reason });
    } else {
      json(res, 200, { ok: true, entries: r.entries });
    }
    return true;
  }

  if (path === "/catalog/config" && req.method === "GET") {
    json(res, 200, host.catalogConfig());
    return true;
  }

  if (path === "/catalog/usage" && req.method === "GET") {
    json(res, 200, { ok: true, usage: await host.catalogUsage() });
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
    const r = await host.catalogCheck(kind, o.entry);
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

  if (path === "/catalog/visibility" && req.method === "POST") {
    const o = await readJsonBody(req);
    const kind = String(o.kind ?? "characters");
    const id = String(o.id ?? "").trim();
    if (!id) { json(res, 400, { ok: false, reason: "no id" }); return true; }
    if (typeof o.hidden !== "boolean") { json(res, 400, { ok: false, reason: "hidden must be a boolean" }); return true; }

    const r = await host.catalogSetVisibility(kind, id, o.hidden);
    if (!r.ok) {
      json(res, r.status ?? 400, { ok: false, reason: r.reason });
    } else {
      json(res, 200, { ok: true, entry: r.entry });
    }
    return true;
  }

  if (path === "/catalog/assist" && req.method === "POST") {
    const o = await readJsonBody(req);

    // Every check here is about the request's own shape — mode/fields/instruction/character all
    // arrive from the wire and are specific to this one route, unlike `kind`'s cross-catalog check
    // elsewhere. `assistFields` comes from the host because routes never import engine/.
    const kind = String(o.kind ?? "characters");
    if (kind !== "characters") { json(res, 400, { ok: false, reason: `the assistant does not support "${kind}"` }); return true; }

    const mode = String(o.mode ?? "");
    if (mode !== "create" && mode !== "revise" && mode !== "review") {
      json(res, 400, { ok: false, reason: "mode must be one of create, revise, review" });
      return true;
    }

    const fields = Array.isArray(o.fields) ? o.fields.map((f: unknown) => String(f)) : [];
    if (!fields.length) { json(res, 400, { ok: false, reason: "no fields selected" }); return true; }
    const { assistFields } = host.catalogConfig();
    const unsupported = fields.find((f: string) => !assistFields.includes(f));
    if (unsupported) { json(res, 400, { ok: false, reason: `unsupported field "${unsupported}"` }); return true; }

    const instruction = String(o.instruction ?? "").trim();
    if (!instruction) { json(res, 400, { ok: false, reason: "no instruction" }); return true; }

    if (!o.character || typeof o.character !== "object") { json(res, 400, { ok: false, reason: "no character" }); return true; }

    const r = await host.catalogAssist(mode, fields, instruction, o.character);
    if (!r.ok) {
      // model_unavailable / provider_error / malformed_reply / invalid_draft are expected-failure
      // answers, not a client error — 200, same convention as the other catalog kinds' problems.
      json(res, 200, { ok: false, kind: r.kind, reason: r.reason, issues: r.issues });
    } else {
      json(res, 200, { ok: true, proposal: r.proposal });
    }
    return true;
  }

  return false;
}
