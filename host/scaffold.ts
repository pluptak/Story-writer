/**
 * HOST SCAFFOLD — the new-story interview: the open ScaffoldSession, its busy/abandon-generation
 * bookkeeping, the catalog lookups its rounds need, and the scaffold*() operations HOST exposes.
 * Private here; routes only call these through HOST.
 * Lifecycle contract: docs/GUI-SPEC.md ("Scaffold").
 */

import { sseWrite, setWhere } from "../live.ts";
import { bibleFrom, canonSkill } from "../engine/skills.ts";
import { sameName } from "../engine/config-util.ts";
import { directEdit, specView, storyJsonShape } from "../engine/story-spec.ts";
import {
  buildArchitect, ScaffoldSession,
  type ImportedCharacter, type StylePreset, type AutoStage,
  type ScaffoldRound, type ScaffoldAccept,
} from "../engine/architect.ts";
import { loadCatalog, saveEntry, skillBibleEntries, persistedCatalogs, generalSkillEntries } from "../engine/catalog.ts";
import type { LibraryCharacter } from "../engine/catalog-schema.ts";
import type { ScaffoldRoutesHost, Concept, RegenScope, ScaffoldState, ScaffoldActionResult, ScaffoldAcceptResult } from "../server/route-hosts.ts";
import { loadHostDefaults } from "./defaults.ts";

async function newScaffoldSession(idea: string, model = "",
                                  mode: "oneshot" | "staged" = "oneshot",
                                  concept?: Concept): Promise<ScaffoldSession> {
  const d = await loadHostDefaults(model);
  const entries = await skillBibleEntries();
  const generals = await generalSkillEntries();
  const session = new ScaffoldSession(await buildArchitect(d, true, entries, generals), d, idea, undefined, mode, undefined,
                             concept?.tags ?? [], concept?.castSize ?? 0);
  session.catalogs = { bible: bibleFrom(entries), generals };
  return session;
}

/** The tag catalog is the author's own file, so an unknown tag is news rather than an error: it is
 *  still passed to the architect, and reported so a typo does not quietly become a steering word.
 *  Matching is by trimmed lowercase label, the same key the catalog's own duplicate check uses. */
async function unknownTags(tags: string[]): Promise<string[]> {
  const cat = await loadCatalog("tags");
  const known = new Set<string>((cat?.entries ?? []).map((e: { label?: unknown }) =>
    String(e?.label ?? "").trim().toLowerCase()));
  return tags.filter(t => !known.has(t.trim().toLowerCase()));
}

/** Ids in, tray entries out, in the order the author chose them. Only the portable half travels:
 *  goal and knows are story-positional and the library does not carry them, and the cast gate is
 *  where they get resolved. */
/** Promotion writes through the same validated path the skill editor uses -- one way into the
 *  catalog, one set of rules. The id is derived from the canonical name so promoting the same skill
 *  twice is an update rather than a duplicate. */
async function promoteSkill(name: string, meaning: string) {
  const entry = { id: `skill-${canonSkill(name)}`, version: 1, name, meaning };
  const catalogs = await persistedCatalogs();
  const result = await saveEntry("skills", entry, undefined, catalogs);
  if (!result.ok) {
    return result;
  }
  return { ok: true as const, bible: bibleFrom(await skillBibleEntries()), problems: result.problems };
}

/** `path` is test-only injection, mirroring the same parameter on `loadCatalog`/`saveEntry` — the
 *  real scaffold flow never passes it, so it resolves to the author's own catalog file. */
export async function importCharacters(ids: string[], path?: string): Promise<{ imported: ImportedCharacter[]; missing: string[] }> {
  const cat = await loadCatalog("characters", path);
  const byId = new Map<string, LibraryCharacter>((cat?.entries ?? []).map((e: LibraryCharacter) => [e.id, e]));
  const imported: ImportedCharacter[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const e = byId.get(id);
    // A hidden character is treated exactly like one that no longer exists: it must never enter
    // a new story through this path, even if the id was chosen before it was hidden.
    if (!e || e.hidden) { missing.push(id); continue; }
    imported.push({
      libraryId: e.id, version: e.version, name: e.name, portablePersona: e.portablePersona,
      belief: e.belief, impulse: e.impulse,
      voice: [...e.voice], skills: [...e.skills], restrictions: [...e.restrictions],
      origin: e.origin,
    });
  }
  return { imported, missing };
}

