/**
 * RUN MANIFEST — which engine actually wrote a run.
 *
 * A git revision alone does not answer that. A `--serve` process holds the modules it imported at
 * startup, so a `git checkout` reaches the tree and not the running server: on 2026-08-28 three runs
 * of a four-run series were written by an engine other than the one the tree was sitting on, and
 * telling them apart afterwards meant grepping the per-agent transcripts for a prompt string only one
 * revision contained. A manifest recording only the revision would have recorded the same wrong
 * answer with more authority.
 *
 * So the fingerprint here is taken from the engine's own source **at import time** — process start,
 * when the modules that will run were read — and compared against the same source on disk when the
 * manifest is written. Equal means the process is running the tree. Different means it is not, and
 * that is the case worth shouting about, because a mislabelled control reads as a result where a
 * missing one is merely missing.
 */
import { readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { warn } from "./engine/warnings.ts";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));

// Everything whose content can change what a run does. The viewer's static assets are deliberately
// out: they render a run, they never write one.
const SOURCE_DIRS = ["engine", "prompts"];
const SOURCE_FILES = ["prompts.ts", "live.ts", "app.ts", "run-and-save.ts", "run-manifest.ts", "story-writer.ts"];

/** A short digest over the engine's source. Both the path and the bytes go in, so a file that is
 *  renamed or deleted changes the digest as surely as an edited one. Unreadable files contribute
 *  their name alone rather than throwing: a fingerprint that fails is worse than one that is coarse. */
export function fingerprint(root = HERE): string {
  const h = createHash("sha256");
  const files: string[] = [...SOURCE_FILES];
  for (const d of SOURCE_DIRS) {
    try {
      for (const f of readdirSync(join(root, d)).sort()) if (f.endsWith(".ts")) files.push(`${d}/${f}`);
    } catch { /* a directory that is not there contributes nothing, and says so by its absence */ }
  }
  for (const rel of files.sort()) {
    h.update(rel);
    try { h.update(readFileSync(join(root, rel))); } catch { /* name only */ }
  }
  return h.digest("hex").slice(0, 12);
}

/** Captured at import — process start — so it names the code that is loaded, not what is on disk
 *  now. That difference is the entire point of this module. */
export const LOADED = fingerprint();

/** True when the source has changed since this process imported it: the running engine is not the
 *  one in the working tree, and any run it writes is labelled by neither git nor intuition. */
export const engineChangedSinceStart = (): boolean => fingerprint() !== LOADED;

export interface GitInfo { revision: string; branch: string; dirty: boolean }

/** The tree's own idea of where it is. Context, not identity — see the module note. `null` when git
 *  is unavailable or this is not a checkout, which is not an error worth failing a run over. */
export async function gitInfo(): Promise<GitInfo | null> {
  const exec = promisify(execFile);
  const run = async (...args: string[]) => (await exec("git", args, { cwd: HERE })).stdout.trim();
  try {
    const [revision, branch, status] = await Promise.all([
      run("rev-parse", "--short", "HEAD"),
      run("rev-parse", "--abbrev-ref", "HEAD"),
      run("status", "--porcelain"),
    ]);
    return { revision, branch, dirty: status.length > 0 };
  } catch { return null; }
}

export interface RunManifest {
  run: string;
  story: string;
  chapter: number;
  started: string;
  engine: string;
  /** The engine on disk changed after this process loaded it: this run was NOT written by the tree. */
  engineStale: boolean;
  git: GitInfo | null;
  scene: { pov: string; target: number };
  models: Record<string, string>;
}

/** Write `manifest.json` beside a run's other artifacts. Returns what it wrote so the caller can say
 *  something about it; never throws, because no run is worth losing to its own label. */
export async function writeRunManifest(outDir: string, m: {
  run: string; story: string; chapter: number;
  scene: { pov: string; target: number }; models: Record<string, string>;
}): Promise<RunManifest> {
  const manifest: RunManifest = {
    run: m.run, story: m.story, chapter: m.chapter,
    started: new Date().toISOString(),
    engine: LOADED,
    engineStale: engineChangedSinceStart(),
    git: await gitInfo(),
    scene: m.scene, models: m.models,
  };
  await writeFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8")
    .catch(e => warn(`   (the run's manifest.json was not written: ${(e as Error).message} — this run has no engine label)`));
  return manifest;
}
