/**
 * LIVE SERVER — the viewer's HTTP surface. Node built-ins only, no framework, no build step.
 */

import { createServer, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join as joinPath } from "node:path";

import { C } from "./ansi.ts";
import { LIVE, RUN, stopRun, sseClients, liveHistory, sseWrite, runState, setWhere } from "./live.ts";
import type {
  ScaffoldSession, ScaffoldRound, ScaffoldAccept, StorySpec, StoryCard,
} from "./story-writer.ts";

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

// -- THE INTERVIEW, SERVER SIDE --------------------------------------------
let SCAFFOLD: ScaffoldSession | null = null;
let scaffoldBusy = false;                  // one architect at a time
let scaffoldLast: ScaffoldRound | null = null;
let scaffoldFolderAsk = "";                // why accept() would not derive a folder name

function scaffoldState(host: ServerHost) {
  if (!SCAFFOLD) return { active: false };
  return {
    active: true,
    idea: SCAFFOLD.idea,
    busy: scaffoldBusy,
    haveStory: SCAFFOLD.haveStory(),
    pendingAsk: SCAFFOLD.pendingAsk,
    problems: SCAFFOLD.problems,
    last: scaffoldLast,
    needsFolder: scaffoldFolderAsk,
    model: SCAFFOLD.defaults.models.architect,
    spec: SCAFFOLD.haveStory() ? host.specView(SCAFFOLD.spec) : null,
  };
}

