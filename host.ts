/** HOST — the object handed to server/server.ts, plus everything only it needs: the story.json
 *  read/persist helpers and the scaffold and handoff domains. Built here so server/ never imports
 *  engine/ — routes receive behaviour through narrow interfaces (server/route-hosts.ts). */
import { writeFile, readFile, rename } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { LIVE, storyWriteBlocked, sseWrite, setWhere } from "./live.ts";
import { ENGINE } from "./engine/engine-state.ts";
import { splitMeaning, bibleFrom, canonSkill, SKILL_CATALOG, type Catalogs } from "./engine/skills.ts";
import { sameName } from "./engine/config-util.ts";
import { NET } from "./engine/llm-client.ts";
import { PROVIDER } from "./engine/provider.ts";
import { resolveStoryDir, loadStory, loadDefaults, writtenChapters, selectableStory, type Defaults } from "./engine/story-format.ts";
import { directEdit, specView, storyJsonShape, characterPsychologyWarnings, timelineBeatProblems, timelineOrderProblems, timelineMemoryWarnings, type StorySpec } from "./engine/story-spec.ts";
import { StoryJson, THINK_LEVELS, VOICE_SAMPLE_CAP } from "./engine/story-schema.ts";
import { runDirs, availableModelIds, storyCards, runLlmLogs, readLlmLog } from "./engine/preflight.ts";
import {
  buildArchitect, ScaffoldSession, openNextChapter, suggestEdits as statelessSuggest,
  type NextChapterSession, type ImportedCharacter, type StylePreset, type AutoStage,
  type ScaffoldRound, type ScaffoldAccept, type HandoffAccept,
} from "./engine/architect.ts";
import { loadCatalog, checkEntry, saveEntry, deleteEntry, setVisibility, skillBible, skillBibleEntries, skillOrigins, originSkillGroups, persistedCatalogs, generalSkillEntries } from "./engine/catalog.ts";
import { CATALOG_KINDS, TAG_FACETS, type CatalogKind, type LibraryCharacter } from "./engine/catalog-schema.ts";
import { assistCharacter, ASSIST_FIELDS, type AssistField, type AssistMode } from "./engine/catalog-assist.ts";
import type {
  RouteHosts, Concept, RegenScope, CatalogUsage, EditorConfig, CatalogConfig,
  ScaffoldState, ScaffoldActionResult, ScaffoldAcceptResult,
  HandoffState, HandoffActionResult, HandoffAcceptResult,
} from "./server/route-hosts.ts";

/** The --model override for this process, set once by the composition root (story-writer.ts)
 *  from the parsed CLI options. host.ts never reads process.argv itself. */
let modelOverride: string | undefined;
export function setHostModelOverride(model?: string): void {
  modelOverride = model;
}
function hostModel(): string {
  return modelOverride ?? "";
}

/** The defaults.json knobs every stateless or session-opening author-side call runs under — the
 *  architect's (scaffold, handoff, suggest) and the catalog assistant's alike — never any one
 *  story's. */
async function loadHostDefaults(model = ""): Promise<Defaults> {
  const d = await loadDefaults(model || hostModel() || "");
  ENGINE.stream = d.stream; ENGINE.debug = d.debug;
  NET.timeoutMs = d.requestTimeout * 1000;
  NET.retries = d.attempts - 1;
  ENGINE.maxTokens = d.maxTokens;
  return d;
}

/** Apply the defaults' knobs for the length of `fn`, then restore the engine knobs it touched.
 *  Keeps a stateless call (a suggestion, a catalog-assist proposal) from leaving its token
 *  cap/timeouts behind — unlike a scaffold or handoff session, which owns the console until it
 *  hands off to a run that re-applies the story's own config. `architectModel` is pure for the same
 *  reason; so is this. */
