# Writer

**Status: built.** [`story-page.js`](server/gui/viewer/story-page.js),
[`blocks.js`](server/gui/viewer/blocks.js), [`events.js`](server/gui/viewer/events.js),
[`hud.js`](server/gui/viewer/hud.js) and [`timeline.js`](server/gui/viewer/timeline.js) render drafts,
consults, retries, accepted answers, group reactions and character exits off `/events`. What is left
is listed under [Remaining work](#remaining-work).

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

### What the writer is told about the cast

The cast block every author-side agent shares (writer, judge, narration lint, batch judge, clarifier)
shows only each character's **delta** from the human baseline: `can:` lists non-general skills and
omitted entirely when empty, `REACH:` names what the scene grants through where the character is
standing right now, and `CANNOT:` names authored restrictions. The general skills are not listed —
since every removal is named as a CANNOT, absence-from-CANNOT already implies presence, so printing
`can: movement, speech, hearing, touch, taste, smell, recall` was seven things the model already
assumed, burying the one signal-carrying special skill at the end of the line. The block's header
states the baseline explicitly, so a short `can:` never reads as a short leash.

The three labels are glossed in the header because they are confusable: `can:` is intrinsic (carried
between scenes), `REACH:` is situational (granted by this scene only, gone when it ends), `CANNOT:`
is unavailable whatever its source would have been. A situational capability is never emitted on a
`can:` line; the character's own menu still lists its generals, because that is where the
"all of what you can do; nothing else" fence needs them.

### The judge and the clarifier

Two author-side jobs sit beside the writing itself: **judging** an answer (accept or retry) and
**clarifying** a fact a character asked for. Both are the author's own voice, and both were once extra
sections of this system prompt, answered on the writer's history; sharing that history cost real
judgements, so each is a separate agent now, holding exactly one response schema. All four judge
variants and their gates are specified in [`Judge.MD`](Judge.MD), and the clarifier — its bounds and
its history across a scene — in [`Clarifier.MD`](Clarifier.MD). This section keeps only what the
writer's loop does around them.

The loop's contract with them: an answer is judged before the writer ever sees it, and every
situation-entry path — the writer's first ask, a fan-out's shared text, a judge's revision on a
retry — is checked against its addressee's own CANNOT list before it leaves. A refused ask is never
sent; the writer is told why instead. When an answer is unusable, the retry's re-ask is re-authored
by the judge and passes the same gate before it reaches a fresh character instance that never learns
it was rejected — and when the revision cannot be sent, the answer already in hand is the one the
scene gets. What the clarifier settles on the way folds into the writer's history as it goes, and an
attempt whose answer is thrown away is rewound out of both histories: the writer is told nothing at
all until the answer is the one the scene takes.

Both fail open — an unusable answer is accepted, an unlintable piece goes to the page unchecked, a
clarifier that cannot be reached is treated the same as an author who has stopped answering — but a
reply in the wrong shape is asked once more against its schema first, and the run record says which
of the two happened (`schema_mismatch`, or `judge_failed`, `lint_failed`, `batch_judge_failed`,
`clarify_failed`, `fanout_skip`): one is a model occasionally getting the shape wrong, the other is
the LM Studio connection dropping out from under a chapter mid-write. Each author-side agent logs to
its own transcript under its own name (`writer.jsonl`, `judge.jsonl`, `batch-judge.jsonl`,
`narration-judge.jsonl`, `clarifier.jsonl`), with its own role field, live stats row and tag colour
— and all follow a mid-run `/model` swap.

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
5. Retry through a character-agent fork when necessary, with a re-ask that has itself passed every
   check the first consult did and the directed gates besides. The fork carries the scene so far and
   nothing of the attempt being retried — a re-asked character never learns it was rejected, and
   never forgets a promise it made two consults ago.
6. Add only the accepted answer to the writer's history.
7. Continue the scene from the accepted answer, and write it in before the scene closes.

When several characters face the same fork, each is asked from the same shared moment: a consult's
`situation` may only contain facts that predate every answer in the beat. One character's answer
never becomes part of another's situation — the second one asked blind, and an answer leaked into
someone else's situation decides the moment for them (`prompts.ts`, `WRITER_FORMAT`). The situation
is the only channel there is, so it is also the only place such a leak can happen.

The writer may describe setting, atmosphere, time passing, physical reactions without deliberate
choice, established facts, and POV perception within the character's capabilities.

The writer may not invent dialogue, deliberate actions, decisions, thoughts, feelings, or meaningful
stillness. This asymmetry is the central product invariant.

The writer's ask names no shape, so an open beat has exactly one floor and the point of view sets it:
a thought from outside the point of view reaches the writer as nothing, so a reply carrying neither
speech nor action is a reply the scene never receives. It is reported as a `reaction` shortfall,
because that is the repair the character needs — let it reach the outside.

The four shapes exist only past a judge's escalation, where a fork has been named in words: `speech`
needs words said, `action` needs something done, `decision` needs one or the other to carry it.
`reaction` is the exception, and the only shape a thought alone answers — it asks what a moment lands
on someone as, which happens behind the eyes. A thought offered against any of the other three is not
a quiet answer but an unanswered question, and it is treated as one: the character is asked again,
and if it comes back the same the writer is told nobody answered rather than handed an accepted
answer with nothing in it.

### A thought reaches the writer only from inside the point of view

What a moment lands on someone as is theirs. The writer is handed it only when the scene is written
from inside that person: the point-of-view character's `thought` folds into the writer's history and
onto the narration lint's ledger as a felt entry, and everyone else's does not. The narration lint
already holds that another character's inner life is not narratable fact, so a non-POV thought on the
writer's desk only ever authorized it to narrate one anyway.

The thought still enters the character's **own** history — it is their memory, and continuity depends
on it — and it is still on the run record, because the reader watching a run is not the writer. A
character is never told any of this: one writing for an audience is not answering as itself.

That rule decides what `reaction` asks for. From the point-of-view character it is answered by a
thought alone — the one shape that happens behind the eyes. From anyone else the same answer reaches
the writer as nothing, so a reaction has to surface: a word, a movement, how they hold themselves.
Both sides are told the version that applies — the character through `prompts/consult.ts`'s
`REACTION_OUTWARD`, and the judge through the `wants` menu in `prompts/judge.ts`, which is where that
menu now lives because the judge is the only author-side caller that still names a shape. The menu's
own gloss — *not a deliberate act, not spoken words* — is exactly right for the POV character and
unanswerable for everybody else. That mismatch
was live: two of one run's seventeen consults were `reaction` asks to a non-POV character, both
answered honestly from the inside, both spent on nothing.

The character is never told any of this. A thought that stays inward buys one repair asking it to
reach the outside, phrased as craft rather than policy — one told its thoughts go unread stops
answering as itself. If the second reply is no better it is treated as no answer rather than accepted
empty, for the same reason a thought offered against a `speech` ask is: accepting it would spend the
attempts, mark the character freshly consulted, and hand the writer an answer with nothing in it.

A reaction fan-out whose every reactor ends up there hands over no bundle, and the writer is told so
plainly — silence would read as an unanswered fan-out and get the same beat asked again.

The engine nudges as well as gates: a character gone unconsulted too long is named in the next
`[WRITE]`, and that nudge tells the writer to put the moment to them *whether it turns on a choice of
theirs or they are simply standing in it* (`prompts.ts`'s `writeInstruction`) — the case that
otherwise produces a degenerate "What do you do?". It names no shape, because the writer's ask has
none to name; more than one neglected character turns the nudge into a fan-out instruction instead,
since that costs one step rather than a step apiece.

### Group reactions

When a beat lands on more than one person at once, the writer can fan a **reaction** out to several of
them instead of consulting one at a time: in place of `consult.character` it sends `consult.reactors`,
a list of names, with a shared `situation` any reactor may override (someone who only *heard* it).
This is a second beat, never simultaneous with the action it reacts to — the action is an ordinary
consult that resolved first — so the fan-out rides the prose turn that narrates the aftermath and
costs **one step however many react**. Each reactor is a genuinely isolated consult (`normalizeReactionConsult`
holds each to the same situation floor a lone consult faces, and no reactor ever sees another's reply,
so the asymmetry is unbroken), and the writer is handed all of them together to write as one beat.

What reaches that bundle is bounded by the point of view: a non-POV reactor contributes what it said
and, if promoted, what it did — never what it felt. A reactor left with nothing after that is not in
the bundle under a bare name, which would be an invitation to invent what it was standing next to.

A reactor may volunteer an **action** alongside its thought. The writer promotes **at most one** of
those into the scene by naming that character in `promote` on its next reply; the promoted deed is
folded into that character's history as canon, and every un-promoted deed stays a private impulse —
only the thought is folded, so the page and the character's memory never disagree. Which volunteered
deeds are even offered for promotion is decided by **one** batch-judge call over all of them
([`Judge.MD`](Judge.MD)); a deed that reaches through a CANNOT is not offered, and with no
volunteered deed there is no judge call at all.

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

### The world timeline

A story may carry a ledger of **world events** — a fault alarm firing, an incoming call, the thing
in the dark reaching the door. Each beat has two forms. Before its trigger (`at`, a fraction of the
scene's word target), the `[WRITE]` instruction carries a `[HOLD]` clause: what has **not**
happened, which the writer may not start, have already underway, or build toward as imminent. At the
trigger, the beat's `fired` form replaces it: `[WORLD] … That has happened — nobody in this scene
chose it and nobody can decline it. Write it as already true, on the page, in this piece.` The two
are never sent together; a beat fires once, in authored order, and its hold stands down the moment
it does (`engine/world-timeline.ts` decides; the loop injects). The decision needs no model call.

A world event is the one category no character decides, so it is never a consult: it arrives as
established fact inside the `[WRITE]`, the way the length budget does. A fired beat may also carry
**memories** — per-character knowledge implanted the moment it fires (see
[`Character.MD`](Character.MD)).

**Nothing checks that the event reached the page.** A beat is injected once and the writer is
trusted with it; if the piece ignores it, the run record says the beat fired and nothing says it
never landed. A mechanical check was built and removed — it could not tell a faithful rendering from
an unrelated piece — and what replaces it is the repair entity's, still unbuilt.

What the ledger is for, and the repairs when a character's choice breaks it, are still
[PLANS.md](PLANS.md)'s.

### The narration lint

Every drafted piece is checked once, before it is committed to the page: did it quote a line nobody
was granted; did it hand a deed or meaningful stillness to someone not already granted it this scene
(THE ONE RULE); did it narrate a character perceiving through a sense their CANNOT list removes; and,
if the same reply opens a consult or reaction fan-out, does the `situation` it hands the character
name the concrete fact just established rather than only its consequence. A flag sends the writer back for one
redraft from the same `[WRITE]` instruction — nothing has reached `pieces[]`, the writer's own history,
or the log yet, so this is a clean redo, not an undo. A retry that is also flagged, or that fails
outright, is accepted anyway and logged as `narration_flag` — the lint warns; it never blocks the scene
(`engine/scene-loop.ts`'s `NARRATION_LINT_RETRIES`).

Two of those four are decided in code, and they are the two whose evidence is a closed set.
Quotations are matched against the granted ledger (`engine/quote-lint.ts`); a restricted sense is
matched by verb against the character's own CANNOT list (`engine/sense-lint.ts`). Deeds and the
consult's `situation` stay the model's, because neither has a list to check against. All three run
**alongside** each other and their `why` strings join into the one `narration_flag` — there is only
one redraft, so a piece carrying two findings has to report both in the same message. What the lint
judge is shown, the verdict shapes it may return, the mechanical halves' conservatism, and why a
check nobody made must not read as a check that passed are [`Judge.MD`](Judge.MD)'s.

### The repeat guard

After the lint, and just before the append, a piece that **opens by re-emitting the page's tail** is
stripped back to its genuinely new text (`engine/repeat-lint.ts`, no model call). The recorded
failure: the doorway run's second draft re-emitted the first — 386 identical characters, the whole
opening paragraph — and appended one new sentence, and both were accepted, so the scene opened with
the paragraph twice. The guard matches the piece's leading sentences against the last two pieces
(verbatim, or near-verbatim at the same Dice ≥ 0.8 bar the quote lint uses) and strips the repeated
prefix at a sentence boundary, declining entirely rather than cutting mid-sentence. Everything that
records the piece records the kept text — `pieces[]`, the writer's own history, the `draft` event
and the incremental `scene.md` — so the writer's next draft reads a page that carries the paragraph
once. A piece that repeats the page **in full** counts as a turn that wrote nothing. What is out of
scope: a phrase repeated mid-piece (stripping it would mangle the prose), a callback to anything
older than the tail (legitimate prose), and an echo under eight words (a tolerated phrasing
callback). Every strip is logged as `repeat_strip`; the guard only ever removes a prefix it is
confident about.

### An answer is not canon until it is on the page

Accepting an answer only puts it in the writer's history. The chapter is the durable record, and the
one thing that can put a character's choice into it is a writing turn *after* the answer landed — so
the loop tracks who is owed one. A reply that would end the scene while an answer is still owed does
not end it — whether that reply declares `scene_done` or runs into the hard length cap without
declaring anything: the writer is told the answer is evidence and not yet written, and gets exactly
one more turn, logged as `done_deferred`. That turn is held open against everything; whatever comes
back, the scene closes after it.

A `scene_done` that survives that is put to the done judge, which reads the page back against the
scene's question and records `done_flagged` when it is not settled there. The writer is not told:
the ending stands, and the verdict is the run record's, not an instruction. Why it only records is
[`Judge.MD`](Judge.MD)'s.

A `scene_done` on a page with nothing on it is refused once — there is no scene to end — and honored
if the writer insists again. The backstop for an empty chapter is in saving: a chapter file is
written only by a finished, un-stopped run that actually wrote prose, and "not saved" says which of
those three failed.

What the engine can check is that a beat was written, not that the beat honors the answer — proving
the latter would need a second judge on every piece, and the judgement it makes would be exactly the
one the writer just made. So when a scene does end with an answer never written in — the step budget
gone, the run stopped, the point-of-view character walked out — the run record says so, as
`answer_unwritten` naming the characters. The consult shows as accepted because it was; the event is
there so a chapter missing a choice it was told about cannot read as a clean finish.

### Writing a character out

The writer can end a character's presence in the scene with an `exit` field naming them. They are
dropped from the active cast — not consulted again, and no longer surfaced by the neglect nudge — but
a world-caused removal (a trapdoor, the floor giving way) is the writer's to narrate, while the
*choice* that carried them into it still had to be asked for first. An exit only takes effect when
the reply carried prose: nobody leaves the scene because a prose-less reply declared it — that is
refused as `exit_refused` and the writer is told so. Exiting the **point-of-view**
character ends the chapter: the between-chapters architect handoff re-authors the cast from there,
reading the exit out of the prose it already consumes, so no separate signal reaches it.

One run writes one chapter. A run can finish normally, stop when its step budget is exhausted, pause
for more budget, wait for reader direction, be stopped by the user, be forced closed for running twice
past its target length (see "Length is a budget, not a suggestion" above), or end because of a
model/runtime failure. Only a run that finished un-stopped and wrote prose saves a chapter file; a
stopped, unfinished, or empty run leaves `chapters/` untouched.

The chapters already on disk are protected in turn: a run refuses to start over an existing chapter,
or to skip past one that was never written, unless told otherwise — `--replace` on the CLI, or the
story page's confirm-then-send from the viewer. One explicit authorization covers both deviations,
so a deliberate rerun stays one flag away rather than forbidden.

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
row. Two deliberate decisions behind it:

- **The consult blocks were not simplified.** The shipped rendering carries the full per-attempt
  detail — the fresh-instance note, asked-back Q&A, the flags on a forced or re-asked attempt, judge
  verdicts. One consult going well is easy to render compactly; losing the rest would make a retry
  unreadable, and a retry is the case worth watching.
- **POV is not shown.** POV is a hint to the writer about whose choice comes first, not something a
  reader of the run needs. `RunMeta` carries no `pov` and does not need to.

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
