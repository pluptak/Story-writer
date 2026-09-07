# Plan: close the Architect gaps found by the catalog-consumption / config / generated-artifact audits

## Context

A prior conversation ran three design audits against this repo's "Architect" (the browser scaffold/interview UI for building a story) and its handoff/next-chapter flow, checking three requirement sets that had been reported as "already implemented":

1. Architect should *consume* catalog assets (characters/styles/tags), never behave as a catalog editor.
2. Execution/debug configuration (models, retries, budgets, thinking, streaming, debug) should live behind an Advanced surface, not clutter the creative flow.
3. Generated content should visibly distinguish draft/proposal/edited/approved, and support accept/edit/regenerate/partially-regenerate/reject, without destructive regeneration.

Three read-only Explore agents verified the actual code against each requirement set. Most of it is genuinely built (correct labels, catalog CRUD kept separate, session-only selection, Advanced disclosures for retries/tokens/thinking/debug, real accept/edit/regenerate). Nine concrete gaps were confirmed against the live source (file:line cited below); a tenth item (persisted versioning) was checked and found to be **compliant, not a gap** — the original requirement explicitly said not to invent versioning unless the data model already supports it, and it doesn't, so nothing should be built for that.

This plan closes the nine real gaps, broken into small, independently-pausable blocks per this repo's working process (CLAUDE.md: engine changes and UI/story-authoring changes are separate blocks; test once per block).

**One block (D, provenance) is a genuine design-invariant conflict, not an oversight** — `engine/architect.ts` has an explicit, deliberate doc comment saying provenance must never reach `story.json`. That block presents two options and needs an explicit decision before any code is touched, not silent implementation.

## Sequencing

1. **A** — inspect before selecting (UI-only)
2. **E** — architect model picker behind Advanced (UI-only)
3. **D** — provenance: get a decision (a) vs (b) before coding
4. **B** — create-then-return loop (UI-only)
5. **C** — structured goal/knows fields per cast member (UI + tiny host.ts change)
6. **F** — scoped ("partial") regenerate (prompts + engine/architect.ts + route + host.ts + UI) — split into an engine/prompt sub-block then a UI sub-block
7. **G** — reject action (small engine/architect.ts addition + UI) — pairs with F's per-character card
8. **H** — per-item merge on a full-gate regenerate (engine/architect.ts only) — do last, since F's scoped path already covers the common case

