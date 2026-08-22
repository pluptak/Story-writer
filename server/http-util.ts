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
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;

    // Reject once, then drain the rest of the body rather than destroying the socket, so the
    // caller's error response still reaches the client instead of a connection reset.
    const fail = (err: HttpError) => {
      if (rejected) return;
      rejected = true;
      req.resume();
      reject(err);
    };

    // Check Content-Type if explicitly set (some POSTs send no header when empty)
    const ct = req.headers?.["content-type"];
    if (ct && !ct.includes("application/json")) {
      fail(new HttpError(400, "Content-Type must be application/json"));
      return;
    }

    req.on("data", (c) => {
      if (rejected) return;
      // Buffer the raw bytes and decode once at the end: `body += c` would toString() each chunk
      // on its own, mangling a multi-byte UTF-8 char split across a chunk boundary.
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      size += buf.length;
      if (size > MAX_BODY_SIZE) { fail(new HttpError(413, "request body too large")); return; }
      chunks.push(buf);
    });

    req.on("end", () => {
      if (rejected) return;
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "invalid JSON"));
      }
    });

    req.on("error", () => fail(new HttpError(400, "request error")));
  });
}
