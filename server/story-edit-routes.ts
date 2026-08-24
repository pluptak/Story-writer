/**
 * STORY EDIT ROUTES — read, validate, and save a story's story.json from the GUI.
 * `/story/edit` (GET), `/story/check` (POST), `/story/save` (POST).
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { LIVE } from "../live.ts";
import { json, readJsonBody } from "./http-util.ts";
import type { ServerHost } from "./server.ts";

/** Handles the request and returns true, or returns false if `path` is not one of its routes. */
export async function handleStoryEditRoutes(
  req: IncomingMessage, res: ServerResponse, path: string, host: ServerHost,
): Promise<boolean> {
  if (path === "/story/edit" && req.method === "GET") {
    const query = new URLSearchParams((req.url || "").split("?")[1] || "");
    const dir = await host.selectableStory(query.get("dir") || "");
    if (!dir) { json(res, 400, { ok: false, reason: "no such story" }); return true; }
    if (LIVE.running) { json(res, 409, { ok: false, reason: "cannot edit while a run is in flight" }); return true; }

    const r = await host.storyForEdit(dir);
    if (!r.ok) {
      json(res, 200, { ok: false, error: r.error, raw: r.raw ?? null });
    } else {
      json(res, 200, { ok: true, story: r.story, warnings: r.warnings });
    }
    return true;
  }

  if (path === "/story/check" && req.method === "POST") {
    const o = await readJsonBody(req);
    const r = host.checkStory(o.story);
    if (!r.ok) {
      json(res, 200, { ok: false, error: r.error, issues: r.issues });
    } else {
      json(res, 200, { ok: true, warnings: r.warnings });
    }
    return true;
  }

  if (path === "/story/save" && req.method === "POST") {
    const o = await readJsonBody(req);
    const dir = await host.selectableStory(String(o.dir ?? ""));
    if (!dir) { json(res, 400, { ok: false, reason: "no such story" }); return true; }
    if (LIVE.running) { json(res, 409, { ok: false, reason: "cannot save while a run is in flight" }); return true; }

    const r = await host.saveStory(dir, o.story);
    if (!r.ok) {
      json(res, r.status ?? 400, { ok: false, reason: r.reason });
    } else {
      json(res, 200, { ok: true, warnings: r.warnings });
    }
    return true;
  }

  if (path === "/story/discard" && req.method === "POST") {
    const o = await readJsonBody(req);
    const dir = await host.selectableStory(String(o.dir ?? ""));
    if (!dir) { json(res, 400, { ok: false, reason: "no such story" }); return true; }
    if (LIVE.running) { json(res, 409, { ok: false, reason: "cannot discard while a run is in flight" }); return true; }
    const n = Number(o.n);
    if (!Number.isInteger(n) || n < 1) { json(res, 400, { ok: false, reason: "which chapter?" }); return true; }

    const r = await host.discardScene(dir, n);
    if (!r.ok) json(res, r.status ?? 400, { ok: false, reason: r.reason });
    else json(res, 200, { ok: true, chapter: r.chapter, scenes: r.scenes });
    return true;
  }

  if (path === "/story/suggest" && req.method === "POST") {
    const o = await readJsonBody(req);
    if (LIVE.running) { json(res, 409, { ok: false, reason: "cannot suggest while a run is in flight" }); return true; }
    const r = await host.suggestEdits(o.spec, String(o.text ?? ""));
    json(res, 200, r);
    return true;
  }

  return false;
}
