  # SPEC S — scaffolding a story from an idea

  **Status:** complete (S1–S4, W3, W4 — see §6). The interview lives in `ScaffoldSession` (§4.2) and
  runs from both the console and the browser over one implementation. The loop from idea to running
  scene is closed, and the deterministic tests in §5 all pass. [DESIGN.md](DESIGN.md) §7 summarises
  this; §5 there covers the story format it writes. This document stays authoritative for the
  scaffolder's own contracts and decisions.

  **Scope.** Let a run start from an *idea* instead of an authored folder. You type what you want, an
  **architect** agent proposes a complete story, you refine it by saying what to change, and on
  acceptance it becomes a real `stories/<slug>/` folder that the normal run path loads.

  > **Governing principle, inherited from the rest of this fork**
  > **Code owns bookkeeping and legality. The model owns meaning.**
  > The architect proposes premise, people and voices. It never decides where files go, what a slug
  > is, whether a field name exists, or whether the result loads.

  ---

  ## 1. Why it needs a spec at all

  The obvious build — ask a model for `story.md` and write the string to disk — fails in one specific
  way: a scaffolded story can be *subtly unloadable* (a missing `file:`, a `### NAME` under the wrong
  section, a `lacks:` naming a skill that does not exist) and you find out at run time, after paying
  for a model call.

  So the architect returns a **`StorySpec` object**, never markdown, and `renderStory()` turns that
  into the files `loadStory()` reads. This buys the invariant the whole feature rests on:

  > **spec → files → `loadStory()` → the same spec.**
  > Deterministic, no model, a unit test (§5).

  ---

  ## 2. Where models come from before a story exists

  `## Models` lives *inside* a story, and scaffolding happens before there is one. Resolution order:

  1. the model chosen in the browser's `built by` dropdown, sent with `POST /scaffold/start`
    (GUI-SPEC §6.1) — the most specific asking wins
  2. `--model=<id>` (sets `models.default`)
  3. `defaults.md` at the repo root — the same section grammar `parseStoryMd` already reads
  4. built-in constants

  Each of the first three sets `models.default` *and* `models.architect`, so before a story exists
  there is exactly one model in play: the one that designs the story is the one written into its
  `## Models` and therefore the one that writes it. Two separate choices would be a second concept
  bought before anyone has asked for it — the topbar dropdown already overrides what a run uses
  (GUI-SPEC §4.4), so designing with one model and running with another remains one click away.

  ```markdown
  ## Models
  default: gemma-4-12b-it-qat-uncensored-heretic
  architect: ...        # optional; falls back to default

  ## Config
  thinking: low
  thinking_architect: low
  max_tokens: 2000
  request_timeout: 300
  attempts: 3
  ```

  `defaults.md` is **optional** — absent means the built-ins, silently. A generated story inherits
  these `## Models` so it is runnable the moment it is written.

  `request_timeout` is **300 here, not the 120 a story turn uses**. One architect reply is a whole
  story — premise, scene, and a ~150-word persona per character. Measured at 120 it timed out twice on
  a two-character proposal, discarding a *finished* one each time and keeping the third and weakest.
  (The transport now also keeps a reply that broke off after completing an object — DESIGN.md §4.1 —
  but that is the net, not the fix.)

  ---

  ## 3. The spec

  ```ts
  interface StorySpec {
    title: string;
    premise: string;
    scene: { place: string; question: string; pov: string; length: number };
    writerStyle: string;
    characters: Array<{ name: string; persona: string; knows: string; goal: string; skills: string[]; lacks: string[] }>;
  }
  ```

  `slug` is deliberately **not** in here — the engine derives it from `title` (§4.3). A model that
  picks its own path is a model that can write outside `stories/`.

  Single-line fields (`knows`, `skills`, `lacks`, `place`, `question`) are **flattened on render** —
  the grammar's `key: value` is one line, and a stray newline would silently end the field early.
  `premise` keeps its paragraph breaks: `parseStoryMd` was changed to preserve blank lines in prose
  sections, which is both better for the writer's prompt and what makes the round trip exact.

  `normalizeSpec(raw)` (pure) coerces the model's object into this shape and returns the problems it
  found rather than throwing: names trimmed and de-duplicated, 1–4 characters enforced, `length`
  made a positive integer, `pov` cleared unless it names a character, `skills`/`lacks` split from
  strings or arrays. **`lacks:` entries must name catalog skills** — a `lacks:` the catalog does not
  contain removes nothing, which silently does the *opposite* of what was asked (§4.2 of DESIGN.md
  covers the same trap in hand-authored stories).

  ---

  ## 4. The interview

  ### 4.1 Entry

  `--new`, or the console picker's `new story…` entry (S3). A non-TTY run **never** enters the
  interview — there is nobody to interview — and behaves exactly as today.

  ### 4.2 The loop

  The loop's decisions live in **`ScaffoldSession`** — the interview with no console in it. The caller
  supplies the architect (injected, not built, so a scripted agent can drive it), then reads `spec`,
  `problems` and `pendingAsk` off the session and renders them however it likes:

  | call | returns |
  |---|---|
  | `propose()` | `proposal` · `question` · `nothing` · `failed` |
  | `say(text)` | the same, plus `edits {applied, ignored}` |
  | `accept(folder?)` | `written` · `unloadable` · `needs_folder` · `no_story` |

  Two things this buys, beyond serving the terminal and the browser from one implementation. **The
  state machine below became testable** — the proposal-vs-patch rule and the ask budget were welded to
  readline, so the bug this section exists for could only ever be caught by hand. And **`accept()`
  returns `needs_folder` instead of prompting**: the author still has to answer, but *where* they
  answer is the caller's business, which is what removes the folder-collision path from §5's
  not-covered list.

  **A round is a PROPOSAL or a PATCH, decided by whether a usable story exists — not by whether it is
  the first call.** This is load-bearing. The architect is told to ask a question *instead of*
  proposing when the idea is underdetermined (§3, `ask`), so a vague prompt legitimately yields no
  story on the first call. The loop originally assumed "first call proposes, everything after
  patches", so the author's answer was sent as `[CHANGE] … Reply with edits only` against an **empty
  spec** — edits to a story that had never been proposed. Whatever came back patched a void, the spec
  stayed empty, and every later round inherited the same emptiness. An ambiguous prompt could not be
  recovered from, only abandoned.

  Consequences of deciding by state instead:

  - No story yet ⇒ the request carries the original idea plus what has been learned since, and asks
    for the whole thing. `[MORE] … [THE IDEA, AGAIN] … Propose the whole story now.`
  - After **3 consecutive questions with nothing to show**, the request adds *"Do not ask anything
    else — choose the most interesting reading and commit to it."* An author who keeps being
    interrogated instead of shown something has been given nothing to react to. (The same lesson as
    the character clarification budget in DESIGN.md §4: a question is only worth asking if an answer
    can still arrive.)
  - `[enter]` and `?` do nothing while there is no story, and the prompt says *"say more about it"*
    rather than offering to accept nothing.

  ```
  you type an idea (multi-line, ends on a blank line)
    -> architect proposes a full spec
    -> printed as a readable summary, never raw JSON
  loop:
    [enter]  accept
    ?        print the personas in full
    q        abort, write nothing
    anything else -> a change, in your words
        -> architect returns EDITS, not a new story
        -> engine applies the known ones, warns on the rest, reprints what changed
  ```

  Refinement is a **patch**, against a closed vocabulary of field paths:

  ```
  title · premise · writer_style
  scene.place · scene.question · scene.pov · scene.length
  characters.<NAME>.persona · .knows · .goal · .skills · .lacks
  add_character · remove_character
  ```

  `{ edits: [{field, value}], ask?, note? }`. The engine applies what it recognises and warns about
  what it does not. Re-proposing the whole story each round would make "it kept the parts I liked" a
  hope; a patch against a closed list makes it a property of the code. `applyEdits()` is pure, does
  not mutate its input, and **re-normalizes the result** — so removing the POV character clears
  `scene.pov` rather than leaving it dangling, and a bad `lacks:` is caught in the round that
  introduced it rather than at write time.

  The current spec is sent with every change (`[THE STORY AS IT STANDS]`), so the architect edits what
  the **engine** holds rather than what it last said — its own history and the authoritative spec can
  otherwise drift apart after a few rounds.

  Accepting over an outstanding complaint is allowed — the problems are judgements about the design,
  not errors — but it takes a second, deliberate keypress rather than the same one.

  **`ask`** is the architect's consult move pointed at the author: when the idea is underdetermined it
  asks instead of inventing, and that round changes nothing. This is the same rule the characters
  already follow — ask for the fact you are missing rather than making one up.

  Observed: **it never asked.** Two causes, one on each side of this fork's line.

  - *The prompt.* The rule sat at the bottom of a long field list, hedged with `"" normally`, phrased
    as "genuinely underdetermined" — no trigger a model could check. It is now a **FIRST DECIDE** block
    ahead of the JSON template with a concrete test: does the idea say WHO is in the scene, and WHAT is
    at stake? If either is missing, ask and leave everything else empty. *"Two lighthouse keepers"*
    names who and stakes nothing; that is the worked example of a question.
  - *The code.* `ask` was only honoured when nothing else came back, so a reply carrying **both** a
    story and a question — which is what the model actually does — dropped the question on the floor.
    It cannot become `pendingAsk` (an outstanding question blocks accepting, and there is a perfectly
    good story sitting there), so `withAsk()` folds it into the round's note: visible, answerable as an
    ordinary change, ignorable.

  The over-asking guard in §4.2 (`MAX_ASKS`) is what makes it safe to push this way.

  ### 4.3 Acceptance

  1. `slug` = engine-derived from `title` (lowercased, non-alphanumerics collapsed to `-`, trimmed,
    capped at 40). Empty or colliding ⇒ say so and ask for a folder name, which is slugified the same
    way; blank goes back to refining. An authored story is **never** overwritten, and `slugify("???")`
    is `""` rather than any fallback — a name that cannot be derived must be asked for, not invented.
    Two characters whose names slug alike get `name.md` and `name-2.md`, never one file.
  2. `renderStory(spec, models)` returns `story.md`, one `<name>.md` per character, and `writer.md`
    when a style was proposed — as **filename → contents**, writing nothing itself. That is what
    makes the round trip testable without a filesystem. The caller writes them.
  3. **`runPreflight()` on the written folder before the run starts.** A scaffold that cannot load
    must not become a failed run — this is the same real-loader check `--preflight` uses, so it
    cannot drift.
  4. Hand the directory to the normal `loadStory()` + `writeScene()`.

  ---

  ## 5. Tests

  Deterministic, no model, no network — all landed:

  - **round trip** — `normalizeSpec` → `renderStory` → temp dir → `loadStory` → every field matches,
    including the two that would silently change the *scene* if lost: a `skills:` entry's `::` meaning,
    and a `lacks:` surviving as a real absence without taking anything else with it. Plus a multi-line
    `knows:` that must be flattened rather than truncating the field.
  - `applyEdits` — one test per field path; input never mutated; an unknown path is reported and
    changes nothing; the cast bound holds when a fifth character is added; `remove_character` of the
    `pov` clears `scene.pov`; a missing/empty/malformed `edits` list is survivable.
  - `normalizeSpec` — a `lacks:` naming no catalog skill, an unknown `pov`, duplicate names, pipe
    strings for `skills`/`lacks`, a persona that restates the structured fields, and a cast where
    nobody lacks anything.
  - `slugify` — punctuation, path traversal (`../../etc/passwd` → `etc-passwd`), length cap, and that
    an underivable name yields `""` rather than any fallback.
  - `renderStory` shape — `## Writer` omitted entirely when there is no house style, empty scene keys
    omitted rather than written blank, and two names that slug alike getting separate files.
  - **a non-TTY run never enters the interview** — the picker must never return `NEW_STORY` without a
    terminal, so a scripted run behaves exactly as it did before scaffolding existed.
  - **the interview itself**, against a scripted architect (added with `ScaffoldSession`): an
    ambiguous idea recovering instead of patching a void; the request being `[MORE] … propose the
    whole story` before a story exists and `[CHANGE] … reply with edits only` after; the insistence
    that lands after `MAX_ASKS`; a question mid-refinement changing nothing; the outstanding question
    clearing once a round answers it; and a failed round leaving the spec exactly as it was.
  - **acceptance**, against a temp directory: `no_story` before anything is proposed, `needs_folder`
    for a title that yields no slug *and* for a folder already taken, and a written story that the
    real `loadStory()` reads back with its absences intact.

  Not covered, and deliberately: the console keystrokes themselves (`[enter]` / `?` / `q`), which need
  a terminal. Everything they lead to is now covered directly.

  ---

  ## 6. Blocks

  | block | contents | status |
  |---|---|---|
  | **S1** | `defaults.md` + `loadDefaults()`, `--model=`, `ARCHITECT_FORMAT`, `StorySpec` + `normalizeSpec`, `--new` producing one printed proposal. No writing, no refining. | **landed** |
  | **S2** | the refine loop: `applyEdits()`, the closed path vocabulary, `ask`, `?`, `q` | **landed** |
  | **S3** | `renderStory()`, `slugify` + collision refusal, write, pre-flight, hand off; picker entry | **landed** |
  | **S4** | the tests in §5, DESIGN.md §7, CLAUDE.md | **landed** |
  | **W3** | `ScaffoldSession` — the interview extracted from the console (§4.2), the console loop rebuilt on it, and the state machine + acceptance tests in §5 | **landed** |
  | **W4** | the same session driven from the browser — `/scaffold/*` and the interview screen, conversation only. [GUI-SPEC.md](GUI-SPEC.md) §6.1 is authoritative for that surface | **landed** |

  ---

  ## 7. Known risks, and what was actually observed

  - **Persona quality is the whole value**, and it is what a local model is weakest at. Two
    mitigations: the architect is shown a real authored story as a worked example (read from
    `stories/doorway` at runtime, so the example can never drift from the format), and `?` lets the
    personas be read in full before anything is written.
  - **An architect that writes bland symmetry.** Observed on the first live proposal: two lighthouse
    keepers who could both do everything, with "skills" that merely renamed general ones
    (`watching :: perceiving the rotation of the lens` is sight). Answered on both sides of the line
    this fork draws — the prompt now forbids restating a general skill and requires that at least one
    character lack something real, and `normalizeSpec` **reports a cast where nobody lacks anything**.
    The next proposal gave a keeper who cannot hear, in a scene whose central lie is a fog signal that
    never fired.
  - **The architect bleeding structured fields into persona prose** (`LACKS: None.` written inside a
    persona while the engine hands that character a skill list with something missing — a
    contradiction inside its own prompt). Same treatment: forbidden in the prompt, reported by
    `normalizeSpec`.
  - Each refine round is one model call; the initial proposal is one. Negligible next to a run.

  **Not verified end to end by machine:** accept → write → pre-flight → run, because the accept
  keystroke needs a terminal. Every piece of it is covered deterministically (§5) and every step up to
  acceptance has been exercised live.
