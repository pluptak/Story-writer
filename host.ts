/** HOST — the ServerHost handed to server/server.ts, plus everything only it needs: the story.json
 *  read/persist helpers (exactly one place reads the file, one place commits it) and the architect
 *  session factories with their defaults-scoped engine knobs. Built here so server/ never imports
 *  engine/ — routes receive behaviour through this object. */
import { writeFile, readFile, rename } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { LIVE, storyWriteBlocked, sseWrite, setWhere } from "./live.ts";
import { ENGINE } from "./engine/engine-state.ts";
import { splitMeaning, bibleFrom, canonSkill } from "./engine/skills.ts";
import { sameName } from "./engine/config-util.ts";
import { NET } from "./engine/llm-client.ts";
import { PROVIDER } from "./engine/provider.ts";
import { resolveStoryDir, loadStory, loadDefaults, writtenChapters, selectableStory, type Defaults } from "./engine/story-format.ts";
import { directEdit, specView, storyJsonShape, characterPsychologyWarnings, timelineBeatProblems, timelineOrderProblems, type StorySpec } from "./engine/story-spec.ts";
import { StoryJson, THINK_LEVELS, VOICE_SAMPLE_CAP } from "./engine/story-schema.ts";
import { runDirs, availableModelIds, storyCards, runLlmLogs, readLlmLog } from "./engine/preflight.ts";
import {
  buildArchitect, ScaffoldSession, openNextChapter, suggestEdits as statelessSuggest,
  type NextChapterSession, type ImportedCharacter, type StylePreset,
  type ScaffoldRound, type ScaffoldAccept, type HandoffAccept,
} from "./engine/architect.ts";
import { loadCatalog, checkEntry, saveEntry, deleteEntry, skillBible, skillBibleEntries } from "./engine/catalog.ts";
import { CATALOG_KINDS, TAG_FACETS, type CatalogKind, type LibraryCharacter } from "./engine/catalog-schema.ts";
import type {
  ServerHost, Concept, CatalogUsage, EditorConfig, CatalogConfig,
  ScaffoldState, ScaffoldActionResult, ScaffoldAcceptResult,
  HandoffState, HandoffActionResult, HandoffAcceptResult,
} from "./server/server.ts";
import { flag } from "./cli-flags.ts";

/** The architect's own knobs, which are the defaults' — not any one story's. */
async function architectDefaults(model = ""): Promise<Defaults> {
  const d = await loadDefaults(model || flag("model") || "");
  ENGINE.stream = d.stream; ENGINE.debug = d.debug;
  NET.timeoutMs = d.requestTimeout * 1000;
  NET.retries = d.attempts - 1;
  ENGINE.maxTokens = d.maxTokens;
  return d;
}

/** Apply the architect's knobs for the length of `fn`, then restore the engine knobs it touched.
 *  Keeps a stateless suggestion from leaving the architect's token cap/timeouts behind — unlike a
 *  scaffold or handoff session, which owns the console until it hands off to a run that re-applies
 *  the story's own config. `architectModel` is pure for the same reason; so is this. */
async function withArchitectDefaults<T>(model: string, fn: (d: Defaults) => Promise<T>): Promise<T> {
  const saved = { stream: ENGINE.stream, debug: ENGINE.debug, maxTokens: ENGINE.maxTokens,
                  timeoutMs: NET.timeoutMs, retries: NET.retries };
  try {
    return await fn(await architectDefaults(model));
  } finally {
    ENGINE.stream = saved.stream; ENGINE.debug = saved.debug; ENGINE.maxTokens = saved.maxTokens;
    NET.timeoutMs = saved.timeoutMs; NET.retries = saved.retries;
  }
}

