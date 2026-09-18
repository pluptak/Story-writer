/**
 * RUN LOG ROUTES — `/runs/llm`, `/runs/llm/file`, `/runs/log`, `/log.jsonl`. Read-only by
 * construction. Contract: docs/GUI-SPEC.md ("Saved-run comparison").
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join as joinPath } from "node:path";

import { json, getQuery, requireMethod } from "../infra/http-util.ts";
import type { RunLogHost } from "../route-hosts.ts";

/** Handles the request and returns true, or returns false if `path` is not one of its routes. */
export async function handleRunLogRoutes(
  req: IncomingMessage, res: ServerResponse, path: string, host: RunLogHost,
): Promise<boolean> {
  const isLogRoute = path === "/log.jsonl" || path === "/runs/llm"
    || path === "/runs/llm/file" || path === "/runs/log";
  if (!isLogRoute) return false;
  if (requireMethod(res, req, "GET")) return true;

  if (path === "/log.jsonl") {
    const out = host.outDir();
    if (!out) { json(res, 404, { ok: false, reason: "no run yet" }); return true; }
    try {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end(await readFile(joinPath(out, "writing-log.jsonl"), "utf8"));
    } catch { json(res, 404, { ok: false, reason: "no writing log" }); }
    return true;
  }

  const query = getQuery(req);
  const storyDir = await host.selectableStory(query.get("dir") || "");
  if (!storyDir) { json(res, 400, { ok: false, reason: "no such story" }); return true; }

  const base = host.resolveStoryDir(storyDir);
  const id = query.get("id") || "";
  if (!(await host.runDirs(base)).includes(id)) {
    json(res, 404, { ok: false, reason: "no such run" }); return true;
  }

  if (path === "/runs/log") {
    try {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end(await readFile(joinPath(base, "out", id, "writing-log.jsonl"), "utf8"));
    } catch { json(res, 404, { ok: false, reason: "no writing log" }); }
    return true;
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