/** Only the two halves the settings gate needs travel: the name, so a revert can say which preset
 *  stands, and the voice itself. The description and tags are the catalog's own furniture — they
 *  rank presets in the picker and never reach a prompt. */
async function resolveStyle(id: string): Promise<StylePreset | null> {
  const wanted = id.trim();
  if (!wanted) return null;
  const cat = await loadCatalog("styles");
  const found = (cat?.entries ?? []).find((e: { id?: unknown }) => String(e?.id ?? "") === wanted);
  return found ? { id: found.id, name: found.name, voice: found.voice } : null;
}

// Private to this module; routes only call these through HOST. Abandon may interrupt a round:
// every multi-step action captures `scaffoldGen` at entry and drops its result when stale.
let SCAFFOLD: ScaffoldSession | null = null;
let scaffoldBusy = false;
let scaffoldGen = 0;
let scaffoldLast: ScaffoldRound | null = null;
let scaffoldStage: "" | "fillGaps" | "verify" = "";
let scaffoldFolderAsk = "";                  // why accept() would not derive a folder name
let scaffoldUnknownTags: string[] = [];      // tags the catalog does not hold; allowed, but reported
let scaffoldMissingImports: string[] = [];   // ids the catalog no longer holds
let scaffoldMissingStyle = "";               // the style id that could not be resolved

const SCAFFOLD_ABANDONED = "the interview was abandoned";
const SCAFFOLD_ABANDONED_WHILE_ACCEPTING =
  "the interview was abandoned while accepting — the story folder may exist on disk";
const SCAFFOLD_BUSY = "a round is already in flight";
const SCAFFOLD_NOT_OPEN = "no interview is open";

export function scaffoldSnapshot(): ScaffoldState {
  if (!SCAFFOLD) return { active: false };
  const haveDraft = Boolean(
    SCAFFOLD.spec.title || SCAFFOLD.spec.premise || SCAFFOLD.spec.characters.length
    || SCAFFOLD.spec.writerStyle || SCAFFOLD.spec.facts.length
    || SCAFFOLD.spec.scenes.some(scene => scene.place || scene.question || scene.pov),
  );
  return {
    active: true,
    idea: SCAFFOLD.idea,
    mode: SCAFFOLD.mode,
    busy: scaffoldBusy,
    stage: scaffoldStage,
    gate: SCAFFOLD.stage,          // staged mode only: the checklist gate that is open
    tension: SCAFFOLD.tension,     // the load-bearing conflict the story stage coined; session state,
                                    // never a story.json field, so it reaches the GUI only through here
    concept: {
      tags: SCAFFOLD.tags,
      castSize: SCAFFOLD.castSize,
      unknownTags: scaffoldUnknownTags,
      imported: SCAFFOLD.imported.map(i => ({ libraryId: i.libraryId, version: i.version, name: i.name })),
      missingImports: scaffoldMissingImports,
      styleId: SCAFFOLD.style?.id ?? "",
      styleName: SCAFFOLD.style?.name ?? "",
      missingStyle: scaffoldMissingStyle,
      // A control that has stopped steering must not look live: each half is spent once its
      // gate has produced content (measured against the spec, not the open gate).
      tagsSteer: SCAFFOLD.mode !== "oneshot" && SCAFFOLD.stage === "story",
      // An imported tray IS the cast size, so the number steers nothing afterwards.
      castSizeSteers: SCAFFOLD.mode !== "oneshot" && !SCAFFOLD.imported.length && SCAFFOLD.spec.characters.length === 0,
      importsSteer: SCAFFOLD.mode !== "oneshot" && SCAFFOLD.spec.characters.length === 0,
      // Spent once the settings gate has produced a voice (or a preset stands in for one).
      styleSteers: SCAFFOLD.mode !== "oneshot" && !SCAFFOLD.spec.writerStyle.trim(),
    },
    haveDraft,
    haveStory: SCAFFOLD.haveStory(),
    pendingAsk: SCAFFOLD.pendingAsk,
    problems: SCAFFOLD.problems,
    // Derived from the spec each time rather than stored: a candidate stops being one the moment it
    // is promoted or the cast stops holding it, and a stored list would go stale in both directions.
    bibleCandidates: SCAFFOLD.bibleCandidates(),
    last: scaffoldLast,
    needsFolder: scaffoldFolderAsk,
    model: SCAFFOLD.defaults.models.architect,
    spec: haveDraft ? specView(SCAFFOLD.spec) : null,
    // StoryJson-shaped, unlike `spec` above (specView's GUI-facing shape) — this is what the
    // "review new story" editor loads directly, so the browser never reconciles one shape into
    // the other itself.
    storyDraft: haveDraft ? storyJsonShape(SCAFFOLD.spec, SCAFFOLD.defaults.models) : null,
  };
}