async function newScaffoldSession(idea: string, model = "",
                                  mode: "oneshot" | "staged" = "oneshot",
                                  concept?: Concept): Promise<ScaffoldSession> {
  const d = await architectDefaults(model);
  const entries = await skillBibleEntries();
  const session = new ScaffoldSession(await buildArchitect(d, true, entries), d, idea, undefined, mode, undefined,
                             concept?.tags ?? [], concept?.castSize ?? 0);
  session.bible = bibleFrom(entries);
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
  const entry = { id: `skill-${canonSkill(name)}`, version: 1, name, meaning, tags: [] };
  const result = await saveEntry("skills", entry, undefined, await skillBible());
  if (!result.ok) {
    return result;
  }
  return { ok: true as const, bible: bibleFrom(await skillBibleEntries()), problems: result.problems };
}

async function importCharacters(ids: string[]): Promise<{ imported: ImportedCharacter[]; missing: string[] }> {
  const cat = await loadCatalog("characters");
  const byId = new Map<string, LibraryCharacter>((cat?.entries ?? []).map((e: LibraryCharacter) => [e.id, e]));
  const imported: ImportedCharacter[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const e = byId.get(id);
    if (!e) { missing.push(id); continue; }
    imported.push({
      libraryId: e.id, version: e.version, name: e.name, portablePersona: e.portablePersona,
      belief: e.belief, impulse: e.impulse,
      voice: [...e.voice], skills: [...e.skills], restrictions: [...e.restrictions],
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
// SCAFFOLD and its bookkeeping are private to this module: server/scaffold-routes.ts only ever
// calls HOST.scaffold*() and gets back a full state snapshot or a refusal to forward as-is.
// scaffoldBusy guards against two overlapping rounds; scaffoldGen guards against a round's own
// result landing after the session was abandoned out from under it -- abandon is allowed to
// interrupt an in-flight round rather than wait for it, so every multi-step action captures
// scaffoldGen at entry and re-checks it after each await.
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
      // Each half steers exactly one gate and is spent once that gate has produced its content.
      // Saying so is the point: a control that has stopped doing anything must not keep looking
      // live. Both are asked as "would the next build of that stage's prompt read this?" — which
      // is why cast size is measured against the cast, not against the open gate: it is at its most
      // live during the STORY gate, before the cast prompt has ever been built.
      tagsSteer: SCAFFOLD.mode !== "oneshot" && SCAFFOLD.stage === "story",
      // An imported tray IS the cast size, so the number stops being an answer to anything.
      castSizeSteers: SCAFFOLD.mode !== "oneshot" && !SCAFFOLD.imported.length && SCAFFOLD.spec.characters.length === 0,
      importsSteer: SCAFFOLD.mode !== "oneshot" && SCAFFOLD.spec.characters.length === 0,
      // Spent once the settings gate has produced a voice — which, with a preset in hand, is the
      // preset's own. Measured against the spec rather than the open gate, like the other two.
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

/** Test-only substitution for what scaffoldStart/Concept/Import/Promote call internally: a real
 *  model (newScaffoldSession) and the real catalog files (unknownTags/importCharacters/
 *  resolveStyle/promoteSkill). This is the only way to script an interview when driving it through
 *  the real ServerHost, whose scaffold*() methods take no extra arguments to inject through —
 *  mirrors ScaffoldSession's own injectable `newJudge`, for the same reason: without it, a test
 *  walking the checklist reaches for a real model or the author's real catalog. Pass null to
 *  restore the real implementations. */
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
    const last = await SCAFFOLD.propose(stage => { scaffoldStage = stage; publishScaffold(); });
    if (gen !== scaffoldGen) return { ok: false, reason: SCAFFOLD_ABANDONED, status: 409 };
    scaffoldLast = last;
  } catch (e) {
    scaffoldLast = { kind: "failed", error: (e as Error).message };
  } finally { scaffoldBusy = false; scaffoldStage = ""; }
  publishScaffold();
  return { ok: true, state: scaffoldSnapshot() };
}

export async function scaffoldSay(text: string): Promise<ScaffoldActionResult> {
  if (scaffoldBusy) return { ok: false, reason: SCAFFOLD_BUSY, status: 409 };
  if (!SCAFFOLD) return { ok: false, reason: SCAFFOLD_NOT_OPEN, status: 400 };
  const gen = scaffoldGen;
  const session = SCAFFOLD;
  scaffoldBusy = true; scaffoldFolderAsk = ""; publishScaffold();
  try {
    const r = await session.say(text, stage => { scaffoldStage = stage; publishScaffold(); });
    if (gen === scaffoldGen) scaffoldLast = r;
  } catch (e) {
    if (gen === scaffoldGen) scaffoldLast = { kind: "failed", error: (e as Error).message };
  } finally { scaffoldBusy = false; scaffoldStage = ""; }
  if (gen !== scaffoldGen) return { ok: false, reason: SCAFFOLD_ABANDONED, status: 409 };
  publishScaffold();
  return { ok: true, state: scaffoldSnapshot() };
}

export async function scaffoldApprove(override: boolean): Promise<ScaffoldActionResult> {
  if (scaffoldBusy) return { ok: false, reason: SCAFFOLD_BUSY, status: 409 };
  if (!SCAFFOLD) return { ok: false, reason: SCAFFOLD_NOT_OPEN, status: 400 };
  const gen = scaffoldGen;
  const session = SCAFFOLD;
  scaffoldBusy = true; scaffoldFolderAsk = ""; publishScaffold();
  try {
    const r = await session.approve(stage => { scaffoldStage = stage; publishScaffold(); }, override);
    if (gen === scaffoldGen) scaffoldLast = r;
  } catch (e) {
    if (gen === scaffoldGen) scaffoldLast = { kind: "failed", error: (e as Error).message };
  } finally { scaffoldBusy = false; scaffoldStage = ""; }
  if (gen !== scaffoldGen) return { ok: false, reason: SCAFFOLD_ABANDONED, status: 409 };
  publishScaffold();
  return { ok: true, state: scaffoldSnapshot() };
}

export async function scaffoldConcept(concept: Concept): Promise<ScaffoldActionResult> {
  if (scaffoldBusy) return { ok: false, reason: SCAFFOLD_BUSY, status: 409 };
  if (!SCAFFOLD) return { ok: false, reason: SCAFFOLD_NOT_OPEN, status: 400 };
  // Revising the concept never re-runs a gate: it changes what the NEXT build of a stage prompt
  // says. `tagsSteer` / `castSizeSteers` in the state is what tells the author whether that is
  // still any gate at all.
  SCAFFOLD.tags = concept.tags;
  SCAFFOLD.castSize = concept.castSize;
  scaffoldUnknownTags = concept.tags.length ? await (scaffoldTestHooks?.tags ?? unknownTags)(concept.tags) : [];
  scaffoldMissingStyle = await applyStyleTo(SCAFFOLD, concept.styleId);
  publishScaffold();
  return { ok: true, state: scaffoldSnapshot() };
}

export async function scaffoldImport(ids: string[]): Promise<ScaffoldActionResult> {
  if (scaffoldBusy) return { ok: false, reason: SCAFFOLD_BUSY, status: 409 };
  if (!SCAFFOLD) return { ok: false, reason: SCAFFOLD_NOT_OPEN, status: 400 };
  // Replaces the tray wholesale rather than adding to it: the author's pick is a set, and a
  // partial update would need a second answer for "what does absence mean".
  const resolved = await (scaffoldTestHooks?.imports ?? importCharacters)(ids);
  SCAFFOLD.imported = resolved.imported;
  scaffoldMissingImports = resolved.missing;
  publishScaffold();
  return { ok: true, state: scaffoldSnapshot() };
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
  SCAFFOLD.bible = r.bible;
  publishScaffold();
  return { ok: true, state: scaffoldSnapshot() };
}

export function scaffoldSet(input: { story?: unknown; field?: string; value?: unknown }): ScaffoldActionResult {
  if (scaffoldBusy) return { ok: false, reason: SCAFFOLD_BUSY, status: 409 };
  if (!SCAFFOLD) return { ok: false, reason: SCAFFOLD_NOT_OPEN, status: 400 };
  if (!SCAFFOLD.haveStory()) return { ok: false, reason: "there is no story to change yet", status: 400 };
  if (input.story && typeof input.story === "object") {
    const r = SCAFFOLD.setSpec(input.story);
    scaffoldLast = { kind: "edits", applied: r.applied, ignored: [], flags: [], note: "updated from the story editor" };
    publishScaffold();
    return { ok: true, state: scaffoldSnapshot() };
  }
  const r = directEdit(SCAFFOLD.spec, String(input.field ?? ""), input.value);
  if (!r.ok) return { ok: false, reason: r.reason, status: 400 };
  SCAFFOLD.spec = r.spec; SCAFFOLD.problems = r.problems;
  scaffoldLast = { kind: "edits", applied: r.applied, ignored: [], flags: [], note: "" };
  publishScaffold();
  return { ok: true, state: scaffoldSnapshot() };
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
  // The session dies here, but `scaffoldBusy` is left alone: if a round is in flight it must
  // keep the lock until its own finally clears it, so a second start cannot overlap it. The
  // round itself finds a stale `scaffoldGen` on return and drops everything it produced.
  SCAFFOLD = null; scaffoldLast = null; scaffoldFolderAsk = "";
  scaffoldUnknownTags = []; scaffoldMissingImports = []; scaffoldMissingStyle = "";
  scaffoldGen++;
  publishScaffold();
}

/** Test-only reset for the scaffold's private module state, mirroring live.ts's resetLive() — a
 *  test importing scaffoldStart/Say/etc. directly shares this module's singleton across cases and
 *  must clear it between them, the same leak Playwright's harness had for the same reason. */
export function resetScaffoldForTests(): void {
  SCAFFOLD = null; scaffoldBusy = false; scaffoldGen++;
  scaffoldLast = null; scaffoldStage = ""; scaffoldFolderAsk = "";
  scaffoldUnknownTags = []; scaffoldMissingImports = []; scaffoldMissingStyle = "";
}

async function newHandoffSession(dir: string, model = ""): Promise<NextChapterSession> {
  const entries = await skillBibleEntries();
  return openNextChapter(await architectDefaults(model), dir, entries);
}

// -- HANDOFF (the between-chapters interview) --------------------------------------------------
// HANDOFF and its bookkeeping are private to this module, mirroring SCAFFOLD above. The
// story-write lock (LIVE.storyLock) is tied 1:1 to HANDOFF's own lifecycle -- set the moment a
// session opens, cleared on every exit (abandon, a session-open failure, a round discovering it
// was abandoned, or a successful accept) -- so it lives here too, not at the route.
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

/** The one exit for a round that finds itself abandoned after an await. Always releases the
 *  story-write lock: `handoffAbandon()` deliberately leaves it alone while a round is in flight (an
 *  `accept` already rewriting story.json keeps its guard until that write, and its restore-on-
 *  failure, is finished), so releasing it is the abandoned round's own job on its way out. */
function handoffAbandonedResult(reason: string): { ok: false; reason: string; status: 409 } {
  LIVE.storyLock = null;
  publishHandoffState();
  return { ok: false, reason, status: 409 };
}

/** Test-only substitution for what handoffStart calls internally: a real model and the real story
 *  file (openNextChapter reads story.json and the skill bible). Mirrors scaffoldTestHooks, for the
 *  same reason: without it, a test reaches a real model or the author's real files. Pass null to
 *  restore the real implementation. */
let handoffTestHooks: { session?: typeof newHandoffSession } | null = null;
export function setHandoffTestHooks(hooks: typeof handoffTestHooks): void {
  handoffTestHooks = hooks;
}

export function handoffState(): HandoffState { return handoffSnapshot(); }

export async function handoffStart(dir: string, model: string): Promise<HandoffActionResult> {
  if (handoffBusy) return { ok: false, reason: "a round is already in flight", status: 409 };
  const blocked = storyWriteBlocked(LIVE.storyLock);
  if (blocked) return { ok: false, reason: blocked, status: 409 };
  const gen = handoffGen;
  handoffBusy = true; handoffLast = null;
  try {
    const session = await (handoffTestHooks?.session ?? newHandoffSession)(dir, model);
    // Abandoned while the session was being built: it must not resurrect itself.
    if (gen !== handoffGen) return handoffAbandonedResult(HANDOFF_ABANDONED);
    HANDOFF = session;
    // The session now holds a snapshot it will write back on accept: hold the story-write lock
    // until the handoff ends (accept, abandon, or failure), so an editor save cannot interleave.
    LIVE.storyLock = `a chapter handoff is open for ${dir}`;
    setWhere(`preparing chapter ${HANDOFF.chapter} of ${dir}`, false);
    publishHandoffState();
    const last = await HANDOFF.propose(stage => { handoffStage = stage; publishHandoffState(); });
    if (gen !== handoffGen) return handoffAbandonedResult(HANDOFF_ABANDONED);
    handoffLast = last;
  } catch (e) {
    HANDOFF = null;
    LIVE.storyLock = null;
    handoffBusy = false; handoffStage = "";
    publishHandoffState();
    return { ok: false, reason: (e as Error).message, status: 400 };
  } finally { handoffBusy = false; handoffStage = ""; }
  publishHandoffState();
  return { ok: true, state: handoffSnapshot() };
}

export async function handoffSay(text: string): Promise<HandoffActionResult> {
  if (handoffBusy) return { ok: false, reason: "a round is already in flight", status: 409 };
  const blocked = storyWriteBlocked(LIVE.storyLock);
  if (blocked) return { ok: false, reason: blocked, status: 409 };
  if (!HANDOFF) return { ok: false, reason: "no handoff is open", status: 400 };
  const gen = handoffGen;
  const session = HANDOFF;
  handoffBusy = true; publishHandoffState();
  try {
    const r = await session.say(text);
    if (gen === handoffGen) handoffLast = r;
  } catch (e) {
    if (gen === handoffGen) handoffLast = { kind: "failed", error: (e as Error).message };
  } finally { handoffBusy = false; }
  if (gen !== handoffGen) return handoffAbandonedResult(HANDOFF_ABANDONED);
  publishHandoffState();
  return { ok: true, state: handoffSnapshot() };
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
  // The session dies here, but `handoffBusy` is left alone: if a round is in flight it must keep
  // the lock until its own finally clears it. The round itself finds a stale `handoffGen` on
  // return and drops everything it produced. `LIVE.storyLock` goes the same way and for the same
  // reason -- an `accept` mid-write still needs the guard that keeps an editor save from
  // interleaving with it -- so an in-flight round releases it instead, via handoffAbandonedResult().
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
  // bible a run would use — a story that saves clean should load clean where it will be written.
  try { await loadStory(dir, undefined, await skillBible()); }
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
  ]),
  ...parsed.timeline.flatMap((beat, i) =>
    timelineBeatProblems(`timeline beat ${i + 1}`, beat, parsed.characters.map(c => c.name), parsed.scenes)),
  ...timelineOrderProblems(parsed.timeline),
  ...characterCardWarnings(parsed),
];

