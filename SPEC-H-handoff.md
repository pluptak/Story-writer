# SPEC-H — the architect handoff

**Status: prerequisite blocks P0-P2 built; P3 and the H blocks not yet.** Read this before touching
`runChapter`, `renderStory`, or anything that decides what a run writes. The engine changes here are prerequisites for the GUI work in
[SPEC-E-editor.md](SPEC-E-editor.md) and [SPEC-GUI-MULTISCENE.md](SPEC-GUI-MULTISCENE.md).

## Context

A story has chapters. Nothing in the engine carries state from one to the next: a character's agent is
built once from `story.json` and a chapter's writer starts from a blank history. That looks like a
continuity bug and is not one — the intended mechanism is an **architect handoff** that rewrites the
cast between chapters, so a chapter always opens from a starting point that already encodes what
happened. A character who died in chapter 1 is simply absent from chapter 2's roster.

The handoff is a **menu action, not a step inside a run**. Selecting a story offers four things:

```
   stories/doorway
     1. write a chapter          ← a new one, or re-run one already written
     2. read the story           ← every chapter written so far, in order
     3. edit the story           ← SPEC-E
     4. prepare the next chapter ← the architect handoff; this document
```

This matches SPEC-E's "**one run per chapter**, each with its own write button and its own runs".
The old `writeScenes` contradicted it — it looped every scene in one run — and block P2 replaced it
with [`runChapter`](engine/scene-loop.ts).

> SPEC-E's *mechanics* are stale: it was written against the `story.md` / kv format, before `21960a9`
> moved the story to JSON, and its central complaint (no `story.md → StorySpec` parser) no longer
> applies — `normalizeSpec` consumes a parsed `story.json` almost directly. Its **decisions** stand.

## Decisions taken