function publishScaffold(host: ServerHost) {
  sseWrite({ t: "scaffold", state: scaffoldState(host) });
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
  const json = (res: any, code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

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
      let body = ""; req.on("data", c => (body += c));
      req.on("end", async () => {
        if (!LIVE.awaitingPick || !LIVE.pickResolve) { json(res, 400, { ok: false, reason: "the session is not waiting on a choice" }); return; }
        let o: any = {}; try { o = JSON.parse(body || "{}"); } catch {}
        const dir = await host.selectableStory(String(o.dir ?? ""));
        if (!dir) { json(res, 400, { ok: false, reason: `no such story: ${String(o.dir ?? "")}` }); return; }
        const r = LIVE.pickResolve; LIVE.pickResolve = null; LIVE.awaitingPick = false;
        json(res, 200, { ok: true, dir });
        r(dir);
      });

    } else if (path === "/stop" && req.method === "POST") {
      if (!LIVE.running) { json(res, 400, { ok: false, reason: "no run in progress" }); return; }
      const first = stopRun();
      if (LIVE.awaitingContinue && LIVE.continueResolve) {
        const r = LIVE.continueResolve; LIVE.continueResolve = null; LIVE.awaitingContinue = null; r(0);
      }
      if (LIVE.readerResolve) { const r = LIVE.readerResolve; LIVE.readerResolve = null; r(""); }
      LIVE.readerArmed = false;
      if (LIVE.pauseResolve) { const r = LIVE.pauseResolve; LIVE.pauseResolve = null; r(); }
      LIVE.pausing = false; LIVE.paused = false;
      if (first) console.log(`\n${C.yellow}Stop requested from the viewer — ending the scene.${C.reset}`);
      sseWrite(runState());
      json(res, 200, { ok: true, already: !first });

    } else if (path === "/consult-me" && req.method === "POST") {
      if (!LIVE.running) { json(res, 400, { ok: false, reason: "no run in progress" }); return; }
      if (!LIVE.interactive) { json(res, 400, { ok: false, reason: "interactive is off" }); return; }
      if (LIVE.readerArmed || LIVE.readerResolve) { json(res, 200, { ok: true, already: true }); return; }
      LIVE.readerArmed = true;
      sseWrite(runState());
      json(res, 200, { ok: true });

    } else if (path === "/reader-answer" && req.method === "POST") {
      let body = ""; req.on("data", c => (body += c));
      req.on("end", () => {
        if (!LIVE.readerResolve) { json(res, 400, { ok: false, reason: "no reader prompt pending" }); return; }
        let o: any = {}; try { o = JSON.parse(body || "{}"); } catch {}
        const answer = String(o.answer ?? "").trim();
        if (!answer) { json(res, 400, { ok: false, reason: "empty answer" }); return; }
        const r = LIVE.readerResolve; LIVE.readerResolve = null;
        json(res, 200, { ok: true });
        r(answer);
      });

    } else if (path === "/models" && req.method === "GET") {
      const ids = await host.loadedModelIds();
      json(res, 200, {
        ids: ids ?? [], reachable: ids !== null,
        current: LIVE.modelOverride, architect: await host.architectModel(),
      });

    } else if (path === "/model" && req.method === "POST") {
      let body = ""; req.on("data", c => (body += c));
      req.on("end", async () => {
        if (LIVE.running && !LIVE.paused) { json(res, 400, { ok: false, reason: "pause the run before changing its model" }); return; }
        let o: any = {}; try { o = JSON.parse(body || "{}"); } catch {}
        const model = String(o.model ?? "").trim();
        if (!model) { LIVE.modelOverride = null; json(res, 200, { ok: true }); return; }
        const ids = await host.loadedModelIds();
        if (ids !== null && !ids.includes(model)) {
          json(res, 400, { ok: false, reason: `"${model}" is not loaded in LM Studio` }); return;
        }
        LIVE.modelOverride = model;
        if (LIVE.paused && LIVE.writer && LIVE.agents) {
          LIVE.writer.model = model;
          for (const a of LIVE.agents.values()) a.model = model;
          LIVE.log?.({ t: "model_changed", model });
        }
        sseWrite(runState());
        json(res, 200, { ok: true });
      });

    } else if (path === "/interactive" && req.method === "POST") {
      let body = ""; req.on("data", c => (body += c));
      req.on("end", () => {
        let o: any = {}; try { o = JSON.parse(body || "{}"); } catch {}
        LIVE.interactive = !!o.on;
        if (!LIVE.interactive && LIVE.readerArmed) LIVE.readerArmed = false;
        sseWrite(runState());
        json(res, 200, { ok: true });
      });

    } else if (path === "/pause" && req.method === "POST") {
      if (!LIVE.running) { json(res, 400, { ok: false, reason: "no run in progress" }); return; }
      if (LIVE.pausing || LIVE.paused) { json(res, 200, { ok: true, already: true }); return; }
      LIVE.pausing = true;
      sseWrite(runState());
      json(res, 200, { ok: true });

    } else if (path === "/resume" && req.method === "POST") {
      if (!LIVE.pausing && !LIVE.paused) { json(res, 400, { ok: false, reason: "not paused" }); return; }
      LIVE.pausing = false;
      if (LIVE.pauseResolve) { const r = LIVE.pauseResolve; LIVE.pauseResolve = null; LIVE.paused = false; r(); }
      sseWrite(runState());
      json(res, 200, { ok: true });

    } else if (path === "/continue" && req.method === "POST") {
      let body = ""; req.on("data", c => (body += c));
      req.on("end", () => {
        let steps = 0; try { steps = Number(JSON.parse(body || "{}").steps) || 0; } catch {}
        if (LIVE.awaitingContinue && LIVE.continueResolve) {
          const r = LIVE.continueResolve; LIVE.continueResolve = null; LIVE.awaitingContinue = null;
          json(res, 200, { ok: true });
          r(Math.max(0, Math.floor(steps)));
        } else json(res, 400, { ok: false, reason: "no run is waiting on a budget decision" });
      });

    } else if (path === "/scaffold" && req.method !== "POST") {
      json(res, 200, scaffoldState(host));

    } else if (path.startsWith("/scaffold/") && req.method === "POST") {
      let body = ""; req.on("data", c => (body += c));
      req.on("end", async () => {
        let o: any = {}; try { o = JSON.parse(body || "{}"); } catch {}
        const what = path.slice("/scaffold/".length);
        if (!["start", "say", "accept", "abandon", "set"].includes(what)) {
          json(res, 404, { ok: false, reason: `no such scaffold action: ${what}` }); return;
        }

        if (what === "abandon") {
          SCAFFOLD = null; scaffoldLast = null; scaffoldFolderAsk = ""; scaffoldBusy = false;
          publishScaffold(host);
          json(res, 200, { ok: true });
          return;
        }
        if (scaffoldBusy) { json(res, 409, { ok: false, reason: "a round is already in flight" }); return; }

        if (what === "start") {
          if (!LIVE.awaitingPick) { json(res, 400, { ok: false, reason: "the session is not waiting for a story" }); return; }
          const idea = String(o.idea ?? "").trim();
          if (!idea) { json(res, 400, { ok: false, reason: "nothing to work with" }); return; }
          const model = String(o.model ?? "").trim();
          if (model) {
            const ids = await host.loadedModelIds();
            if (ids !== null && !ids.includes(model)) {
              json(res, 400, { ok: false, reason: `"${model}" is not loaded in LM Studio` }); return;
            }
          }
          scaffoldBusy = true; scaffoldLast = null; scaffoldFolderAsk = "";
          try {
            SCAFFOLD = await host.newScaffoldSession(idea, model);
            setWhere("building a new story", false);
            publishScaffold(host);
            scaffoldLast = await SCAFFOLD.propose();
          } catch (e) {
            scaffoldLast = { kind: "failed", error: (e as Error).message };
          } finally { scaffoldBusy = false; }
          publishScaffold(host);
          json(res, 200, scaffoldState(host));
          return;
        }

        if (!SCAFFOLD) { json(res, 400, { ok: false, reason: "no interview is open" }); return; }

        if (what === "set") {
          if (!SCAFFOLD.haveStory()) { json(res, 400, { ok: false, reason: "there is no story to change yet" }); return; }
          const r = host.directEdit(SCAFFOLD.spec, String(o.field ?? ""), o.value);
          if (!r.ok) { json(res, 400, { ok: false, reason: r.reason }); return; }
          SCAFFOLD.spec = r.spec; SCAFFOLD.problems = r.problems;
          scaffoldLast = { kind: "edits", applied: r.applied, ignored: [], note: "" };
          publishScaffold(host);
          json(res, 200, scaffoldState(host));
          return;
        }

        if (what === "say") {
          const text = String(o.text ?? "").trim();
          if (!text) { json(res, 400, { ok: false, reason: "say something" }); return; }
          scaffoldBusy = true; scaffoldFolderAsk = ""; publishScaffold(host);
          try { scaffoldLast = await SCAFFOLD.say(text); }
          catch (e) { scaffoldLast = { kind: "failed", error: (e as Error).message }; }
          finally { scaffoldBusy = false; }
          publishScaffold(host);
          json(res, 200, scaffoldState(host));
          return;
        }

        if (what === "accept") {
          if (!LIVE.awaitingPick || !LIVE.pickResolve) { json(res, 400, { ok: false, reason: "the session is not waiting for a story" }); return; }
          scaffoldBusy = true; publishScaffold(host);
          let r: ScaffoldAccept;
          try { r = await SCAFFOLD.accept(String(o.folder ?? "").trim()); }
          catch (e) {
            scaffoldBusy = false; publishScaffold(host);
            json(res, 500, { ok: false, reason: (e as Error).message }); return;
          }
          scaffoldBusy = false;
          if (r.kind !== "written") {
            scaffoldFolderAsk = r.kind === "needs_folder" ? r.reason : "";
            publishScaffold(host);
            json(res, r.kind === "no_story" ? 400 : 200, { ok: false, ...r });
            return;
          }
          SCAFFOLD = null; scaffoldLast = null; scaffoldFolderAsk = "";
          publishScaffold(host);
          const resolve = LIVE.pickResolve; LIVE.pickResolve = null; LIVE.awaitingPick = false;
          json(res, 200, { ok: true, ...r });
          resolve(r.dir);                 // the parked session gets the story it was waiting for
          return;
        }
      });

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
