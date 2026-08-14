# PROTOCOL — what the agents return

Every agent reply is one JSON object. `extractJson()` takes the **last top-level** object (models
emit examples and preambles first) and falls back to labelled prose. The architect, which only runs
before a scene exists, has its own contracts in [SPEC-S-scaffold.md](SPEC-S-scaffold.md).

## Writer modes

Set by the leading tag on the user message.

| tag | returns |
|---|---|
| `[WRITE]` | `{ prose, consult?: { character, situation, question, wants }, scene_done }` |
| `[ASK READER]` | `{ framing, options }` |
| `[<NAME> ASKS]` | `{ answer }` |
| `[<NAME> ANSWERED]` | `{ verdict: "accept" \| "retry", note, revised?: { situation, question } }` |

- `prose` may be `""` on a step that only consults; `consult` is omitted when none is needed. Each
  piece is capped at `config.max_prose_words` — [LOOP.md → Pacing](LOOP.md#pacing).
- `wants` is **one of four words**: `speech · action · decision · reaction`. As free text it
  degenerated into "what they do next", which names no shape at all — and a question that never asks
  for words never gets any. `canonWants()` recovers near misses ("whether they move aside" ⇒
  `decision`); anything with no shape in it is refused rather than guessed.
- `situation` is the only world the character gets, and the contract tells the writer to put no steer
  toward the answer it wants in there. Below `MIN_SITUATION_WORDS` it is refused.
- `answer` decides a fact: if the writer had not decided yet, its answer becomes true for the scene.
  The Q&A is pushed into the writer's history, so it must live with what it decided.
- `retry` is reserved for an unusable answer — wrong question answered, a situation too thin to
  answer from, or an act the character cannot perform. Explicitly **not** for an answer that is
  merely inconvenient.

## THE ONE RULE

Stated as its own block in `WRITER_FORMAT`, and echoed in one line on every `[WRITE]`:

> Dialogue and deliberate acts may reach the page only from an answer already received. The place,
> the light, involuntary body and anything already answered are the writer's.

**The POV character is not exempt** — the point of view is a lens, not a licence. Two clauses were
added later, each covering a case where the *letter* of the rule permits what the point of it forbids:

- **Stillness is a choice.** "He does not move." "She says nothing." Inaction reads as absence and so
  escapes a rule written about acts, and it is the one thing the writer can award unasked that stops
  a scene deadest.
- **The pressure may not be resolved before the consult that turns on it.** A threat leaving is just
  time passing, which the rule explicitly grants — so a writer can build a beat, dissolve it inside
  one piece and then ask into the calm, legally.

All of it is LLM-judged; what the code guarantees is that the contract states it. The run behind each
clause is in [GOTCHAS.md](GOTCHAS.md), and it is the file to read before loosening any of this.

## `[ASK READER]`

Replaces one `[WRITE]` step in place, sent only when the viewer's **consult me** button has armed a
one-shot flag — there is no console path, and the writer cannot trigger it. `options` is meant to be
exactly three real forks; the person at the browser picks one or types their own, and the result is
folded into the writer's history as `[READER CHOSE] ...` before the next `[WRITE]`.

Both halves are real events (`reader_ask`, `reader_answer`), unlike the out-of-budget prompt: a
reader consult is part of the story, not UI state. An arm that goes stale, or a stop while one is
outstanding, resolves to an empty answer the loop discards rather than folds in.

## Character replies

```json
{"need": "Can I reach the door handle from where I am?"}
{"thought": "...", "speech": "...", "action": "...", "skills_used": ["movement"], "note": ""}
```

`thought` is capped at two sentences and `speech` carries no quotation marks — [GOTCHAS.md](GOTCHAS.md).
`skills_used` is checked against the character's effective set: [DESIGN.md → Skills are checked, not
gated](DESIGN.md#skills-are-checked-not-gated).

## When a reply does not parse

`extractJson` returns `{}` and the caller reads empty fields — a missing verdict is an accept, a
missing consult is no consult.

The one exception is a **draft**, where the reply carries the product: a `prose` string cut off at the
token cap parses to nothing and would silently discard everything written. `salvageProse()` recovers
it up to the last finished sentence and marks the `draft` event `salvaged: true`, so the log says when
a piece of the scene arrived that way.
