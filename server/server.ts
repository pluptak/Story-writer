/**
 * LIVE SERVER — the viewer's HTTP surface. Node built-ins only, no framework, no build step.
 */

import { createServer, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join as joinPath } from "node:path";

import { C } from "../ansi.ts";
import { LIVE, RUN, sseClients, liveHistory, runState } from "../live.ts";
import { json, readJsonBody } from "./http-util.ts";
import { handleRunControl } from "./run-control-routes.ts";
import { handleScaffoldRoutes } from "./scaffold-routes.ts";
import type { ScaffoldSession } from "../engine/architect.ts";
import type { StorySpec } from "../engine/story-spec.ts";
import type { StoryCard } from "../engine/preflight.ts";

export interface ServerHost {
  storyCards(): Promise<StoryCard[]>;
  /** Resolve a directory that came from OUTSIDE the process to one the engine discovered, or null. */
  selectableStory(dir: string): Promise<string | null>;
  resolveStoryDir(dir: string): string;
  runDirs(storyDir: string): Promise<string[]>;
  loadedModelIds(): Promise<string[] | null>;
  /** The model an interview would use if you chose nothing — resolved, not `defaults.md`'s text. */
  architectModel(): Promise<string>;
  newScaffoldSession(idea: string, model?: string): Promise<ScaffoldSession>;
  directEdit(spec: StorySpec, field: string, value: unknown):
    { ok: false; reason: string } | { ok: true; spec: StorySpec; applied: string[]; problems: string[] };
  specView(spec: StorySpec): unknown;
  /** The current run's output folder, or "" before a run has committed one. */
  outDir(): string;
}

async function serveFile(res: ServerResponse, url: URL, contentType: string) {
  try {
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-cache" });
    res.end(await readFile(url, "utf8"));
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}

let serverStarted = false;
export function startServer(port: number, host: ServerHost) {
  if (serverStarted) return; serverStarted = true;
  LIVE.port = port;
  const viewerPath = new URL("./gui/viewer.html", import.meta.url);
  const viewerCssPath = new URL("./gui/viewer.css", import.meta.url);
  const viewerJsPath = new URL("./gui/viewer.js", import.meta.url);

  const server = createServer(async (req, res) => {
    const path = (req.url || "/").split("?")[0];
    if (path === "/" || path === "/index.html") {
      await serveFile(res, viewerPath, "text/html; charset=utf-8");
    } else if (path === "/viewer.css") {
      await serveFile(res, viewerCssPath, "text/css; charset=utf-8");
    } else if (path === "/viewer.js") {
      await serveFile(res, viewerJsPath, "application/javascript; charset=utf-8");
    } else if (path === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
        Connection: "keep-alive", "X-Accel-Buffering": "no",
      });
      res.write("retry: 3000\n\n");
      for (const ev of liveHistory) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      res.write(`data: ${JSON.stringify(runState())}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));

    } else if (path === "/run") {
      json(res, 200, {
        run: LIVE.meta, awaitingContinue: LIVE.awaitingContinue, events: liveHistory.length,
        running: LIVE.running, stopping: RUN.stopped && LIVE.running, where: LIVE.where,
        picking: LIVE.awaitingPick, armed: LIVE.readerArmed, paused: LIVE.paused,
        pausing: LIVE.pausing && !LIVE.paused, model: LIVE.modelOverride,
        interactive: LIVE.interactive,
      });

    } else if (path === "/stories") {
      json(res, 200, { stories: await host.storyCards(), picking: LIVE.awaitingPick });

    } else if (path === "/select" && req.method === "POST") {
      const o = await readJsonBody(req);
      if (!LIVE.awaitingPick || !LIVE.pickResolve) { json(res, 400, { ok: false, reason: "the session is not waiting on a choice" }); return; }
      const dir = await host.selectableStory(String(o.dir ?? ""));
      if (!dir) { json(res, 400, { ok: false, reason: `no such story: ${String(o.dir ?? "")}` }); return; }
      const r = LIVE.pickResolve; LIVE.pickResolve = null; LIVE.awaitingPick = false;
      json(res, 200, { ok: true, dir });
      r(dir);

    } else if (path === "/models" && req.method === "GET") {
      const ids = await host.loadedModelIds();
      json(res, 200, {
        ids: ids ?? [], reachable: ids !== null,
        current: LIVE.modelOverride, architect: await host.architectModel(),
      });

    } else if (await handleRunControl(req, res, path, host)) {
      // handled

    } else if (await handleScaffoldRoutes(req, res, path, host)) {
      // handled

    } else if (path === "/log.jsonl") {
      try {
        const out = host.outDir();
        if (!out) throw new Error("no run yet");
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.end(await readFile(joinPath(out, "writing-log.jsonl"), "utf8"));
      } catch { res.writeHead(404); res.end(""); }

    } else if (path === "/runs/log") {
      const query = new URLSearchParams((req.url || "").split("?")[1] || "");
      const storyDir = await host.selectableStory(query.get("dir") || "");
      if (!storyDir) { res.writeHead(400); res.end("no such story"); return; }
      const base = host.resolveStoryDir(storyDir);
      const id = query.get("id") || "";
      if (!(await host.runDirs(base)).includes(id)) { res.writeHead(404); res.end("no such run"); return; }
      try {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.end(await readFile(joinPath(base, "out", id, "writing-log.jsonl"), "utf8"));
      } catch { res.writeHead(404); res.end(""); }

    } else { res.writeHead(404); res.end("not found"); }
  });

  server.on("error", (e: NodeJS.ErrnoException) => {
    console.error(`\n${C.red}Could not start the viewer on port ${port}: ${e.message}${C.reset}`);
    console.error(`${C.dim}Another run may already be serving. Try --port=${port + 1}.${C.reset}`);
  });
  server.listen(port, () => {
    console.log(`\n${C.bold}▶ live viewer: http://localhost:${port}/${C.reset}\n`);
  });
  setInterval(() => { for (const c of sseClients) { try { c.write(": ping\n\n"); } catch {} } }, 15000);
}
