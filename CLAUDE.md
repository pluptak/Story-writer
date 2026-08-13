# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## Working process (how to build here)

The owner wants change delivered in **small, independently-pausable blocks**, not whole features at
once. When implementing:
- **Split each feature into named blocks** and finish one before starting the next. Prefer the
  smaller self-contained slice even when it is not the most efficient path.
- **Keep the owner in the loop**: present the block plan and surface real design forks *before*
  coding; report at each block boundary.
- **Test once per block, not per step.** Verify when a whole block is complete. Do not run the model
  after every edit.
- **Live runs are the owner's to run**, batched. Hand off after the cheap static checks
  (`npx tsc`, `npm test`, `npm run preflight`) with the exact commands.
- Engine changes and story-authoring changes are separate blocks — the engine must stay
  story-independent (it knows nothing about any particular character).

## What this is

A single-file **story writer** engine. A writer agent drafts one scene from a premise and, whenever
what happens next turns on a choice a character makes, **consults** that character's agent. The
character may ask for a fact it was not given before answering; the writer accepts the answer or
rewrites the question and asks a **fresh instance** that never learns it was rejected. Everything
about a particular story lives in a folder under [stories/](stories/); the engine in
[story-writer.ts](story-writer.ts) knows nothing about any of it.

**[DESIGN.md](DESIGN.md) is the authoritative spec** — read it before making architectural changes,
and keep it in sync when you change the loop, the JSON contracts or the story format. §5.1 is the
normative field reference.

This is a **fork** of the "Multimodel AI roleplay" game-master engine. The transport, JSON
extraction, agent/history windowing, markdown parsing and config-validation policy were carried over
as source; the Director / Warden / Ledger / WorldState machinery was not. **Nothing here imports or
references that repo** — keep it that way.

## Commands

Requires **LM Studio running locally** with a loaded model at `http://localhost:1234/v1` (hardcoded
as `LMSTUDIO_URL`). The model ids in a story's `## Models` must match what LM Studio actually has
loaded, or every call errors.

```bash
npx tsx story-writer.ts stories/doorway
```

- The CLI arg is the story **directory**, resolved against this file's folder rather than the cwd.
  With no arg, `discoverStories()` finds every `stories/*` folder containing a `story.md`; a TTY with
  more than one gets a console picker, otherwise the sole/first is used.
- `--steps=N` overrides `config.max_steps`. A non-interactive run stops when the budget is spent
  instead of prompting, which makes `--steps=3` a cheap smoke test of the whole loop.
- `--consult=NAME --situation="..." --question="..."` asks one character one question and prints the
  answer — the character half alone, with clarifications answered by you at the console.
- `--new` starts from an idea instead of an authored folder: an **architect** agent proposes a
  complete story (premise, scene, personas, skills) which you refine and then run. `--idea="..."`
  supplies the idea without a prompt, so the path is scriptable and testable; `--model=<id>`
  overrides `defaults.md`. At the prompt: `[enter]` accepts, `?` prints the personas in full, `q`
  abandons, anything else is a change in your own words. The interview itself is
  **`ScaffoldSession`** — headless, architect injected, `propose()` / `say()` / `accept()` — and the
  console is just one caller of it; `accept()` returns `needs_folder` rather than prompting, so the
  folder-collision path is testable and the browser can reuse it in W4.
  **[SPEC-S-scaffold.md](SPEC-S-scaffold.md)
  is authoritative** — S1–S3 have landed, so the loop from idea to running scene is closed:
  accepting writes a real `stories/<slug>/`, pre-flights it, and runs it. A refinement is a **patch
  against a closed list of field paths**, never a fresh proposal, so what you already liked cannot
  drift — `applyEdits()` is where that is enforced. The picker offers `n. new story…` too.
- `defaults.md` at the repo root holds the models used *before* a story exists (scaffolding needs a
  model before there is a story to read one from). Optional; absent means built-in constants.
- `--serve` (`--port=NNNN`, default 8080) opens the **live viewer** at `http://localhost:PORT/` —
  the scene as prose with every consult foldable into the gap it happened in.
  **[GUI-SPEC.md](GUI-SPEC.md) is authoritative** for it. The viewer also answers the out-of-budget
  prompt and can **stop a run** (`POST /stop`, topbar button, second click confirms), so a run can be
  extended or abandoned from the browser. The server now starts before the picker, so the viewer is
  up while you are still choosing. A port already in use **warns and lets the run continue** —
  losing the viewer must never cost a scene. Without `--serve` nothing changes: the server, SSE
  fan-out and all, is inert.
- **A session is not a run.** Finishing or stopping a scene returns to the picker instead of exiting,
  so abandoning a story costs the scene and nothing else. One-shot is preserved exactly where it was
  load-bearing: a story dir on the command line, `--consult`, or no TTY still runs once and exits,
  which keeps `--steps=3` a scripted smoke test. A stop cuts the model call in flight (`RUN.abort`)
  as well as breaking the loop, and is never reported as a failure — see GUI-SPEC §4.2.
- **With `--serve` and no story on the command line, the browser drives the session** (GUI-SPEC §6):
  the console prints status and never blocks on stdin, `GET /stories` serves pre-flighted picker
  cards, and `POST /select` resolves the parked `awaitPick()`. A dir arriving over HTTP is checked
  against `discoverStories()` by `selectableStory()` — never trusted as a path. A non-TTY run is
  never browser-driven.