async function withHostDefaults<T>(model: string, fn: (d: Defaults) => Promise<T>): Promise<T> {
  const saved = { stream: ENGINE.stream, debug: ENGINE.debug, maxTokens: ENGINE.maxTokens,
                  timeoutMs: NET.timeoutMs, retries: NET.retries };
  try {
    return await fn(await loadHostDefaults(model));
  } finally {
    ENGINE.stream = saved.stream; ENGINE.debug = saved.debug; ENGINE.maxTokens = saved.maxTokens;
    NET.timeoutMs = saved.timeoutMs; NET.retries = saved.retries;
  }
}

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

// -- SCAFFOLD (the new-story interview) --------------------------------------------------------
// Private to this module; routes only call HOST.scaffold*(). Abandon may interrupt a round:
// every multi-step action captures `scaffoldGen` at entry and drops its result when stale.
// Lifecycle contract: docs/GUI-SPEC.md ("Scaffold").
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

export async function scaffoldStart(input: {
  idea: string; model: string; mode: "oneshot" | "staged"; concept: Concept; importIds: string[];
}): Promise<ScaffoldActionResult> {
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
}

export async function scaffoldSay(text: string): Promise<ScaffoldActionResult> {
  return runScaffoldRound((s, onStage) => s.say(text, onStage));
}

export async function scaffoldApprove(override: boolean): Promise<ScaffoldActionResult> {
  return runScaffoldRound((s, onStage) => s.approve(onStage, override));
}

export async function scaffoldRegenerate(scope?: RegenScope): Promise<ScaffoldActionResult> {
  if (scaffoldBusy) return { ok: false, reason: SCAFFOLD_BUSY, status: 409 };
  if (!SCAFFOLD) return { ok: false, reason: SCAFFOLD_NOT_OPEN, status: 400 };
  // Refuse before taking the lock: a scoped re-run for a stranger would spend a model round
  // to discover nobody to reconsider.
  if (scope && !SCAFFOLD.spec.characters.some(c => sameName(c.name, scope.name)))
    return { ok: false, reason: `there is no cast member named "${scope.name}"`, status: 400 };
  return runScaffoldRound((s, onStage) => scope
    ? s.rerunScoped(scope, onStage)
    : s.rerun(onStage));
}

export async function scaffoldConcept(concept: Concept): Promise<ScaffoldActionResult> {
  if (scaffoldBusy) return { ok: false, reason: SCAFFOLD_BUSY, status: 409 };
  if (!SCAFFOLD) return { ok: false, reason: SCAFFOLD_NOT_OPEN, status: 400 };
  // Never re-runs a gate: it changes what the NEXT stage-prompt build says. `tagsSteer` et al.
  // tell the author whether any gate is left for it to steer.
  SCAFFOLD.tags = concept.tags;
  SCAFFOLD.castSize = concept.castSize;
  scaffoldUnknownTags = concept.tags.length ? await (scaffoldTestHooks?.tags ?? unknownTags)(concept.tags) : [];
  scaffoldMissingStyle = await applyStyleTo(SCAFFOLD, concept.styleId);
  return scaffoldOk();
}

export async function scaffoldImport(ids: string[]): Promise<ScaffoldActionResult> {
  if (scaffoldBusy) return { ok: false, reason: SCAFFOLD_BUSY, status: 409 };
  if (!SCAFFOLD) return { ok: false, reason: SCAFFOLD_NOT_OPEN, status: 400 };
  // Replaces the tray wholesale rather than adding to it: the author's pick is a set, and a
  // partial update would need a second answer for "what does absence mean".
  const resolved = await (scaffoldTestHooks?.imports ?? importCharacters)(ids);
  SCAFFOLD.imported = resolved.imported;
  scaffoldMissingImports = resolved.missing;
  return scaffoldOk();
}

export async function scaffoldPromote(name: string): Promise<ScaffoldActionResult> {
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
}

export function scaffoldSet(input: { story?: unknown; field?: string; value?: unknown; source?: string }): ScaffoldActionResult {
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
}

export async function scaffoldAccept(folder: string): Promise<ScaffoldAcceptResult> {
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
}

