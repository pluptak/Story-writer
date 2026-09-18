/**
 * SSE — the `/events` endpoint's HTTP framing plus the keep-alive ping. The bus itself
 * (clients, history, frames) lives in live.ts; this module only speaks HTTP. Contract:
 * docs/GUI-SPEC.md ("/events").
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { LIVE, sseClients, liveHistory, runState } from "../live.ts";
import { requireMethod } from "./http-util.ts";

/** Attach an SSE subscriber for `/events`: headers, replay, then park on the bus.
 *  Returns true, or false if `path` is not the event stream. */
export function handleSseRoute(
  req: IncomingMessage, res: ServerResponse, path: string,
): boolean {
  if (path !== "/events") return false;
  if (requireMethod(res, req, "GET")) return true;
  res.writeHead(200, {
    "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
    Connection: "keep-alive", "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");
  for (const ev of liveHistory) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  res.write(`data: ${JSON.stringify(runState())}\n\n`);
  if (LIVE.awaitingContinue) res.write(`data: ${JSON.stringify({ t: "continue_prompt", ...LIVE.awaitingContinue, suggested: 8 })}\n\n`);
  if (LIVE.awaitingLint) res.write(`data: ${JSON.stringify({ t: "lint_prompt", ...LIVE.awaitingLint })}\n\n`);
  sseClients.add(res);
  const dropClient = () => sseClients.delete(res);
  req.on("close", dropClient);
  // Without an `error` listener, an async socket failure (EPIPE/ECONNRESET on a half-dead
  // viewer) emits an unhandled 'error' event that would crash the whole process.
  res.on("error", dropClient);
  return true;
}

/** Ping every subscriber until the returned stop function runs. Owned by startServer. */
export function startSsePing(): () => void {
  const ping = setInterval(() => { for (const c of sseClients) { try { c.write(": ping\n\n"); } catch {} } }, 15000);
  return () => clearInterval(ping);
}