| question | decision |
|---|---|
| when the handoff runs | a **user-invoked menu action** between runs, never inside one |
| what a run writes | **one chapter**, chosen by the user |
| what the architect may re-author | **everything**: personas, `knows`, goals, skills/restrictions, the next chapter's scene definition and roster, and the number of chapters remaining |
| killing a character off | drop them from the next chapter's **`roster`** — they stay in `characters[]` |
| writing to disk | **propose, then accept** — the architect never writes `story.json` directly (SPEC-E's rule) |
| character memory across chapters | **none** — the re-authored definition is the carrier, so agents are rebuilt per chapter |
| `config` / `models` | move onto `StorySpec`, so `renderStory` stops inventing them |
| `CharacterDef.goals[]` | **removed** — an artefact of the old 3-chapter cap; `goal` becomes the live goal the handoff re-authors |

## Two things that must be fixed first

**`renderStory` is lossy.** [story-spec.ts:211](engine/story-spec.ts#L211) hardcodes `config` to three
keys, emits only `models.default`, and writes `model: ""` for every character
([story-spec.ts:195](engine/story-spec.ts#L195)). Since the handoff writes the story back through it,
every invocation would silently reset `maxProseWords`, `thinking`, `stream`, `requestTimeout`,
`attempts`, `maxTokens`, `models.writer`/`summary` and every per-character model override. The feature
is destructive until this is fixed. It is already a live bug on the scaffold's accept path.

**Chapter prose does not survive.** [`runAndSave`](story-writer.ts#L359) rotates `out/` to
`MAX_RUNS = 3`, so chapter 1's prose is deleted after three later runs. Both the reader (menu 2) and
the handoff — which has to summarize what actually happened — would find nothing to read.

## Blocks

Each finishes before the next starts. P0 and P1 both rework `normalizeSpec`/`renderStory` and the same
test regions, so they are strictly sequential; P2 and P3 are independent of both.

**Done so far: P0, P1, P2.** Next up is P3.

### P0 — remove `CharacterDef.goals[]`

Delete `goals` from [story-schema.ts:24](engine/story-schema.ts#L24), from `CharacterDef`
([story-format.ts:20](engine/story-format.ts#L20)), from `StorySpec`, the `"goal 1"`/`"goal 2"`/
`"goal 3"` wire keys `normalizeSpec` reads, the `characters.<NAME>.goal_<n>` edit field, and
`chapterGoal` in [scene-loop.ts:350](engine/scene-loop.ts#L350). `goal` becomes the character's goal
for the chapter about to be written.

This drops the four `goals` tests added alongside it — they cover machinery that is going away.

> This removes any way to *pre-author* a multi-chapter arc before running anything. If that is wanted
> back, its home is the scene rather than the character: `scenes[n]` already knows its roster.

### P1 — `renderStory` stops being lossy

`StorySpec` grows `config` and `models`. `normalizeSpec` reads them from raw input, falling back to the
`StoryJson` schema defaults. `renderStory` emits them from the spec; its `models: { default }` argument
becomes the fallback for a scaffold that has no story yet.

**The trap:** `applyEdits` deep-clones the spec and re-normalizes it
([story-spec.ts:100](engine/story-spec.ts#L100), [:166](engine/story-spec.ts#L166)). If `normalizeSpec`
does not read `o.config`, every edit silently resets config to defaults — the exact failure that wiped
`goals`, where an unrelated `title` edit blanked them. The handoff runs entirely through `applyEdits`,
so this would fire on every use.

Tests: an unrelated edit leaves `config` and `models` untouched; and
`loadStory → normalizeSpec → renderStory → loadStory` is a fixed point, including per-character
`model` and every `config` key.

### P2 — one run per chapter

Replace `writeScenes` with `runChapter(sc, n, log)`: build the agents for chapter `n`'s roster, call
`writeScene`, return. The accumulating agent map goes; each run builds its own, which is what the
no-memory decision requires. The chapter to write is chosen by the caller: a `--chapter` flag
defaulting to 1, and an optional `chapter` on `POST /select`. The pick carries it — `LIVE.pickResolve`
resolves with `{ dir, chapter }` — rather than a separate field, so the scaffold's own pick path has
to state a chapter too and nothing can go stale between runs.

Two things from the multi-scene code became vestigial and went with it: the chapter separator in
`runAndSave`, since a one-chapter run never changes chapter mid-file, and the `story_end` event
entirely — `scene_end` already carries `chapter`, `done`, `stopped`, `steps` and `words`, so a run's
terminal event is `scene_end`.

> **`out/` deliberately did NOT change.** An earlier draft of this block moved run output to
> `out/chapter-<n>/<runId>/`. That would break `runDirs`, `retainedRuns`, the rotation, `StoryCard.runs`
> and the server's run-log route, all of which assume a flat `out/<runId>/`, with no GUI work in flight
> to match — and it contradicts P3, which says `out/` stays the per-run scratch area. The chapter is
> already recorded on every event in `writing-log.jsonl`; per-chapter durability is P3's job.

### P3 — durable chapter prose

On a completed chapter, write `chapters/<n>.md` next to `out/`, outside the rotation. This is the one
artifact the reader and the handoff both read. `out/` stays the per-run scratch area it is today.

### H1 — the prompt

`P.architectNextChapter(premise, specJson, chaptersSoFar)` in [prompts.ts](prompts.ts). A pure string
function, testable by assertion, no engine change. Every word said to a model lives here.

### H2 — editing the chapter list

`applyEdits` gains `add_scene` and `remove_scene`, and the `.min(1).max(3)` cap at
[story-schema.ts:53](engine/story-schema.ts#L53) is lifted. Everything else the architect needs
already exists: `characters.<NAME>.persona|knows|goal|skills|restrictions`, `remove_character`, and
`scene_<n>.place|question|pov|length|roster`.

### H3 — the session

A `NextChapterSession` shaped like [`ScaffoldSession`](engine/architect.ts#L56): send the handoff
request, apply the returned `edits` through `applyEdits`, expose the proposed `story.json` for review,
and write only on accept, with `runPreflight` as the validation gate. A failed or unparseable architect
reply leaves the story untouched and reports why.

### H4 — the two surfaces

The CLI menu entry, plus a `ServerHost` method and a route so the action exists in the viewer too.
`server/` never imports `engine/` — this needs a host method, not an import.

## Files

| file | what changes |
|---|---|
| [engine/story-schema.ts](engine/story-schema.ts) | `goals` removed; scene cap lifted |
| [engine/story-spec.ts](engine/story-spec.ts) | `config`/`models` on `StorySpec`; `renderStory` lossless; `add_scene`/`remove_scene` |
| [engine/story-format.ts](engine/story-format.ts) | `goals` off `CharacterDef` |
| [engine/scene-loop.ts](engine/scene-loop.ts) | `writeScenes` → `runChapter`; `chapterGoal` gone |
| [engine/architect.ts](engine/architect.ts) | `NextChapterSession` |
| [prompts.ts](prompts.ts) | `architectNextChapter` |
| [story-writer.ts](story-writer.ts) | the four-way story menu; per-chapter output; `chapters/<n>.md`; the new host method |
| [server/](server/) | the route for menu action 4 |

## Verification

`npx tsc`, `npm test` and `npm run preflight` after each block. Live runs are the owner's, batched —
the handoff cannot be judged without one, since its whole output is a model's re-authoring of a cast.

## Out of scope

The GUI for any of this — menu 1 and 2 are [SPEC-GUI-MULTISCENE.md](SPEC-GUI-MULTISCENE.md), menu 3 is
[SPEC-E-editor.md](SPEC-E-editor.md). Re-running a chapter that later chapters were already written
from: the handoff makes chapters depend on their predecessors, and nothing here decides what happens to
chapter 3 when chapter 2 is rewritten.