export function scaffoldAbandon(): void {
  // The lock stays with an in-flight round: its own finally clears it, and the round drops
  // its result on a stale `scaffoldGen`.
  SCAFFOLD = null; scaffoldLast = null; scaffoldFolderAsk = "";
  scaffoldUnknownTags = []; scaffoldMissingImports = []; scaffoldMissingStyle = "";
  scaffoldGen++;
  publishScaffold();
}

/** Test-only reset for the scaffold's module state (cf. live.ts resetLive()). */
export function resetScaffoldForTests(): void {
  SCAFFOLD = null; scaffoldBusy = false; scaffoldGen++;
  scaffoldLast = null; scaffoldStage = ""; scaffoldFolderAsk = "";
  scaffoldUnknownTags = []; scaffoldMissingImports = []; scaffoldMissingStyle = "";
}

async function newHandoffSession(dir: string, model = ""): Promise<NextChapterSession> {
  const entries = await skillBibleEntries();
  return openNextChapter(await loadHostDefaults(model), dir, entries, await generalSkillEntries());
}

// -- HANDOFF (the between-chapters interview) --------------------------------------------------
// Mirrors SCAFFOLD above. LIVE.storyLock is tied 1:1 to HANDOFF's lifecycle, so it lives here.
// Lifecycle contract: docs/GUI-SPEC.md ("The handoff").
let HANDOFF: NextChapterSession | null = null;
let handoffBusy = false;
let handoffGen = 0;
let handoffLast: ScaffoldRound | null = null;
let handoffStage: "" | "fillGaps" | "verify" = "";

const HANDOFF_ABANDONED = "the handoff was abandoned";
const HANDOFF_ABANDONED_WHILE_ACCEPTING =
  "the handoff was abandoned while accepting — story.json may have been rewritten";

function handoffSnapshot(): HandoffState {
  if (!HANDOFF) return { active: false };
  return {
    active: true,
    dir: HANDOFF.dir,
    chapter: HANDOFF.chapter,
    busy: handoffBusy,
    stage: handoffStage,
    edited: HANDOFF.edited,
    pendingAsk: HANDOFF.pendingAsk,
    problems: HANDOFF.problems,
    last: handoffLast,
    model: HANDOFF.defaults.models.architect,
    spec: specView(HANDOFF.spec),
  };
}

function publishHandoffState(): void {
  sseWrite({ t: "handoff", state: handoffSnapshot() });
}

/** The exit for a round abandoned mid-flight. Always releases the story-write lock, which
 *  `handoffAbandon()` leaves in place while a round (e.g. a mid-write accept) still needs it. */
function handoffAbandonedResult(reason: string): { ok: false; reason: string; status: 409 } {
  LIVE.storyLock = null;
  publishHandoffState();
  return { ok: false, reason, status: 409 };
}

/** Test-only seam for handoffStart's model/story-file dependencies (cf. scaffoldTestHooks). */
let handoffTestHooks: { session?: typeof newHandoffSession } | null = null;
export function setHandoffTestHooks(hooks: typeof handoffTestHooks): void {
  handoffTestHooks = hooks;
}

export function handoffState(): HandoffState { return handoffSnapshot(); }

/** The stage callback every handoff round hands its session. */
function onHandoffStage(stage: AutoStage): void {
  handoffStage = stage; publishHandoffState();
}

/** The ok-tail every handoff op answers with: publish, then hand back a full snapshot. */
function handoffOk(): HandoffActionResult {
  publishHandoffState();
  return { ok: true, state: handoffSnapshot() };
}

/** One model round behind the handoff lock. Start/accept keep bespoke flows; say/regenerate
 *  share this one — except say leaves the auto-pass stage marker alone (resetStage: false). */
