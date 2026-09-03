/**
 * Shared test helpers. Not a test file — not named `*.test.ts`, so the runner skips it and it needs
 * no line in package.json's `test` script.
 */
import { readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerHost } from "../server/server.ts";
import { Agent } from "../engine/agent.ts";
import type { SceneRun } from "../engine/scene-loop.ts";
import type { StoryConfig } from "../engine/story-format.ts";
import type { SceneDef } from "../engine/story-schema.ts";
import { SITE_HEADER, AGENT_HEADER } from "../engine/llm-client.ts";
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

// -- A FAKE LM STUDIO, ROUTED BY CALL SITE ---------------------------------
/** One intercepted request, as a route handler sees it. */
export interface SiteCall {
  /** This call's index within its OWN site, 0-based — what a per-site reply queue indexes on.
   *  Adding a call to some other site never shifts it. */
  n: number;
  /** Each message's content, in order; `[0]` is the system prompt. */
  messages: string[];
  /** The parsed request body, for the rare assertion needing more than the messages. */
  body: any;
}

/** What a site replies with: a fixed object, or a function of the call (for queues, captured
 *  prompts, or a `throw` standing in for an outage). Returning a `Response` passes it through. */
export type SiteHandler =
  | Record<string, unknown>
  | ((call: SiteCall) => Record<string, unknown> | Response);

/** Wrap an object as the completion body LM Studio would have sent. */
export const siteReply = (o: unknown) =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(o) } }] }));

/**
 * A `globalThis.fetch` stand-in that routes on the `X-SW-Site` header — the engine's own name for
 * the call site — instead of matching text out of the system prompt.
 *
 * Routing on prompt text is what this replaces, and it failed quietly: the branch that did not match
 * fell through to whichever route sat last, so a reworded prompt did not error, it fed one agent's
 * replies to another. Prompts move constantly (the writer's system prompt shifted by ~1,100
 * characters across four days of ordinary work), so that was a matter of time. A site that no route
 * covers is an error here, naming the site and everything that IS covered.
 */
export function siteFetch(routes: Record<string, SiteHandler>) {
  const seen: Record<string, SiteCall[]> = {};
  const fetchMock = (async (_url: string, init: any) => {
    const body = JSON.parse(String(init.body));
    const site = new Headers(init.headers).get(SITE_HEADER) ?? "";
    const messages: string[] = (body.messages ?? []).map((m: any) => String(m.content ?? ""));
    const call: SiteCall = { n: (seen[site] ??= []).length, messages, body };
    seen[site].push(call);
    const handler = routes[site];
    if (!handler)
      throw new Error(`siteFetch: nothing routes "${site || "(no site header)"}" — `
        + `routed sites are ${Object.keys(routes).join(", ") || "(none)"}`);
    const out = typeof handler === "function" ? handler(call) : handler;
    return out instanceof Response ? out : siteReply(out);
  }) as unknown as typeof globalThis.fetch;

  return {
    fetchMock,
    /** Every call a site received, in order — its length is the call count. */
    seen,
    count: (site: string) => (seen[site] ?? []).length,
    /** The messages of a site's Nth call, for asserting what a prompt carried. */
    messagesOf: (site: string, n = 0) => seen[site]?.[n]?.messages ?? [],
  };
}

// -- REPLAYING A RECORDED RUN ----------------------------------------------
/**
 * A `globalThis.fetch` stand-in that answers from a real recorded run — `tests/fixtures/recorded-run`,
 * made by `scripts/make-replay-fixture.mjs`. Each `(agent, site)` gets its own queue, served in the
 * order it was recorded.
 *
 * Keyed on the pair, not on order alone: one run's `writer.jsonl` held 23 drafts interleaved with 9
 * redrafts, so a change that skips a redraft would shift every later reply by one and hand a redraft
 * to a draft — wrong, and silent. Per-queue, that same change instead exhausts one queue and says
 * which. Not keyed on the prompt either: prompt text drifts constantly, and every edit would
 * invalidate the whole recording.
 *
 * `extra` supplies sites the recording cannot contain — `summary.digest` is the real case, since
 * `trimHistory` calls the transport outside any `Agent` and so is never written to a transcript.
 */
