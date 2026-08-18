/**
 * HTTP helpers shared by server.ts and its route modules.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

/** Send a JSON response with the given status code. */
export function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Read a request body as JSON, defaulting to {} when it is empty or malformed. */
export function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); } catch { resolve({}); }
    });
  });
}