async function runHandoffRound(
  resetStage: boolean,
  run: (session: NextChapterSession) => Promise<ScaffoldRound>,
): Promise<HandoffActionResult> {
  if (handoffBusy) return { ok: false, reason: "a round is already in flight", status: 409 };
  const blocked = storyWriteBlocked(LIVE.storyLock);
  if (blocked) return { ok: false, reason: blocked, status: 409 };
  if (!HANDOFF) return { ok: false, reason: "no handoff is open", status: 400 };
  const gen = handoffGen;
  const session = HANDOFF;
  handoffBusy = true; publishHandoffState();
  try {
    const r = await run(session);
    if (gen === handoffGen) handoffLast = r;
  } catch (e) {
    if (gen === handoffGen) handoffLast = { kind: "failed", error: (e as Error).message };
  } finally { handoffBusy = false; if (resetStage) handoffStage = ""; }
  if (gen !== handoffGen) return handoffAbandonedResult(HANDOFF_ABANDONED);
  return handoffOk();
}

export async function handoffStart(dir: string, model: string): Promise<HandoffActionResult> {
  if (handoffBusy) return { ok: false, reason: "a round is already in flight", status: 409 };
  const blocked = storyWriteBlocked();
  if (blocked) return { ok: false, reason: blocked, status: 409 };
  const gen = handoffGen;
  handoffBusy = true; handoffLast = null;
  LIVE.storyLock = `a chapter handoff is open for ${dir}`;
  // The lock is taken before the session build (which awaits) so no second handoff or editor
  // save can interleave before the session holds its snapshot.
  try {
    const session = await (handoffTestHooks?.session ?? newHandoffSession)(dir, model);
    // Abandoned while the session was being built: it must not resurrect itself.
    if (gen !== handoffGen) return handoffAbandonedResult(HANDOFF_ABANDONED);
    HANDOFF = session;
    setWhere(`preparing chapter ${HANDOFF.chapter} of ${dir}`, false);
    publishHandoffState();
    const last = await HANDOFF.propose(onHandoffStage);
    if (gen !== handoffGen) return handoffAbandonedResult(HANDOFF_ABANDONED);
    handoffLast = last;
  } catch (e) {
    HANDOFF = null;
    LIVE.storyLock = null;
    handoffBusy = false; handoffStage = "";
    publishHandoffState();
    return { ok: false, reason: (e as Error).message, status: 400 };
  } finally { handoffBusy = false; handoffStage = ""; }
  return handoffOk();
}

export async function handoffSay(text: string): Promise<HandoffActionResult> {
  // resetStage: false — say refines within the open round, so unlike regenerate it leaves the
  // auto-pass stage marker alone.
  return runHandoffRound(false, s => s.say(text));
}

export async function handoffRegenerate(): Promise<HandoffActionResult> {
  return runHandoffRound(true, s => s.propose(onHandoffStage));
}

export async function handoffAccept(): Promise<HandoffAcceptResult> {
  if (handoffBusy) return { ok: false, reason: "a round is already in flight", status: 409 };
  const blocked = storyWriteBlocked(LIVE.storyLock);
  if (blocked) return { ok: false, reason: blocked, status: 409 };
  if (!HANDOFF) return { ok: false, reason: "no handoff is open", status: 400 };
  const gen = handoffGen;
  const session = HANDOFF;
  handoffBusy = true; publishHandoffState();
  let r: HandoffAccept;
  try { r = await session.accept(); }
  catch (e) {
    handoffBusy = false;
    // A throwing accept that was also abandoned owns the lock abandon left behind.
    if (gen !== handoffGen) LIVE.storyLock = null;
    publishHandoffState();
    return { ok: false, reason: (e as Error).message, status: 500 };
  }
  handoffBusy = false;
  // Abandoned while the write was in flight. story.json may or may not have been rewritten, but
  // this call commits nothing further -- not even its success -- and releases the story lock
  // abandon held open for the duration of that write.
  if (gen !== handoffGen) return handoffAbandonedResult(HANDOFF_ABANDONED_WHILE_ACCEPTING);
  if (r.kind !== "written") {
    publishHandoffState();
    return r.kind === "nothing"
      ? { ok: false, kind: "nothing", status: 400 }
      : { ok: false, kind: "unloadable", dir: r.dir, error: r.error, status: 200 };
  }
  const chapter = session.chapter;
  HANDOFF = null; handoffLast = null; LIVE.storyLock = null;
  setWhere("idle", false);
  publishHandoffState();
  return { ok: true, kind: "written", chapter, dir: r.dir, files: r.files, warnings: r.warnings, status: 200 };
}