export function replayFetch(dir: string, extra: Record<string, SiteHandler> = {}) {
  const queues = new Map<string, string[]>();
  const text = readFileSync(joinPath(dir, "calls.jsonl"), "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as { agent: string; site: string; response: string };
    const key = `${rec.agent}|${rec.site}`;
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key)!.push(rec.response);
  }

  const taken = new Map<string, number>();
  const fetchMock = (async (_url: string, init: any) => {
    const h = new Headers(init.headers);
    const agent = h.get(AGENT_HEADER) ?? "", site = h.get(SITE_HEADER) ?? "";
    const key = `${agent}|${site}`;

    const handler = extra[site];
    if (handler && !queues.has(key)) {
      const body = JSON.parse(String(init.body));
      const messages: string[] = (body.messages ?? []).map((m: any) => String(m.content ?? ""));
      const n = taken.get(key) ?? 0;
      taken.set(key, n + 1);
      const out = typeof handler === "function" ? handler({ n, messages, body }) : handler;
      return out instanceof Response ? out : siteReply(out);
    }

    const q = queues.get(key);
    if (!q)
      throw new Error(`replay: the recording has nothing for ${key} — it holds `
        + `${[...queues.keys()].sort().join(", ")}. The run is making a call the recording never saw.`);
    const n = taken.get(key) ?? 0;
    if (n >= q.length)
      throw new Error(`replay: ${key} is exhausted — the recording has ${q.length} of them, `
        + `this run asked for ${n + 1}. The engine now makes more calls here than it did.`);
    taken.set(key, n + 1);
    // The transcript stores the reply as the model sent it, WITHOUT the `{` that Agent.generate
    // prepends — so handing it back verbatim reproduces exactly what generate() saw.
    return new Response(JSON.stringify({ choices: [{ message: { content: q[n] } }] }));
  }) as unknown as typeof globalThis.fetch;

  return {
    fetchMock,
    /** Recorded calls no replayed run asked for, as `agent|site → how many were left`. Empty means
     *  the run consumed the recording exactly. */
    unused: () => {
      const left: Record<string, number> = {};
      for (const [k, q] of queues) {
        const n = q.length - (taken.get(k) ?? 0);
        if (n > 0) left[k] = n;
      }
      return left;
    },
    used: (key: string) => taken.get(key) ?? 0,
    total: () => [...queues.values()].reduce((a, q) => a + q.length, 0),
  };
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

// -- A SHARED FAKE SERVER HOST -----------------------------------------------
/** A `ServerHost` with every member set to a safe default that fails loudly if a route calls it
 *  unscripted — a refusal shaped like the real one, or a throw naming the call "unused". Override
 *  only the members the test under it actually exercises; this is the one shape every route test
 *  fakes a host with, promoted so ServerHost's own shape stays the only thing to update.
 *
 *  `overrides` is deliberately untyped against `ServerHost` itself: a route double often returns a
 *  deliberately trimmed shape (a `story.config` with none of the run defaults, a cast entry missing
 *  fields the route under test never reads) that the real interface would reject. The final cast is
 *  what makes that legal, same as every hand-rolled fake this replaces did with its own trailing
 *  `as unknown as ServerHost`. */
export function makeHost(overrides?: Record<string, any>): ServerHost {
  return {
    storyCards: async () => [],
    selectableStory: async () => null,
    resolveStoryDir: (d: string) => d,
    runDirs: async () => [],
    runLlmLogs: async () => [],
    readLlmLog: async () => null,
    writtenChapters: async () => [],
    availableModelIds: async () => null,
    providerName: "none",
    architectModel: async () => "none",
    newScaffoldSession: async () => { throw new Error("unused"); },
    unknownTags: async () => [],
    importCharacters: async () => ({ imported: [], missing: [] }),
    resolveStyle: async () => null,
    newHandoffSession: async () => { throw new Error("unused"); },
    directEdit: () => ({ ok: false, reason: "unused" }),
    specView: (s: unknown) => s,
    outDir: () => "",
    editorConfig: () => ({
      defaults: { retries: 2, clarifications: 2, maxSteps: 24, maxProseWords: 140,
                  requestTimeout: 120, attempts: 3, maxTokens: 2000, stream: true, debug: false,
                  thinking: { writer: "low", character: "low", summary: "low" }, sceneLength: 700 },
      thinkingLevels: ["off", "low", "medium", "high", "default"],
      caps: { voiceSamples: 3 },
    }),
    storyForEdit: async () => ({ ok: false, error: "unused" }),
    fullCast: async () => ({ ok: false, error: "unused" }),
    checkStory: () => ({ ok: false, error: "unused", issues: [] }),
    saveStory: async () => ({ ok: false, reason: "unused" }),
    discardScene: async () => ({ ok: false, reason: "unused", status: 400 }),
    suggestEdits: async () => ({ ok: false, error: "unused" }),
    catalogEntries: async () => ({ ok: false, reason: "unused" }),
    catalogCheck: async () => ({ ok: false, reason: "unused" }),
    catalogSave: async () => ({ ok: false, reason: "unused" }),
    catalogDelete: async () => ({ ok: false, reason: "unused" }),
    catalogUsage: async () => ({ tags: {}, skills: {} }),
    promoteSkill: async () => ({ ok: false, reason: "unused" }),
    ...overrides,
  } as unknown as ServerHost;
}

// -- A SCENE RUN FOR TESTS --------------------------------------------------
/** A `SceneRun` for a fixture story, with the fields most call sites share already filled in.
 *  Overrides win wholesale: pass `{ scene: sd, agents, log, maxSteps: 30 }` and the rest is the
 *  story's own config. */
export function sceneRun(sc: StoryConfig, over: Partial<SceneRun> & { scene: SceneDef }): SceneRun {
  return {
    chapter: 1,
    characters: sc.characters,
    agents: new Map(),
    premise: sc.premise,
    writerStyle: sc.writerStyle,
    writerStyleConstraints: sc.writerStyleConstraints,
    writerModel: sc.models.writer,
    summaryModel: sc.models.summary,
    thinking: { writer: "low", summary: sc.thinking.summary },
    maxSteps: 10,
    maxProseWords: sc.maxProseWords,
    retries: sc.retries,
    clarifications: sc.clarifications,
    dir: sc.dir,
    log: () => {},
    ...over,
  };
}
