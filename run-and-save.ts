/** RUN AND SAVE — everything one chapter run does around the scene loop: the out/ directory and its
 *  logs, the incremental scene.md, the retained-run rotation, and the finished chapter's snapshot. */
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { join as joinPath } from "node:path";
import { C } from "./ansi.ts";
import { LIVE, resetLive, setWhere, publish } from "./live.ts";
import { ENGINE } from "./engine/engine-state.ts";
import { runDirs } from "./engine/preflight.ts";
import { runChapter, type RunEvent } from "./engine/scene-loop.ts";
import { warn } from "./engine/warnings.ts";
import type { StoryConfig } from "./engine/story-format.ts";

const MAX_RUNS = 3;

export async function runAndSave(sc: StoryConfig, dir: string, chapter = 1,
                                 opts: { serving: boolean; serve: () => void }) {
  const sceneCount = sc.scenes.length;
  const targetScene = sc.scenes[chapter - 1];
  const chapterDisplay = sceneCount > 1 ? ` · chapter ${chapter} of ${sceneCount}` : "";
  console.log(`${C.bold}${dir}${C.reset} ${C.dim}— ${sc.characters.map(c => c.name).join(", ")} `
    + `${chapterDisplay} · ~${targetScene.length} words · up to ${sc.maxSteps} steps${C.reset}`);

  LIVE.meta = {
    story: dir, chapter, chapters: sceneCount, target: targetScene.length, question: targetScene.question,
    characters: sc.characters.map(c => ({
      name: c.name,
      skills: c.skills.filter(s => s.source !== "general").map(s => s.name),
      restrictions: c.limits,
    })),
  };
  resetLive();
  if (opts.serving) opts.serve();
  setWhere(`writing ${dir}`, true);

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  ENGINE.outDir = joinPath(sc.dir, "out", runId);
  await mkdir(ENGINE.outDir, { recursive: true });
  await mkdir(joinPath(ENGINE.outDir, "llm"), { recursive: true });
  ENGINE.llmStreams = new Map();
  ENGINE.llmFilenames = new Set();
  ENGINE.llmDead = new Set();
  ENGINE.fitWarned = new Set();
  const scenePath = joinPath(ENGINE.outDir, "scene.md");
  const logPath = joinPath(ENGINE.outDir, "writing-log.jsonl");
  const logStream = createWriteStream(logPath, { flags: "w" });
  // A failed run log warns once and stops receiving events — the run itself must never crash on logging.
  let logDead = false;
  logStream.on("error", e => {
    if (logDead) return;
    logDead = true;
    warn(`   (the run log ${logPath} stopped being written: ${(e as Error).message} — later events are dropped, the run continues)`);
  });

  const events: RunEvent[] = [];
  const allPieces: string[] = [];
  let sceneWrites: Promise<unknown> = Promise.resolve();
  let sceneWriteError: Error | null = null;

  // Safe stream closing: never throws, never hangs; errors are reported but don't displace the original exception
  const endStream = (stream: NodeJS.WritableStream): Promise<void> => {
    return new Promise<void>((resolve) => {
      stream.on("error", () => resolve());
      stream.end(() => resolve());
    });
  };

  let r: { prose: string[]; steps: number; words: number; done: boolean; stopped: boolean };
  let cleanupError: Error | null = null;
  try {
    r = await runChapter(sc, chapter, e => {
      events.push(e);
      if (!logDead) logStream.write(JSON.stringify(publish(e)) + "\n");
      if (e.t === "draft" && e.prose) {
        allPieces.push(e.prose);
        sceneWrites = sceneWrites.then(() => writeFile(scenePath, allPieces.join("\n\n") + "\n", "utf8")).catch((err: unknown) => {
          if (!sceneWriteError) sceneWriteError = err instanceof Error ? err : new Error(String(err));
        });
      }
    });
  } finally {
    try {
      await sceneWrites;
      await endStream(logStream);
      await Promise.all([...ENGINE.llmStreams.values()].map(s => endStream(s)));
    } catch (e) {
      cleanupError = e as Error;
    }
  }

  if (sceneWriteError) {
    console.error(`${C.red}Failed to write scene.md: ${(sceneWriteError as Error).message}${C.reset}`);
    process.exitCode = 1;
  }
  if (cleanupError) {
    console.error(`${C.red}Error closing streams: ${cleanupError.message}${C.reset}`);
  }

  // Rotate: keep only the last MAX_RUNS folders, including the one just written.
  const kept = await runDirs(sc.dir);
  for (const stale of kept.slice(0, Math.max(0, kept.length - MAX_RUNS))) {
    await rm(joinPath(sc.dir, "out", stale), { recursive: true, force: true }).catch(() => {});
  }

  let chapterPath = "";
  // A chapter file is the engine's durable record, so it is written only by a run that finished
  // un-stopped AND wrote something. `done` with nothing on the page is a declaration the loop may
  // have honored (a second blank scene_done closes the scene), and a stop landing after the final
  // reply does not make the run finished — either way there is no chapter to accept.
  if (r.done && !r.stopped && r.prose.length > 0) {
    const chaptersDir = joinPath(sc.dir, "chapters");
    await mkdir(chaptersDir, { recursive: true });
    chapterPath = joinPath(chaptersDir, `${chapter}.md`);
    await writeFile(chapterPath, r.prose.join("\n\n") + "\n", "utf8");

    // The definition this chapter was written from, beside the prose rather than in out/, which is
    // rotated. The handoff rewrites story.json between chapters; without this, what produced an
    // older chapter is gone. Copied verbatim: re-rendering would record a normalised story, not the
    // authored one. Losing it must never cost the chapter that is already safely written.
    try {
      await writeFile(joinPath(chaptersDir, `${chapter}.json`),
                      await readFile(joinPath(sc.dir, "story.json"), "utf8"), "utf8");
    } catch (e) {
      console.log(`${C.dim}chapter ${chapter}'s definition was not snapshotted — ${(e as Error).message}${C.reset}`);
    }
  } else {
    const why = r.stopped ? "the run was stopped"
      : !r.done ? "the run did not finish"
      : "the run closed without writing a word";
    console.log(`${C.dim}chapter ${chapter} not saved — ${why}${C.reset}`);
  }

  setWhere(r.stopped ? `stopped ${dir}` : `finished ${dir}`, false);

  if (!opts.serving) {
    console.log(`\n${C.bold}${"=".repeat(60)}${C.reset}`);
    console.log(r.prose.join("\n\n"));
    console.log(`${C.bold}${"=".repeat(60)}${C.reset}`);
  }
  const consults = events.filter(e => e.t === "consult").length;
  const retries  = events.filter(e => e.t === "retry").length;
  const needs    = events.filter(e => e.t === "need").length;
  console.log(`${C.dim}${r.words} words · ${r.steps} steps · ${consults} consult(s) · `
    + `${needs} clarification(s) · ${retries} retry/retries · `
    + `${r.stopped ? "stopped by request" : r.done ? "chapter finished" : "stopped early"}${C.reset}`);
  console.log(`${C.dim}${scenePath}\n${logPath}${chapterPath ? "\n" + chapterPath : ""}${C.reset}`);
}
