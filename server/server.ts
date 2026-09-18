/**
 * LIVE SERVER — the viewer's HTTP surface. Node built-ins only, no framework, no build step.
 * Dispatches to the route modules; engine access arrives as narrow host interfaces
 * (route-hosts.ts). Contract: docs/GUI-SPEC.md.
 */

import { createServer, ServerResponse } from "node:http";

import { C } from "../ansi.ts";
import { LIVE, sseClients } from "../live.ts";
import { HttpError, json } from "./http-util.ts";
import { serveStatic } from "./static-files.ts";
import { handleSseRoute, startSsePing } from "./sse.ts";
import { handleSessionRoutes } from "./session-routes.ts";
import { handleRunControl } from "./run-control-routes.ts";
import { handleScaffoldRoutes } from "./scaffold-routes.ts";
import { handleNextChapterRoutes } from "./next-chapter-routes.ts";
import { handleRunLogRoutes } from "./run-log-routes.ts";
import { handleStoryEditRoutes } from "./story-edit-routes.ts";
import { handleStoryReadRoutes } from "./story-read-routes.ts";
import { handleCatalogRoutes } from "./catalog-routes.ts";
import type { RouteHosts } from "./route-hosts.ts";

/** Everything a route can ask of the engine lives in route-hosts.ts as narrow per-domain
 *  interfaces; the single runtime object satisfies their `RouteHosts` intersection. */

/** A started viewer's HTTP server. `close()` ends every SSE client, stops the keep-alive ping,
 *  and frees the port — after which a fresh `startServer` may bind again. */
export interface ServerHandle {
  /** Resolves with the port actually bound — the requested one, or the ephemeral port when 0 was
   *  asked for. Never resolves if the bind failed. */
  bound: Promise<number>;
  close(): Promise<void>;
}

let started: { handle: ServerHandle } | null = null;
/** Start the viewer's HTTP server once: static GUI files, SSE at /events, and dispatch to the route
 *  modules. Idempotent — every call returns the same handle until it is closed. */
export function startServer(port: number, host: RouteHosts, bindAddr: string = "127.0.0.1"): ServerHandle {
  if (started) return started.handle;
  LIVE.port = port;

  const server = createServer(async (req, res) => {
    try {
      const path = (req.url || "/").split("?")[0];
      if (await serveStatic(req, res, path)) {
        // handled

      } else if (handleSseRoute(req, res, path)) {
        // handled (the connection stays open on the bus)

      } else if (await handleSessionRoutes(req, res, path, host)) {
        // handled

      } else if (await handleRunControl(req, res, path, host)) {
        // handled

      } else if (await handleScaffoldRoutes(req, res, path, host)) {
        // handled

      } else if (await handleNextChapterRoutes(req, res, path, host)) {
        // handled

      } else if (await handleStoryEditRoutes(req, res, path, host)) {
        // handled

      } else if (await handleStoryReadRoutes(req, res, path, host)) {
        // handled

      } else if (await handleCatalogRoutes(req, res, path, host)) {
        // handled

      } else if (await handleRunLogRoutes(req, res, path, host)) {
        // handled

      } else { res.writeHead(404); res.end("not found"); }
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      const status = error instanceof HttpError ? error.status : 500;
      const reason = error instanceof HttpError ? error.message : "internal server error";
      if (!res.headersSent) {
        json(res, status, { ok: false, reason });
      } else {
        res.end();
      }
      console.error(`\n${C.red}Request error: ${error.message}${C.reset}`);
    }
  });

  const bound = new Promise<number>((resolve, reject) => {
    server.listen(port, bindAddr, () => {
      const a = server.address();
      const bound = typeof a === "object" && a !== null ? a.port : port;
      console.log(`\n${C.bold}▶ live viewer: http://localhost:${bound}/${C.reset}\n`);
      resolve(bound);
    });
    server.on("error", (e: NodeJS.ErrnoException) => {
      console.error(`\n${C.red}Could not start the viewer on port ${port}: ${e.message}${C.reset}`);
      console.error(`${C.dim}Another run may already be serving. Try --port=${port + 1}.${C.reset}`);
      // A no-op once the bind has landed (a resolved promise ignores reject); before it, the caller
      // must not be left waiting on a port that never opened.
      reject(e);
    });
  });
  const stopPing = startSsePing();

  const handle: ServerHandle = {
    bound,
    close: () => new Promise<void>(resolve => {
      stopPing();
      for (const c of sseClients) { try { (c as ServerResponse).end(); } catch { } }
      sseClients.clear();
      server.close(() => { started = null; resolve(); });
      server.closeIdleConnections();
    }),
  };
  started = { handle };
  return handle;
}
