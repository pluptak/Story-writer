# DESIGN — story writer + character agents

Authoritative spec for [story-writer.ts](story-writer.ts). Keep it in sync when the loop, the JSON
contracts or the story format change.

---

## 1. The idea

A **writer** agent drafts one scene from a premise. Whenever what happens next turns on a choice a
character makes, it stops and **consults** that character's agent. The character answers as itself
and may first **ask for a fact** it was not given. The writer either accepts the answer or rewrites
the question and asks again — and a retry goes to a **fresh instance** that never learns it was
rejected.

> **Governing rule**
> **The writer owns the page. The characters own themselves.**
> An answer is evidence about the scene, not a suggestion the writer may overrule for being
> inconvenient.

What makes this more than prompt-chaining is what each side is *denied*:

| party | is given | is NOT given |
|---|---|---|
| writer | premise, scene, house style, cast names + **capabilities** | any character's persona, memory or interiority |
| character | own persona, own skills, own `knows:`, own `goal:`, the situation the writer wrote, its own accepted answers | the premise, the draft, the scene's purpose, anyone else's replies |

A writer holding everyone's interiority writes them from the inside and stops asking; a character
holding the draft answers the story instead of the moment. Both directions are enforced by what
`wrapWriter()` and `wrapCharacter()` put in the prompt, and by `consult()` never seeing the draft.

`goal` follows the same rule as persona: it shapes the character's own agent and nothing else. Only
the character can weigh whether they are closer to what they want or further from it, so `goal` is
never shown to the writer or the architect, and no code scores progress toward it. Where it earns its
keep is at *design* time — two characters whose goals genuinely collide (what one needs is what
blocks the other) produce friction a scene doesn't have to be told to have.

---

## 2. Skills

An engine-level catalog every character starts with (`SKILL_CATALOG`): `movement, speech, hearing,
sight, touch, taste, smell, recall`, each with a one-line meaning. A character's **effective set** is

```
catalog − lacks: + skills:
```

resolved by `resolveSkills()`. Names match case- and spacing-insensitively (`Lock Picking` and
`lockpicking` are one skill). Order is fixed: `lacks:` applies to the **catalog only**, then
`skills:` are added — so a name in both ends up present, with a warning saying so.

The effective set is rendered into the character's prompt as its whole menu of possible action, and
the writer is shown each character's `can:` / `CANNOT:` list so it never writes a blind man watching
someone.

**Enforcement is a check, not a gate.** A reply names `skills_used`; unknown names trigger one
re-ask naming the actual set. If the second reply still claims them, the answer reaches the writer
**flagged** (`[FLAGGED] They used "x", which they cannot do.`) — never silently accepted, never
silently dropped. Best-effort by design: a deterministic gate would need a rule layer with
world-state predicates, which this does not have.

---

## 3. JSON contracts

Every agent reply is one JSON object. `extractJson()` takes the **last top-level** object (models
emit examples and preambles first) and falls back to labelled prose.

Two agents run during a scene — the writer and each character. The **architect**, which only runs
before a scene exists, has its own contracts in [SPEC-S-scaffold.md](SPEC-S-scaffold.md) §3–4.

### 3.1 Writer — four modes

The mode is set by the leading tag on the user message.

| tag | returns |
|---|---|
| `[WRITE]` | `{ prose, consult?: { character, situation, question, wants }, scene_done }` |
| `[ASK READER]` | `{ framing, options }` |
| `[<NAME> ASKS]` | `{ answer }` |
| `[<NAME> ANSWERED]` | `{ verdict: "accept" \| "retry", note, revised?: { situation, question } }` |

`[ASK READER]` replaces one `[WRITE]` step in place, sent only when the viewer's "consult me" button
has armed a one-shot flag (§4, §6.1) — there is no console path and no way for the writer to trigger
it itself. `options` is meant to be exactly three real forks; the person at the browser picks one or
types their own, and whatever comes back is folded into the writer's history as `[READER CHOSE] ...`
before the next `[WRITE]`. Unlike the out-of-budget prompt, both the ask and the answer are real
`RunEvent`s (`reader_ask`, `reader_answer`) — a reader consult is part of the story, not UI state, so
it is logged and replayed like any other event rather than living only in `GET /run`.

- `prose` may be `""` on a step that only consults; `consult` is omitted when none is needed. Each
  piece is capped at `config.max_prose_words` — §4.3.
