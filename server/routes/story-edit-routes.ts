/**
 * STORY EDIT ROUTES — load, validate, and save story.json. Refuse with 409 while story.json is
 * held (run, loading window, or handoff). Contract: docs/GUI-SPEC.md ("Story editor").
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { json, readJsonBody, getQuery } from "../infra/http-util.ts";
import { storyOr400, refuseWrite } from "./route-helpers.ts";
import type { StoryEditHost } from "../route-hosts.ts";

/** Handles the request and returns true, or returns false if `path` is not one of its routes. */
export async function handleStoryEditRoutes(
  req: IncomingMessage, res: ServerResponse, path: string, host: StoryEditHost,
): Promise<boolean> {
  if (path === "/story/edit" && req.method === "GET") {
    const query = getQuery(req);
    const dir = await storyOr400(res, host, query.get("dir") || "");
    if (!dir) return true;
    if (refuseWrite(res, "edit")) return true;

    const r = await host.storyForEdit(dir);
    if (!r.ok) {
      json(res, 200, { ok: false, error: r.error, raw: r.raw ?? null });
    } else {
      json(res, 200, { ok: true, story: r.story, warnings: r.warnings });
    }
    return true;
  }

  if (path === "/story/edit-config" && req.method === "GET") {
    json(res, 200, host.editorConfig());
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
    const dir = await storyOr400(res, host, String(o.dir ?? ""));
    if (!dir) return true;
    if (refuseWrite(res, "save")) return true;

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
    const dir = await storyOr400(res, host, String(o.dir ?? ""));
    if (!dir) return true;
    if (refuseWrite(res, "discard")) return true;
    const n = Number(o.n);
    if (!Number.isInteger(n) || n < 1) { json(res, 400, { ok: false, reason: "which chapter?" }); return true; }

    const r = await host.discardScene(dir, n);
    if (!r.ok) json(res, r.status ?? 400, { ok: false, reason: r.reason });
    else json(res, 200, { ok: true, chapter: r.chapter, scenes: r.scenes });
    return true;
  }

  if (path === "/story/suggest" && req.method === "POST") {
    const o = await readJsonBody(req);
    if (refuseWrite(res, "suggest")) return true;
    const r = await host.suggestEdits(o.spec, String(o.text ?? ""));
    json(res, 200, r);
    return true;
  }

  return false;
}
