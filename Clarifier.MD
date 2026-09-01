# Clarifier

**Status: built.** The clarifier is the author-side agent that answers a character's mid-scene
question about a fact of its situation. This document owns it: what it holds, the bounds it answers
under, and its history across a scene. The ask that reaches it is described from the character's
side in [`Character.MD`](Character.MD) and from the writer's in [`Writer.MD`](Writer.MD).

## Role

When a character replies to a consult with `{"need": ...}`, someone has to answer. That someone is
the clarifier — not the writer, and not the writer inside its own conversation. Like the judge
family, it was once a section of `WRITER_FORMAT` answered on the writer's history, and it was
carved out for the same recorded reason (`prompts/judge.ts`'s header): a writer twenty messages
deep in `[WRITE]` → `{"prose": …}` falls into the wrong shape often enough to matter, and each of
these jobs holds exactly one response schema. The clarifier's is the smallest in the engine:

```json
{"answer": "..."}
```

There is one per scene, built lazily on the first question that needs it (`theClarifier()` in
`engine/scene-loop.ts`). It shares the writer's voice deliberately — the author is answering, and
the author's voice is the writer's — built with the writer's temperature and think level, and
taking the writer's model at call time, so a mid-run `/model` swap reaches it like every other
author-side agent. It logs to its own transcript (`clarifier.jsonl`) under its own name and tag
colour.

## What it holds

Its system prompt (`clarifySystem`, `prompts/clarify.ts`) is `CLARIFY_FORMAT` plus everything the
author knows that a one-fact answer might need to stay consistent:

- the premise, and where the scene is;
- the story's `facts` — what it decides on the spot cannot contradict what the story already
  settled;
- the same cast block every author-side agent sees — names, `can:`, `REACH:`, `CANNOT:` — so it
  knows what everyone in the scene is able to do;
- a closing line making the CANNOT rule absolute: never answer someone with something they would
  have to perceive through a sense they do not have.

Each request is a one-shot user message (`clarifyRequest`): who is asking, their question, the
situation they were sent, **the last piece of prose written**, and the asking character's own
`knows`. The prose is there so a fact it decides on the spot cannot contradict the page. The
`knows` travels in the transient payload only — never folded into the clarifier's history — because
the instructions tell it to reveal only what *this* character could perceive or already know, and
that boundary is uncheckable without the field itself being present at ask time.

## Its bounds

- **Answer plainly, briefly, and only what was asked.** If the author had not decided yet, the
  clarifier decides now — the answer becomes true for the rest of the scene, and the author is held
  to it.
- **Bounded by who is asking, not by what is true.** A fact real but out of that character's reach
  does not reach them: it answers with what they would actually perceive in their place, and leaves
  the rest unsaid.
- **Never words in another character's mouth.** What anyone else says, or decides, is theirs, and
  nobody has consulted them yet. If the honest answer is that they hear someone speak, they hear a
  voice they cannot yet make out — not what it said. An answer that quoted another character would
  be a line nobody was consulted for, and the rest of the scene would be built on it.

## Lifecycle

`consult()`'s ladder gives each consult a clarification budget (`sc.clarifications`). When a
character asks, the `clarify` closure in `engine/scene-loop.ts` runs the call: a reply in the wrong
shape is recorded as `schema_mismatch` and asked once more against `ANSWER_ONLY`, and a second miss
comes back empty — which the consult folds as "(no answer)". A call that never comes back returns
`null`, which costs no clarification slot and surfaces to the character as `clarify_failed` — the
author who cannot be reached is treated the same as an author who has stopped answering, and the
consult moves onto its forced ladder.

Every answered question is folded into the clarifier's own history — who asked what, and the answer
given — because a character may ask twice in one attempt and the second answer has to know the
first. The same questions and answers are held in `attemptClarifications` for the writer's side of
the fold (below). At the end of the scene, the clarifier's history is trimmed along with everyone
else's (`trimHistory`).

## The rewind rule

A clarification is part of the attempt that asked for it, and it survives on exactly the terms the
answer survives. Before each consult attempt the engine marks the clarifier's history
(`beginAttempt`); when the attempt's answer is the one the scene takes, the held questions and
answers are told to the writer first and then the answer is folded; when the attempt is thrown away
— a judge retry, an unusable re-ask, a consult that failed outright — the engine calls
`clarifier.rewind(mark)` and the writer is told nothing at all until the answer is the one the
scene takes.

The asymmetry behind the rule: the fact was settled for a character instance that no longer
exists. The fresh instance asked in its place never heard it, so a writer narrating around a
discarded clarification would be treating a rejected branch as canon while the character standing
in the scene has never heard of it. This is the same rule as *only the accepted answer enters
history*, applied to the part of an answer that arrives before it.

## Known weak spots

Unbuilt improvements and observed failure modes are tracked in [`PLANS.md`](PLANS.md), including
the one live observation that the clarifier can answer a different question than the one asked —
there is no check that a clarification addresses its question.
