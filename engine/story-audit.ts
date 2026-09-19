/**
 * STORY-AUDIT — how current one authored story is against the engine that reads it today.
 *
 * The library accumulated across stages of development: fourteen stories written at different
 * times, all of which still validate, several of which silently get less engine than they look
 * like they are getting. A story with no declared `pronouns` is not rejected anywhere — it is
 * simply skipped by `pronoun-lint.ts`, invisible to the quote lint's speech-tag resolution and to
 * the reported-speech lint's pronoun subjects. Nothing says so at load, at preflight, or on the
 * shelf, so a run against it quietly produces weaker evidence than the same run against doorway.
 * This module is the thing that says so.
 *
 * It answers one question per story — how much of today's engine can actually reach it — in three
 * tiers, because the useful answers are not the same question at different strengths:
 *
 *  - `broken`   the story cannot run. It does not parse, does not validate, or has no cast.
 *  - `degraded` it runs, but a shipped check cannot see it at all, or an authored field is
 *               dropped on the floor. Every finding here names something the engine WOULD do.
 *  - `dated`    it runs and every check applies; it predates a feature and never adopted it.
 *               Not a defect — a two-hander in one room needs no world timeline — which is why
 *               this tier exists rather than folding into `degraded`.
 *
 * The tier is the worst finding, and `current` means none at all. A caller picks its own bar
 * (`passesBar`), because the right bar differs by errand: a batch measuring lint behaviour sets the
 * bar at `degraded` and runs only what is better; a smoke test that needs stories merely to start
 * sets it at `broken`.
 *
 * Two deliberate non-features. It never writes to `story.json`: the gaps are not mechanically
 * fillable — a restriction's `:: meaning` has to say what its ABSENCE leaves, which the skill
 * bible does not hold, and pronouns cannot be inferred from a persona without guessing at a
 * person. Reporting what to write is the honest half, and the sidecar in `scripts/story-audit.ts`
 * is a cache of this verdict, never a second source of truth. And it makes no network call, so it
 * says nothing about models — that is `runPreflight`'s question, and this one answers offline.
 */
import { readFile } from "node:fs/promises";
import { join as joinPath } from "node:path";

import { loadStory } from "./story-format.ts";
import { characterPsychologyWarnings } from "./story-spec.ts";
import { WARN } from "./warnings.ts";
import type { Catalogs } from "./skills.ts";

/** Worst-first, which is also the order `passesBar` compares in. */
export const AUDIT_LEVELS = ["broken", "degraded", "dated", "current"] as const;
export type AuditLevel = (typeof AUDIT_LEVELS)[number];

const RANK = new Map<AuditLevel, number>(AUDIT_LEVELS.map((l, i) => [l, i]));

/** True when a story at `level` clears a bar set at `bar` — strictly better, not equal to. The bar
 *  names the worst tier you are refusing, so `passesBar("dated", "degraded")` is true and
 *  `passesBar("degraded", "degraded")` is false: a bar of `degraded` runs only stories carrying no
 *  degraded and no broken finding. Equality would leave the useful bars unnameable, since `broken`
 *  is the worst tier there is and a bar has to be able to exclude it. */
export const passesBar = (level: AuditLevel, bar: AuditLevel): boolean =>
  RANK.get(level)! > RANK.get(bar)!;

/** One thing the audit found, with what to do about it. `what` is a worklist line, not a
 *  restatement of whatever the loader already warned — the loader's own wording travels
 *  separately on `loadWarnings`, so neither has to be kept in step with the other. */
export interface AuditFinding {
  /** Stable kebab-case id, so a caller can filter or suppress one without matching prose. */
  check: string;
  level: Exclude<AuditLevel, "current">;
  /** Where it is: a character name, `scene 2`, or omitted when it is the whole story. */
  where?: string;
  /** What is missing or wrong. */
  what: string;
  /** What the engine does about it today — the reason this is worth a line. */
  effect: string;
}

export interface StoryAudit {
  dir: string;
  /** The folder name, which is what the shelf and the CLI show. */
  name: string;
  level: AuditLevel;
  findings: AuditFinding[];
  /** Everything the loader warned while reading this story, verbatim and unclassified. Kept
   *  because it is the one place a story's own oddities are already worded, and re-wording them
   *  here would make two homes for the same sentence. */
  loadWarnings: string[];
  /** Set only when the story could not be loaded at all; `level` is `broken` when it is. */
  error?: string;
  checkedAt: string;
}

/** The loader warns through the engine sink while it reads. Capturing it costs a swap, the same
 *  one `runPreflight` makes, and the audits are run one at a time so no story can catch another's
 *  warnings. */
async function loadCapturing(dir: string, catalogs?: Catalogs) {
  const warnings: string[] = [];
  const orig = WARN.sink;
  WARN.sink = (msg: string) => { warnings.push(String(msg).trim()); };
  try {
    return { sc: await loadStory(dir, undefined, catalogs), warnings, error: undefined as string | undefined };
  } catch (e) {
    return { sc: undefined, warnings, error: (e as Error).message };
  } finally { WARN.sink = orig; }
}

/** Audit one story folder. Never throws: a story that cannot be read IS the answer, reported as
 *  `broken` with the reason on `error`. */