export function handoffAbandon(): void {
  // Locks go the same way as the scaffold's: an in-flight round keeps them and releases them
  // itself via handoffAbandonedResult() — a mid-write accept still needs its guard.
  HANDOFF = null; handoffLast = null;
  if (!handoffBusy) LIVE.storyLock = null;
  handoffGen++;
  publishHandoffState();
}

/** Test-only reset for the handoff's private module state, mirroring resetScaffoldForTests(). */
export function resetHandoffForTests(): void {
  HANDOFF = null; handoffBusy = false; handoffGen++;
  handoffLast = null; handoffStage = ""; LIVE.storyLock = null;
}

/** Read and Zod-parse a story's story.json. Shared by storyForEdit and fullCast so there is exactly
 *  one place that reads the file. On parse failure returns the raw object for the editor to show. */
async function loadStoryJson(dir: string): Promise<
  { ok: true; story: StoryJson } | { ok: false; error: string; raw?: object }
> {
  const base = resolveStoryDir(dir);
  const storyPath = joinPath(base, "story.json");
  let raw: unknown;
  try { raw = JSON.parse(await readFile(storyPath, "utf8")); }
  catch (e) { return { ok: false, error: `could not read story.json: ${(e as Error).message}` }; }
  const result = StoryJson.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      error: result.error.issues.map(i => `${i.path.join(".") || "story"}: ${i.message}`).join("\n"),
      raw: raw as object,
    };
  }
  return { ok: true, story: result.data };
}

/** Write a validated story.json atomically (write .tmp, rename over) and confirm it still loads.
 *  Shared by saveStory (a full form save) and discardScene (dropping one scene) so there is exactly
 *  one place that commits story.json to disk. */
async function persistStoryJson(dir: string, parsed: StoryJson): Promise<{ ok: true } | { ok: false; reason: string }> {
  const base = resolveStoryDir(dir);
  const storyPath = joinPath(base, "story.json");
  const tmpPath = storyPath + ".tmp";
  const content = JSON.stringify(parsed, null, 2) + "\n";
  try {
    await writeFile(tmpPath, content, "utf8");
    await rename(tmpPath, storyPath);
  } catch (e) {
    return { ok: false, reason: `write failed: ${(e as Error).message}` };
  }
  // Re-load to confirm (catches silently-corrupt writes on constrained filesystems), under the same
  // catalogs a run would use — a story that saves clean should load clean where it will be written.
  try { await loadStory(dir, undefined, await persistedCatalogs()); }
  catch (e) { return { ok: false, reason: `saved but does not load: ${(e as Error).message}` }; }
  return { ok: true };
}

/** The psychology fields are REQUIRED on every character: surfaced as editor/check warnings so an
 *  old or hand-edited story is told what its cards are missing. Shares its wording with normalizeSpec. */
const characterCardWarnings = (parsed: StoryJson): string[] =>
  parsed.characters.flatMap(c => characterPsychologyWarnings(c.name, c.belief, c.impulse, c.voice));

/** The two problems that are advisory warnings on load and check but a refused save, named once so
 *  every surface words them identically. */
const EMPTY_PREMISE = "Premise is empty — there is nothing to write.";
const NO_CHARACTERS = "No characters defined — the writer would have nobody to consult.";

/** The engine's advisory warnings about a parsed story. The editor's load view, the in-memory
 *  checker and the save confirmation all return this same list, worded identically. */