Excluded on purpose: no version-history/diff-log store anywhere (matches the original requirement's own "do not invent versioning" instruction). G's reject and H's merge both reuse the engine's existing single-slot before/after bookkeeping rather than adding a history stack.

---

## Block A — Inspect before selecting

**Gap.** `server/gui/viewer/interview.js` — `importPickerHtml` (~103–135) and `stylePickerHtml` (~152–176) only render the full `<details class="story-cast-member">` / `<details class="story-style-detail">` detail block for an *already-selected* chip. An unselected chip has only a `title` tooltip, so the author can't inspect a candidate before choosing it.

**Fix.** Let any chip (selected or not) expand the same detail block the selected case already builds, keyed by a small local UI toggle (e.g. `APP.scaffoldInspect = {kind, id}`) rather than by pick-state. Selecting stays a separate action from inspecting — e.g. an "ⓘ"/chevron per chip toggles the detail block without changing selection.

**Files:** `server/gui/viewer/interview.js` (`importPickerHtml`, `stylePickerHtml`, `wireScaffold`); possibly `server/gui/viewer/viewer.css` for the expanded-unselected state.

**Layer:** UI-only.

---

## Block E — Architect model picker behind Advanced

**Gap.** `interview.js` `ideaModalHtml()` (~234–259) renders a "built by" `modelSelect` (~251–253) inline in the idea modal — the one model/config control never moved behind Advanced, unlike every other one (`handoff-view.js` ~68–72 already wraps its model picker in `<details data-tid="handoff.advanced"><summary>Advanced — execution settings</summary>`).

**Fix.** Same pattern: show the configured default model as plain text, collapse the override into `<details data-tid="idea.advanced"><summary>Advanced — choose a different model</summary>${modelSelect(...)}</details>`. This one genuinely can't be deferred past the first call (unlike retries), so the default must stay pre-selected and valid with the `<details>` collapsed — `modelSelect`'s existing `defaultLabel`/`selected` behavior already does this; only the surrounding container changes.

**Files:** `server/gui/viewer/interview.js` (`ideaModalHtml` only — the existing `#f-model` change listener at ~1201–1202 needs no change).

**Layer:** UI-only.

---

## Block D — Provenance persistence: decide before coding

**Gap.** `engine/architect.ts` ~181–186 has a deliberate doc comment: `libraryId`/`version` on `ImportedCharacter` are "provenance that ends at accept — `StoryJson` is a strict object with nowhere to put them, and the handoff must never know a character came from a template." Same for `StylePreset.id` (~200–203). `engine/story-schema.ts`'s `CharacterDef`/`StoryJson` are `z.strictObject` with no `catalogId`/`sourceId` field. This is confirmed as an intentional invariant, not an oversight — closing it as literally requested means overturning that stated design decision.

**Option (a) — recommended.** UI-only. Provenance already renders live in-session (`castHtml`'s `prov-catalog`/`prov-ai` tags, `interview.js` ~266–290). Add one explicit line at the accept/handoff step (`folderHtml`, ~710–732) stating plainly which characters/style came from the catalog and that this association is **not** saved to `story.json`, so the author is never surprised later. No schema or engine change.

**Option (b).** Add an optional, purely descriptive block to `StoryJson` (e.g. `_provenance: { characters: [{name, catalogId, catalogVersion}], style?: {catalogId, catalogVersion} }`), populated at `ScaffoldSession.accept()` (~809–834), **never read** by scene-loop/reach/character-resolution — display-only for the editor/handoff UI. This is a real exception to the existing invariant and grows `StoryJson` for every story, forever, for a display convenience.

**Decided: option (a).** The invariant stays; this block is UI-only — a note at accept time, no schema or engine change.

---

## Block B — Create-then-return loop

**Gap.** The `#/catalog`, `#/catalog?kind=styles`, `#/catalog?kind=tags` links in `interview.js` (~72, ~108, ~156) are plain outbound anchors — no way to return to the same scaffold selection state with a newly created asset available/pre-selected. The scaffold session lives server-side (`SCAFFOLD` in `host.ts`) and survives navigation untouched, so this is pure client-side routing, not session plumbing.

**Fix.**
1. Replace the three anchors with buttons that set `APP.catalog.returnTo = { view: "scaffold", selectId? }` alongside the existing `APP.catalog.kind`, then `go("catalog")`.
2. In `server/gui/viewer/pages.js`'s `render*Library` wrappers, when `returnTo` is set, show a "back to your story →" banner the whole time on the catalog page.
3. In each library's save handler (`character-library.js`, `style-library.js`, `tag-library.js`), after a successful create/save, if `returnTo.view === "scaffold"`, auto-navigate back and clear the flag.
4. On return, `wireScaffold`'s existing `loadVocab(); loadLibrary(); loadStyles();` calls refetch the new entry (catalogs are already invalidated on save). If `selectId` is set, fire the same selection handler the chip itself uses (`postScaffold("import"/"concept", …)`) once after reload.

**Files:** `interview.js` (link sites + `wireScaffold` return-hook), `pages.js` (return banner), `character-library.js`/`style-library.js`/`tag-library.js` (auto-return after save).

**Layer:** UI-only.

---

## Block C — Structured goal/knows fields per cast member

**Gap.** Shaping a selected character's role in this story (`goal`, `knows` — the two story-positional fields `CharacterDef` already carries, `engine/story-schema.ts` ~36–57) is purely conversational today (`interview.js` ~100–102 says so explicitly). The original requirement asks for a first-class "change story-specific role/importance" control. There is no `importance` field in the schema and none should be invented — this adds structured editing for the two fields that already exist.

**Fix.** Add inline text inputs for `goal`/`knows` to each cast card (`castHtml`, ~271–290) and the imported-character detail block (`importPickerHtml`, ~118–131). On change, clone `APP.scaffold.storyDraft`, set the field on the matching character, and POST `/scaffold/set` with `{ story: patched, source: "role" }` — reusing the exact whole-draft-replace path `revertRound()` already uses (~1129–1140), so `ScaffoldSession.setSpec()`/`normalizeSpec()` validates it and no new direct-field allowlist entry in `engine/story-spec.ts`'s `directEdit` is needed.

One small **host.ts** change: `scaffoldSet` (~368–385) derives its round note from `input.source === "revert" ? … : "updated from the story editor"`. Add a third `"role"` source with its own note, so `regenRowHtml`'s `fromEditor` guard (`interview.js` ~769, keyed to the literal string `"updated from the story editor"`) doesn't misfire and disable regenerate after a role edit.

**Files:** `interview.js` (`castHtml`, `importPickerHtml`, new `setCharacterField` helper), `host.ts` (`scaffoldSet` note derivation, ~372–376).

**Layer:** UI-only + one small server-domain (`host.ts`) change. No engine/story-schema.ts change.

---

## Block F — Scoped ("partial") regenerate

**Gap.** `regenStage()` (`interview.js` ~1124–1127) → `/scaffold/regenerate` → `ServerHost.scaffoldRegenerate` (`host.ts` ~311–326) → `ScaffoldSession.rerun()` (`engine/architect.ts` ~684–691) always re-runs the whole open gate's prompt. For the cast gate, every character is redone even if the author only wanted one reconsidered.

**Fix, as two sub-blocks (engine+prompt, then UI):**

*F1 — engine/prompt.*
1. `prompts/architect.ts`: add a scoped prompt variant, e.g. `architectCastRegenerateOne(premise, tension, specSoFar, targetName)`, naming the one character to reconsider while instructing every other character be returned unchanged — mirrors the preservation contract `architectCastImportStage` already uses (~427–490). Same reply shape (`{"characters":[...]}`) as today, so no new JSON contract.
2. `engine/architect.ts`: add `ScaffoldSession.rerunScoped(scope: {kind: "character"; name: string}, onStage?)`, parallel to `rerun()`, using the scoped prompt for the cast stage and reusing the existing `runGate`/`takeStaged` pipeline for parsing and merging (Block H's per-item merge plugs in here for the scoped case too, though scoped regenerate makes merging trivial: only the named character's entry is ever replaced).
3. `server/scaffold-routes.ts`: extend the `"regenerate"` action to accept an optional `{ scope: { kind: "character", name } }`, validated against the current cast before calling `host.scaffoldRegenerate(scope)`.
4. `host.ts` (~311–326): thread the optional scope to `session.rerunScoped(scope, …)` when present, else call `session.rerun(…)` unchanged.

*F2 — UI.*
5. `interview.js` (`castworldBits`/`castHtml`, ~649–660, ~271–290): add a "regenerate just this one" action per cast card, visible at the cast gate, calling `postScaffold("regenerate", { scope: { kind: "character", name } })`. The existing `regenRowHtml` whole-gate regenerate stays as-is; this is additive.

**Files:** `prompts/architect.ts`, `engine/architect.ts`, `server/scaffold-routes.ts`, `host.ts`, `interview.js`.

**Layer:** F1 touches engine + prompts + route layer (largest sub-block); F2 is UI-only.

---

## Block G — Reject as a distinct action

**Gap.** Only `abandon` (kill the whole session, `scaffold-routes.ts` ~60–64) and `approve({override:true})` (override a blocked gate, ~130–137) exist. There is no "put this one generated item back" short of a full regenerate. `interview.js` already has single-step revert machinery (`revertPlan`/`revertOp`, ~783–920), but it only operates on `s.last.applied`, which the `"proposal"` variant of `ScaffoldRound` doesn't carry (confirmed: `engine/architect.ts` ~219–223 — `"proposal"` has no `applied`/`before`/`after`, only `"edits"` does). So a freshly-generated cast — the common case — has nothing to reject yet.

**Fix.** Reuse the existing convention rather than inventing new state:
1. `engine/architect.ts`: give the `"proposal"` variant of `ScaffoldRound` an optional `rejectable: {field: string; before: unknown; after: unknown}[]`. In `takeStaged`/`takeProposal` (~555–590, ~693–705), when a cast-stage proposal lands, compute the same `{field: "added <Name>", before: null, after: <char>}` shape `applyEdits` already produces for an author-typed "add a character" edit — `revertOp`'s `^added (.+)$` case (`interview.js` ~860–870) already understands this shape end-to-end.
2. `interview.js`: a per-character "reject" button (in `castHtml`) and a per-field "reject" next to Block C's inline goal/knows fields (once that edit appears in an `applied` list). Both route through a small `revertOne(entry)` wrapper: take the single matching entry out of `s.last.rejectable` (proposal) or `s.last.applied` (edits), run it through the existing `revertPlan`/`revertOp` for that one entry, POST `/scaffold/set` exactly as `revertRound()` does today. No new route, no new host method.

**Files:** `engine/architect.ts` (`ScaffoldRound`'s `"proposal"` variant + `takeStaged`/`takeProposal`), `interview.js` (reject buttons + `revertOne` wrapper).

**Layer:** small engine/architect.ts change (new field, populated from data already computed) + UI. No route or schema change.

---

## Block H — Per-item merge on a full-gate regenerate

**Gap.** `mergedRaw()` (`engine/architect.ts` ~474–529, confirmed by reading the source) starts from `{...this.spec}` so untouched *gates* survive a regenerate, but the cast branch does `raw.characters = Array.isArray(out.characters) ? out.characters : [];` (line 481) — a full wholesale replace. Any character hand-edited since the last generation is silently lost on a full "regenerate cast."

**Fix.** Once Block F exists, the common case (regenerate one named character) is already safe by construction — only that one entry is ever replaced. This block only needs to cover the remaining **unscoped, whole-gate** regenerate:
1. Add a single in-memory baseline field on `ScaffoldSession`: `lastGeneratedCharacters: Map<string, CharacterDef> | null`, snapshotted (keyed by lower-cased name) immediately after any cast-stage proposal or regenerate lands. One slot, overwritten each time — not a history stack, matching the "no versioning" constraint.
2. In `mergedRaw`'s cast branch: for each name present in both the fresh reply and `this.spec.characters`, per travelling field — if the character's current value still equals the baseline's value for that field (untouched by the author since generation), take the fresh value; if it differs (author edited it), keep the current value for that field. A character missing from the fresh reply but present in the spec is kept (mirrors `applyImportContract`'s "added back unchanged" policy, ~166–174). A genuinely new character in the fresh reply is added.
3. Reset the baseline to the merged result after applying.

**Files:** `engine/architect.ts` only (new private field + `mergedRaw`'s cast branch, ~480–481).

**Layer:** engine/architect.ts only. No prompt, route, or UI change — the existing "regenerate cast" button's behavior simply stops clobbering hand edits.

---

## Verification

Per-block: `npx tsc`, `npm test`, `npm run lint` (or the bundled `npm run check`) after each block, not after every edit. For UI-only blocks (A, B, C's UI half, E, F2, G's UI half), also load the scaffold in a browser (`npm run test:gui` covers the mechanical Playwright pass; manually exercise the new controls — inspect-before-select, create-and-return, goal/knows edit, collapsed model picker, per-character regenerate, reject — since `GUI-CHECKLIST.md` notes what Playwright can't see). Live-model runs (actually calling the architect to test F1's scoped prompt and H's merge behavior) are the owner's to run, batched, once F1/F2/H land.