export async function auditStory(dir: string, catalogs?: Catalogs): Promise<StoryAudit> {
  const name = dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
  const checkedAt = new Date().toISOString();
  const findings: AuditFinding[] = [];

  // The raw file as authored, read beside the loaded story: the loader fills defaults, so an
  // absent field and an authored-empty one look identical by the time it is done, and "did the
  // author ever write this" is exactly what half the checks below are asking.
  let raw: Record<string, unknown> | undefined;
  try {
    raw = JSON.parse(await readFile(joinPath(dir, "story.json"), "utf8")) as Record<string, unknown>;
  } catch (e) {
    const why = (e as NodeJS.ErrnoException).code === "ENOENT"
      ? "no story.json in this folder" : `story.json is not valid JSON — ${(e as Error).message}`;
    return { dir, name, level: "broken", findings: [{ check: "unreadable", level: "broken",
      what: why, effect: "nothing can load it" }], loadWarnings: [], error: why, checkedAt };
  }

  const { sc, warnings, error } = await loadCapturing(dir, catalogs);
  if (!sc) {
    return { dir, name, level: "broken", findings: [{ check: "invalid", level: "broken",
      what: `story.json does not validate — ${error}`,
      effect: "the run refuses to start" }], loadWarnings: warnings, error, checkedAt };
  }

  // No cast-less check here on purpose: `loadStory` already refuses that story, in better words
  // than a second copy would find, and it arrives above as `invalid`.

  // -- degraded: a shipped check cannot see this story --------------------------------------
  const noPronouns = sc.characters.filter(c => !c.pronouns);
  if (noPronouns.length)
    findings.push({ check: "no-pronouns", level: "degraded",
      where: noPronouns.length === sc.characters.length ? undefined : noPronouns.map(c => c.name).join(", "),
      what: `${noPronouns.length} of ${sc.characters.length} characters declare no pronouns`,
      effect: "pronoun-lint skips them entirely; the quote lint cannot resolve a \"she said\" tag "
        + "to a speaker, and the reported-speech lint cannot resolve a pronoun subject" });

  for (const c of sc.characters) {
    const bare = c.limitMeanings.filter(l => !l.meaning.trim()).map(l => l.name);
    if (bare.length)
      findings.push({ check: "restriction-no-meaning", level: "degraded", where: c.name,
        what: `restriction${bare.length > 1 ? "s" : ""} ${bare.map(b => `"${b}"`).join(", ")} `
          + "carr" + (bare.length > 1 ? "y" : "ies") + " no \":: what its absence leaves\"",
        effect: "the prompt states the CANNOT with nothing about what it leaves them, "
          + "so the judge has no standard to read a refusal against" });
  }

  sc.scenes.forEach((s, i) => {
    const where = `scene ${i + 1}`;
    if (!s.question.trim())
      findings.push({ check: "no-question", level: "degraded", where,
        what: "the scene names no dramatic question",
        effect: "the done judge has nothing to resolve, so question_state can never leave \"open\" "
          + "and the writer alone decides when the scene ends" });
    if (s.pov.trim() && !sc.characters.some(c => c.name.toLowerCase() === s.pov.trim().toLowerCase()))
      findings.push({ check: "pov-not-cast", level: "degraded", where,
        what: `pov "${s.pov}" is not one of the characters`,
        effect: "the loader drops it, so the scene is written from no point of view" });
  });

  // -- dated: it works, it simply predates something -----------------------------------------
  for (const c of sc.characters)
    for (const w of characterPsychologyWarnings(c.name, c.belief, c.impulse, c.voice))
      findings.push({ check: "thin-psychology", level: "dated", where: c.name, what: w,
        effect: "the character prompt carries one fewer thing to be consistent with" });

  const authored = (k: string) => Array.isArray(raw?.[k]) && (raw[k] as unknown[]).length > 0;
  if (!authored("writerStyleConstraints"))
    findings.push({ check: "no-style-constraints", level: "dated",
      what: "no writerStyleConstraints",
      effect: "the story-derived half of the house style is empty — perception clauses read off "
        + "this cast and POV are exactly what a preset must not carry" });
  if (!authored("facts"))
    findings.push({ check: "no-facts", level: "dated",
      what: "no facts",
      effect: "the writer holds no world truths it may state without asking anyone" });
  if (!authored("timeline"))
    findings.push({ check: "no-timeline", level: "dated",
      what: "no world timeline",
      effect: "nothing in this story happens that no character decided" });

  const worst = findings.reduce<AuditLevel>(
    (acc, f) => (RANK.get(f.level)! < RANK.get(acc)! ? f.level : acc), "current");
  return { dir, name, level: worst, findings, loadWarnings: warnings, checkedAt };
}

/** Audit several stories, one at a time. Serial on purpose: every audit swaps the shared warning
 *  sink, and two overlapping loads would shuffle each other's warnings. */
export async function auditStories(dirs: readonly string[], catalogs?: Catalogs): Promise<StoryAudit[]> {
  const out: StoryAudit[] = [];
  for (const dir of dirs) out.push(await auditStory(dir, catalogs));
  return out;
}
