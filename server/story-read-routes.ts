/**
 * STORY READ ROUTES — `/stories`, `/cast`, `/chapter`. Read-only; all served while a run is in
 * flight. Contract: docs/GUI-SPEC.md ("Session / run info", "Read-only cast view").
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join as joinPath } from "node:path";

import { LIVE } from "../live.ts";
import { json, getQuery, requireMethod } from "./http-util.ts";
import type { StoryReadHost } from "./route-hosts.ts";

/** Handles the request and returns true, or returns false if `path` is not one of its routes. */
export async function handleStoryReadRoutes(
  req: IncomingMessage, res: ServerResponse, path: string, host: StoryReadHost,
): Promise<boolean> {
  if (path === "/stories") {
    if (requireMethod(res, req, "GET")) return true;
    json(res, 200, { stories: await host.storyCards(), picking: LIVE.awaitingPick });
    return true;
  }

  if (path === "/cast" && req.method === "GET") {
    const query = getQuery(req);
    const dir = await host.selectableStory(query.get("dir") || "");
    if (!dir) { json(res, 400, { ok: false, reason: "no such story" }); return true; }

    const r = await host.fullCast(dir);
    if (!r.ok) {
      json(res, 200, { ok: false, error: r.error });
    } else {
      // Reach/presence/constraint stay per scene (I4); absence means "unaffected".
      json(res, 200, { ok: true, characters: r.characters, scenes: r.scenes ?? [] });
    }
    return true;
  }

  if (path === "/chapter") {
    if (requireMethod(res, req, "GET")) return true;
    const query = getQuery(req);
    const storyDir = await host.selectableStory(query.get("dir") || "");
    if (!storyDir) { json(res, 400, { ok: false, reason: "no such story" }); return true; }
    const n = Number(query.get("n"));
    if (!(await host.writtenChapters(storyDir)).includes(n)) {
      json(res, 404, { ok: false, reason: "no such chapter" }); return true;
    }
    try {
      res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
      res.end(await readFile(joinPath(host.resolveStoryDir(storyDir), "chapters", `${n}.md`), "utf8"));
    } catch { json(res, 404, { ok: false, reason: "no such chapter" }); }
    return true;
  }

  return false;
}
