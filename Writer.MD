# Writer

**Status: built.** [`story-page.js`](server/gui/viewer/story-page.js),
[`blocks.js`](server/gui/viewer/blocks.js), [`events.js`](server/gui/viewer/events.js),
[`hud.js`](server/gui/viewer/hud.js) and [`timeline.js`](server/gui/viewer/timeline.js) render drafts,
consults, retries and accepted answers off `/events`, in the layout
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
that quotes someone is a line nobody was consulted for. Both agents log to the writer's transcript and
both follow a mid-run `/model` swap.

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

One run writes one chapter. A run can finish normally, stop when its step budget is exhausted, pause
for more budget, wait for reader direction, be stopped by the user, or end because of a model/runtime
failure.

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

The manual pass that verifies all of this is [`GUI-CHECKLIST.md`](GUI-CHECKLIST.md) §8.

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
