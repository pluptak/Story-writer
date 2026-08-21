/**
 * HTTP helpers shared by server.ts and its route modules.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

/** Send a JSON response with the given status code. */
export function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const MAX_BODY_SIZE = 1024 * 1024; // 1 MiB

/** Read a request body as JSON. Rejects with HttpError on size limit, malformed JSON, or unsupported content type. */
export function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    let rejected = false;

    // Check Content-Type if explicitly set (some POSTs send no header when empty)
    const ct = req.headers?.["content-type"];
    if (ct && !ct.includes("application/json")) {
      rejected = true;
      reject(new HttpError(400, "Content-Type must be application/json"));
      req.destroy();
      return;
    }

    req.on("data", (c) => {
      if (rejected) return;
      body += c;
      if (body.length > MAX_BODY_SIZE) {
        rejected = true;
        reject(new HttpError(413, "request body too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (rejected) return;
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new HttpError(400, "invalid JSON"));
      }
    });

    req.on("error", () => {
      if (!rejected) {
        rejected = true;
        reject(new HttpError(400, "request error"));
      }
    });
  });
}
