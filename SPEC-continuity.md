# SPEC-continuity: Fact Bible, Continuity Flags, Handoff Diff

**Status: proposed, not built.** Three ideas that all concern turning accumulated chapter prose into
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

No such field exists today — `StoryJson` (`engine/story-schema.ts`) has `title`, `premise`, `scenes`,
`writerStyle`, `characters`, `config`, `models` only; `CharacterDef.knows` is per-character, there is
no story-level equivalent for world truths nobody in particular owns (e.g. "the lighthouse hasn't
worked since the storm").

- **Schema**: add `facts: string[]` to `StoryJson`, following the same plain-list shape as
  `writerStyle`-adjacent fields rather than inventing an id/object shape.
- **Writer context**: `writerSystem()` (`prompts.ts` ~line 497, called from `engine/scene-loop.ts:35`)
  builds `THE PREMISE:`/`THE SCENE:`/`THE CAST:` blocks from a plain object. Add a `THE FACTS:` block
  in the same function, threaded from the same place `premise`/`scene`/`cast` already are.
- **Architect edit surface**: `applyEdits()` (`engine/story-spec.ts` ~line 107) already has a proven
  pattern for indexed collections — `scene_<n>.field` addresses one scene by array index. Facts should
  follow the same convention rather than a new id concept: `add_fact <text>`, `remove_fact <n>`,
  `update_fact <n> <text>`, targeting `facts[n]` the same way scene edits target `scenes[n]`.
- **Prompts**: `architectNextChapter()` (`prompts.ts` ~line 172) needs its `[STORY FACTS]` input block
  and the new `add_fact`/`remove_fact`/`update_fact` entries added to its edit-field grammar (alongside
  the existing `title`/`characters.<NAME>.persona`/`scene_<n>.*` list, ~line 222). The scaffold's
  `architectSystem`/worked example (`prompts.ts` ~line 152) needs the same additions so facts can be
  proposed on the *first* story proposal, not only introduced later during a handoff.

**Files:** `engine/story-schema.ts`, `engine/story-spec.ts`, `prompts.ts`, `engine/scene-loop.ts`
(threading `sc.facts` into the writer-context call).

**Tests:** `tests/story-spec.test.ts` for the three new edit ops; `tests/story-format.test.ts` for the
schema default; a `prompts`-adjacent test (or extend an existing writer-prompt test) confirming facts
appear in `writerSystem()`'s output.

## B. Continuity flags in the handoff round

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

**Tests:** `tests/architect.test.ts` — a round whose model response includes `flags` passes them
through untouched and does not fold them into `applied`/`problems`.

## C. Before/after diff for handoff edits

Today `applyEdits()` (`engine/story-spec.ts` ~lines 111-187) clones `spec` into a mutated `draft` and,
at each edit, pushes only a bare field label to `applied` (e.g. `applied.push(field)` line ~131,
`applied.push(\`${c.name}.${targetField}\`)` line ~178) — the old value is one line away at each of
these seven call sites (readable off `draft` immediately before the mutating assignment, or off the
original untouched `spec`), it's just never captured.

- Change each `applied.push(field)` call to `applied.push({ field, before, after })`, reading `before`
  from `spec` (or pre-mutation `draft`) at that exact point and `after` from the value being assigned.
  `add_scene`/`remove_scene`/`add_character`/`remove_character` are structural, not field-level — for
  those, `before`/`after` should be `undefined`/the added object (or the removed object/`undefined`),
  not a value diff, so the GUI can distinguish "changed" from "added"/"removed".
- `draft` is re-normalized into `next` at the end (line ~185), so `after` should reflect the
  **normalized** result the caller actually receives, not the raw edit `value` — read it off `next`
  after normalization rather than off `draft` mid-loop, or defer filling `after` until normalization
  completes.
- `applied` changes shape from `string[]` to `{ field: string; before: unknown; after: unknown }[]`.
  This is a breaking shape change for existing consumers: `handoff-view.js`'s "CHANGES TO REVIEW" list
  (`Architect.MD` Mockup B) currently renders `applied` entries as bare labels (`IVO.goal`,
  `MARA.restrictions`) — update it to render `field` as the label and show `before → after` beneath it
  when both are present.

**Files:** `engine/story-spec.ts` (`applyEdits`), `GUI-SPEC.md` (the `applied` shape in the handoff
round-result), `server/gui/viewer/handoff-view.js`.

**Tests:** `tests/story-spec.test.ts` — a scalar field edit produces the right `before`/`after` pair,
an `add_scene`/`remove_character` produces the added/removed-object shape, and `after` reflects
post-normalization values (e.g. a coerced number) rather than the raw edit input.

## Blocks

1. **Fact bible** (A) — schema, writer prompt, architect edit ops on both scaffold and handoff. Self-
   contained; nothing else here depends on it, though (B) reads more naturally once facts exist as a
   substrate to check contradictions against.
2. **Continuity flags** (B) — prompt/response schema, `NextChapterSession` passthrough, the GUI's
   fourth block. Best done after (A) so there's a concrete fact list to check chapters against, but not
   strictly blocked by it — flags can also catch contradictions against `knows`/prior chapters alone.
3. **Handoff diff** (C) — `applyEdits`'s shape change and the corresponding `handoff-view.js` render
   update. Independent of (A) and (B); pure engine + one GUI file.

**Verify (all three):** `npx tsc`, `npm test`. (B) additionally needs an owner-run handoff against a
multi-chapter story with a deliberately introduced contradiction, to confirm the architect actually
flags it rather than silently rewriting state — `npx tsx story-writer.ts stories/<name> --next-chapter`.

## Out of scope

- Auto-resolving a continuity flag into an edit — flags are advisory only, by design (see B).
- A story-level fact bible editable from the scaffold/handoff GUI panels directly (as opposed to
  through the architect conversation) — that's [`SPEC-E-editor.md`](SPEC-E-editor.md)'s concern if it
  happens at all.
- Diffing anything other than the current round's edits (C is not a full story-version history).