/** Validate a catalog kind that arrived from the wire — returns the validated kind or null. */
const validateCatalogKind = (kind: string): CatalogKind | null =>
  CATALOG_KINDS.includes(kind as CatalogKind) ? (kind as CatalogKind) : null;

export const HOST: ServerHost = {
  selectableStory, resolveStoryDir, runDirs, runLlmLogs, readLlmLog, writtenChapters, availableModelIds,
  providerName: PROVIDER.displayName,
  // The shelf's cards resolve capabilities against the author's own bible, so a card and the run it
  // starts report the same skills.
  storyCards: async () => storyCards(await skillBible()),
  scaffoldState: scaffoldSnapshot,
  scaffoldStart, scaffoldSay, scaffoldApprove, scaffoldConcept, scaffoldImport, scaffoldPromote,
  scaffoldSet, scaffoldAccept, scaffoldAbandon,
  handoffState, handoffStart, handoffSay, handoffAccept, handoffAbandon,
  architectModel: async () => (await loadDefaults(flag("model") ?? "")).models.architect,
  outDir: () => ENGINE.outDir,
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
  fullCast: async (dir) => {
    const loaded = await loadStoryJson(dir);
    if (!loaded.ok) return { ok: false, error: loaded.error };
    return {
      ok: true,
      characters: loaded.story.characters.map(c => ({
        name: c.name, persona: c.persona, knows: c.knows, goal: c.goal,
        belief: c.belief, impulse: c.impulse, voice: c.voice,
        skills: c.skills.map(s => splitMeaning(s)),
        restrictions: c.restrictions,
      })),
      // Reach stays per scene and never merges into a character's skills (I4): the GUI labels it
      // with the scene it comes from so it can never read as intrinsic.
      scenes: loaded.story.scenes.map((s, i) => ({ n: i + 1, reach: s.reach ?? {} })),
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
      return await withArchitectDefaults(flag("model") ?? "", async d => {
        const r = await statelessSuggest(d, specObj, String(text ?? ""), entries);
        if (r.kind === "failed") return { ok: false as const, error: r.error };
        if (r.kind === "question") return { ok: true as const, kind: "question" as const, ask: r.ask };
        return { ok: true as const, kind: "edits" as const, spec: r.spec, applied: r.applied, ignored: r.ignored, problems: r.problems, note: r.note };
      });
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  catalogConfig: (): CatalogConfig => ({
    tagFacets: TAG_FACETS,
    caps: { voiceSamples: VOICE_SAMPLE_CAP },
  }),
  catalogEntries: async (kind) => {
    const validated = validateCatalogKind(kind);
    if (!validated) return { ok: false, reason: `no such catalog "${kind}"` };
    const catalog = await loadCatalog(validated);
    return { ok: true, entries: catalog.entries };
  },
  catalogCheck: async (kind, entry) => {
    const validated = validateCatalogKind(kind);
    if (!validated) return { ok: false, reason: `no such catalog "${kind}"` };
    const bible = await skillBible();
    const result = checkEntry(validated, entry, bible);
    if (!result.ok) return { ok: false, issues: result.issues };
    return { ok: true, problems: result.problems };
  },
  catalogSave: async (kind, entry) => {
    const validated = validateCatalogKind(kind);
    if (!validated) return { ok: false, reason: `no such catalog "${kind}"` };
    const bible = await skillBible();
    return await saveEntry(validated, entry, undefined, bible);
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
  catalogUsage: async () => {
    const [characters, styles, skills] = await Promise.all(
      (["characters", "styles", "skills"] as const).map(k => loadCatalog(k)));
    const usage: CatalogUsage = { tags: {}, skills: {} };
    const tagFor = (label: unknown) => {
      const key = String(label ?? "").trim().toLowerCase();
      if (!key) return null;
      return usage.tags[key] ?? (usage.tags[key] = { characters: 0, styles: [], skills: 0 });
    };
    for (const c of characters.entries as { tags?: string[] }[])
      for (const t of c.tags ?? []) { const u = tagFor(t); if (u) u.characters++; }
    for (const s of styles.entries as { name?: string; tags?: string[] }[])
      for (const t of s.tags ?? []) { const u = tagFor(t); if (u) u.styles.push(String(s.name || "")); }
    for (const k of skills.entries as { tags?: string[] }[])
      for (const t of k.tags ?? []) { const u = tagFor(t); if (u) u.skills++; }
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
};
