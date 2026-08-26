/**
 * STORY EDIT ROUTES — read, validate, and save a story's story.json from the GUI.
 * `/story/edit` (GET), `/story/check` (POST), `/story/save` (POST).
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { LIVE, storyWriteBlocked } from "../live.ts";
import { json, readJsonBody } from "./http-util.ts";
import type { ServerHost } from "./server.ts";

/** One refusal for every story-mutating action: a run is reading story.json, or a picked story is
 *  still loading (the window between /select and the run starting), or a handoff holds it. */
function writeBlocked(action: string): string {
  return `cannot ${action} while ${storyWriteBlocked()}`;
}

/** Handles the request and returns true, or returns false if `path` is not one of its routes. */
export async function handleStoryEditRoutes(
  req: IncomingMessage, res: ServerResponse, path: string, host: ServerHost,
): Promise<boolean> {
  if (path === "/story/edit" && req.method === "GET") {
    const query = new URLSearchParams((req.url || "").split("?")[1] || "");
    const dir = await host.selectableStory(query.get("dir") || "");
    if (!dir) { json(res, 400, { ok: false, reason: "no such story" }); return true; }
    if (storyWriteBlocked()) { json(res, 409, { ok: false, reason: writeBlocked("edit") }); return true; }

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
    if (storyWriteBlocked()) { json(res, 409, { ok: false, reason: writeBlocked("save") }); return true; }

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
    if (storyWriteBlocked()) { json(res, 409, { ok: false, reason: writeBlocked("discard") }); return true; }
    const n = Number(o.n);
    if (!Number.isInteger(n) || n < 1) { json(res, 400, { ok: false, reason: "which chapter?" }); return true; }

    const r = await host.discardScene(dir, n);
    if (!r.ok) json(res, r.status ?? 400, { ok: false, reason: r.reason });
    else json(res, 200, { ok: true, chapter: r.chapter, scenes: r.scenes });
    return true;
  }

  if (path === "/story/suggest" && req.method === "POST") {
    const o = await readJsonBody(req);
    if (storyWriteBlocked()) { json(res, 409, { ok: false, reason: writeBlocked("suggest") }); return true; }
    const r = await host.suggestEdits(o.spec, String(o.text ?? ""));
    json(res, 200, r);
    return true;
  }

  return false;
}