function publishScaffold(): void {
  sseWrite({ t: "scaffold", state: scaffoldSnapshot() });
}

/** Test-only seam for the scaffold's model/catalog dependencies: without it a test driving the
 *  real host would reach a real model or the author's real catalogs. Pass null to restore. */
let scaffoldTestHooks: {
  session?: typeof newScaffoldSession;
  tags?: typeof unknownTags;
  imports?: typeof importCharacters;
  style?: typeof resolveStyle;
  promote?: typeof promoteSkill;
} | null = null;

export function setScaffoldTestHooks(hooks: typeof scaffoldTestHooks): void {
  scaffoldTestHooks = hooks;
}

/** Resolve the author's style pick onto the session, and say so when the id names nothing. Returns
 *  the id it could not find, or "". Assigned unconditionally by every caller for the same reason the
 *  tray is: a pick that resolves must clear a previous session's report of one that did not. */
async function applyStyleTo(session: ScaffoldSession, styleId: string): Promise<string> {
  if (!styleId) { session.style = null; return ""; }
  const found = await (scaffoldTestHooks?.style ?? resolveStyle)(styleId);
  session.style = found;
  return found ? "" : styleId;
}

/** The stage callback every scaffold round hands its session: records the auto-pass stage
 *  and publishes, named once so the rounds cannot drift apart. */
function onScaffoldStage(stage: AutoStage): void {
  scaffoldStage = stage; publishScaffold();
}

/** The ok-tail every scaffold op answers with: publish, then hand back a full snapshot. */
function scaffoldOk(): ScaffoldActionResult {
  publishScaffold();
  return { ok: true, state: scaffoldSnapshot() };
}

/** One model round behind the scaffold lock. Start/accept keep bespoke flows; say/approve/
 *  regenerate share this one. A stale generation answers 409 and commits nothing. */
async function runScaffoldRound(
  run: (session: ScaffoldSession, onStage: (stage: AutoStage) => void) => Promise<ScaffoldRound>,
): Promise<ScaffoldActionResult> {
  if (scaffoldBusy) return { ok: false, reason: SCAFFOLD_BUSY, status: 409 };
  if (!SCAFFOLD) return { ok: false, reason: SCAFFOLD_NOT_OPEN, status: 400 };
  const gen = scaffoldGen;
  const session = SCAFFOLD;
  scaffoldBusy = true; scaffoldFolderAsk = ""; publishScaffold();
  try {
    const r = await run(session, onScaffoldStage);
    if (gen === scaffoldGen) scaffoldLast = r;
  } catch (e) {
    if (gen === scaffoldGen) scaffoldLast = { kind: "failed", error: (e as Error).message };
  } finally { scaffoldBusy = false; scaffoldStage = ""; }
  if (gen !== scaffoldGen) return { ok: false, reason: SCAFFOLD_ABANDONED, status: 409 };
  return scaffoldOk();
}

export const scaffoldStart: ScaffoldRoutesHost["scaffoldStart"] = async (input) => {
  if (scaffoldBusy) return { ok: false, reason: SCAFFOLD_BUSY, status: 409 };
  const gen = scaffoldGen;
  scaffoldBusy = true; scaffoldLast = null; scaffoldFolderAsk = "";
  try {
    const session = await (scaffoldTestHooks?.session ?? newScaffoldSession)(input.idea, input.model, input.mode, input.concept);
    // Abandoned while the session was being built: it must not resurrect itself.
    if (gen !== scaffoldGen) return { ok: false, reason: SCAFFOLD_ABANDONED, status: 409 };
    SCAFFOLD = session;
    scaffoldUnknownTags = input.concept.tags.length ? await (scaffoldTestHooks?.tags ?? unknownTags)(input.concept.tags) : [];
    if (gen !== scaffoldGen) return { ok: false, reason: SCAFFOLD_ABANDONED, status: 409 };
    // Assigned whether or not there are ids: a start that imports nothing must clear what the
    // last session could not find, or the new interview reports a loss it never had.
    const resolved = input.importIds.length
      ? await (scaffoldTestHooks?.imports ?? importCharacters)(input.importIds) : { imported: [], missing: [] };
    if (gen !== scaffoldGen) return { ok: false, reason: SCAFFOLD_ABANDONED, status: 409 };
    SCAFFOLD.imported = resolved.imported;
    scaffoldMissingImports = resolved.missing;
    scaffoldMissingStyle = await applyStyleTo(SCAFFOLD, input.concept.styleId);
    if (gen !== scaffoldGen) return { ok: false, reason: SCAFFOLD_ABANDONED, status: 409 };
    setWhere("building a new story", false);
    publishScaffold();
    const last = await SCAFFOLD.propose(onScaffoldStage);
    if (gen !== scaffoldGen) return { ok: false, reason: SCAFFOLD_ABANDONED, status: 409 };
    scaffoldLast = last;
  } catch (e) {
    scaffoldLast = { kind: "failed", error: (e as Error).message };
  } finally { scaffoldBusy = false; scaffoldStage = ""; }
  return scaffoldOk();
};

