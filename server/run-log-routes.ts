/**
 * RUN LOG ROUTES — reading a retained run's per-agent LLM transcripts. Read-only by construction:
 * nothing here can touch a running scene, which is what keeps inspection separate from run control.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { json } from "./http-util.ts";
import type { ServerHost } from "./server.ts";

/** Handles the request and returns true, or returns false if `path` is not one of its routes. */
export async function handleRunLogRoutes(
  req: IncomingMessage, res: ServerResponse, path: string, host: ServerHost,
): Promise<boolean> {
  if (path !== "/runs/llm" && path !== "/runs/llm/file") return false;

  const query = new URLSearchParams((req.url || "").split("?")[1] || "");
  const storyDir = await host.selectableStory(query.get("dir") || "");
  if (!storyDir) { json(res, 400, { ok: false, reason: "no such story" }); return true; }

  const base = host.resolveStoryDir(storyDir);
  const id = query.get("id") || "";
  if (!(await host.runDirs(base)).includes(id)) {
    json(res, 404, { ok: false, reason: "no such run" }); return true;
  }

  if (path === "/runs/llm") {
    json(res, 200, { ok: true, logs: await host.runLlmLogs(base, id) });
    return true;
  }

  // `file` is caller-supplied; `readLlmLog` refuses anything its own listing did not name.
  const text = await host.readLlmLog(base, id, query.get("file") || "");
  if (text === null) { json(res, 404, { ok: false, reason: "no such transcript" }); return true; }
  res.writeHead(200, { "Content-Type": "application/x-ndjson" });
  res.end(text);
  return true;
}
