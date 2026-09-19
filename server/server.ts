/**
 * LIVE SERVER — the viewer's HTTP surface. Node built-ins only, no framework, no build step.
 * Dispatches to the route modules; engine access arrives as narrow host interfaces
 * (route-hosts.ts). Contract: docs/GUI-SPEC.md.
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";

import { C } from "../ansi.ts";
import { LIVE, sseClients } from "../live.ts";
import { HttpError, json } from "./infra/http-util.ts";
import { serveStatic } from "./infra/static-files.ts";
import { handleSseRoute, startSsePing } from "./infra/sse.ts";
import { handleSessionRoutes } from "./routes/session-routes.ts";
import { handleRunControl } from "./routes/run-control-routes.ts";
import { handleScaffoldRoutes } from "./routes/scaffold-routes.ts";
import { handleNextChapterRoutes } from "./routes/next-chapter-routes.ts";
import { handleRunLogRoutes } from "./routes/run-log-routes.ts";
import { handleStoryEditRoutes } from "./routes/story-edit-routes.ts";
import { handleStoryReadRoutes } from "./routes/story-read-routes.ts";
import { handleCatalogRoutes } from "./routes/catalog-routes.ts";
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

/** One dispatch entry: true when the handler answered. Order is precedence — static files
 *  first, the event stream before any route that publishes on it. */
type RouteHandler = (
  req: IncomingMessage, res: ServerResponse, path: string, host: RouteHosts,
) => boolean | Promise<boolean>;

/** Every handler the server can answer with, in precedence order. Adding a route means adding
 *  a line here, not another branch. */
const ROUTES: ReadonlyArray<RouteHandler> = [
  (req, res, path) => serveStatic(req, res, path),
  (req, res, path) => handleSseRoute(req, res, path),
  (req, res, path, host) => handleSessionRoutes(req, res, path, host),
  (req, res, path, host) => handleRunControl(req, res, path, host),
  (req, res, path, host) => handleScaffoldRoutes(req, res, path, host),
  (req, res, path, host) => handleNextChapterRoutes(req, res, path, host),
  (req, res, path, host) => handleStoryEditRoutes(req, res, path, host),
  (req, res, path, host) => handleStoryReadRoutes(req, res, path, host),
  (req, res, path, host) => handleCatalogRoutes(req, res, path, host),
  (req, res, path, host) => handleRunLogRoutes(req, res, path, host),
];
/** Start the viewer's HTTP server once: static GUI files, SSE at /events, and dispatch to the route
 *  modules. Idempotent — every call returns the same handle until it is closed. */
export function startServer(port: number, host: RouteHosts, bindAddr: string = "127.0.0.1"): ServerHandle {
  if (started) return started.handle;
  LIVE.port = port;

  const server = createServer(async (req, res) => {
    try {
      const path = (req.url || "/").split("?")[0];
      for (const handle of ROUTES) {
        if (await handle(req, res, path, host)) return;
      }
      res.writeHead(404); res.end("not found");
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
