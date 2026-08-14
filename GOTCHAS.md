# Gotchas

The runs behind the rules. The specs state each constraint; this file records what went wrong without
it. Read the relevant entry — and a fresh run's log — before loosening one.

## Prompt and transport

- **The writer's history must start with a user message.** The `[WRITE]` instruction is pushed into
  history rather than passed as an ephemeral extra for exactly this reason — a history opening with
  the writer's own prose left the chat template with no user turn after the system prompt, and the
  model returned empty completions until the run died. [LOOP.md](LOOP.md).
- **`thought` is capped at two sentences and `speech` carries no quote marks** in `CHARACTER_FORMAT`.
  An uncapped `thought` became a dumping ground for the model's whole deliberation and blew the 120s
  request deadline mid-object. [PROTOCOL.md](PROTOCOL.md).
- **A draft carries prose, so it is the reply most likely to hit the token cap.** Truncated JSON
  parses to nothing, throwing away words that were actually written — hence `max_tokens` defaulting
  to 2000 rather than the 1200 this forked with, and `salvageProse()` as the net. If drafts start
  coming back marked `salvaged` in the log, raise `config.max_tokens` for that story.
  [PROTOCOL.md](PROTOCOL.md).
- **Model calls are heavy.** A step is 1 draft + 1 judge + 1–3 character calls + any clarifications,
  each tens of seconds locally. A full scene takes a while — expect to interrupt; both output files
  survive it.
- `LMSTUDIO_URL`, `MAX_TOKENS`, `STREAM`, `DEBUG`, `OUT_DIR`, `LLM_STREAMS`, `LLM_FILENAMES` are
  module-level mutable globals set by `main()` from the loaded story.

## THE ONE RULE ([PROTOCOL.md](PROTOCOL.md))

**The writer's standing temptation is to write a character's choice and then ask about it**, which
wastes the answer against a page that already contradicts it. Observed: the writer wrote *"She
doesn't reach for the package yet… waiting"*, consulted, and was told *"I take the package with both
hands"*. `WRITER_FORMAT`'s rule block and the echo on every `[WRITE]` exist for that, and the POV
character is deliberately not exempt. It is LLM-judged, so check a log for consults whose answers the
prose pre-empted before loosening it.

Two clauses were added after the rule was observed holding while scenes stalled anyway — both cases
where the letter of it permits what the point of it forbids.

- **Stillness is a choice.** Inaction reads as absence and so escaped a rule written about acts.
- **The pressure may not be resolved before the consult that turns on it.** In
  `stories/three-in-a-cupboard`: a searcher arrived at the hiding place, tested the door and walked
  away in 167 words with no consult; the next `situation` opened *"The cupboard is quiet. Dudley has
  passed without hearing them"* and asked what the hider did next. They got comfortable. Four
  choices in that paragraph, none asked for.

## Pacing ([LOOP.md](LOOP.md))

**A scene stalls by spending its words on narration.** The budget buys narration or choices, and
uncapped the writer buys narration. Measured across four runs in `stories/*/out/`: **~300 words of
prose per draft, at most one consult each — 1119 words bought four decisions**, and 1 answer in 7
carried any speech.

Three things push back: `config.max_prose_words`, `normalizeConsult()` refusing a request before it
costs a character call, and `wants` as a closed set so "ask for words" is expressible. A story that
wants long unbroken prose should raise `max_prose_words`, not remove the cap.

What the refusals were built from:

- **An empty situation.** In `stories/glass-womb` a consult went out with a **zero-character**
  situation; the character, whose only world is that field, answered with filler.
- **The degenerate question.** Four of the seven consults on record were `"What do you do?"` shaped —
  no fork, no stake, so the safest answer is always correct, and the safest answer is the one that
  does not move the scene.
- **`wants` as free text** became "what they do next" in four of five consults, naming no shape at
  all — which is also why nobody spoke.

## An inert cast ([LOOP.md](LOOP.md#an-inert-cast))

**A cast member the writer is not steering toward can go a whole scene unconsulted, on stage the
entire time.** Measured on `stories/doorway/out/2026-08-14T12-13-23-439Z/`: 11 drafts, 10 consults,
**all 10 to RIVEN (the `pov:` character), zero to MERRITT**, who never leaves the corridor. Nothing in
the loop noticed — there was no signal anywhere that one character had gone silent.

Worse, `scene.md` from that run gives Merritt deliberate acts nobody asked for, a THE ONE RULE
violation ([PROTOCOL.md](PROTOCOL.md)) sitting right next to the omission that caused it: *"Merritt
slowly pushes themselves off the upturned crate, rising to their full height"*, *"Merritt has closed
the distance between them and the open doorway"*.

