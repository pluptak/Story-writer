# CLI reference

Requires **LM Studio running locally** at `http://localhost:1234/v1` (hardcoded as `LMSTUDIO_URL`)
with the models named in a story's `## Models` actually loaded — otherwise every call errors.

```bash
npx tsx story-writer.ts stories/doorway
```

## Story selection

The positional arg is a story **directory**, resolved against the repo folder, not the cwd. With no
arg, `discoverStories()` finds every `stories/*` containing a `story.md`; a TTY with more than one
gets a console picker, otherwise the sole/first is used.

**A session is not a run.** Finishing or stopping a scene returns to the picker instead of exiting.
One-shot survives where it was load-bearing: a story dir on the command line, `--consult`, or no TTY
runs once and exits — which keeps `--steps=3` a scripted smoke test.

## Flags

| flag | effect |
| --- | --- |
| `--steps=N` | overrides `config.max_steps`. Non-interactive runs stop when the budget is spent instead of prompting |
| `--consult=NAME --situation=".." --question=".."` | asks one character one question and prints the answer; clarifications answered by you at the console |
| `--new` / `--idea=".."` / `--model=<id>` | scaffold a story from an idea — see below |
| `--serve` / `--port=NNNN` | live viewer, default port 8080 — see below |
| `--preflight` | see below |

## `--new` — scaffolding

An **architect** agent proposes a complete story (premise, scene, personas, skills); you refine it,
then run it. Accepting writes a real `stories/<slug>/`, pre-flights it and runs it. The picker offers
`n. new story…` too. [SPEC-S-scaffold.md](SPEC-S-scaffold.md) is authoritative.

- `--idea="..."` supplies the idea without a prompt, so the path is scriptable.
- `--model=<id>` overrides `defaults.md`, the repo-root file holding the models used *before* a story
  exists (optional; absent means built-in constants).
- At the prompt: `[enter]` accepts, `?` prints the personas in full, `q` abandons, anything else is a
  change in your own words.

## `--serve` — live viewer

`http://localhost:PORT/` shows the scene as prose, with every consult foldable into the gap it
happened in. It also answers the out-of-budget prompt, stops a run, pauses one to swap models, and
runs the scaffolding interview. [GUI-SPEC.md](GUI-SPEC.md) is authoritative for all of it.

Three things worth knowing before you pass the flag:

- **With `--serve` and no story on the command line, the browser drives the session** — the console
  prints status and never blocks on stdin (GUI-SPEC §5). A non-TTY run is never browser-driven.
- **The console stops echoing story prose and character dialogue too** — the viewer is the place to
  read the scene as it streams. The console still carries logs, retries and errors.
- **A port already in use warns and lets the run continue.** Losing the viewer must never cost a
  scene. Without `--serve` the server and SSE fan-out are inert.

## Checks

- `npm run preflight` (or `--preflight [dir]`) runs the real `loadStory()` — no model calls, no
  files written — prints a per-character skill summary plus every warning, and exits 1 if any story
  fails to load. It pings `/v1/models` and reports ids that are not loaded; an unreachable server is
  a warning, never a failure.
- `npm test` runs the deterministic suite ([tests/writer.test.ts](tests/writer.test.ts), `node --test`
  via tsx) — **no model calls, ever**; acceptance writes to a temp dir and its pre-flight makes one
  fast-failing localhost model-list request. It covers **code-enforced** invariants only: story and
  spec parsing, skill resolution, config rejection, `extractJson` / `topLevelObjects` /
  `salvageProse`, the consult protocol's control flow, the stop path, `selectableStory`,
  `applyEdits`, the `ScaffoldSession` state machine and acceptance, and the scaffolding round trip.
  Whether the writer asks *good* questions is judgement, not a gate. Because the tests import the
  engine, `story-writer.ts` only runs when it is the entry point (`IS_MAIN`) — importing it must
  never start a run.
- `npx tsc` typechecks (`noEmit`). `include` lists all five modules — add new ones there. Imports
  carry the `.ts` extension, hence `allowImportingTsExtensions`.

## Output

`<story dir>/out/<run id>/`, one folder per run: `scene.md` (prose alone) and `writing-log.jsonl`
(every consult, clarification, repair, flag, retry and acceptance). Both are written as the run goes,
so an interrupted run still leaves readable artifacts. A story keeps its last 3 runs, oldest pruned
once the newest finishes writing ([RUN-RECORD.md](RUN-RECORD.md)); the browser picker can **read** any
of them ([VIEWER-UI.md](VIEWER-UI.md#the-picker)).
