/**
 * ROUTE HOSTS — the narrow engine-facing interfaces each route module gets. One interface per
 * route domain; a handler sees only what its routes call. The single runtime object (host.ts
 * `HOST`) satisfies them all as `RouteHosts`. Wire shapes: docs/GUI-SPEC.md.
 */

import type { StoryCard, LlmLogSummary } from "../engine/preflight.ts";
import type { StoryJson, ThinkLevel } from "../engine/story-schema.ts";
import type { TagFacet } from "../engine/catalog-schema.ts";

/** The author's pre-architect steering: tags/cast-size/style for the staged walk's gates. */
export type Concept = { tags: string[]; castSize: number; styleId: string };

/** A scoped regenerate: reconsider exactly one cast member at the staged cast gate. */
export type RegenScope = { kind: "character"; name: string };

/** Observed reuse of the shared vocabulary: tag label → styles carrying it, skill name → user count. */
export interface CatalogUsage {
  tags: Record<string, { styles: string[] }>;
  skills: Record<string, number>;
}

/** Hand-enumerated projection of story-schema.ts's defaults for the editors — never the schema. */
export interface EditorConfig {
  defaults: {
    retries: number; clarifications: number; maxSteps: number; maxProseWords: number;
    requestTimeout: number; attempts: number; maxTokens: number; stream: boolean; debug: boolean;
    thinking: { writer: ThinkLevel; character: ThinkLevel; summary: ThinkLevel };
    sceneLength: number;
  };
  thinkingLevels: readonly ThinkLevel[];
  caps: { voiceSamples: number };
}

/** Hand-enumerated projection of catalog-schema.ts for the catalog editor — never the schema. */
export interface CatalogConfig {
  tagFacets: readonly TagFacet[];
  caps: { voiceSamples: number };
  assistFields: readonly string[];
  /** Origin name → the general skills it grants. */
  originSkills: Readonly<Record<string, readonly string[]>>;
  /** The selectable universe for an origin's `general` list: name → meaning. */
  generalSkills: Readonly<Record<string, string>>;
}

/** One open interview's snapshot — what GET /scaffold and every /scaffold/* action returns. */
export type ScaffoldState =
  | { active: false }
  | {
      active: true;
      idea: string;
      mode: "oneshot" | "staged";
      busy: boolean;
      stage: "" | "fillGaps" | "verify";
      gate: string | null;
      tension: string;
      concept: {
        tags: readonly string[]; castSize: number; unknownTags: string[];
        imported: { libraryId: string; version: number; name: string }[];
        missingImports: string[];
        styleId: string; styleName: string; missingStyle: string;
        tagsSteer: boolean; castSizeSteers: boolean; importsSteer: boolean; styleSteers: boolean;
      };
      haveDraft: boolean;
      haveStory: boolean;
      pendingAsk: string;
      problems: string[];
      bibleCandidates: { name: string; meaning: string; heldBy: string[] }[];
      last: unknown;
      needsFolder: string;
      model: string;
      spec: unknown;
      storyDraft: unknown;
    };

/** One scaffold action's outcome: the resulting state, or a refusal naming the status. */
export type ScaffoldActionResult =
  | { ok: true; state: ScaffoldState }
  | { ok: false; reason: string; status?: number; issues?: string[] };

/** accept()'s outcome. A non-"written" result is not always a refusal: the route answers 200 for
 *  "needs_folder"/"unloadable", which carry files/dir rather than a state snapshot. */
export type ScaffoldAcceptResult =
  | { ok: true; kind: "written"; dir: string; files: string[]; warnings: string[]; status: 200 }
  | { ok: false; kind: "unloadable"; dir: string; files: string[]; error: string; warnings: string[]; status: 200 }
  | { ok: false; kind: "needs_folder"; reason: string; status: 200 }
  | { ok: false; kind: "no_story"; status: 400 }
  | { ok: false; reason: string; status: number };

/** One open handoff's snapshot — the handoff's version of ScaffoldState (no concept/gate/mode,
 *  plus dir/chapter/edited). */
export type HandoffState =
  | { active: false }
  | {
      active: true;
      dir: string;
      chapter: number;
      busy: boolean;
      stage: "" | "fillGaps" | "verify";
      edited: boolean;
      pendingAsk: string;
      problems: string[];
      last: unknown;
      model: string;
      spec: unknown;
    };

/** One handoff action's outcome — the handoff's version of ScaffoldActionResult. */
export type HandoffActionResult =
  | { ok: true; state: HandoffState }
  | { ok: false; reason: string; status?: number };

/** accept()'s outcome — the handoff's version of ScaffoldAcceptResult: "unloadable" carries only
 *  dir/error, there is no "needs_folder", and "nothing" takes "no_story"'s 400. */
