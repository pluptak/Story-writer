# Architect

**Status: built — both modes and both screens.** What is left is listed under
[Remaining work](#remaining-work).

This document owns the architect: its role, the between-chapters handoff behaviour, and the two
screens that drive it (the scaffold interview and the handoff panel). The route contract stays in
[`GUI-SPEC.md`](GUI-SPEC.md), which is the single source of truth for request bodies, replies and SSE
state. The proposed `story.json` form editor ([`PLANS.md`](PLANS.md) plan 1) is a different screen —
its architect panel edits an in-memory draft and is not the handoff.

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

## Operating principle

Agent history does not carry between chapters. Agents are rebuilt for every chapter and no character
remembers the last one. **The story definition is the only continuity mechanism**, which is what makes
the handoff a real step rather than bookkeeping.

The handoff turns consequences in accepted prose into durable story state:

- New knowledge becomes `characters[].knows`.
- Changed motivations become `characters[].goal`.
- Lasting personality changes become `characters[].persona`.
- Lost capabilities become `characters[].restrictions`.
- Characters who are absent from the next chapter are removed from that scene's `roster`. A character
  who died can leave the roster while remaining in `characters[]` for historical context or later use.
- New dramatic pressure becomes a new or revised scene definition.
- World truths nobody in particular owns become story-level `facts`.

The architect must not invent an unsupported consequence. If the chapters do not establish whether a
character changed, it should ask rather than put an unverified fact into the story.

## Handoff behaviour

The handoff prepares the next chapter between runs. It is a user-invoked action, not another step
inside a scene run.

- One run writes one chapter, selected by `--chapter=<n>` or `POST /select { dir, chapter }`.
- A successful run writes prose to `chapters/<n>.md`, and the `story.json` it was written from to
  `chapters/<n>.json`. The snapshot lives beside the prose because `out/` is rotated at `MAX_RUNS`,
  and it is a verbatim copy so it records the authored story rather than a normalized one. Failing to
  write it costs the snapshot, never the chapter. Chapter discovery still keys on `<n>.md` alone.
- A stopped or incomplete run does not replace an existing accepted chapter file.
- The handoff reads the highest numbered accepted chapter and prepares the next number.
- The architect proposes edits; it never writes directly during a conversation.
- Accept writes `story.json`, validates it with preflight, and restores the previous file if
  validation fails.
- The handoff does not start a run. The user starts the prepared chapter separately.

### Edit surface

The architect can edit the fields supported by `engine/story-spec.ts`:

- story metadata: `title`, `premise`, and `writerStyle`
- scenes: `scene_<n>.place`, `question`, `pov`, `length`, and `roster`
- scene structure: `add_scene` and `remove_scene`
- characters: `persona`, `knows`, `goal`, `skills`, and `restrictions`
- cast membership: `add_character` and `remove_character`
- story facts: `add_fact`, `remove_fact`, and an indexed update of `facts[n]`

Removing the last scene is refused. Two things are refused because they would rewrite history:
removing a scene that already has accepted prose, since renumbering would make existing
`chapters/<n>.md` files refer to different scenes; and editing any field of such a scene, since the
prose on disk answers the older question. An unnumbered `scene.<field>` means scene 1 and is refused
on the same terms once chapter 1 exists.

A refusal is reported as an ignored edit, not an error — the round still applies everything else.

### Drift warning

Opening a handoff also compares each written chapter against its `chapters/<n>.json` snapshot and
reports a **warning** when the scene has since changed. That path exists for edits made by hand,
which the refusals above cannot reach; revising your own story is legitimate, so it is said rather
than undone. Chapters written before snapshots existed have nothing to compare and pass quietly.

### Continuity flags are advisory

A handoff round can return `flags` — plain observations that the accumulated prose contradicts itself,
or contradicts `facts`/`knows`. The architect already reads every accepted chapter in one call, so a
continuity check needs no new agent and no new information-boundary decision.

**Flags must never be resolved through `edits`.** A contradiction is exactly the kind of thing the
architect must not silently fix by rewriting character state; it surfaces the problem and the author
resolves it. Flags block nothing, and they are not `problems` — `problems` are validation warnings
about the story that resulted, flags are observations about the prose that already exists.

## Conversation rules

### Scaffold

The architect first checks whether the idea explains:

- who is in the scene
- what is at stake

If either is missing, it asks one load-bearing question. Otherwise it proposes the complete story.
Follow-up messages produce structured edits and preserve fields that were not mentioned.

### Handoff

The architect receives the premise, all accepted `chapters/<n>.md` files, and the current normalized
story definition. It prepares the chapter after the highest written chapter. It may update the cast,
scene roster, scene definition, and story structure, but it must not write the next chapter's prose.

The author can refine the proposal conversationally. Accepting writes `story.json`; it does not start
the next run. The GUI must offer the prepared chapter as a separate action.

## Round shapes

Which rounds each mode can produce — the bodies and the state each route publishes are
[`GUI-SPEC.md`](GUI-SPEC.md)'s *Scaffold* and *The handoff* sections:

| mode | `last.kind` |
| --- | --- |
| scaffold | `proposal` \| `edits` \| `question` \| `nothing` \| `failed` |
| handoff | `edits` \| `question` \| `nothing` \| `failed` |

The handoff never returns `proposal`. Its first round is already an edit list against the story on
disk, so the proposed-next-chapter panel renders from `spec` and `last.applied`, never from a
proposal round.

```text
scaffold: start → proposal → say/refine → accept (folder) → run
handoff:  start → edits    → say/refine → accept → select prepared chapter → run
                                       ↘ abandon
```

## The screens

The visual prototype is [`architect-mockup.html`](architect-mockup.html) — an interactive static page
covering both modes, question and edit rounds, the accept flow, the theme toggle and the responsive
layout, without calling the API. **It is the picture; this section is the rules.**

Use the existing viewer language: shelf cards for story selection, `.picker.story` for story-level
actions, `.iv` panels for interview content, `.thinking` for an in-flight model call, `.said.bad` for
errors, `.prob` for warnings, and the existing `btn`, `primary`, `tab` and `divider` styles.

Do not make the architect a full-screen chat application. The conversation is a tool for changing a
visible story proposal, not the primary artifact. The layout keeps three things visible at all times:

1. What story or chapter is being prepared.
2. What the current proposed definition looks like.
3. What the architect most recently asked, changed, or failed to do.

On mobile the proposal comes *before* the conversation, because the proposal is the artifact being
reviewed; the architect input stays sticky at the bottom while the proposal scrolls.

### Scaffold interview

Built as a modal over the shelf in [`interview.js`](server/gui/viewer/interview.js): the idea field,
the model select, the proposal panel and cast, the `scene.length` box, `pendingAsk`, `problems`, the
`.thinking` state, the folder question, arm-to-accept, arm-to-abandon, and re-entry into an open
interview after a reload. `architect-mockup.html`'s scaffold screen is a **redesign of that working
screen**, not a description of missing work.

Behaviour the redesign must keep:

- The idea field is shown only before the first proposal.
- While `/scaffold/start` or `/scaffold/say` is running, sending is disabled and `.thinking` shows.
- A `question` round focuses the answer field and labels it as the architect's question.
- A `proposal` or `edits` round updates the proposal panel without clearing the conversation context.
- `problems` are shown beneath the proposal; warnings do not prevent further refinement.
- Accept opens a folder-name step when the server returns `needs_folder`, and does not disappear until
  the server returns `kind: "written"`.

### Handoff panel

Built as [`handoff.js`](server/gui/viewer/handoff.js) and
[`handoff-view.js`](server/gui/viewer/handoff-view.js) on its own `#/handoff?dir=` route, reached from
the story page's "prepare chapter N" button. Four states:

- **Preparing** — `busy` renders as `.thinking`; Accept and Send are disabled, Abandon stays available.
- **Question** — `pendingAsk` is visually distinct from an ordinary suggestion. It blocks a meaningful
  proposal until answered, but writes nothing.
- **Edits available** — `last.applied`, `last.ignored`, `flags` and `problems` are **four different
  lists and belong in four separate blocks**. An edit the architect asked for and the engine refused
  is not a validation warning about the resulting story, and neither is a continuity flag. Applied
  entries carry `field`, `before` and `after`, so each one renders as a labelled before → after line;
  `add_scene`/`remove_scene`/`add_character`/`remove_character` are structural and show the added or
  removed object rather than a value diff.
- **Accepted** — offers to write the prepared chapter. That button calls `POST /select { dir, chapter }`
  and is disabled unless the session is parked at the picker; the handoff itself never starts a run.

The proposed chapter renders from `spec.scenes[chapter - 1]`, and the story page names the chapter a
handoff would prepare from `/stories`'s `scenes[]` and `chapters: number[]` — which is also what hides
the action for a story with nothing written.

### Viewer modules

Split the way the scaffold's are:

- `handoff.js`: posting, action wiring, and the arm-to-confirm timers.
- `handoff-view.js`: the four states' markup.
- `state.js`: `APP.handoff`, `handoffDir`, `handoffError`, `handoffDone`, the two armed timers, and
  `hdraft` — a separate draft from the scaffold's, so text typed in one screen cannot surface in the
  other.
- `sse.js`: consumes `{ t: "handoff" }` frames, and re-fetches `/next-chapter` on load so a reload
  mid-round lands back in it.
- `pages.js` / `nav.js` / `viewer.js`: the `#/handoff?dir=` route, which reads as the shelf in the tab
  bar exactly as the story page does.

The posting and error behaviour follows `interview.js` deliberately, but none of its state is shared:
the two have similar round shapes and different lifecycle rules.

## Console and HTTP surfaces

```bash
npx tsx story-writer.ts stories/example --next-chapter
npx tsx story-writer.ts stories/example --chapter=2
```

The HTTP equivalents are `GET /next-chapter` and `POST /next-chapter/{start,say,accept,abandon}`,
specified in [`GUI-SPEC.md`](GUI-SPEC.md). The server reaches the engine through `ServerHost` and never
imports engine modules directly.

## Remaining work

- **The chapters-written column** on the handoff panel — a "✓ Chapter 1 · 812 words" list beside the
  proposed chapter. `GET /chapter?dir=&n=` serves the prose, so nothing is blocked at the API, but the
  word counts mean one fetch per chapter. Tracked in [`PLANS.md`](PLANS.md).
- `specView` omits `config`, `models` and per-character `model` — needed only if a panel shows them.
- Scaffold acceptance is not transactional: a story that writes but fails preflight is left on disk as
  `kind: "unloadable"`, unlike the handoff, which puts back exactly what was there.
- A **scaffold** architect receives a hard-coded worked example from `stories/doorway` (~1,870
  estimated tokens); making it story-independent is what stands between that prompt and being
  portable. A **handoff** architect no longer gets it — the handoff prompt names every edit field
  inline and resends the real story each round, so the example was the format said twice.

## Safety and product constraints

- At most one scaffold session and one handoff session exist per process, each behind its own lock.
  Nothing forbids both being open at once, so neither screen may assume the other is closed.
- Only one architect round may be in flight per session; a second round gets `409`.
- A handoff cannot run while a chapter run is active — the run is reading the file the handoff rewrites.
- Accepting a handoff rewrites `story.json`, so the GUI shows the target story and chapter clearly.
- A failed handoff preflight restores the previous `story.json`.
- The GUI does not expose raw filesystem paths; it uses the story directories the API discovered.

## Out of scope

- Carrying agent histories across chapters.
- Starting a chapter automatically after accepting a handoff.
- Deciding what to do with later chapters when an earlier chapter is rewritten.
- Auto-resolving a continuity flag into an edit — flags are advisory by design.
