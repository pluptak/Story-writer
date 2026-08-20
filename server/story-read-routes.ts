/**
 * STORY READ ROUTES — read-only views of a loaded story's authored definition.
 * `/cast` (GET): the full cast, shaped for the live screen's character sheet, models omitted.
 * Unlike `/story/edit` this does NOT refuse while a run is in flight — the character sheet is a
 * panel on the live writer screen, so it is needed exactly when a run is running.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { json } from "./http-util.ts";
import type { ServerHost } from "./server.ts";

/** Handles the request and returns true, or returns false if `path` is not one of its routes. */
export async function handleStoryReadRoutes(
  req: IncomingMessage, res: ServerResponse, path: string, host: ServerHost,
): Promise<boolean> {
  if (path === "/cast" && req.method === "GET") {
    const query = new URLSearchParams((req.url || "").split("?")[1] || "");
    const dir = await host.selectableStory(query.get("dir") || "");
    if (!dir) { json(res, 400, { ok: false, reason: "no such story" }); return true; }

    const r = await host.fullCast(dir);
    if (!r.ok) {
      json(res, 200, { ok: false, error: r.error });
    } else {
      json(res, 200, { ok: true, characters: r.characters });
    }
    return true;
  }

  return false;
}