export const scaffoldSay: ScaffoldRoutesHost["scaffoldSay"] = async (text) => {
  return runScaffoldRound((s, onStage) => s.say(text, onStage));
};

export const scaffoldApprove: ScaffoldRoutesHost["scaffoldApprove"] = async (override) => {
  return runScaffoldRound((s, onStage) => s.approve(onStage, override));
};

export const scaffoldRegenerate: ScaffoldRoutesHost["scaffoldRegenerate"] = async (scope) => {
  if (scaffoldBusy) return { ok: false, reason: SCAFFOLD_BUSY, status: 409 };
  if (!SCAFFOLD) return { ok: false, reason: SCAFFOLD_NOT_OPEN, status: 400 };
  // Refuse before taking the lock: a scoped re-run for a stranger would spend a model round
  // to discover nobody to reconsider.
  if (scope && !SCAFFOLD.spec.characters.some(c => sameName(c.name, scope.name)))
    return { ok: false, reason: `there is no cast member named "${scope.name}"`, status: 400 };
  return runScaffoldRound((s, onStage) => scope
    ? s.rerunScoped(scope, onStage)
    : s.rerun(onStage));
};

export const scaffoldConcept: ScaffoldRoutesHost["scaffoldConcept"] = async (concept) => {
  if (scaffoldBusy) return { ok: false, reason: SCAFFOLD_BUSY, status: 409 };
  if (!SCAFFOLD) return { ok: false, reason: SCAFFOLD_NOT_OPEN, status: 400 };
  // Never re-runs a gate: it changes what the NEXT stage-prompt build says. `tagsSteer` et al.
  // tell the author whether any gate is left for it to steer.
  SCAFFOLD.tags = concept.tags;
  SCAFFOLD.castSize = concept.castSize;
  scaffoldUnknownTags = concept.tags.length ? await (scaffoldTestHooks?.tags ?? unknownTags)(concept.tags) : [];
  scaffoldMissingStyle = await applyStyleTo(SCAFFOLD, concept.styleId);
  return scaffoldOk();
};

export const scaffoldImport: ScaffoldRoutesHost["scaffoldImport"] = async (ids) => {
  if (scaffoldBusy) return { ok: false, reason: SCAFFOLD_BUSY, status: 409 };
  if (!SCAFFOLD) return { ok: false, reason: SCAFFOLD_NOT_OPEN, status: 400 };
  // Replaces the tray wholesale rather than adding to it: the author's pick is a set, and a
  // partial update would need a second answer for "what does absence mean".
  const resolved = await (scaffoldTestHooks?.imports ?? importCharacters)(ids);
  SCAFFOLD.imported = resolved.imported;
  scaffoldMissingImports = resolved.missing;
  return scaffoldOk();
};

export const scaffoldPromote: ScaffoldRoutesHost["scaffoldPromote"] = async (name) => {
  if (scaffoldBusy) return { ok: false, reason: SCAFFOLD_BUSY, status: 409 };
  if (!SCAFFOLD) return { ok: false, reason: SCAFFOLD_NOT_OPEN, status: 400 };
  // The owner's approval, and a gate distinct from accepting the story: a skill lands in the
  // bible here or not at all, and accepting a story never writes one.
  const found = SCAFFOLD.bibleCandidates().find(c => c.name === name);
  if (!found) return { ok: false, reason: `"${name}" is not a promotion candidate`, status: 400 };
  const r = await (scaffoldTestHooks?.promote ?? promoteSkill)(found.name, found.meaning);
  if (!r.ok) return { ok: false, reason: r.reason ?? "", status: 400, issues: r.issues };
  SCAFFOLD.catalogs = { ...SCAFFOLD.catalogs, bible: r.bible };
  return scaffoldOk();
};