- `wants` is **one of four words**: `speech · action · decision · reaction`. It was free text, and
  degenerated: across four runs it was "what they do next" in four of five consults, which names no
  shape at all. It is also why nobody spoke — one answer in seven carried any `speech`, because a
  question that never asks for words never gets any. `canonWants()` recovers near misses ("whether
  they move aside" ⇒ `decision`); anything with no shape in it is refused rather than guessed.
- **The one rule**, stated as its own block in `WRITER_FORMAT`: dialogue and deliberate acts may
  reach the page only from an answer already received. The place, the light, involuntary body and
  anything already answered are the writer's. **The POV character is not exempt** — the point of
  view is a lens, not a licence. Observed failure it exists to prevent: the writer wrote *"She
  doesn't reach for the package yet… waiting"*, then consulted, and was told *"I take the package
  with both hands"* — an answer wasted against a page that already said otherwise. The `[WRITE]`
  instruction carries a one-line echo of the rule on every step.

  Two clauses were added after the rule was observed holding while scenes stalled anyway. Both are
  cases where the *letter* of it permits what the point of it forbids:

  - **Stillness is a choice.** "He does not move." "She says nothing." "They wait." Inaction reads
    as absence and so escaped a rule written about acts, and it is the one thing the writer can
    award unasked that stops a scene deadest.
  - **The pressure may not be resolved before the consult that turns on it.** A threat leaving is
    just time passing, which the rule explicitly grants — so a writer could build a beat and
    dissolve it inside one piece, legally, and then ask into the calm. Observed in
    `stories/three-in-a-cupboard`: a searcher arrived at the hiding place, tested the door and
    walked away in 167 words with no consult; the next `situation` opened *"The cupboard is quiet.
    Dudley has passed without hearing them"* and asked what the hider did next. They got
    comfortable. There had been four choices in that paragraph and none was asked for.

  Both are LLM-judged, like the rest of the rule. What the code guarantees is that the contract
  states them; check a run's log before loosening either.
- `situation` is the only world the character gets. The contract tells the writer to put no steer
  toward the answer it wants in there. Below `MIN_SITUATION_WORDS` it is refused — §4.3.
- `answer` decides a fact: if the writer had not decided yet, its answer becomes true for the scene.
  The Q&A is pushed into the writer's history, so it must live with what it decided.
- `retry` is reserved for an unusable answer — wrong question answered, a situation too thin to
  answer from, or an act the character cannot perform. Explicitly **not** for an answer that is
  merely inconvenient.

### 3.2 Character — two shapes

```json
{"need": "Can I reach the door handle from where I am?"}
{"thought": "...", "speech": "...", "action": "...", "skills_used": ["movement"], "note": ""}
```

`thought` is capped at two sentences and `speech` carries no quotation marks — both earned: an
uncapped `thought` field became a dumping ground for the model's whole deliberation and blew the
120-second request deadline mid-object.

### 3.3 When a reply does not parse

`extractJson` returns `{}` and the caller reads empty fields — a missing verdict is an accept, a
missing consult is no consult. The one exception is a **draft**, where the reply carries the
product: a `prose` string cut off at the token cap parses to nothing and would silently discard
everything written. `salvageProse()` recovers it up to the last finished sentence and the `draft`
event is marked `salvaged: true`, so the log says when a piece of the scene arrived that way.

---

## 4. The loop

`writeScene()`:

```
while not done:
  budget spent?           -> ask the console for more steps, or stop
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

Two invariants hold this together:

1. **`consult()` never touches `agent.history`.** Every exchange inside it is ephemeral. The caller
   decides what becomes memory, and it folds in **only the accepted answer** — so a rejected attempt
   leaves no trace, and `fork()` is genuinely clean.
2. **The writer's history alternates user/assistant from the first message.** The `[WRITE]`
   instruction goes into history rather than being passed as an ephemeral extra. A history opening
   with the writer's own prose left the chat template with no user turn after the system prompt and
   the model returned empty completions until the run died.

### 4.1 Failure handling

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

### 4.2 Budget

`config.max_steps` is **soft**: spending it prompts at the console for more (default 8, `0` stops).
A non-interactive run stops instead — there is nobody to ask. `--steps=N` overrides it, which makes
`--steps=3` a cheap smoke test of the whole loop.

### 4.3 Pacing

A scene has a fixed word budget and exactly two things to spend it on: the writer's narration and
the characters' choices. Left alone the writer spends it on narration. Measured across the four runs
in `stories/*/out/`: **~300 words of prose per draft, at most one consult each — 1119 words bought
four decisions**, and 1 of 7 answers carried any speech at all. A scene that runs out of words
before it runs out of story reads as a stall, and that is the mechanism.

Three things push against it, and none of them is a truncation — cutting prose at a word count would
throw away words that were actually written, which is the one thing this loop is built not to do.

- **`config.max_prose_words`** (default 140) is stated in `WRITER_FORMAT` and repeated in every
  `[WRITE]`. When a piece overruns it by more than `OVERRUN_SLACK` (×1.5 — a model told 140 returns
  160, and nagging about 20 words teaches nothing) the **next** `[WRITE]` says so and by how much.
  At the default a 700-word scene is at least five pieces rather than two.
- **`normalizeConsult()`** refuses a request that is not worth sending, *before* any character call.
  It is pure, and it is the engine's half of the split: whether a question is **good** stays a
  judgement, but whether it is a question at all is decidable here. It refuses an empty situation
  (observed in `stories/glass-womb` — a consult went out with a **zero-character** situation, and
  the character, whose only world is that field, answered with filler), a situation under
  `MIN_SITUATION_WORDS`, an empty question, a `wants` with no shape in it, and the **degenerate
  question**: `"What do you do?"`, `"What does Elara do?"`, `"What happens next?"`. Those name no
  fork and no stake, so the safest possible answer is always correct — and the safest possible
  answer is the one that does not move the scene. Four of the seven consults on record were that
  shape. The `why` is written to be handed straight back to the writer, so it says what a good one
  looks like: a rejection the writer cannot act on is one it repeats.
- **`wants` as a closed set** (§3.1), so "ask for words" is a thing the writer can actually do.

A refused consult is logged as `bad_consult` and counts toward the stuck-writer guard in §4.1.

---

## 5. Story format

`stories/<name>/story.md`, `##` sections, `### NAME` sub-blocks under `## Characters`. Story dirs
resolve against **this file's folder**, not the cwd.

One file at the repo root uses the same grammar: `defaults.md` (`## Models`, `## Config`), read only
when no story is loaded yet — see §7 and SPEC-S §2. It is optional.

### 5.1 Field reference (normative)

| section | key | default | absent / malformed |
|---|---|---|---|
| `## Premise` | (prose) | — | **throws** — nothing to write. Blank lines are kept (runs collapse to one, ends trimmed): paragraphing is part of the prose, and it is what lets a scaffolded story round-trip unchanged |
| `## Scene` | `place` | `""` | omitted from both prompts |
| | `question` | `""` | **warns** — the writer alone decides when it is done |
| | `pov` | `""` | not a known character ⇒ warns, ignored |
| | `length` | `700` | non-integer or `< 1` ⇒ warns, default |
| `## Writer` | `file` | — | declared but unreadable ⇒ **throws**; undeclared ⇒ no style block, silent |
| `## Characters` | `### NAME` | — | none ⇒ **throws**; duplicate name ⇒ **throws** |
| | `file` | — | missing or unreadable ⇒ **throws** |
| | `model` | `models.default` | — |
| | `skills` | `""` | `\|`-separated, each `name :: meaning`; nameless entry ⇒ warns, dropped |
| | `lacks` | `""` | `\|`-separated; a name that is not a general skill ⇒ warns, ignored |
| | `knows` | `""` | — |
| `## Config` | `retries` | `2` | every value: warns and uses the default, never throws |
| | `clarifications` | `2` | |
| | `max_steps` | `24` | |
| | `max_prose_words` | `140` | ceiling on ONE draft's prose — the pacing dial, §4.3 |
| | `stream` | `true` | only `true`/`false` |
| | `debug` | `false` | |
| | `thinking` | `low` | `off/low/medium/high/default` |
| | `thinking_writer` / `_character` / `_summary` | `thinking` | |
| | `request_timeout` | `120` (s) | |
| | `attempts` | `3` (total tries) | `1` = never retry |
| | `max_tokens` | `2000` | shared by the reasoning pass and the reply; higher than the engine this forked from because a draft carries prose |
| `## Models` | `default` | `qwen3.6-35b-a3b` | |
| | `writer` / `summary` | `default` | |

Inline `# comments` are stripped after `key: value` in the structured sections **only** — never
inside a character block, where `knows:` and `skills:` are prose.

`loadStory()` takes an optional model override beating `default` above, for exactly one run — the
viewer's model dropdown (§6.1) is what sets it; nothing in the story format itself can. It applies
the same way whether the story was authored by hand or just scaffolded: `renderStory()` writes
`## Models → default:` from whatever S1's own resolution chose (SPEC-S §2), untouched, and the
override is layered on top of that file the moment it is loaded to run.

### 5.2 Sharp edges

- A model id is the one field a structural load cannot check. `--preflight` asks LM Studio's
  `/v1/models` what is actually loaded; an unreachable server downgrades to a warning.
- `config.clarifications: 0` is rejected (`num` requires `>= 1`). To stop characters asking, say so
  in the persona instead.
- Skills are checked, not enforced. See §2.

---

## 6. Outputs

`<story dir>/out/`, written **as the run goes** so an interrupted run leaves both artifacts:

- `scene.md` — the prose alone, rewritten after every draft that produces any.
- `writing-log.jsonl` — one JSON object per line, `seq`-stamped: `scene_start, draft, bad_consult,
  consult, need, clarify, forced, repair, skill_flag, answer, judge, retry, accept, budget,
  reader_ask, reader_answer, model_changed, scene_end`. This is the
  record of *why* the scene reads the way it does — which questions were asked, what was clarified,
  what was rejected and re-asked.

`publish()` fans every event to three places at once — the file, an in-memory history, and any
attached SSE client — under **one `seq`**. So a saved log and a live run are the same data in the
same order, and the viewer renders both identically. See [GUI-SPEC.md](GUI-SPEC.md).

### 6.1 Watching a run

`--serve` opens a live viewer (GUI-SPEC.md). Several frames exist for it that are **never written to
the log**, because they are UI state rather than record: `composing`/`idle` (the indicator),
`continue_prompt` (§4.2's budget question, asked in the browser when one is attached, at the console
otherwise), and `run_state`/`run_reset` (whether a scene is being written right now, and that a new
one has begun). Without `--serve` the whole surface is inert.

A run can also be **stopped** from the viewer — GUI-SPEC §4.2. It sets a flag the loop checks at
every boundary *and* aborts the model call in flight, since a run spends nearly all its time inside
one call. A stop is not a failure: never retried, never salvaged into a half-draft, never written
into a character's memory. `scene_end` carries `stopped` so the log distinguishes the three ways a
scene can end. Stopping returns the session to the picker rather than ending the process; a story
named on the command line still runs once and exits. A stop also resolves any pending reader consult
(with an empty answer, discarded rather than folded in) so it cannot leave the loop parked.

The topbar's **consult me** button (browser-only) arms the one-shot flag `[ASK READER]` checks — see
§3.1, §4. Arming with nobody attached by the time it would fire is dropped silently rather than left
to block forever, the same principle as losing the viewer never costing a scene.

**Pausing** (browser-only, GUI-SPEC §4.4) is a second flag checked at the same loop boundary as
`RUN.stopped`, but it never aborts the call in flight — the point is to let the piece already being
generated finish before the model underneath it changes, not to cut it short. While actually paused
(not merely requested — the loop has to reach the boundary first, which can take as long as the call
in flight), the viewer's model dropdown becomes live-editable and `POST /model` swaps the model on
**every already-instantiated agent**, writer and every character, even one authored with its own
`model:` — pausing is a live override of what is running, not a rewrite of how the story was
authored. The swap is logged (`model_changed`) so the record says when and to what, the same reason a
stop or a reader consult is logged rather than left as UI trivia. The same override, picked before a
run starts, instead beats the story's own `## Models → default:` for that run only (§5.1) — it is
applied before per-character and per-role fallbacks resolve, so it reaches exactly the agents that
would otherwise have inherited the default, and nothing that named its own model explicitly.

The console itself prints a **status line rather than the model's raw draft** — one rewritten line
with elapsed time and characters received, nothing at all when output is not a TTY. Streaming raw
JSON into the terminal buried the formatted output it was interleaved with; the text is still
buffered and parsed exactly as before, only the display changed.

---

## 7. Scaffolding

A run can start from an *idea* rather than an authored folder: an **architect** agent proposes a
complete story, you refine it by saying what to change, and on acceptance it becomes a real
`stories/<slug>/` that is pre-flighted and then run. `--new`, or `n` in the picker. Specified in
[SPEC-S-scaffold.md](SPEC-S-scaffold.md), which is authoritative for it.

Two things hold it together, both the same division of labour as §1's governing rule — the model
owns meaning, the code owns bookkeeping and legality:

- The architect returns a **spec object, never markdown**, so `spec → files → loadStory() → the same
  spec` is a unit test rather than a hope. A scaffolded story that cannot load is caught by
  `renderStory` + `runPreflight` before a single run-time model call is spent.
- A refinement round is a **patch against a closed list of field paths**, not a re-proposal, so
  "it kept the parts I liked" is a property of `applyEdits()` rather than of the model's memory.

The engine owns every path: `slugify()` derives the folder from the title, never the model, and
returns `""` rather than a fallback when nothing usable survives.

Because a generated story is an ordinary folder, it appears in the picker and in `--preflight`
afterwards and can be edited by hand — there is no second kind of story.

---

## 8. What is deliberately not here

Multi-scene stories and outlining · a declarative rule layer gating skills on world state and
possessions · any dependency on the roleplay engine this was forked from.

Tests cover code-enforced invariants only ([tests/writer.test.ts](tests/writer.test.ts)): story and
spec parsing, skill resolution, config rejection, JSON extraction, the consult protocol's control
flow, `applyEdits`, and the scaffolding round trip. Whether the writer asks *good* questions, whether
the architect designs an interesting scene, and whether the prose is any good are judgements — they
belong in a live run, not a pass/fail gate. The one place code does venture an opinion is
`normalizeSpec`, which flags a cast where **nobody lacks anything**: it cannot tell whether a design
is interesting, but it can notice the single absence that reliably makes it dull.
