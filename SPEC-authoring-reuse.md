# SPEC-authoring-reuse: Restriction Bundles and Per-Scene Overrides

**Status: implemented.** Two ideas for reducing repetitive `story.json` authoring: named
bundles for multi-skill restrictions, and per-scene model/thinking overrides.

## Correction to the original premise

The initial idea was "named trait templates (`blind`, `amnesiac`) instead of hand-authored restriction
text." Inspection shows restrictions are **already** named, single references, not freeform prose:
`CharacterDef.restrictions` (`engine/story-schema.ts`) is `string[]`, and `resolveSkills()`
(`engine/skills.ts` ~line 35) matches each entry against the fixed 8-key `SKILL_CATALOG` (movement,
speech, hearing, sight, touch, taste, smell, recall) via `canonSkill()`, dropping the matching general
skill. A restriction of `"sight"` already means "blind" — there is no prose to template.

Two real gaps were identified, and this doc records both implementations:

1. **No bundles.** A character restricted in several senses at once still needs one catalog entry per
   sense (`["sight", "hearing"]`), and there's no way to name that combination once and reuse it across
   characters or stories.
2. **Silent no-op on typos.** An unrecognized restriction value isn't rejected — `resolveSkills()`
   just `console.warn`s and treats it as a no-op (skills.ts ~line 42), so a misspelled restriction
   (`"sights"`) silently does nothing. This is a reliability gap worth fixing alongside bundles, not a
   separate feature.

## A. Named restriction/skill bundles

- Add a small bundle catalog — either a fixed `TRAIT_CATALOG: Record<string, string[]>` in
  `engine/skills.ts` (same shape and location as the existing `SKILL_CATALOG`, e.g. `deprived: ["sight",
  "hearing"]`) or a story-level `traits: Record<string, string[]>` in `story.json` if bundles should be
  story-specific rather than global. Given the existing `SKILL_CATALOG` is a fixed, global, in-code
  list, mirroring that (global, in-code) is the smaller change; a story-level catalog is a natural v2 if
  authors want custom bundles per story.
- Extend `resolveSkills()` so a restriction entry is checked against `TRAIT_CATALOG` first: if it
  matches, expand to its constituent skill names and resolve each as today; otherwise fall through to
  the existing single-skill lookup.
- Fix the silent-no-op gap in the same pass: after resolving all restrictions, any entry that matched
  neither `SKILL_CATALOG` nor `TRAIT_CATALOG` becomes a `preflight` warning (surfaced the same way
  other story-load warnings are, via `engine/preflight.ts`) instead of only a console warning invisible
  outside the terminal.

**Implementation:** `engine/skills.ts` now contains the fixed global `TRAIT_CATALOG` with the built-in
`deprived` (`sight`, `hearing`), `anosmic` (`smell`), and `insensate` (`touch`, `taste`) bundles.
`resolveSkills()` checks bundle names before single skills, composes multiple bundles, and warns once
for unresolved restriction entries. `runPreflight()` already captured `console.warn` during story
loading, so no additional `engine/preflight.ts` change was needed to surface those warnings. No schema
change — `restrictions` stays `string[]`, and values may reference a bundle name.

**Tests:** `tests/skills.test.ts` covers bundle expansion, composition, case-insensitive matching,
unknown restriction warnings, and unchanged single-skill behavior. Existing story-load warning tests
also confirm the preflight capture path.

**Verify:** `npx tsc --noEmit`, `npm test` — 231 tests passed.

## B. Per-scene model/thinking overrides

The original limitation was that `models`/`config.thinking` were read exactly once per story load
(`engine/story-format.ts`, building `StoryConfig`) and reused unchanged across every chapter —
`engine/scene-loop.ts` reads `sc.models.writer` (line ~354) and `sc.thinking.writer` (line ~122) as
constants for the whole run. `SceneDef` (`engine/story-schema.ts`) was a `strictObject` with only
`place`/`question`/`pov`/`length`/`roster`; it now explicitly includes the two writer override fields.

- `SceneDef`: add `writerModel?: string` (falls back to `sc.models.writer` when unset) and
  `writerThink?: ThinkLevel` (falls back to `sc.thinking.writer`). Scoped to the writer only, since
  that's the motivating case (a climactic chapter wanting a stronger model or higher reasoning budget)
  — character-agent overrides per scene are a separate, larger change (character agents are already
  built with a per-character `model`, so a per-scene-per-character override would need a different
  shape) and are out of scope here.
- `engine/scene-loop.ts`: at the two read sites above, change to `sd.writerModel ?? sc.models.writer`
  and `sd.writerThink ?? sc.thinking.writer`. `sd` (the active `SceneDef`) is already in scope at both
  call sites — no new parameter threading needed.

**Implementation:** `SceneDef` in `engine/story-schema.ts` now accepts optional `writerModel` and
`writerThink` fields. `engine/scene-loop.ts` uses those values for the active writer, falling back to
the story-wide model and thinking settings with nullish coalescing. Character-agent settings remain
story-wide/per-character as before.

**Tests:** `tests/story-format.test.ts` covers schema acceptance, absent-field behavior, and invalid
thinking values. `tests/run-state.test.ts` directly inspects writer construction without an LLM call to
confirm an override wins and absent overrides fall back.

**Verify:** `npx tsc --noEmit`, `npm test` — 231 tests passed.

## Blocks

1. Bundle catalog + preflight warning fix (A) — implemented in `engine/skills.ts`; existing
   `engine/preflight.ts` warning capture required no code change.
2. Per-scene writer model/thinking override (B) — implemented in `engine/story-schema.ts` and
   `engine/scene-loop.ts`.

Independent of each other; either can go first. Both are engine-only — no GUI or prompt changes, since
neither introduces anything a model needs told differently (a bundle just expands before the existing
skill-menu rendering in `prompts.ts` runs; a scene override just changes which model/think-level gets
used, not what's said to it).

## Out of scope

- Story-level custom trait catalogs (bundles authors define per story rather than a fixed in-code
  list) — noted above as a natural v2, not needed to solve the repetition problem for the built-in
  8-skill catalog.
- Per-scene, per-character model/thinking overrides — larger shape change, not the motivating case.
- Any GUI surface for authoring bundles or scene overrides — both are `story.json` fields; editing them
  through a GUI is [`SPEC-E-editor.md`](SPEC-E-editor.md)'s concern, not this one's.
