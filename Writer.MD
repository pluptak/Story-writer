# Writer

**Status: the live writer screen is already built.** [`story-page.js`](server/gui/viewer/story-page.js),
[`blocks.js`](server/gui/viewer/blocks.js), [`events.js`](server/gui/viewer/events.js) and
[`hud.js`](server/gui/viewer/hud.js) already render drafts, consults, retries and accepted answers off
`/events`. [`writer-mockup.html`](writer-mockup.html) is a proposed redesign of that screen, not a
description of missing work — see [Readiness](#readiness).

This document is the GUI-facing reference for the writer. The HTTP and SSE contract remains in
[`GUI-SPEC.md`](GUI-SPEC.md); this document explains the writer's role and the proposed live-run
experience.

## Role

The writer is the scene-level prose agent. It receives the premise, selected scene, active cast,
character capabilities and restrictions, and house style. It does not receive character personas,
goals, or private knowledge.

The writer is created fresh for each chapter run with its own history, model, thinking level, and
temperature (`0.8`). Character agents are created separately for the characters in the selected
scene.

## Principle Of Operation

The writer controls narration and pressure. Character agents control character choices.

The writer must:

1. Write prose up to the next meaningful choice.
2. Stop before resolving that pressure.
3. Consult the relevant character agent.
4. Accept the answer unless it is unusable.
5. Retry through a clean character-agent fork when necessary.
6. Add only the accepted answer to the writer's history.
7. Continue the scene from the accepted answer.

The writer may describe setting, atmosphere, time passing, physical reactions without deliberate
choice, established facts, and POV perception within the character's capabilities.

The writer may not invent dialogue, deliberate actions, decisions, thoughts, feelings, or meaningful
stillness. This asymmetry is the central product invariant.

One run writes one chapter. A run can finish normally, stop when its step budget is exhausted, pause
for more budget, wait for reader direction, be stopped by the user, or end because of a model/runtime
failure.

## The Reader Seat

`/consult-me` does not seat the reader in a character's chair. It arms the reader as the **director**
for one round: the writer spends that round proposing directions instead of writing prose, they
arrive as a `reader_ask` frame — a `framing` plus up to three `options` — and whatever comes back
through `/reader-answer` is handed to the writer as the direction the scene takes from here. The
answer is free text and need not be one of the three offered.

This leaves the central asymmetry intact. The reader chooses which pressure the scene follows; the
characters still own their own choices, and the writer still has to consult them for one.

A screen therefore renders a reader round as a short list of directions, not as a question waiting
for a character's answer. Nothing in `run_state` reports that a reader question is outstanding —
`armed` means armed and not yet asked, and it is cleared before the prompt goes out — so a screen
that wants to show "waiting on the reader" tracks `reader_ask` and `reader_answer` itself.

## API Summary

The current API is sufficient for a functional live writer screen.

```text
GET  /run
GET  /stories
GET  /models
GET  /events                         SSE
GET  /log.jsonl
GET  /runs/log?dir=&id=

POST /select              { dir, chapter? }
POST /stop
POST /pause
POST /resume
POST /continue           { steps }
POST /model              { model }
POST /interactive        { on }
POST /consult-me
POST /reader-answer      { answer }
```

The SSE stream exposes drafts, consults, clarifications, retries, accepted answers, reader prompts,
budget prompts, model changes, and the final `scene_end` event. The GUI can reconstruct the complete
live run from those events.

## Readiness

**Verdict: build the redesign now.** Every route the live screen needs (API Summary, above) already
works and is already exercised by the shipped viewer. Nothing below blocks a redesign of the existing
screen — they are refinements, and two of them are already someone else's tracked work rather than a
writer-screen gap.

### Ready

The full run-control surface — `/run`, `/events`, `/select`, `/stop`, `/pause`, `/resume`, `/continue`,
`/model`, `/interactive`, `/consult-me`, `/reader-answer` — is implemented and is what
[`story-page.js`](server/gui/viewer/story-page.js) and [`blocks.js`](server/gui/viewer/blocks.js)
already drive. The reader round's `framing` and `options[]` are on the wire already, so the mockup's
three-direction panel needs no new field — see [The Reader Seat](#the-reader-seat).

`writer-mockup.html` can be built against the real API as-is.

### Tracked elsewhere — don't duplicate here

- Showing every chapter (`scenes[]` from `/stories`) and reading accepted `chapters/<n>.md` prose are
  multi-chapter chrome, not a gap in the writer screen itself. Both are already
  [`SPEC-GUI-MULTISCENE.md`](SPEC-GUI-MULTISCENE.md)'s work (its items 1 and 3) and
  [`Architect.MD`](Architect.MD)'s handoff entry point depends on the same two routes — this document
  should point there, not restate the routes.

### Gaps specific to the live screen

These would make the writer screen more robust; none of them block starting the redesign.

1. Add `chapter` to `RunMeta`; it currently appears only in `scene_start` and scene events, so the
   screen cannot label which chapter is running from `GET /run` alone.
2. Add `chapter` to retained `RunSummary` so runs can be grouped by chapter without reading every log.
3. Consider an explicit `phase` and `awaitingReader` field in `run_state` instead of requiring the GUI
   to infer them from event history.
4. Add structured model-error events so failures are understandable without reading the console.
5. Consider `POST /run/start { dir, chapter, model? }` if the application moves away from the CLI-owned
   picker handshake.

The current API supports one global model override for the writer and all character agents. It does
not provide separate live model controls for writer, character, judge, or summary calls.

## Mockup

The standalone prototype is [`writer-mockup.html`](writer-mockup.html). It demonstrates a redesign of
the live writer screen without calling the API.