Two compounding causes, both addressed:

- `ARCHITECT_FORMAT` used to say *"TWO is the sweet spot"* outright, and the worked example fed to
  every interview is `stories/doorway` itself — a two-hander (SPEC-S-scaffold.md §7). Rewritten to
  state the actual trade-off (a cast member costs consults out of the step budget) instead of a
  target count.
- `writerSystem`'s `Point of view: RIVEN` line names whose *perception* frames the scene, not whose
  choices are the only ones worth asking about — but nothing stopped it reading as the latter.
  `neglectedCast()` ([LOOP.md](LOOP.md#an-inert-cast)) is the notice; `"wants": "reaction"` is what a
  writer that takes the notice actually sends.

**The nudge works, and its first wording taught two lessons about how.** In
`out/2026-08-14T12-51-10-134Z/` the same story went from 10/0 to **RIVEN 10, MERRITT 5**, with
`llm/merritt.jsonl` existing for the first time, MERRITT consulted on steps 4/8/12/16 — the
`NEGLECT_GAP` of 3 firing like clockwork. But:

- **A nudge must name no sense.** The first wording asked what the neglected character could *see*.
  MERRITT `lacks: sight`. The scene then said *"Merritt watches the receding figure"*, *"their gaze
  fixed"*, five times over — precisely the failure `wrapWriter`'s `CANNOT:` list is supposed to
  prevent. The list was being **rendered but never instructed**; `writerSystem` now states that a
  CANNOT governs narration, not just answers.
- **A nudge must name no `wants` shape.** Both halves of that wording were reaction-shaped, and all
  **5 of 5** MERRITT consults came back `"wants": "reaction"` — no decision, no speech, not one line
  of dialogue in 989 words. The scene's own question is *"Does Riven get through the door before
  **Merritt decides** what to do about them?"*, so the one shape never asked for was the one that
  could close it, and the run ended `done: false` over a 700-word target. Consulting a character is
  not the same as letting them matter.

## Nobody ever asks ([PROTOCOL.md](PROTOCOL.md#character-replies))

**Zero `need` events across every retained run.** No character has ever asked the writer for a fact.
The `llm/riven.jsonl` interaction log ([RUN-RECORD.md](RUN-RECORD.md)) shows why: every question the
writer sent was a closed binary — *"Do you attempt to pick the lock with your tools, or do you speak
first?"*, *"Do you push harder on the pick, risking a loud noise, or pause and assess what Merritt has
done?"*. A fully-specified either/or leaves nothing to ask for.

That is the Pacing section's own anti-stall rules working as designed —
`DEGENERATE_QUESTIONS`/`badConsult.degenerate` and `WRITER_FORMAT`'s *"NAME THE FORK OR NAME THE
COST"* all push the writer toward exactly this shape. **The rule that stops a scene stalling on a
question with no stake is the same rule that leaves a character nothing to ask for**, and nothing
before this had written that tension down. `CHARACTER_FORMAT` also framed asking as an exception
("if you cannot answer without…") rather than a real choice, unlike `ARCHITECT_FORMAT`'s own
propose-or-ask split, where the same model demonstrably does choose to ask. Rephrased to match —
[PROTOCOL.md](PROTOCOL.md#character-replies). Whether that alone is enough against a fully-specified
question is for a live run to show; the tension itself is structural and does not go away.

**It was enough, and the tension is confirmed in the same breath.** The first run after the rewrite
produced the first two `need` events on record — both from MERRITT, the blind character, and both
spatial: *"How close is Riven standing to the service door?"*, *"Where is Riven standing relative to
me?"*. Exactly the shape the design predicts: a character asks when the situation withholds something
they genuinely cannot perceive for themselves. Note which character it was **not** — RIVEN, who can
see, was handed 10 fully-specified binaries and asked nothing, all 10 times.

## A character written out is still consultable ([DESIGN.md](DESIGN.md#presence-is-not-modelled))

**There is no code path that stops the writer consulting a character it has already narrated leaving
the scene.** Not yet observed in a retained run — none of the three stories currently sends anyone
offstage — but confirmed by tracing every place the cast is referenced: `buildCharacterAgents()`
builds the full cast once, `defOf()` in `writeScene()` accepts any cast name for the run's whole
length, and `normalizeConsult` checks the *shape* of a request, never its subject. Left for
[DESIGN.md](DESIGN.md#presence-is-not-modelled) rather than fixed here, because the honest fix needs
new per-character state the loop does not carry yet, not a prompt tweak.
