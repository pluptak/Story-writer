/**
 * How current is every authored story against the engine that reads it today?
 *
 *   npx tsx scripts/story-audit.ts                     every story under data/stories/
 *   npx tsx scripts/story-audit.ts data/stories/doorway one or more folders
 *   npx tsx scripts/story-audit.ts --min-level=degraded only stories BETTER than degraded pass
 *   npx tsx scripts/story-audit.ts --json              the whole report, machine-readable
 *   npx tsx scripts/story-audit.ts --no-write          skip the per-story sidecar
 *
 * A thin shell over `engine/story-audit.ts`, which holds every judgement — so the viewer can
 * answer the same question later without this file. Offline: no model, no provider call.
 *
 * It writes `story-audit.json` beside each `story.json`, as a cache of the verdict a batch runner
 * can read without re-auditing. That file is a cache and never a source of truth: `checkedAt` and
 * `engineRevision` say how stale it is, and re-running this replaces it. `story.json` itself is a
 * strict schema, so the verdict could not live inside it even if it should — and it should not.
 */
import { writeFile } from "node:fs/promises";
import { join as joinPath } from "node:path";

import { gitInfo, LOADED } from "../run-manifest.ts";
import { discoverStories } from "../engine/story-format.ts";
import { persistedCatalogs } from "../engine/catalog.ts";
import {
  auditStories, passesBar, AUDIT_LEVELS, type AuditLevel, type StoryAudit,
} from "../engine/story-audit.ts";
import { C } from "../ansi.ts";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.includes("=") ? hit.split("=").slice(1).join("=") : "";
};
const dirsFromArgv = argv.filter(a => !a.startsWith("--"));

const JSON_OUT = flag("json") !== undefined;
const WRITE = flag("no-write") === undefined;
const MIN = (flag("min-level") || "degraded") as AuditLevel;
if (!AUDIT_LEVELS.includes(MIN)) {
  console.error(`--min-level must be one of ${AUDIT_LEVELS.join(", ")}`);
  process.exit(2);
}

const TONE: Record<AuditLevel, string> = {
  broken: C.red, degraded: C.yellow, dated: C.dim, current: C.green,
};

/** The sidecar: the verdict alone, plus enough to know when it went stale. Findings travel with
 *  it so a runner can say WHY it skipped a story without loading the story itself. Staleness is
 *  stamped the way a run is (`run-manifest.ts`): the git revision AND the engine source
 *  fingerprint, because an audit of a dirty tree is the ordinary case here and a revision alone
 *  would call it clean. */
async function writeSidecar(a: StoryAudit, git: Awaited<ReturnType<typeof gitInfo>>) {
  const path = joinPath(a.dir, "story-audit.json");
  const body = {
    level: a.level, checkedAt: a.checkedAt,
    engine: LOADED, git,
    findings: a.findings, loadWarnings: a.loadWarnings,
    ...(a.error ? { error: a.error } : {}),
  };
  await writeFile(path, JSON.stringify(body, null, 2) + "\n", "utf8");
  return path;
}

function report(audits: StoryAudit[]) {
  const width = Math.max(...audits.map(a => a.name.length), 4);
  console.log(`\n${C.bold}── story audit ──${C.reset}  ${C.dim}against the engine in this working tree${C.reset}\n`);
  for (const a of audits) {
    const counts = AUDIT_LEVELS.filter(l => l !== "current")
      .map(l => [l, a.findings.filter(f => f.level === l).length] as const)
      .filter(([, n]) => n > 0)
      .map(([l, n]) => `${n} ${l}`).join(", ");
    const gate = passesBar(a.level, MIN) ? "" : `  ${C.red}✗ excluded by --min-level=${MIN}${C.reset}`;
    console.log(`  ${TONE[a.level]}${a.level.padEnd(8)}${C.reset} ${a.name.padEnd(width)}  ${C.dim}${counts || "nothing to do"}${C.reset}${gate}`);
  }

  for (const a of audits) {
    if (!a.findings.length) continue;
    console.log(`\n${C.bold}${a.name}${C.reset} ${C.dim}(${a.dir})${C.reset}`);
    for (const f of a.findings) {
      const where = f.where ? ` ${C.cyan}${f.where}${C.reset}` : "";
      console.log(`  ${TONE[f.level]}${f.level}${C.reset}${where}  ${f.what}`);
      console.log(`      ${C.dim}${f.effect}${C.reset}`);
    }
    if (a.loadWarnings.length) {
      console.log(`  ${C.dim}the loader also said:${C.reset}`);
      for (const w of a.loadWarnings) console.log(`      ${C.dim}${w}${C.reset}`);
    }
  }

  const tally = AUDIT_LEVELS.map(l => `${audits.filter(a => a.level === l).length} ${l}`).join(" · ");
  const failing = audits.filter(a => !passesBar(a.level, MIN));
  const runnable = audits.length - failing.length;
  console.log(`\n${C.bold}── summary ──${C.reset}  ${tally}`);
  console.log(`  ${C.dim}--min-level=${MIN} runs a story only when it is better than ${MIN}.${C.reset}`);
  if (failing.length)
    console.log(`  ${C.green}${runnable} runnable${C.reset} · ${C.red}${failing.length} excluded:${C.reset} ${failing.map(a => a.name).join(", ")}`);
  else
    console.log(`  ${C.green}all ${runnable} runnable${C.reset}`);
  return failing.length;
}

const dirs = dirsFromArgv.length ? dirsFromArgv : await discoverStories();
if (!dirs.length) {
  console.error("no stories found under data/stories/ — pass a folder explicitly");
  process.exit(2);
}

const audits = await auditStories(dirs, await persistedCatalogs());

if (WRITE) {
  const git = await gitInfo();
  for (const a of audits) await writeSidecar(a, git);
}

if (JSON_OUT) {
  console.log(JSON.stringify({ minLevel: MIN, audits }, null, 2));
} else {
  const failing = report(audits);
  if (WRITE) console.log(`  ${C.dim}story-audit.json written beside each story.json${C.reset}`);
  if (failing) process.exit(1);
}
