/**
 * HOST — the route-host object handed to server/server.ts. The domains live in host/:
 * defaults (the --model override + defaults.json knobs), scaffold (the new-story interview),
 * handoff (the between-chapters interview) and story-store (story.json read/persist, the story
 * editor and the catalog). This module only assembles them into the RouteHosts intersection the
 * routes see. Built here so server/ never imports engine/ — routes receive behaviour through
 * narrow interfaces (server/route-hosts.ts).
 */
import { ENGINE } from "./engine/engine-state.ts";
import { PROVIDER } from "./engine/providers/provider.ts";
import { resolveStoryDir, loadDefaults, writtenChapters, selectableStory } from "./engine/story-format.ts";
import { runDirs, availableModelIds, storyCards, runLlmLogs, readLlmLog } from "./engine/preflight.ts";
import { persistedCatalogs } from "./engine/catalog.ts";
import type { RouteHosts } from "./server/route-hosts.ts";
import { hostModel } from "./host/defaults.ts";
import {
  scaffoldSnapshot, scaffoldStart, scaffoldSay, scaffoldApprove, scaffoldRegenerate,
  scaffoldConcept, scaffoldImport, scaffoldPromote, scaffoldSet, scaffoldAccept, scaffoldAbandon,
} from "./host/scaffold.ts";
import {
  handoffState, handoffStart, handoffSay, handoffRegenerate, handoffAccept, handoffAbandon,
} from "./host/handoff.ts";
import {
  editorConfig, storyForEdit, fullCast, checkStory, saveStory, discardScene, suggestEdits,
  catalogConfig, catalogEntries, catalogCheck, catalogSave, catalogDelete, catalogSetVisibility,
  catalogUsage, catalogAssist,
} from "./host/story-store.ts";

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
  // -- StoryReadHost (/stories, /cast, /chapter) --
  writtenChapters,
  fullCast,
  // -- ScaffoldRoutesHost (/scaffold/*) --
  scaffoldState: scaffoldSnapshot,
  scaffoldStart, scaffoldSay, scaffoldApprove, scaffoldRegenerate, scaffoldConcept, scaffoldImport, scaffoldPromote,
  scaffoldSet, scaffoldAccept, scaffoldAbandon,
  // -- HandoffRoutesHost (/next-chapter/*) --
  handoffState, handoffStart, handoffSay, handoffRegenerate, handoffAccept, handoffAbandon,
  // -- StoryEditHost (/story/*) --
  editorConfig, storyForEdit, checkStory, saveStory, discardScene, suggestEdits,
  // -- CatalogRoutesHost (/catalog/*) --
  catalogConfig, catalogEntries, catalogCheck, catalogSave, catalogDelete, catalogSetVisibility,
  catalogUsage, catalogAssist,
};

export { setHostModelOverride } from "./host/defaults.ts";
export { setScaffoldTestHooks, resetScaffoldForTests, importCharacters } from "./host/scaffold.ts";
export { setHandoffTestHooks, resetHandoffForTests } from "./host/handoff.ts";