const storyWarnings = (parsed: StoryJson): string[] => [
  ...(!parsed.premise.trim() ? [EMPTY_PREMISE] : []),
  ...(!parsed.characters.length ? [NO_CHARACTERS] : []),
  ...parsed.scenes.flatMap((s, i) => [
    ...(!s.question ? [`Scene ${i + 1} has no question — the writer decides alone when the scene is done`] : []),
    // The same case-insensitive orphan test loadStory applies (wording shared with it): sceneReach
    // resolves the grant key case-insensitively, so only a key matching NO character is dead.
    ...Object.keys(s.reach ?? {})
      .filter(who => !parsed.characters.some(c => sameName(c.name, who)))
      .map(who => `Scene ${i + 1} grants reach to "${who}", who is not one of the characters — ignored`),
    // Constraint is reach's negative twin and gets the same orphan check.
    ...Object.keys(s.constraint ?? {})
      .filter(who => !parsed.characters.some(c => sameName(c.name, who)))
      .map(who => `Scene ${i + 1} sets a constraint for "${who}", who is not one of the characters — ignored`),
  ]),
  ...parsed.timeline.flatMap((beat, i) =>
    timelineBeatProblems(`timeline beat ${i + 1}`, beat, parsed.characters.map(c => c.name), parsed.scenes)),
  ...timelineOrderProblems(parsed.timeline),
  ...timelineMemoryWarnings(parsed),
  ...characterCardWarnings(parsed),
];

/** Validate a catalog kind that arrived from the wire — returns the validated kind or null. */
const validateCatalogKind = (kind: string): CatalogKind | null =>
  CATALOG_KINDS.includes(kind as CatalogKind) ? (kind as CatalogKind) : null;