export type HandoffAcceptResult =
  | { ok: true; kind: "written"; chapter: number; dir: string; files: string[]; warnings: string[]; status: 200 }
  | { ok: false; kind: "unloadable"; dir: string; error: string; status: 200 }
  | { ok: false; kind: "nothing"; status: 400 }
  | { ok: false; reason: string; status: number };

// -- Shared capabilities (declared once, composed into the per-route interfaces) ----------------

/** Resolve an outside-process directory against the engine's discovered stories. */
export interface StorySelection {
  /** Resolve a directory that came from OUTSIDE the process to one the engine discovered, or null. */
  selectableStory(dir: string): Promise<string | null>;
  resolveStoryDir(dir: string): string;
}

/** Name the configured provider in user-facing refusals without importing the engine. */
export interface ModelAvailability {
  availableModelIds(): Promise<string[] | null>;
  /** The configured provider's display name ("LM Studio", "Ollama", …). */
  providerName: string;
}

// -- Per-route-domain hosts -------------------------------------------------------------------

/** What scaffold-routes.ts may call. */
export interface ScaffoldRoutesHost extends ModelAvailability {
  /** The open interview's current snapshot, or `{active:false}`. Never mutates or publishes. */
  scaffoldState(): ScaffoldState;
  /** Opens a new interview. Refuses (409) if a round is already in flight, or if abandoned
   *  while this one was still getting under way. */
  scaffoldStart(input: { idea: string; model: string; mode: "oneshot" | "staged";
                         concept: Concept; importIds: string[] }): Promise<ScaffoldActionResult>;
  /** A free-text turn against the open interview. */
  scaffoldSay(text: string): Promise<ScaffoldActionResult>;
  /** Staged mode only: pass the open checklist gate. `override` overrules a blocked gate. */
  scaffoldApprove(override: boolean): Promise<ScaffoldActionResult>;
  /** Re-runs the open stage's prompt without advancing the checklist; with a scope, re-runs
   *  only that cast member. Writes nothing either way. */
  scaffoldRegenerate(scope?: RegenScope): Promise<ScaffoldActionResult>;
  /** Revises the author's concept on the open session — never re-runs a gate. */
  scaffoldConcept(concept: Concept): Promise<ScaffoldActionResult>;
  /** Replaces the import tray on the open session, wholesale. */
  scaffoldImport(ids: string[]): Promise<ScaffoldActionResult>;
  /** Puts one of the session's current bible candidates into the author's skill bible. */
  scaffoldPromote(name: string): Promise<ScaffoldActionResult>;
  /** Direct edit, bypassing the model: `{field, value}` for a single scalar field, or `{story}`
   *  to replace the in-memory draft wholesale. */
  scaffoldSet(input: { story?: unknown; field?: string; value?: unknown; source?: string }): ScaffoldActionResult;
  /** Writes the accepted story to disk and ends the session on success. */
  scaffoldAccept(folder: string): Promise<ScaffoldAcceptResult>;
  /** Drops the open interview unconditionally. */
  scaffoldAbandon(): void;
}

/** What next-chapter-routes.ts may call. */
export interface HandoffRoutesHost extends StorySelection, ModelAvailability {
  /** The open handoff's current snapshot, or `{active:false}`. Never mutates or publishes. */
  handoffState(): HandoffState;
  /** Opens the handoff on a discovered story and runs the first round. */
  handoffStart(dir: string, model: string): Promise<HandoffActionResult>;
  /** A follow-up from the author, in the same edits-only format. */
  handoffSay(text: string): Promise<HandoffActionResult>;
  /** Re-runs the handoff's opening round on the live session. Writes nothing. */
  handoffRegenerate(): Promise<HandoffActionResult>;
  /** Writes the re-authored story over the one on disk; on failure puts back exactly what was
   *  there and answers `kind:"unloadable"`, leaving the session open. */
  handoffAccept(): Promise<HandoffAcceptResult>;
  /** Drops the open handoff unconditionally. */
  handoffAbandon(): void;
}

/** What story-read-routes.ts may call. Read-only; all served while a run is in flight. */
export interface StoryReadHost extends StorySelection {
  storyCards(): Promise<StoryCard[]>;
  /** One story's full authored cast for the read-only character sheet, `model` omitted.
   *  Reach/presence/constraint stay per scene (I4) — a missing entry means "unaffected". */
  fullCast(dir: string): Promise<{
    ok: true; characters: {
      name: string; persona: string; knows: string; goal: string;
      belief: string; impulse: string; voice: string[]; origin: string;
      skills: { text: string; meaning: string }[]; restrictions: string[];
      pronouns?: { subject: string; object: string; possessive: string; reflexive: string };
    }[]; scenes?: { n: number; reach: Record<string, string[]>; presence: Record<string, string>; constraint: Record<string, string[]> }[];
  } | {
    ok: false; error: string;
  }>;
  /** The chapter numbers already written for a story. Takes a discovered story dir. */
  writtenChapters(dir: string): Promise<number[]>;
}

