# Architect

**Status: both screens built.** The mockups below are a proposed redesign, not a description of
missing work; see [Readiness](#readiness) for what is actually there and what is still missing.

This document is the GUI-facing reference for the architect: the role, the user experience, and the
proposed scaffold and handoff screens. **It owns those two screens.** The route contract stays in
[`GUI-SPEC.md`](GUI-SPEC.md) and the engine behaviour in [`SPEC-H-handoff.md`](SPEC-H-handoff.md).
[`SPEC-E-editor.md`](SPEC-E-editor.md) owns a different screen — the direct `story.json` form editor,
whose architect panel edits an in-memory draft and is not the handoff.

## Role

The architect is a planning and continuity agent. It does not write chapter prose and it does not
make character decisions inside a scene.

It has two modes:

- **Scaffold**: turn a rough idea into a new `story.json` through questions, a proposal, refinements,
  and an explicit accept action.
- **Handoff**: run between chapters, read the accepted chapter prose, and re-author the story
  definition for the next chapter.

The architect is a normal `Agent` with its own prompt, history, model, thinking level, and temperature
(`0.9`). The surrounding engine extracts JSON, normalizes it into a `StorySpec`, applies only supported
edits, and reports non-fatal problems separately from model errors.

## Operating Principle

Agent history does not carry between chapters. The story definition is the only continuity mechanism.

The handoff turns consequences in accepted prose into durable story state:

- New knowledge becomes `characters[].knows`.
- Changed motivations become `characters[].goal`.
- Lasting personality changes become `characters[].persona`.
- Lost capabilities become `characters[].restrictions`.
- Characters who are absent from the next chapter are removed from that scene's `roster`.
- New dramatic pressure becomes a new or revised scene definition.

The architect must not invent an unsupported consequence. If the chapters do not establish whether a
character changed, it should ask rather than put an unverified fact into the story.

## Conversation Rules

### Scaffold

The architect first checks whether the idea explains:

- who is in the scene
- what is at stake

If either is missing, it asks one load-bearing question. Otherwise it proposes the complete story.
Follow-up messages produce structured edits and preserve fields that were not mentioned.

### Handoff

The architect receives:

- the premise
- all accepted `chapters/<n>.md` files
- the current normalized story definition

It prepares the chapter after the highest written chapter. It may update the cast, scene roster, scene
definition, and story structure, but it must not write the next chapter's prose.

The author can refine the proposal conversationally. Accepting writes `story.json`; it does not start
the next run. The GUI must offer the prepared chapter as a separate action.

## Round Shapes

The routes, their bodies, and the state each one publishes are the single contract in
[`GUI-SPEC.md`](GUI-SPEC.md) — *Scaffold* and *The handoff*. What the screens below need from it is
which rounds each mode can actually produce:

| mode | `last.kind` |
| --- | --- |
| scaffold | `proposal` \| `edits` \| `question` \| `nothing` \| `failed` |
| handoff | `edits` \| `question` \| `nothing` \| `failed` |

The handoff never returns `proposal`. Its first round is already an edit list against the story on
disk, so the proposed-next-chapter panel renders from `spec` and `last.applied`, never from a
proposal round.

The two flows are:

```text
scaffold: start → proposal → say/refine → accept (folder) → run
handoff:  start → edits    → say/refine → accept → select prepared chapter → run
                                       ↘ abandon
```

Both frames have a consumer: the scaffold modal and the handoff page
([sse.js](server/gui/viewer/sse.js)). Neither screen is an engine feature — the routes below were
there first, and the panels only read them.

## GUI Direction

An interactive static prototype is available at
[`architect-mockup.html`](architect-mockup.html). It demonstrates the handoff and scaffold modes,
question and edit rounds, accept flow, theme toggle, and responsive layout without calling the API.

Use the existing viewer language:

- shelf cards for story selection
- `.picker.story` for story-level actions
- `.iv` panels for interview/conversation content
- `.thinking` for an in-flight model call
- `.said.bad` for errors
- `.prob` for warnings
- existing `btn`, `primary`, `tab`, and `divider` styles

Do not make the architect a full-screen chat application. The conversation is a tool for changing a
visible story proposal, not the primary artifact.

The main layout should always keep these three things visible:

1. What story or chapter is being prepared.
2. What the current proposed definition looks like.
3. What the architect most recently asked, changed, or failed to do.

## Mockup A: New Story Scaffold

This screen is **already built** as a modal in [`interview.js`](server/gui/viewer/interview.js). What
follows is a proposed redesign of it, not a description of missing work.

### Desktop

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ STORY WRITER                                    [theme] [models] [connection]│
├──────────────────────────────────────────────────────────────────────────────┤
│ NEW STORY                                                               [x]  │
│                                                                              │
│ Idea                                                                         │
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
│ │ A lighthouse keeper must decide whether to log a signal nobody else heard│ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
│                                                     [start architect]        │
│                                                                              │
│ ┌──────────────────────────────────┐  ┌────────────────────────────────────┐ │
│ │ PROPOSAL                         │  │ ARCHITECT                          │ │
│ │                                  │  │                                    │ │
│ │ The Last Signal                  │  │ “Who is affected if the signal is  │ │
│ │ Scene 1 · lighthouse · ~700 words│  │ not logged?”                       │ │
│ │                                  │  │                                    │ │
│ │ Question                         │  │ [answer the question]              │ │
│ │ Will Mara report the signal?     │  │ [say what to change...]            │ │
│ │                                  │  │                                    │ │
│ │ CAST                             │  │ [send]                             │ │
│ │ MARA  cannot: hearing            │  │                                    │ │
│ │ IVO   knows: the log is falsified│  │                                    │ │
│ │                                  │  │                                    │ │
│ │ [expand details]                 │  │                                    │ │
│ └──────────────────────────────────┘  └────────────────────────────────────┘ │
│                                                                              │
│ [accept and choose folder]                          [abandon]                │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Behavior

- The idea field is shown only before the first proposal.
- While `/scaffold/start` or `/scaffold/say` is running, disable sending and show `.thinking`.
- A `question` round focuses the answer field and labels it as the architect's question.
- A `proposal` or `edits` round updates the proposal panel without clearing the conversation context.
- `problems` are shown beneath the proposal. Warnings do not automatically prevent refinement.
- Accept opens a folder-name step when the server returns `needs_folder`.
- Accept does not disappear until the server returns `kind: "written"`.

### Mobile

```text
┌──────────────────────────────┐
│ NEW STORY                 [x]│
├──────────────────────────────┤
│ IDEA                         │
│ ┌──────────────────────────┐ │
│ │ describe the story...    │ │
│ └──────────────────────────┘ │
│ [start architect]            │
│                              │
│ ── PROPOSAL ──────────────── │
│ The Last Signal              │
│ lighthouse · ~700 words      │
│                              │
│ Question                     │
│ Will Mara report the signal? │
│                              │
│ CAST                         │
│ MARA · cannot hear           │
│ IVO · knows the truth        │
│                              │
│ ── ARCHITECT ─────────────── │
│ Who is affected if it is not │
│ logged?                      │
│ ┌──────────────────────────┐ │
│ │ answer or request change │ │
│ └──────────────────────────┘ │
│ [send]                       │
│                              │
│ [accept] [abandon]           │
└──────────────────────────────┘
```

On mobile, the proposal comes before the conversation because the proposal is the artifact being
reviewed. Keep the architect input sticky at the bottom while the proposal scrolls.

## Mockup B: Next-Chapter Handoff

### Desktop

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ STORY: THE LAST SIGNAL                        HANDOFF · PREPARE CHAPTER 2    │
├──────────────────────────────────────────────────────────────────────────────┤
│ CHAPTERS WRITTEN                 PROPOSED NEXT CHAPTER                       │
│ ┌──────────────────────┐         ┌─────────────────────────────────────────┐ │
│ │ ✓ Chapter 1          │         │ CHAPTER 2                               │ │
│ │   read · 812 words   │         │ Place                                   │ │
│ │                      │         │ storm room                              │ │
│ │   architect reads    │         │                                         │ │
│ │   accepted prose     │         │ Question                                │ │
│ └──────────────────────┘         │ Will Ivo expose the falsified log?      │ │
│                                  │                                         │ │
│                                  │ CAST CHANGES                            │ │
│                                  │ IVO · goal changed                      │ │
│                                  │ MARA · restriction added: hearing       │ │
│                                  │                                         │ │
│                                  │ [show all characters]                   │ │
│                                  └─────────────────────────────────────────┘ │
│                                                                              │
│ ARCHITECT                                                                    │
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
│ │ The chapter changed Ivo's goal. Ask for a correction or add context...   │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
│ [send]                                                                       │
│                                                                              │
│ [accept handoff]                                      [abandon]              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Handoff states

#### Preparing

```text
CHAPTER 2 · ARCHITECT IS READING CHAPTER 1
.thinking  Reviewing accepted prose…
```

Disable Accept and Send while `busy` is true. Keep Abandon available unless the product decides that
an in-flight model call must be allowed to finish.

#### Question

```text
ARCHITECT QUESTION
Did Ivo actually learn that the log was falsified, or did he only suspect it?

[answer the architect...]
[send]
```

The question should be visually distinct from an ordinary suggestion. It blocks a meaningful proposal
until answered, but it does not write anything.

#### Edits available

```text
CHANGES TO REVIEW
✓ IVO.goal
✓ MARA.restrictions

NOT APPLIED
✗ remove_scene 1 — chapter 1 is already written

WARNINGS
⚠ scene_2 has no roster

[accept handoff] [ask for changes]
```

`last.applied`, `last.ignored` and `problems` are three different lists and belong in three separate
blocks. An edit the architect asked for and the engine refused is not a validation warning about the
story that resulted.

#### Accepted

```text
HANDOFF ACCEPTED
Chapter 2 is prepared.

[write chapter 2]
[return to story]
```

The Write button must call `POST /select { dir, chapter }`. The handoff itself does not start the run.

### Mobile

```text
┌──────────────────────────────┐
│ THE LAST SIGNAL               │
│ PREPARE CHAPTER 2        [x] │
├──────────────────────────────┤
│ ACCEPTED CHAPTERS             │
│ ✓ Chapter 1 · 812 words       │
│                              │
│ ── PROPOSED ───────────────── │
│ CHAPTER 2                     │
│ storm room                    │
│ Will Ivo expose the log?      │
│                              │
│ CHANGES                       │
│ ✓ Ivo · goal changed          │
│ ✓ Mara · restriction added    │
│                              │
│ ── ARCHITECT ──────────────── │
│ [ask for a change...]         │
│ [send]                        │
│                              │
│ [accept handoff]              │
│ [abandon]                     │
└──────────────────────────────┘
```

Use a collapsible “accepted chapters” section on mobile. The proposed next chapter and changed fields
should remain expanded by default.

## Proposed GUI State

Add a dedicated handoff state rather than putting it into `APP.scaffold`:

```js
APP.handoff = {
  active: false,
  dir: "",
  chapter: 0,
  busy: false,
  edited: false,
  pendingAsk: "",
  problems: [],
  last: null,
  model: "",
  spec: null
};
```

Suggested additional transient fields:

```js
APP.handoffError = "";
APP.handoffSending = false;
APP.handoffDir = "";
```

`handoffDir` should be initialized from the story page, not typed by the user in a second place.

## Viewer Modules

Built, and split the way the scaffold's are:

- `handoff.js`: posting, action wiring, and the arm-to-confirm timers.
- `handoff-view.js`: the four screens' markup.
- `state.js`: `APP.handoff`, `handoffDir`, `handoffError`, `handoffDone`, the two armed timers, and
  `hdraft` — a separate draft from the scaffold's, so text typed in one screen cannot surface in the
  other.
- `sse.js`: consumes `{ t: "handoff" }` frames, and re-fetches `/next-chapter` on load so a reload
  mid-round lands back in it.
- `pages.js` / `nav.js` / `viewer.js`: the `#/handoff?dir=` route, which reads as the shelf in the tab
  bar exactly as the story page does.

The posting and error behaviour follows `interview.js` deliberately, but none of its state is shared:
the two have similar round shapes and different lifecycle rules.

## Readiness

Whether the screens above can be built against the server as it stands today.

### Scaffold — already built

The scaffold screen exists. [`interview.js`](server/gui/viewer/interview.js) renders it as a modal
over the shelf, with the idea field, the model select, the proposal panel and cast, the
`scene.length` box, `pendingAsk`, `problems`, the `.thinking` state, the folder question,
arm-to-accept, arm-to-abandon, and re-entry into an open interview after a reload. **Mockup A is a
redesign of a working screen, not new work**, and nothing on the server blocks it.

### Handoff — built, minus the chapter column

The panel is [`handoff.js`](server/gui/viewer/handoff.js) and
[`handoff-view.js`](server/gui/viewer/handoff-view.js), on its own `#/handoff?dir=` route, reached
from the story page's "prepare chapter N" button. It has four screens — nothing chosen, start,
active, accepted — and covers the round loop end to end: `busy` as `.thinking`, `pendingAsk` as a
question, `last.applied` / `last.ignored` / `problems` in three separate blocks, arm-to-confirm on
accept and abandon, and a write button that posts `POST /select { dir, chapter }`, disabled unless
the session is parked at the picker.

Two things it leans on, both landed:

- `specView` returns `scenes[]` alongside `title`, `premise`, `writerStyle` and the full cast, so the
  proposed chapter renders from `spec.scenes[chapter - 1]` and the changes list from `applied`
  entries like `IVO.goal` or `scene_2.place`.
- `/stories` carries `scenes[]` and `chapters: number[]`, which is what lets the story page name the
  chapter the handoff would prepare and hide the action for a story with nothing written.

Still missing:

1. **The chapters-written column.** `GET /chapter?dir=&n=` now serves the prose, and the story page
   reads a chapter inline, so nothing is blocked at the API — but Mockup B's "✓ Chapter 1 · 812
   words" list is not on the handoff page yet. The word count means fetching each chapter, so it is
   its own small piece of work rather than a free addition.

Known gaps that block neither:

3. `specView` omits `config`, `models` and per-character `model` — needed only if a panel shows them.
4. There is no before/after. `applied` names the field, `spec` holds the new value, and the old value
   is already gone; field-level review would need the engine to keep it.
5. Scaffold acceptance is not transactional: a story that writes but fails preflight is left on disk
   as `kind: "unloadable"`, unlike the handoff, which puts back exactly what was there.

**Verdict.** Both screens exist. What is left is the chapter column, which waits on (1) — not
architect work, but the story-data route the multi-chapter reader needs anyway.

## Safety and Product Constraints

- At most one scaffold session and one handoff session exist per process, each behind its own lock.
  Nothing forbids both being open at once, so neither screen may assume the other is closed.
- Only one architect round may be in flight per session; a second round gets `409`.
- A handoff cannot run while a chapter run is active.
- Accepting a handoff rewrites `story.json`, so the GUI should show the target story and chapter clearly.
- A failed handoff preflight restores the previous `story.json`.
- The GUI should not expose raw filesystem paths; use discovered story directories returned by the API.
- A **scaffold** architect receives a hard-coded worked example from `stories/doorway` (~1,870
  estimated tokens); this should be made story-independent before treating that prompt as fully
  portable. A **handoff** architect no longer gets it — the handoff prompt names every edit field
  inline and resends the real story each round, so the example was the format said twice.