export const scaffoldSet: ScaffoldRoutesHost["scaffoldSet"] = (input) => {
  if (scaffoldBusy) return { ok: false, reason: SCAFFOLD_BUSY, status: 409 };
  if (!SCAFFOLD) return { ok: false, reason: SCAFFOLD_NOT_OPEN, status: 400 };
  if (!SCAFFOLD.haveStory()) return { ok: false, reason: "there is no story to change yet", status: 400 };
  if (input.story && typeof input.story === "object") {
    const r = SCAFFOLD.setSpec(input.story);
    // "role" is Block C's structured goal/knows edit: same whole-draft path as a revert, so it
    // keeps regenerate enabled — unlike the story editor's free-form note, which disables it.
    const note = input.source === "revert" ? "reverted a round"
      : input.source === "role" ? "updated a character's role" : "updated from the story editor";
    scaffoldLast = { kind: "edits", applied: r.applied, ignored: [], flags: [], note };
    return scaffoldOk();
  }
  const r = directEdit(SCAFFOLD.spec, String(input.field ?? ""), input.value);
  if (!r.ok) return { ok: false, reason: r.reason, status: 400 };
  SCAFFOLD.spec = r.spec; SCAFFOLD.problems = r.problems;
  scaffoldLast = { kind: "edits", applied: r.applied, ignored: [], flags: [], note: "" };
  return scaffoldOk();
};

export const scaffoldAccept: ScaffoldRoutesHost["scaffoldAccept"] = async (folder) => {
  if (scaffoldBusy) return { ok: false, reason: SCAFFOLD_BUSY, status: 409 };
  if (!SCAFFOLD) return { ok: false, reason: SCAFFOLD_NOT_OPEN, status: 400 };
  const gen = scaffoldGen;
  const session = SCAFFOLD;
  scaffoldBusy = true; publishScaffold();
  let r: ScaffoldAccept;
  try { r = await session.accept(folder); }
  catch (e) {
    scaffoldBusy = false; publishScaffold();
    return { ok: false, reason: (e as Error).message, status: 500 };
  }
  scaffoldBusy = false;
  if (gen !== scaffoldGen) {
    // Abandoned while the write was in flight. The story folder may exist on disk either way,
    // but nothing is resolved and no run starts.
    publishScaffold();
    return { ok: false, reason: SCAFFOLD_ABANDONED_WHILE_ACCEPTING, status: 409 };
  }
  if (r.kind !== "written") {
    scaffoldFolderAsk = r.kind === "needs_folder" ? r.reason : "";
    publishScaffold();
    if (r.kind === "needs_folder") return { ok: false, kind: "needs_folder", reason: r.reason, status: 200 };
    if (r.kind === "unloadable")
      return { ok: false, kind: "unloadable", dir: r.dir, files: r.files, error: r.error, warnings: r.warnings, status: 200 };
    return { ok: false, kind: "no_story", status: 400 };
  }
  SCAFFOLD = null; scaffoldLast = null; scaffoldFolderAsk = "";
  publishScaffold();
  return { ok: true, kind: "written", dir: r.dir, files: r.files, warnings: r.warnings, status: 200 };
};

export const scaffoldAbandon: ScaffoldRoutesHost["scaffoldAbandon"] = () => {
  // The lock stays with an in-flight round: its own finally clears it, and the round drops
  // its result on a stale `scaffoldGen`.
  SCAFFOLD = null; scaffoldLast = null; scaffoldFolderAsk = "";
  scaffoldUnknownTags = []; scaffoldMissingImports = []; scaffoldMissingStyle = "";
  scaffoldGen++;
  publishScaffold();
};

/** Test-only reset for the scaffold's module state (cf. live.ts resetLive()). */
export function resetScaffoldForTests(): void {
  SCAFFOLD = null; scaffoldBusy = false; scaffoldGen++;
  scaffoldLast = null; scaffoldStage = ""; scaffoldFolderAsk = "";
  scaffoldUnknownTags = []; scaffoldMissingImports = []; scaffoldMissingStyle = "";
}