/** What story-edit-routes.ts may call. */
export interface StoryEditHost extends StorySelection {
  /** Schema-derived defaults, thinking levels and caps for the story editor. */
  editorConfig(): EditorConfig;
  /** A story's full validated definition for editing, plus engine warnings. On parse failure
   *  returns the raw object so the editor can show the error. */
  storyForEdit(dir: string): Promise<{
    ok: true; story: StoryJson; warnings: string[]
  } | {
    ok: false; error: string; raw?: object
  }>;
  /** Validate a modified story.json in memory without writing. */
  checkStory(story: object): {
    ok: true; warnings: string[]
  } | {
    ok: false; error: string; issues: { path: string; message: string }[]
  };
  /** Save a validated story.json atomically. Refuses while a run is in flight. */
  saveStory(dir: string, story: object): Promise<{
    ok: true; warnings: string[]
  } | {
    ok: false; reason: string; status?: number
  }>;
  /** Drop the last authored scene, undoing an accepted-but-unwritten chapter. */
  discardScene(dir: string, n: number): Promise<{
    ok: true; chapter: number; scenes: number
  } | {
    ok: false; reason: string; status?: number
  }>;
  /** Stateless architect suggestion against the editor's unsaved draft. */
  suggestEdits(spec: unknown, text: string): Promise<{
    ok: true; kind: "edits"; spec: unknown; applied: {field:string;before:unknown;after:unknown}[]; ignored: string[];
    problems: string[]; note: string
  } | {
    ok: true; kind: "question"; ask: string
  } | {
    ok: false; error: string
  }>;
}

/** What catalog-routes.ts may call. Story-independent: no story dir, no story-write lock. */
export interface CatalogRoutesHost {
  /** The catalog's schema-derived shape. May be asynchronous; the route awaits it. */
  catalogConfig(): CatalogConfig | Promise<CatalogConfig>;
  /** All entries in a catalog. `kind` is validated here — it arrives from the wire. */
  catalogEntries(kind: string, opts?: { includeHidden?: boolean }): Promise<{ ok: true; entries: unknown[] } | { ok: false; reason: string }>;
  /** Validate one catalog entry without saving. */
  catalogCheck(kind: string, entry: unknown): Promise<
    { ok: true; problems: string[] } |
    { ok: false; issues: string[] } |
    { ok: false; reason: string }
  >;
  /** Insert or replace one catalog entry by id. */
  catalogSave(kind: string, entry: unknown): Promise<{ ok: true; entry: unknown; problems: string[] } | { ok: false; reason: string; status?: number; issues?: string[] }>;
  /** Remove one catalog entry by id. Fails if the id is not found. */
  catalogDelete(kind: string, id: string): Promise<{ ok: true } | { ok: false; reason: string; status?: number }>;
  /** Hide or restore one catalog entry. Never a content revision: does not touch `version`. */
  catalogSetVisibility(kind: string, id: string, hidden: boolean): Promise<{ ok: true; entry: unknown } | { ok: false; reason: string; status?: number }>;
  /** Which catalogs reference which entries — read-only derivation over the other kinds. */
  catalogUsage(): Promise<CatalogUsage>;
  /** Field-scoped character assistant on its own configured model — never saves. Expected model
   *  failures are 200 answers, not a 4xx. */
  catalogAssist(mode: "create" | "revise" | "review", fields: string[], instruction: string, character: unknown): Promise<
    | { ok: true; proposal: { draft: unknown; changes: { field: string; before: unknown; after: unknown }[]; warnings: string[] } }
    | { ok: false; kind?: string; reason: string; issues?: string[] }
  >;
}

/** What run-control-routes.ts may call. The run itself is steered through LIVE, not the host. */
export interface RunControlHost extends ModelAvailability {}

/** What run-log-routes.ts may call. Read-only by construction. */
export interface RunLogHost extends StorySelection {
  /** A retained run's per-agent LLM transcripts. Takes a resolved story path. */
  runLlmLogs(storyDir: string, id: string): Promise<LlmLogSummary[]>;
  readLlmLog(storyDir: string, id: string, file: string): Promise<string | null>;
  runDirs(storyDir: string): Promise<string[]>;
  /** The current run's output folder, or "" before a run has committed one. */
  outDir(): string;
}

/** What server.ts's own inline routes (/stories, /select, /models) may call. */
export interface SessionRoutesHost extends StorySelection, ModelAvailability {
  storyCards(): Promise<StoryCard[]>;
  /** The model an interview would use if you chose nothing — resolved, not defaults text. */
  architectModel(): Promise<string>;
}

/** Everything the server can ask of the engine. The one runtime object (host.ts `HOST`)
 *  satisfies this intersection; each route module sees only its own slice. */
export type RouteHosts =
  & ScaffoldRoutesHost
  & HandoffRoutesHost
  & StoryReadHost
  & StoryEditHost
  & CatalogRoutesHost
  & RunControlHost
  & RunLogHost
  & SessionRoutesHost;