export const HOST: RouteHosts = {
  // -- SessionRoutesHost (/stories, /select, /models), incl. the shared StorySelection --
  selectableStory, resolveStoryDir,
  availableModelIds,
  providerName: PROVIDER.displayName,
  // The shelf's cards resolve capabilities against the author's own catalogs, so a card and the run it
  // starts report the same skills.
  storyCards: async () => storyCards(await persistedCatalogs()),
  architectModel: async () => (await loadDefaults(hostModel() ?? "")).models.architect,
  // -- RunLogHost (/runs/*, /log.jsonl) --
  runDirs, runLlmLogs, readLlmLog,
  outDir: () => ENGINE.outDir,
  // -- StoryReadHost (/cast, /chapter) — fullCast's body sits with the editor's below --
  writtenChapters,
  // -- ScaffoldRoutesHost (/scaffold/*) --
  scaffoldState: scaffoldSnapshot,
  scaffoldStart, scaffoldSay, scaffoldApprove, scaffoldRegenerate, scaffoldConcept, scaffoldImport, scaffoldPromote,
  scaffoldSet, scaffoldAccept, scaffoldAbandon,
  // -- HandoffRoutesHost (/next-chapter/*) --
  handoffState, handoffStart, handoffSay, handoffRegenerate, handoffAccept, handoffAbandon,
  // -- StoryEditHost (/story/*) --
  editorConfig: (): EditorConfig => {
    const d = StoryJson.parse({});
    return {
      defaults: {
        retries: d.config.retries, clarifications: d.config.clarifications, maxSteps: d.config.maxSteps,
        maxProseWords: d.config.maxProseWords, requestTimeout: d.config.requestTimeout,
        attempts: d.config.attempts, maxTokens: d.config.maxTokens,
        stream: d.config.stream, debug: d.config.debug, thinking: d.config.thinking,
        sceneLength: d.scenes[0].length,
      },
      thinkingLevels: THINK_LEVELS,
      caps: { voiceSamples: VOICE_SAMPLE_CAP },
    };
  },
  storyForEdit: async (dir) => {
    const loaded = await loadStoryJson(dir);
    if (!loaded.ok) return { ok: false, error: loaded.error, raw: loaded.raw };
    return { ok: true, story: loaded.story, warnings: storyWarnings(loaded.story) };
  },
  // -- StoryReadHost (/cast body; the rest of the interface is grouped above) --
  fullCast: async (dir) => {
    const loaded = await loadStoryJson(dir);
    if (!loaded.ok) return { ok: false, error: loaded.error };
    return {
      ok: true,
      characters: loaded.story.characters.map(c => ({
        name: c.name, persona: c.persona, knows: c.knows, goal: c.goal,
        belief: c.belief, impulse: c.impulse, voice: c.voice, origin: c.origin,
        skills: c.skills.map(s => splitMeaning(s)),
        restrictions: c.restrictions,
        pronouns: c.pronouns,
      })),
      // Reach, presence and constraint stay per scene and never merge into a character's skills or
      // any other character-level field (I4): the GUI labels each with the scene it comes from so
      // none of them can ever read as intrinsic. A missing presence or constraint entry means
      // "unaffected", the unmarked default, and travels as absence — never as a value.
      scenes: loaded.story.scenes.map((s, i) => ({ n: i + 1, reach: s.reach ?? {}, presence: s.presence ?? {}, constraint: s.constraint ?? {} })),
    };
  },
  checkStory: (story) => {
    const result = StoryJson.safeParse(story);
    if (!result.success) {
      return {
        ok: false, error: "validation failed",
        issues: result.error.issues.map(i => ({ path: i.path.join(".") || "story", message: i.message })),
      };
    }
    return { ok: true, warnings: storyWarnings(result.data) };
  },
  saveStory: async (dir, story) => {
    // Validate first
    const check = StoryJson.safeParse(story);
    if (!check.success) {
      return { ok: false, reason: "validation failed" };
    }
    const parsed = check.data;
    if (!parsed.premise.trim()) return { ok: false, reason: EMPTY_PREMISE };
    if (!parsed.characters.length) return { ok: false, reason: NO_CHARACTERS };

    // Guard: nothing else may be reading or writing this story (route already checked; double-check)
    const blocked = storyWriteBlocked();
    if (blocked) return { ok: false, reason: blocked, status: 409 };

    const w = await persistStoryJson(dir, parsed);
    if (!w.ok) return { ok: false, reason: w.reason };

    return { ok: true, warnings: storyWarnings(parsed) };
  },
  discardScene: async (dir, n) => {
    const blocked = storyWriteBlocked();
    if (blocked) return { ok: false, reason: blocked, status: 409 };
    const loaded = await loadStoryJson(dir);
    if (!loaded.ok) return { ok: false, reason: `story.json does not load: ${loaded.error}` };
    const parsed = loaded.story;
    // Only the last authored scene, and only while unwritten: a written chapter's scene defines its
    // prose, and removing a middle scene would renumber the chapters after it. `scenes.min(1)` in the
    // schema means the sole scene can never go.
    if (parsed.scenes.length <= 1) return { ok: false, reason: "a story must keep at least one scene" };
    if (n !== parsed.scenes.length) return { ok: false, reason: `only chapter ${parsed.scenes.length} (the last authored scene) can be discarded` };
    if ((await writtenChapters(dir)).includes(n)) return { ok: false, reason: `chapter ${n} is already written — discarding it would orphan the prose` };

    parsed.scenes = parsed.scenes.slice(0, -1);
    const w = await persistStoryJson(dir, parsed);
    if (!w.ok) return { ok: false, reason: w.reason };
    return { ok: true, chapter: n, scenes: parsed.scenes.length };
  },
  suggestEdits: async (spec, text) => {
    const specObj = spec as StorySpec;
    try {
      const entries = await skillBibleEntries();
      return await withHostDefaults(hostModel() ?? "", async d => {
        const r = await statelessSuggest(d, specObj, String(text ?? ""), entries);
        if (r.kind === "failed") return { ok: false as const, error: r.error };
        if (r.kind === "question") return { ok: true as const, kind: "question" as const, ask: r.ask };
        return { ok: true as const, kind: "edits" as const, spec: r.spec, applied: r.applied, ignored: r.ignored, problems: r.problems, note: r.note };
      });
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  // -- CatalogRoutesHost (/catalog/*) --
  catalogConfig: async (): Promise<CatalogConfig> => ({
    tagFacets: TAG_FACETS,
    caps: { voiceSamples: VOICE_SAMPLE_CAP },
    assistFields: ASSIST_FIELDS,
    originSkills: await originSkillGroups(),
    generalSkills: await generalSkillEntries(),
  }),
  catalogEntries: async (kind, opts) => {
    const validated = validateCatalogKind(kind);
    if (!validated) return { ok: false, reason: `no such catalog "${kind}"` };
    const catalog = await loadCatalog(validated);
    const entries = opts?.includeHidden ? catalog.entries : catalog.entries.filter((e: { hidden?: boolean }) => !e.hidden);
    return { ok: true, entries };
  },
  catalogCheck: async (kind, entry) => {
    const validated = validateCatalogKind(kind);
    if (!validated) return { ok: false, reason: `no such catalog "${kind}"` };
    const catalogs = await persistedCatalogs();
    const result = checkEntry(validated, entry, catalogs);
    if (!result.ok) return { ok: false, issues: result.issues };
    return { ok: true, problems: result.problems };
  },
  catalogSave: async (kind, entry) => {
    const validated = validateCatalogKind(kind);
    if (!validated) return { ok: false, reason: `no such catalog "${kind}"` };
    const catalogs = await persistedCatalogs();
    return await saveEntry(validated, entry, undefined, catalogs);
  },
  catalogDelete: async (kind, id) => {
    const validated = validateCatalogKind(kind);
    if (!validated) return { ok: false, reason: `no such catalog "${kind}"` };
    const result = await deleteEntry(validated, id);
    // Engine says *what happened* (missing: true); host says *what that means over HTTP* (404).
    if (!result.ok && result.missing) {
      return { ok: false, reason: result.reason, status: 404 };
    }
    return result;
  },
  catalogSetVisibility: async (kind, id, hidden) => {
    const validated = validateCatalogKind(kind);
    if (!validated) return { ok: false, reason: `no such catalog "${kind}"` };
    const result = await setVisibility(validated, id, hidden);
    // Engine says *what happened* (missing: true); host says *what that means over HTTP* (404).
    if (!result.ok && result.missing) {
      return { ok: false, reason: result.reason, status: 404 };
    }
    return result;
  },
  catalogUsage: async () => {
    const [characters, styles, skills] = await Promise.all(
      (["characters", "styles", "skills"] as const).map(k => loadCatalog(k)));
    const usage: CatalogUsage = { tags: {}, skills: {} };
    const tagFor = (label: unknown) => {
      const key = String(label ?? "").trim().toLowerCase();
      if (!key) return null;
      return usage.tags[key] ?? (usage.tags[key] = { styles: [] });
    };
    for (const s of styles.entries as { name?: string; tags?: string[] }[])
      for (const t of s.tags ?? []) { const u = tagFor(t); if (u) u.styles.push(String(s.name || "")); }
    // A skill is "used by" a character when resolution would find it: the name a character's
    // `name :: meaning` line holds, matched the way every identity comparison is (sameName).
    for (const c of characters.entries as { skills?: string[] }[])
      for (const raw of c.skills ?? []) {
        const name = splitMeaning(String(raw)).text;
        const key = Object.keys(usage.skills).find(k => sameName(k, name)) ?? name;
        usage.skills[key] = (usage.skills[key] ?? 0) + 1;
      }
    return usage;
  },
  catalogAssist: async (mode, fields, instruction, character) => {
    try {
      const catalogs = await persistedCatalogs();
      return await withHostDefaults(hostModel() ?? "", async d => {
        const r = await assistCharacter(d, {
          mode: mode as AssistMode, fields: fields as AssistField[], instruction,
          character: character as { id: string; name: string; portablePersona: string; belief: string;
                                     impulse: string; voice: string[]; origin: string; skills: string[];
                                     restrictions: string[] },
        }, catalogs);
        if (!r.ok) return { ok: false as const, kind: r.kind, reason: r.reason, issues: r.issues };
        return { ok: true as const, proposal: { draft: r.draft, changes: r.changes, warnings: r.warnings } };
      });
    } catch (e) {
      return { ok: false as const, kind: "provider_error" as const, reason: (e as Error).message };
    }
  },
};
