# SPEC-continuity: Fact Bible, Continuity Flags, Handoff Diff

**Status: Sections A, B and C implemented.** Three ideas that all concern turning accumulated chapter prose into
durable, reviewable story state: a story-level fact bible, continuity flags surfaced during the
handoff, and a before/after diff for the edits the handoff already applies. The third is explicitly
named as a known gap in [`Architect.MD`](Architect.MD) ("There is no before/after... field-level
review would need the engine to keep it") — this doc is where that gets designed.

**Part of the substrate now exists.** A completed run writes `chapters/<n>.json`, a verbatim copy of
the `story.json` that produced that chapter, and `readChapterSpec` reads it back
([SPEC-H-handoff.md](SPEC-H-handoff.md)). Opening a handoff already uses it for one narrow check —
`sceneDrift`, warning when a written chapter's scene has since been edited by hand. That is the
before/after machinery in miniature: the "before" is on disk per chapter, so a fuller diff no longer
needs the engine to start keeping something it currently throws away. Note snapshots only exist for
chapters written after they were introduced.

## A. Story-level fact bible

**Implemented in Block 1.** `facts` is present in the schema and working story/spec shapes, is carried
into the writer prompt, survives story rendering/loading, and is available through the architect's
scaffold and handoff edit vocabulary. Tests cover the fact edit operations, schema default, and writer
prompt facts block.

The story-level `facts` field holds world truths nobody in particular owns (e.g. "the lighthouse
hasn't worked since the storm"). It is a plain list rather than an id/object shape, while
`CharacterDef.knows` remains per-character.

- **Schema**: `StoryJson` has `facts: string[]`, following the same plain-list shape as the
  `writerStyle`-adjacent fields.
- **Writer context**: `writerSystem()` includes a `THE FACTS:` block, threaded through
  `engine/scene-loop.ts` with the premise, scene, and cast.
- **Architect edit surface**: `applyEdits()` supports `add_fact <text>`, `remove_fact <n>`, and the
  indexed fact update operation, targeting `facts[n]` without a new id concept.
- **Prompts**: scaffold and handoff architect prompts include the story-facts input and fact edit
  vocabulary, so facts can be proposed on the first story and during later handoffs.

**Files:** `engine/story-schema.ts`, `engine/story-spec.ts`, `prompts.ts`, `engine/scene-loop.ts`
(threading `sc.facts` into the writer-context call).

**Tests:** `tests/story-spec.test.ts` covers the fact edit ops; `tests/story-format.test.ts` covers the
schema default; prompt coverage confirms facts appear in `writerSystem()`'s output.

## B. Continuity flags in the handoff round

**Implemented in Block 2.** The existing handoff architect round now returns normalized advisory
continuity flags, passes them through as a separate result list, documents them in the GUI contract,
and renders them in a distinct non-blocking handoff block. Scaffold edit rounds return `flags: []` to
keep the shared round shape stable.

**Resolves the open design question in [`next-steps1.md`](next-steps1.md)** ("decide which agent owns
[a continuity-check] call and what it may see") rather than adding a new agent.

Confirmed: the handoff already reads everything a continuity check would need, in one call.
`NextChapterSession.propose()` (`engine/architect.ts` ~line 208) calls `architectNextChapter(premise,
specJson, chapters)`, and `chapters` is **every** accepted chapter's full text, concatenated under
`[WHAT HAPPENED]` (`prompts.ts` ~line 177) — not just the latest one. Folding continuity-checking into
this existing round means no new agent, no new information-boundary decision: the architect already
sees exactly what a continuity checker would need to see, and nothing a continuity checker shouldn't
(it never sees writer/character private state either).

**The one real design decision:** flags must be **advisory, not actionable**. The architect's handoff
job today is normative — it re-authors `knows`/`goal`/`persona`/etc. This project's core rule is that
"the architect must not invent an unsupported consequence... it should ask rather than put an
unverified fact into the story" (`Architect.MD`). A continuity contradiction is exactly the kind of
thing the architect must not silently "fix" by rewriting state — it must surface it for the author to
resolve, the same way an `ask` question already blocks a round without writing anything.

- Extend `architectNextChapter()`'s response schema with a `flags: string[]` array, alongside the
  existing `edits`/`ask`/`note` (`prompts.ts` response shape ~line 220) — plain sentences like "Ivo
  reacts to the falsified log in chapter 3 as if he already knew, but no chapter establishes that he
  learned it." The prompt instructs the architect to populate this when accumulated prose conflicts
  with itself or with `facts`/`knows`, and explicitly *not* to resolve it via `edits`.
- `NextChapterSession.take()` (`engine/architect.ts` ~line 193) passes `flags` through alongside
  `applied`/`ignored`/`problems` to the round result — a fourth list, not folded into `problems`
  (which are schema-validation warnings about the *resulting* story, not prose-level continuity
  observations about what happened).
- GUI: per `Architect.MD`'s own rule ("`last.applied`, `last.ignored` and `problems` are three
  different lists and belong in three separate blocks"), flags become a fourth block in
  `handoff-view.js` — visually distinct, blocking nothing, purely informative.

**Files:** `prompts.ts` (`architectNextChapter`), `engine/architect.ts` (`NextChapterSession.take`),
`GUI-SPEC.md` (the handoff round-result shape), `server/gui/viewer/handoff-view.js`.

**Tests:** `tests/architect.test.ts` — a round whose model response includes `flags` passes trimmed,
valid flag strings through and does not fold them into `applied`/`problems`.

## C. Before/after diff for handoff edits

**Implemented in Block 3.** `applyEdits()` returns structured applied entries with normalized
`before`/`after` values. Structural additions and removals report an undefined side and the relevant
object on the other side; repeated edits retain each edit's own normalized result. The handoff view
renders concise, escaped values for review.

`applyEdits()` (`engine/story-spec.ts`) clones `spec` into a mutated `draft` and records each applied
edit with its field label, before value, and after value. Internal target descriptors resolve ordinary
single edits against the normalized result returned to the caller; repeated and structural edits keep
normalized per-edit snapshots so later edits do not overwrite earlier review entries.

- Applied entries are `{ field: string; before: unknown; after: unknown }` and are populated after the
  final `normalizeSpec()` call, so `after` is what the caller actually receives rather than the raw
  architect value.
  `add_scene`/`remove_scene`/`add_character`/`remove_character` are structural, not field-level — for
  those, `before`/`after` should be `undefined`/the added object (or the removed object/`undefined`),
  not a value diff, so the GUI can distinguish "changed" from "added"/"removed".
- Ordinary single edits resolve `after` against the final normalized `next`; repeated and structural
  edits retain normalized snapshots for their individual operations.
- `applied` changes shape from `string[]` to `{ field: string; before: unknown; after: unknown }[]`.
  This is a breaking shape change for existing consumers: `handoff-view.js`'s "CHANGES TO REVIEW" list
  (`Architect.MD` Mockup B) renders `field` as the label and shows a concise escaped `before → after`
  value line, including readable summaries for objects and arrays.

**Files:** `engine/story-spec.ts` (`applyEdits`), `GUI-SPEC.md` (the `applied` shape in the handoff
round-result), `server/gui/viewer/handoff-view.js`.

**Tests:** `tests/story-spec.test.ts` — a scalar field edit produces the right `before`/`after` pair,
an `add_scene`/`remove_character` produces the added/removed-object shape, and `after` reflects
post-normalization values (e.g. a coerced number) rather than the raw edit input.

## Blocks

1. **Fact bible** (A) — complete: schema, writer prompt, architect edit ops on both scaffold and handoff. Self-
   contained; nothing else here depends on it, though (B) reads more naturally once facts exist as a
   substrate to check contradictions against.
2. **Continuity flags** (B) — complete: prompt/response schema, `NextChapterSession` passthrough, the
   GUI's fourth advisory block, and focused passthrough tests. Best done after (A) so there's a concrete
   fact list to check chapters against, though flags also catch contradictions against `knows`/prior
   chapters alone.
3. **Handoff diff** (C) — complete: `applyEdits`'s shape change, normalized value handling, tests, and
   the corresponding `handoff-view.js` render update. Independent of (A) and (B); pure engine + one
   GUI file.

**Verify:** `npx tsc`, `npm test` are the completed cheap checks for all three blocks. B additionally
needs an owner-run handoff against a multi-chapter story with a deliberately introduced contradiction,
to confirm the architect actually flags it rather than silently rewriting state —
`npx tsx story-writer.ts stories/<name> --next-chapter`.

## Out of scope

- Auto-resolving a continuity flag into an edit — flags are advisory only, by design (see B).
- A story-level fact bible editable from the scaffold/handoff GUI panels directly (as opposed to
  through the architect conversation) — that's [`SPEC-E-editor.md`](SPEC-E-editor.md)'s concern if it
  happens at all.
- Diffing anything other than the current round's edits (C is not a full story-version history).