- **The scaffolding interview runs in the browser too** (GUI-SPEC §6.1): `POST /scaffold/{start,say,
  accept,abandon}` over one server-held `ScaffoldSession`, pushed to every client as `scaffold`
  frames. It is **conversation only** — same patch-through-the-architect round the console sends.
  The session stays parked in `awaitPick()` throughout, so accepting just resolves that pick with
  the directory it wrote; the main loop never learns an interview happened.
- `npm run preflight` (or `--preflight`, optionally with a dir) runs the real `loadStory()`, makes no
  model calls, writes no files, prints a per-character skill summary plus every warning, and exits 1
  if any story fails to load. It also pings `/v1/models` and reports ids that are not loaded; an
  unreachable server downgrades to a warning, never a failure.
- `npm test` runs the deterministic suite ([tests/writer.test.ts](tests/writer.test.ts), `node --test`
  via tsx — **no model calls, ever**; acceptance writes to a temp dir and the pre-flight behind it
  makes one fast-failing localhost model-list request). It covers **code-enforced** invariants only:
  story and spec parsing, skill resolution, config rejection, `extractJson` / `topLevelObjects` /
  `salvageProse`, the consult protocol's control flow, the stop path, `selectableStory`,
  `applyEdits`, the `ScaffoldSession` state machine and acceptance, and the scaffolding round trip. Whether the
  writer asks *good* questions is judgement, not a gate. Because the tests import the engine,
  `story-writer.ts` only runs when it is the entry point (`IS_MAIN`); importing it must never start
  a run.
- `npx tsc` typechecks (`noEmit`, `include` is just `story-writer.ts`).
- Outputs land in `<story dir>/out/<run id>/`, one folder per run: `scene.md` (prose alone) and
  `writing-log.jsonl` (every consult, clarification, repair, flag, retry and acceptance). Both are
  written as the run goes, so an interrupted run still leaves readable artifacts. A story keeps its
  last 3 runs, oldest pruned once the newest finishes writing (DESIGN.md §6); the browser picker lets
  you **read** any of them, read-only, alongside starting a new one (GUI-SPEC.md §6).

## Architecture

Everything is in [story-writer.ts](story-writer.ts). **Agents** are all the same generic `Agent`
class (windowed history + rolling `digest`), differing only by system prompt, model and temperature:
**writer** (0.8) and one **character** per `### NAME` (0.9).

**The asymmetry is the product.** The writer is given the premise, the scene, the house style, and
the cast as names + capabilities — never anyone's persona. Each character is given its own persona,
skills and `knows:`, plus the situation the writer wrote for it — never the premise, the draft, or
another character's replies. See DESIGN.md §1.

**Skills** (`SKILL_CATALOG` + per-character `skills:` / `lacks:`) are a *checked* menu, not a gate: a
claimed skill the character lacks earns one re-ask, then reaches the writer flagged. DESIGN.md §2.

**The consult** (`consult()`) resolves clarifications, forces an answer when that budget is spent,
runs one repair pass, and checks skills. It **never touches `agent.history`** — the caller folds in
only the accepted answer, which is what makes `agent.fork()` a genuinely clean retry.

**The loop** (`writeScene()`) alternates `[WRITE]` with consult cycles until `scene_done` or the soft
step budget runs out. DESIGN.md §4.

### Gotchas
- **The writer's history must start with a user message.** The `[WRITE]` instruction is pushed into
  history rather than passed as an ephemeral extra for exactly this reason — a history opening with
  the writer's own prose left the chat template with no user turn after the system prompt, and the
  model returned empty completions until the run died.
- **`thought` is capped at two sentences and `speech` carries no quote marks** in `CHARACTER_FORMAT`.
  Both were earned: an uncapped `thought` became a dumping ground for the model's whole deliberation
  and blew the 120s request deadline mid-object.
- **The writer's standing temptation is to write a character's choice and then ask about it**, which
  wastes the answer against a page that already contradicts it. `WRITER_FORMAT`'s "THE ONE RULE"
  block and the echo on every `[WRITE]` exist for that, and the POV character is deliberately not
  exempt. It is LLM-judged, so check a run's log for consults whose answers the prose pre-empted
  before loosening any of it.
- **A scene stalls by spending its words on narration.** The budget buys narration or choices, and
  uncapped the writer buys narration: measured, ~300 words of prose per draft and four decisions out
  of 1119 words, with 1 answer in 7 carrying any speech. Three things push back, all in DESIGN.md
  §4.3 — `config.max_prose_words`, `normalizeConsult()` refusing a request before it costs a
  character call, and `wants` as a closed set so "ask for words" is expressible. If a story wants
  long unbroken prose, raise `max_prose_words` for that story rather than removing the cap.
- **THE ONE RULE has two clauses that were added late, and both look redundant until you read a
  stalled log.** Stillness is a choice (inaction reads as absence and escapes a rule about acts), and
  the pressure may not be resolved before the consult that turns on it (a threat leaving is "time
  passing", which the rule grants). DESIGN.md §3.1 records the run each came from.
- **A draft carries prose, so it is the reply most likely to hit the token cap.** Truncated JSON
  parses to nothing, which would throw away words that were actually written — hence `max_tokens`
  defaulting to 2000 here rather than the 1200 this forked with, and `salvageProse()` as the net.
  If drafts start coming back marked `salvaged` in the log, raise `config.max_tokens` for that story.
- **Model calls are heavy.** A step is 1 draft + 1 judge + 1–3 character calls + any clarifications,
  each tens of seconds locally. A full scene takes a while — expect to interrupt, and note that both
  output files survive it.
- `LMSTUDIO_URL`, `MAX_TOKENS`, `STREAM`, `DEBUG`, `OUT_DIR` are module-level mutable globals set by
  `main()` from the loaded story.
