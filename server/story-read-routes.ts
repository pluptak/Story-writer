/**
 * STORY READ ROUTES — read-only views of loaded stories.
 *   /stories        (GET): the story-card listing for the shelf, plus whether a pick is awaited.
 *   /cast?dir=      (GET): one story's full cast, shaped for the live screen's character sheet,
 *                          models omitted. Unlike `/story/edit` this does NOT refuse while a run is
 *                          in flight — the character sheet is a panel on the live writer screen, so
 *                          it is needed exactly when a run is running.
 *   /chapter?dir=&n= (GET): an accepted chapter's markdown, or 404 if that chapter is not written.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join as joinPath } from "node:path";

import { LIVE } from "../live.ts";
import { json } from "./http-util.ts";
import type { ServerHost } from "./server.ts";

/** Handles the request and returns true, or returns false if `path` is not one of its routes. */
export async function handleStoryReadRoutes(
  req: IncomingMessage, res: ServerResponse, path: string, host: ServerHost,
): Promise<boolean> {
  if (path === "/stories") {
    json(res, 200, { stories: await host.storyCards(), picking: LIVE.awaitingPick });
    return true;
  }

  if (path === "/cast" && req.method === "GET") {
    const query = new URLSearchParams((req.url || "").split("?")[1] || "");
    const dir = await host.selectableStory(query.get("dir") || "");
    if (!dir) { json(res, 400, { ok: false, reason: "no such story" }); return true; }

    const r = await host.fullCast(dir);
    if (!r.ok) {
      json(res, 200, { ok: false, error: r.error });
    } else {
      // Reach rides separately from the characters (I4), already labelled per scene by the host.
      json(res, 200, { ok: true, characters: r.characters, scenes: r.scenes ?? [] });
    }
    return true;
  }

  if (path === "/chapter") {
    const query = new URLSearchParams((req.url || "").split("?")[1] || "");
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
