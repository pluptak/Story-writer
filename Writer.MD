# Writer

**Status: built.** [`story-page.js`](server/gui/viewer/story-page.js),
[`blocks.js`](server/gui/viewer/blocks.js), [`events.js`](server/gui/viewer/events.js),
[`hud.js`](server/gui/viewer/hud.js) and [`timeline.js`](server/gui/viewer/timeline.js) render drafts,
consults, retries, accepted answers, group reactions and character exits off `/events`, in the layout
[`writer-mockup.html`](writer-mockup.html) proposed. What is left is listed under
[Remaining work](#remaining-work).

This document owns the writer's role and the live-run screen. The routes and SSE frames it consumes
are specified in [`GUI-SPEC.md`](GUI-SPEC.md) — the single source of truth for the wire, and complete
enough to drive this screen without additions.

## Role

The writer is the scene-level prose agent. It receives the premise, the story facts, the selected
scene, the active cast, character capabilities and restrictions, and house style. It does not receive
character personas, goals, or private knowledge.

The writer is created fresh for each chapter run with its own history, model, thinking level, and
temperature (`0.8`). Character agents are created separately for the characters in the selected
scene.

### The judge and the clarifier

Two author-side jobs sit beside the writing itself: **judging** an answer (accept or retry) and
**clarifying** a fact a character asked for. Both are the author's own voice, and both were once extra
sections of the writer's system prompt, answered on the writer's history.

They are separate agents now, each holding exactly one response schema, because sharing a history
cost real judgements: a writer twenty messages deep in `[WRITE]` → `{"prose": …}` answers a judge
request with prose often enough to matter, and a reply with no `verdict` used to default silently to
*accept*. A `schema_mismatch` event now records any such reply, and the call is made once more before
any default is taken.

| | history | temperature | why |
| --- | --- | --- | --- |
| judge | none — built per call | `0.3` | it is given the situation, the question, the answer and the cast's limits; a verdict needs no memory, and consistency beats invention |
| clarifier | one per scene | the writer's | what it settles becomes true for the rest of the scene, so it has to remember what it has already said |

The clarifier is also given the last piece of prose written, so a fact it decides on the spot cannot
contradict the page; and it is forbidden from putting words in a character's mouth, because an answer
that quotes someone is a line nobody was consulted for. Its answers are bounded by who is asking, not
by what is true: a fact real but out of that character's reach does not reach them — it answers with
what would. Each author-side agent logs to its own transcript under its own name (`writer.jsonl`,
`judge.jsonl`, `batch-judge.jsonl`, `narration-judge.jsonl`, `clarifier.jsonl`), with its own role
field, live stats row and tag colour — and all follow a mid-run `/model` swap.

Between chapters, the handoff can declare what a chapter taught someone as `characters.<NAME>.learned`;
the engine folds it into their `knows` verbatim rather than trusting the architect to weave it in
(`engine/story-spec.ts`).

## Principle of operation

The writer controls narration and pressure. Character agents control character choices.

The writer must:

1. Write prose up to the next meaningful choice.
2. Stop before resolving that pressure.
3. Consult the relevant character agent.
4. Accept the answer unless it is unusable.
5. Retry through a clean character-agent fork when necessary, with a re-ask that has itself passed
   the same check the first consult did.
6. Add only the accepted answer to the writer's history.
7. Continue the scene from the accepted answer.

When several characters face the same fork, each is asked from the same shared moment: a consult's
`situation` may only contain facts that predate every answer in the beat. One character's answer
never becomes part of another's situation — the second one asked blind, and an answer leaked into
someone else's question decides the fork for them (`prompts.ts`, `WRITER_FORMAT`).

The writer may describe setting, atmosphere, time passing, physical reactions without deliberate
choice, established facts, and POV perception within the character's capabilities.

The writer may not invent dialogue, deliberate actions, decisions, thoughts, feelings, or meaningful
stillness. This asymmetry is the central product invariant.

An answer has to arrive in the shape the consult asked for: `speech` needs words said, `action` needs
something done, `decision` needs one or the other to carry it. `reaction` is the exception, and the
only shape a thought alone answers — it asks what a moment lands on someone as, which happens behind
the eyes. A thought offered against any of the other three is not a quiet answer but an unanswered
question, and it is treated as one: the character is asked again, and if it comes back the same the
writer is told nobody answered rather than handed an accepted answer with nothing in it.

The engine nudges as well as gates: a character gone unconsulted too long is named in the next
`[WRITE]`, and that nudge explicitly offers `reaction` as the honest ask when the moment turns on no
choice of theirs at all (`prompts.ts`'s `writeInstruction`) — the situation that otherwise produces a
degenerate "What do you do?".

### Group reactions

When a beat lands on more than one person at once, the writer can fan a **reaction** out to several of
them instead of consulting one at a time: in place of `consult.character` it sends `consult.reactors`,
a list of names, with a shared `situation` any reactor may override (someone who only *heard* it).
This is a second beat, never simultaneous with the action it reacts to — the action is an ordinary
consult that resolved first — so the fan-out rides the prose turn that narrates the aftermath and
costs **one step however many react**. Each reactor is a genuinely isolated consult (`normalizeReactionConsult`
holds each to the same situation floor a lone consult faces, and no reactor ever sees another's reply,
so the asymmetry is unbroken), and the writer is handed all of them together to write as one beat.

A reactor may volunteer an **action** alongside its thought. The writer promotes **at most one** of
those into the scene by naming that character in `promote` on its next reply; the promoted deed is
folded into that character's history as canon, and every un-promoted deed stays a private impulse —
only the thought is folded, so the page and the character's memory never disagree. Which volunteered
deeds are even offered for promotion is decided by **one** batch-judge call over all of them (a
thought is never judged — it always satisfies the reaction floor); a deed that reaches through a
CANNOT is not offered. No volunteered deed ⇒ no judge call at all.

### Length is a budget, not a suggestion

Each `[WRITE]` carries the running word count against the scene's target and escalates as the gap
grows: a soft warning at 85% of target, "bring the scene to its end" at target, and a harder line —
no new consult but the one choice the scene's question still turns on — past 130%. None of that is
enforcement; it is the writer being told, and a writer mid-scene can keep finding one more fork to ask
about (`engine/scene-loop.ts`'s `HARD_CAP_MULT`). At **twice** the target, the engine stops asking: the
`[WRITE]` says this is the last piece, and once that reply comes back the scene is marked done
regardless of what `scene_done` says — logged as `forced_end`, rendered as a note. The writer still
gets that one last reply to close on its own terms; the engine just no longer takes "not yet" for an
answer past that point.

### The narration lint

Every drafted piece is checked once, before it is committed to the page: did it hand a line, a deed,
or meaningful stillness to someone not already granted it this scene (THE ONE RULE); did it narrate
the point-of-view character perceiving through a sense their CANNOT list removes; and, if the same
reply opens a consult or reaction fan-out, does the `situation` it hands the character name the
concrete fact just established rather than only its consequence. A flag sends the writer back for one
redraft from the same `[WRITE]` instruction — nothing has reached `pieces[]`, the writer's own history,
or the log yet, so this is a clean redo, not an undo. A retry that is also flagged, or that fails
outright, is accepted anyway and logged as `narration_flag` — the lint warns; it never blocks the scene
(`engine/scene-loop.ts`'s `NARRATION_LINT_RETRIES`).

### Writing a character out

The writer can end a character's presence in the scene with an `exit` field naming them. They are
dropped from the active cast — not consulted again, and no longer surfaced by the neglect nudge — but
a world-caused removal (a trapdoor, the floor giving way) is the writer's to narrate, while the
*choice* that carried them into it still had to be asked for first. Exiting the **point-of-view**
character ends the chapter: the between-chapters architect handoff re-authors the cast from there,
reading the exit out of the prose it already consumes, so no separate signal reaches it.

One run writes one chapter. A run can finish normally, stop when its step budget is exhausted, pause
for more budget, wait for reader direction, be stopped by the user, be forced closed for running twice
past its target length (see "Length is a budget, not a suggestion" above), or end because of a
model/runtime failure.

## The reader seat

`/consult-me` does not seat the reader in a character's chair. It arms the reader as the **director**
for one round: the writer spends that round proposing directions instead of writing prose, and
whatever comes back is handed to it as the direction the scene takes from here.

This leaves the central asymmetry intact. The reader chooses which pressure the scene follows; the
characters still own their own choices, and the writer still has to consult them for one.

A screen therefore renders a reader round as a short list of directions, not as a question waiting for
a character's answer — and it tracks the `reader_ask`/`reader_answer` frames itself, because
`run_state` deliberately reports no outstanding reader question (see `/consult-me` in
[`GUI-SPEC.md`](GUI-SPEC.md)).

## The live screen

The shipped screen: the run controls and the cast in the right-hand rail as cards, an
eyebrow/headline/lede block at the top, and the prose in a card with a phase-derived title and a chip
row. Two deliberate departures from `writer-mockup.html`:

- **The consult blocks were not simplified to the mockup's.** The shipped rendering carries per-attempt
  detail the mockup drops — the fresh-instance note, asked-back Q&A, skill flags, judge verdicts. The
  mockup is a picture of one consult going well; losing the rest would make a retry unreadable.
- **POV is not shown.** The mockup has a `POV RIVEN` chip, but POV is a hint to the writer about whose
  choice comes first, not something a reader of the run needs. `RunMeta` carries no `pov` and does not
  need to.

The live rail also accumulates completed model calls by agent: call count, average duration, and
prompt/completion token totals when the provider reports them. Missing token usage is shown as
unavailable rather than guessed.

The manual pass that verifies all of this is [`GUI-CHECKLIST.md`](GUI-CHECKLIST.md) §9; §8 covers
the read-tab-only per-agent model-call panel.

## Remaining work

None of these block anything; the screen works without them.

1. **The phase is inferred, not reported.** `hud.js`'s `phaseOf()` derives it from `run_state` plus
   `APP.awaitingReader` plus the `#prompt` element's own class. That last one is the tell — the budget
   wait has no representation in state at all, only in the DOM. An explicit `phase` and
   `awaitingReader` field in `run_state` would replace a client-side workaround.
2. **Model errors are unstructured.** Add structured model-error events so a failure is understandable
   without reading the console.
3. **Starting a run still goes through the picker handshake.** `POST /run/start { dir, chapter, model? }`
   is worth considering if the application moves away from the CLI-owned pick.
4. **One model override for everyone.** `/model` swaps the writer and every character agent together;
   there are no separate live controls for writer, character, judge, or summary calls.
