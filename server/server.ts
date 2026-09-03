/**
 * LIVE SERVER — the viewer's HTTP surface. Node built-ins only, no framework, no build step.
 */

import { createServer, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";

import { C } from "../ansi.ts";
import { LIVE, RUN, sseClients, liveHistory, runState } from "../live.ts";
import { HttpError, json, readJsonBody } from "./http-util.ts";
import { handleRunControl } from "./run-control-routes.ts";
import { handleScaffoldRoutes } from "./scaffold-routes.ts";
import { handleNextChapterRoutes } from "./next-chapter-routes.ts";
import { handleRunLogRoutes } from "./run-log-routes.ts";
import { handleStoryEditRoutes } from "./story-edit-routes.ts";
import { handleStoryReadRoutes } from "./story-read-routes.ts";
import { handleCatalogRoutes } from "./catalog-routes.ts";
import type { ScaffoldSession, NextChapterSession, ImportedCharacter } from "../engine/architect.ts";
import type { StorySpec } from "../engine/story-spec.ts";
import type { StoryCard, LlmLogSummary } from "../engine/preflight.ts";
import type { StoryJson } from "../engine/story-schema.ts";

/** The author's concept, chosen before the architect runs and never written to story.json:
 *  `tags` steer the story stage, `castSize` is the opening cast's target size for the cast
 *  stage. Staged mode only — the one-shot walk has no gate for either to steer. */
export type Concept = { tags: string[]; castSize: number };

/** Everything a route can ask of the engine; built in story-writer.ts so server/ never imports engine/. */
export interface ServerHost {
  storyCards(): Promise<StoryCard[]>;
  /** Resolve a directory that came from OUTSIDE the process to one the engine discovered, or null. */
  selectableStory(dir: string): Promise<string | null>;
  resolveStoryDir(dir: string): string;
  runDirs(storyDir: string): Promise<string[]>;
  /** A retained run's per-agent LLM transcripts. Both take a resolved story path, as `runDirs` does. */
  runLlmLogs(storyDir: string, id: string): Promise<LlmLogSummary[]>;
  readLlmLog(storyDir: string, id: string, file: string): Promise<string | null>;
  /** The chapter numbers already written for a story -- the chapter equivalent of `runDirs`. Takes
   *  a discovered story dir, not a resolved path. */
  writtenChapters(dir: string): Promise<number[]>;
  loadedModelIds(): Promise<string[] | null>;
  /** The model an interview would use if you chose nothing — resolved, not `defaults.md`'s text. */
  architectModel(): Promise<string>;
  /** `mode` picks the scaffold's walk: "staged" runs the gated checklist
   *  (story → cast → settings → scene, an author approval between stages); "oneshot" is the
   *  whole-story proposal. Omitted means staged. The optional `concept` carries the author's
   *  pre-architect steering: tags and target cast size. */
  newScaffoldSession(idea: string, model?: string, mode?: "oneshot" | "staged",
                     concept?: Concept): Promise<ScaffoldSession>;
  /** Which of these tags the tag catalog does not hold, in the order given. Off-vocabulary tags
   *  are allowed — the catalog is a seed the author edits, not a gate — but they are reported so
   *  a typo does not silently become a steering word. */
  unknownTags(tags: string[]): Promise<string[]>;
  /** Resolve character-catalog ids into the scaffold's import tray. A id the catalog no longer holds
   *  comes back in `missing` rather than failing the call: the catalog is the author's and they may
   *  have deleted an entry since choosing it, and a tray that silently shrank is worse than one that
   *  says what it lost. */
  importCharacters(ids: string[]): Promise<{ imported: ImportedCharacter[]; missing: string[] }>;
  /** Open the handoff that prepares the chapter after the last one written; throws if there is none. */
  newHandoffSession(dir: string, model?: string): Promise<NextChapterSession>;
  directEdit(spec: StorySpec, field: string, value: unknown):
    { ok: false; reason: string } | { ok: true; spec: StorySpec; applied: { field: string; before: unknown; after: unknown }[]; problems: string[] };
  specView(spec: StorySpec): unknown;
  /** The current run's output folder, or "" before a run has committed one. */
  outDir(): string;
  /** Load a story's full validated definition for editing. Returns the Zod-parsed StoryJson
   *  plus engine warnings. On parse failure returns the raw object so the editor can show the
   *  error and let the user fix the file. */
  storyForEdit(dir: string): Promise<{
    ok: true; story: StoryJson; warnings: string[]
  } | {
    ok: false; error: string; raw?: object
  }>;
  /** A story's full authored cast for the live screen's read-only character sheet. Same load and
   *  validation as `storyForEdit`, but mapped to the display shape and with `model` omitted.
   *  `scenes[].reach` is the per-scene grant, kept OUT of the characters (I4: reach is
   *  character-in-place, never intrinsic). On a story that will not parse, returns `{ ok:false, error }`. */
  fullCast(dir: string): Promise<{
    ok: true; characters: {
      name: string; persona: string; knows: string; goal: string;
      belief: string; impulse: string; voice: string[];
      skills: { text: string; meaning: string }[]; restrictions: string[];
    }[]; scenes?: { n: number; reach: Record<string, string[]> }[];
  } | {
    ok: false; error: string;
  }>;
  /** Validate a modified story.json in memory without writing. Returns Zod errors + engine
   *  warnings (empty premise, no characters, etc.) grouped by path. */
  checkStory(story: object): {
    ok: true; warnings: string[]
  } | {
    ok: false; error: string; issues: { path: string; message: string }[]
  };
  /** Save a validated story.json atomically. Guards: refuses while a run is in flight and
   *  refuses if the story no longer loads. */
  saveStory(dir: string, story: object): Promise<{
    ok: true; warnings: string[]
  } | {
    ok: false; reason: string; status?: number
  }>;
  /** Drop the last authored scene from story.json, undoing an accepted-but-unwritten chapter.
   *  Refuses the sole scene, any scene but the last, a written chapter, or a run in flight. */
  discardScene(dir: string, n: number): Promise<{
    ok: true; chapter: number; scenes: number
  } | {
    ok: false; reason: string; status?: number
  }>;
  /** Stateless architect suggestion: given the current spec and user text, return proposed edits
   *  with the edited spec, for the editor to adopt into its (unsaved) draft. */
  suggestEdits(spec: unknown, text: string): Promise<{
    ok: true; kind: "edits"; spec: unknown; applied: {field:string;before:unknown;after:unknown}[]; ignored: string[];
    problems: string[]; note: string
  } | {
    ok: true; kind: "question"; ask: string
  } | {
    ok: false; error: string
  }>;
  /** All entries in a catalog. `kind` is validated here because it arrives from the wire. */
  catalogEntries(kind: string): Promise<{ ok: true; entries: unknown[] } | { ok: false; reason: string }>;
  /** Validate one catalog entry without saving. `kind` is validated here because it arrives from
   *  the wire; an unknown kind returns `reason`, not `issues`. Schema validation failure returns
   *  `issues`; both schema and kind validation answers are 200 (validation is ordinary reply). */
  catalogCheck(kind: string, entry: unknown): Promise<
    { ok: true; problems: string[] } |
    { ok: false; issues: string[] } |
    { ok: false; reason: string }
  >;
  /** Insert or replace one catalog entry by id. */
  catalogSave(kind: string, entry: unknown): Promise<{ ok: true; entry: unknown; problems: string[] } | { ok: false; reason: string; status?: number; issues?: string[] }>;
  /** Remove one catalog entry by id. Fails if the id is not found. */
  catalogDelete(kind: string, id: string): Promise<{ ok: true } | { ok: false; reason: string; status?: number }>;
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
export function startServer(port: number, host: ServerHost, bindAddr: string = "127.0.0.1"): ServerHandle {
  if (started) return started.handle;
  LIVE.port = port;
  const viewerPath = new URL("./gui/viewer.html", import.meta.url);
  const viewerCssPath = new URL("./gui/viewer.css", import.meta.url);
  const viewerJsPath = new URL("./gui/viewer.js", import.meta.url);
  const viewerModule = /^\/viewer\/([a-z0-9_-]+\.js)$/i;

  const server = createServer(async (req, res) => {
    try {
      const path = (req.url || "/").split("?")[0];
      if (path === "/" || path === "/index.html") {
        await serveFile(res, viewerPath, "text/html; charset=utf-8");
      } else if (path === "/viewer.css") {
        await serveFile(res, viewerCssPath, "text/css; charset=utf-8");
      } else if (path === "/viewer.js") {
        await serveFile(res, viewerJsPath, "application/javascript; charset=utf-8");
      } else if (viewerModule.test(path)) {
        // viewer.js's own submodules -- an allowlist regex (flat filenames only, no subfolders)
        // rather than a `..`-blacklist check, since that's the shape the folder actually has.
        const file = path.match(viewerModule)![1];
        await serveFile(res, new URL(`./gui/viewer/${file}`, import.meta.url), "application/javascript; charset=utf-8");
      } else if (path === "/studio" || path === "/studio/") {
        await serveFile(res, new URL("../mockups/studio/index.html", import.meta.url), "text/html; charset=utf-8");
      } else if (path === "/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
          Connection: "keep-alive", "X-Accel-Buffering": "no",
        });
        res.write("retry: 3000\n\n");
        for (const ev of liveHistory) res.write(`data: ${JSON.stringify(ev)}\n\n`);
        res.write(`data: ${JSON.stringify(runState())}\n\n`);
        sseClients.add(res);
        const dropClient = () => sseClients.delete(res);
        req.on("close", dropClient);
        // Without an `error` listener, an async socket failure (EPIPE/ECONNRESET on a half-dead
        // viewer) emits an unhandled 'error' event that would crash the whole process.
        res.on("error", dropClient);

      } else if (path === "/run") {
        json(res, 200, {
          run: LIVE.meta, awaitingContinue: LIVE.awaitingContinue, events: liveHistory.length,
          running: LIVE.running, stopping: RUN.stopped && LIVE.running, where: LIVE.where,
          picking: LIVE.awaitingPick, loading: LIVE.loading, armed: LIVE.readerArmed,
          paused: LIVE.paused, pausing: LIVE.pausing && !LIVE.paused, model: LIVE.modelOverride,
          interactive: LIVE.interactive,
        });

      } else if (path === "/select" && req.method === "POST") {
        const o = await readJsonBody(req);
        if (!LIVE.awaitingPick || !LIVE.pickResolve) { json(res, 400, { ok: false, reason: "the session is not waiting on a choice" }); return; }
        const dir = await host.selectableStory(String(o.dir ?? ""));
        if (!dir) { json(res, 400, { ok: false, reason: `no such story: ${String(o.dir ?? "")}` }); return; }
        const asked = Number(o.chapter ?? 1);
        const chapter = Number.isInteger(asked) && asked > 0 ? asked : 1;
        // Explicit authorization to write over an existing chapter or skip past an unwritten one —
        // the viewer's counterpart of the CLI's --replace. Absent, runOne's durability guard holds.
        const replace = o.replace === true;
        const r = LIVE.pickResolve; LIVE.pickResolve = null; LIVE.awaitingPick = false;
        json(res, 200, { ok: true, dir });
        r({ dir, chapter, replace });

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
  const ping = setInterval(() => { for (const c of sseClients) { try { c.write(": ping\n\n"); } catch {} } }, 15000);

  const handle: ServerHandle = {
    bound,
    close: () => new Promise<void>(resolve => {
      clearInterval(ping);
      for (const c of sseClients) { try { (c as ServerResponse).end(); } catch { } }
      sseClients.clear();
      server.close(() => { started = null; resolve(); });
      server.closeIdleConnections();
    }),
  };
  started = { handle };
  return handle;
}
