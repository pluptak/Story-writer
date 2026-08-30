/**
 * Shared test helpers. Not a test file — not named `*.test.ts`, so the runner skips it and it needs
 * no line in package.json's `test` script.
 */
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerHost } from "../server/server.ts";
import { Agent } from "../engine/agent.ts";
import { WARN } from "../engine/warnings.ts";

// -- A MODEL THAT SAYS WHAT YOU TELL IT TO ---------------------------------
/** Replies straight from a script, so tests never touch a model. Used by the consult tests and by
 *  the architect ones, which drive a session with a scripted architect. */
export class ScriptedAgent extends Agent {
  calls: number = 0;
  constructor(public script: string[]) { super("TESTER", "none", "system", 0); }
  async generate(): Promise<string> {
    const r = this.script[this.calls++];
    if (r === undefined) throw new Error(`ScriptedAgent ran out of replies after ${this.calls - 1}`);
    return r;
  }
}

// -- QUIETING WARNINGS -----------------------------------------------------
// Several loaders warn by design; silence them to keep test output readable. They warn through the
// engine's sink, so capturing means swapping that — never touching global console.
export async function quiet<T>(fn: () => Promise<T> | T): Promise<T> {
  const orig = WARN.sink;
  WARN.sink = () => {};
  try { return await fn(); } finally { WARN.sink = orig; }
}

export function quietSync<T>(fn: () => T): T {
  const orig = WARN.sink;
  WARN.sink = () => {};
  try { return fn(); } finally { WARN.sink = orig; }
}

export function warnings(fn: () => void): string[] {
  const out: string[] = [];
  const orig = WARN.sink;
  WARN.sink = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  try { fn(); } finally { WARN.sink = orig; }
  return out;
}

// -- FAKE HTTP -------------------------------------------------------------
/** A request carrying `body`. Set `headers` only for the content-type checks. */
export function fakeRequest(body: unknown, method = "POST",
                            headers?: Record<string, string>): IncomingMessage {
  const chunks = body === undefined ? [] : [JSON.stringify(body)];
  const req = Readable.from(chunks) as unknown as IncomingMessage;
  (req as { method?: string }).method = method;
  if (headers) (req as { headers?: unknown }).headers = headers;
  return req;
}

/** A request whose body is a raw string, for the cases where it is not valid JSON. */
export function fakeRawRequest(raw: string, method = "POST",
                               headers?: Record<string, string>): IncomingMessage {
  const req = Readable.from([raw]) as unknown as IncomingMessage;
  (req as { method?: string }).method = method;
  if (headers) (req as { headers?: unknown }).headers = headers;
  return req;
}

type RouteHandler =
  (req: IncomingMessage, res: ServerResponse, path: string, host: ServerHost) => Promise<boolean>;

/** Drive one route call with a fake request/response pair, and hand back what it replied. */
export async function callRoute(handler: RouteHandler, path: string, body: unknown,
                                host: ServerHost, method = "POST") {
  const req = fakeRequest(body ?? {}, method);
  let code = 0, sent = "";
  const res = {
    writeHead(c: number) { code = c; return res; },
    end(s?: string) { sent = s ?? ""; },
  } as unknown as ServerResponse;
  const handled = await handler(req, res, path, host);
  return { handled, code, body: sent ? JSON.parse(sent) : null };
}

/** Drive one GET route whose parameters live in the query string. Unlike `callRoute` it sets
 *  `req.url` and returns the raw body and response headers -- these routes answer with NDJSON as
 *  often as JSON, so parsing is the caller's choice. */
export async function callGet(handler: RouteHandler, url: string, host: ServerHost) {
  const req = Readable.from([]) as unknown as IncomingMessage;
  (req as { method?: string }).method = "GET";
  (req as { url?: string }).url = url;
  let code = 0, sent = "", headers: Record<string, string> = {};
  const res = {
    writeHead(c: number, h?: Record<string, string>) { code = c; headers = h ?? {}; return res; },
    end(s?: string) { sent = s ?? ""; },
  } as unknown as ServerResponse;
  const handled = await handler(req, res, url.split("?")[0], host);
  return { handled, code, headers, text: sent, json: () => JSON.parse(sent) };
}
