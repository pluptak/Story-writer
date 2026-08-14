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
