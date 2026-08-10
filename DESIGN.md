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
| character | own persona, own skills, own `knows:`, the situation the writer wrote, its own accepted answers | the premise, the draft, the scene's purpose, anyone else's replies |

A writer holding everyone's interiority writes them from the inside and stops asking; a character
holding the draft answers the story instead of the moment. Both directions are enforced by what
`wrapWriter()` and `wrapCharacter()` put in the prompt, and by `consult()` never seeing the draft.

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
silently dropped. This is best-effort by design: the deterministic version is a rule layer with
world-state predicates, which this v1 does not have.

---

## 3. JSON contracts

Every agent reply is one JSON object. `extractJson()` takes the **last top-level** object (models
emit examples and preambles first) and falls back to labelled prose.

Two agents run during a scene — the writer and each character. The **architect**, which only runs
before a scene exists, has its own contracts in [SPEC-S-scaffold.md](SPEC-S-scaffold.md) §3–4.

### 3.1 Writer — three modes

The mode is set by the leading tag on the user message.

| tag | returns |
|---|---|
| `[WRITE]` | `{ prose, consult?: { character, situation, question, wants }, scene_done }` |
| `[<NAME> ASKS]` | `{ answer }` |
| `[<NAME> ANSWERED]` | `{ verdict: "accept" \| "retry", note, revised?: { situation, question } }` |

- `prose` may be `""` on a step that only consults; `consult` is omitted when none is needed.
- **The one rule**, stated as its own block in `WRITER_FORMAT`: dialogue and deliberate acts may
  reach the page only from an answer already received. The place, the light, involuntary body and
  anything already answered are the writer's. **The POV character is not exempt** — the point of
  view is a lens, not a licence. Observed failure it exists to prevent: the writer wrote *"She
  doesn't reach for the package yet… waiting"*, then consulted, and was told *"I take the package
  with both hands"* — an answer wasted against a page that already said otherwise. The `[WRITE]`
  instruction carries a one-line echo of the rule on every step.
- `situation` is the only world the character gets. The contract tells the writer to put no steer
  toward the answer it wants in there.
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
  [WRITE]                 -> prose (appended, written to out/scene.md) + optional consult + scene_done
  consult requested?
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
| three drafts with no prose and no consult | stop — a stuck writer should not eat the budget |

### 4.2 Budget

`config.max_steps` is **soft**: spending it prompts at the console for more (default 8, `0` stops).
A non-interactive run stops instead — there is nobody to ask. `--steps=N` overrides it, which makes
`--steps=3` a cheap smoke test of the whole loop.

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
- `writing-log.jsonl` — one JSON object per line, `seq`-stamped: `scene_start, draft, consult, need,
  clarify, forced, repair, skill_flag, answer, judge, retry, accept, budget, scene_end`. This is the
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
every boundary *and* aborts the model call in flight, because a run spends nearly all of its time
inside one call. A stop is not a failure: it is never retried, never salvaged into a half-draft, and
never written into a character's memory. `scene_end` carries `stopped` so the log distinguishes the
three ways a scene can end. Stopping returns the session to the picker rather than ending the
process; a story named on the command line still runs once and exits.

The console itself prints a **status line rather than the model's raw draft** — one rewritten line
with elapsed time and characters received, and nothing at all when output is not a TTY. Streaming
raw JSON into the terminal buried the formatted output it was interleaved with; the text is still
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

Multi-scene stories and outlining · a live viewer / SSE server · a declarative rule layer gating
skills on world state and possessions · any dependency on the roleplay engine this was forked from.

Tests cover code-enforced invariants only ([tests/writer.test.ts](tests/writer.test.ts)): story and
spec parsing, skill resolution, config rejection, JSON extraction, the consult protocol's control
flow, `applyEdits`, and the scaffolding round trip. Whether the writer asks *good* questions, whether
the architect designs an interesting scene, and whether the prose is any good are judgements — they
belong in a live run, not a pass/fail gate. The one place code does venture an opinion is
`normalizeSpec`, which flags a cast where **nobody lacks anything**: it cannot tell whether a design
is interesting, but it can notice the single absence that reliably makes it dull.
