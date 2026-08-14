# LOOP — how a scene gets written

`writeScene()` alternates drafting with consult cycles until the writer says `scene_done` or the soft
step budget runs out. What the agents return on each leg is in [PROTOCOL.md](PROTOCOL.md).

```
while not done:
  budget spent?           -> ask for more steps, or stop
  reader-consult armed?   -> [ASK READER] instead of [WRITE] this step, wait for the browser's answer
  [WRITE]                 -> prose (appended, written to out/scene.md) + optional consult + scene_done
  consult requested?
      normalizeConsult()  -> refused: writer told why, NOBODY is asked, step is otherwise ordinary
      attempt = 1: the character's OWN agent (remembers the scene)
      attempt > 1: agent.fork() — same persona, empty history, revised question only
      inside consult():
          need? -> writer [<NAME> ASKS] -> answer -> re-ask   (up to config.clarifications)
          budget spent -> told plainly none is coming, answer anyway  (reply.forced)
          skill check -> one repair pass -> else flag
      [<NAME> ANSWERED]   -> accept | retry   (up to config.retries; last answer stands)
      on accept: fold into the character's persistent history AND tell the writer
  trimHistory over the writer and every character
```

## Two invariants

1. **`consult()` never touches `agent.history`.** Every exchange inside it is ephemeral. The caller
   decides what becomes memory, and folds in **only the accepted answer** — so a rejected attempt
   leaves no trace, and `fork()` is genuinely clean.
2. **The writer's history alternates user/assistant from the first message.** The `[WRITE]`
   instruction goes into history rather than travelling as an ephemeral extra —
   [GOTCHAS.md](GOTCHAS.md).

## Failure handling

A single bad model call must not destroy a run that has written 600 words.

| fails | result |
|---|---|
| a stream that breaks off (usually our own deadline) | if what arrived already contains a **complete** top-level object, that reply is kept rather than retried — checked with `topLevelObjects`, deliberately not `extractJson`, whose prose fallback would call a half-written reply complete |
| a draft truncated at the token cap | `salvageProse()` recovers the written words up to the last finished sentence |
| `[WRITE]` | stop cleanly, keep the prose (transport already retried twice) |
| clarification | `"(no answer)"` — the character answers with what it has |
| judge | **accept** — the character did answer; discarding it over a meta-call is the wrong way to fail |
| a whole consult | writer told `[NO ANSWER]`, scene continues |
| three steps that neither wrote nor asked anybody | stop — a stuck writer should not eat the budget. A consult **refused** by `normalizeConsult` counts as nothing achieved, so a writer repeating a malformed one cannot spin here |

A **stop** from the viewer is none of these and is never reported as a failure:
[GUI-SPEC.md](GUI-SPEC.md) §4.2 lists what it must not be mistaken for.

## Budget

`config.max_steps` is **soft**: spending it prompts for more (default 8, `0` stops) — in the browser
when one is attached, at the console on a TTY, otherwise the run stops rather than blocking forever.
`--steps=N` overrides it.

The viewer's **interactive** toggle (`LIVE.interactive`, [GUI-SPEC.md](GUI-SPEC.md#46-going-hands-off))
makes it hard instead: switched off, `askMoreSteps` returns `0` before asking anybody, and the reader
consult cannot arm either. Checked first in `askMoreSteps`, ahead of the browser and console branches.

## Pacing

A scene has a fixed word budget and exactly two things to spend it on: the writer's narration and the
characters' choices. Left alone the writer spends it on narration — measured, in
[GOTCHAS.md](GOTCHAS.md). A scene that runs out of words before it runs out of story reads as a
stall, and that is the mechanism.

Three things push against it. None is a truncation — cutting prose at a word count would throw away
words that were actually written, the one thing this loop is built not to do.

- **`config.max_prose_words`** (default 140) is stated in `WRITER_FORMAT` and repeated in every
  `[WRITE]`. When a piece overruns by more than `OVERRUN_SLACK` (×1.5 — a model told 140 returns 160,
  and nagging about 20 words teaches nothing) the **next** `[WRITE]` says so and by how much. At the
  default a 700-word scene is at least five pieces rather than two.
- **`normalizeConsult()`** refuses a request that is not worth sending, *before* any character call.
  It is pure, and it is the engine's half of the split: whether a question is **good** stays a
  judgement, but whether it is a question at all is decidable here. It refuses an empty situation, a
  situation under `MIN_SITUATION_WORDS`, an empty question, a `wants` with no shape in it, and the
  **degenerate question** — `"What do you do?"`, `"What does Elara do?"`, `"What happens next?"` —
  which names no fork and no stake, so the safest possible answer is always correct, and the safest
  possible answer is the one that does not move the scene. The `why` is written to be handed straight
  back to the writer: a rejection the writer cannot act on is one it repeats.
- **`wants` as a closed set** ([PROTOCOL.md](PROTOCOL.md#writer-modes)), so "ask for words" is a thing
  the writer can actually do.

A refused consult is logged as `bad_consult` and counts toward the stuck-writer guard above.

## An inert cast

The pacing pressure above has a side effect: a cast member the writer is not actively steering toward
tends never to be asked anything at all, even when they never leave the scene. Measured on
`stories/doorway`'s most complete run — two characters, both on stage the whole time — 10 of 10
consults went to the POV character and 0 to the other ([GOTCHAS.md](GOTCHAS.md)).

`neglectedCast(cast, lastAsked, step, gap)` is the notice, not a fix: pure, and the same shape as the
overrun nudge above — it never blocks or forces a consult, it names whoever has gone `NEGLECT_GAP`
(3) steps or more unconsulted on the **next** `[WRITE]`, and `writeScene()` updates `lastAsked` only
on an *accepted* consult, so a refused or unanswered one does not count as having reached them. It has
no notion of whether a character has left the scene — that is item 6's gap, not this one's — so the
nudge is phrased "if they are still in the scene" rather than as a demand.

The other half is `"wants": "reaction"` ([PROTOCOL.md](PROTOCOL.md#writer-modes)): the shape that lets
a present-but-quiet character be asked something without needing them to speak or act, so a writer
that takes the nudge has somewhere to spend it.
