# RUN RECORD — what a run leaves behind

`<story dir>/out/<run id>/`, one folder per run, written **as the run goes** so an interrupted run
leaves its artifacts:

- `scene.md` — the prose alone, rewritten after every draft that produces any.
- `writing-log.jsonl` — one JSON object per line, `seq`-stamped: `scene_start, draft, bad_consult,
  consult, need, clarify, forced, repair, skill_flag, answer, judge, retry, accept, budget,
  reader_ask, reader_answer, model_changed, scene_end`. This is the record of *why* the scene reads
  the way it does — which questions were asked, what was clarified, what was rejected and re-asked.
- `llm/<agent>.jsonl` — one file per agent identity (`writer`, each character), one JSON object per
  model call: `ts`, `role`, `agent`, `model`, `prompt` (the exact `messages` array sent — system,
  digest, history, the trailing `"{"` priming turn) and `response` (the model's raw reply text,
  before `extractJson`). A rejected/retried attempt is just another line: `fork()` keeps the same
  name, so it keeps writing to the same file. File-only — never routed through `publish()`, never
  `seq`-stamped, never reaches the SSE viewer.

`publish()` fans every event to three places at once — the file, an in-memory history, and any
attached SSE client — under **one `seq`**. A saved log and a live run are therefore the same data in
the same order, and the viewer renders both identically.

`scene_end` carries `stopped`, so the log distinguishes the three ways a scene can end: finished, ran
out, abandoned.

## Retention

**A story keeps its last `MAX_RUNS` (3) runs.** `<run id>` is the run's start time as an ISO timestamp
(`:`/`.` swapped for `-`: filesystem-safe, and sort order stays chronological order), so `runDirs()` —
every run folder under a story's `out/`, oldest first — is a plain directory listing needing no
metadata file. Rotation runs once, after a run finishes writing: list, delete whatever is oldest
beyond `MAX_RUNS`.

`retainedRuns()` reads each kept run's own `scene_end` line for its outcome (`steps`, `words`, `done`,
`stopped`); a run killed mid-scene has no such line and is listed with those fields simply absent —
"absent, not guessed at", the same rule `scene_end` follows for `stopped`.

A story predating run folders (a flat `out/scene.md` + `out/writing-log.jsonl`) is left alone:
`runDirs()` only counts directories, so those files are neither migrated nor rotated away.

## What the engine owes the viewer

`--serve` opens a live viewer; [GUI-SPEC.md](GUI-SPEC.md) is authoritative for it, including the
console's status line. The engine's side of the boundary is three things and no more:

- **Frames that are never written to the log**, being UI state rather than record: `composing`/`idle`,
  `continue_prompt` (the budget question, [LOOP.md](LOOP.md#budget)), and `run_state`/`run_reset`.
  Without `--serve` the whole surface is inert.
- **Three boundary flags** the loop checks between steps — stop, reader-consult arm, pause. Only stop
  also aborts the model call in flight, since a run spends nearly all its time inside one call; pause
  deliberately does not, so the piece being generated finishes before the model under it changes.
- **A model swap is record, not UI state** (`model_changed`): it changes what the rest of the scene
  sounds like. While paused, `POST /model` swaps **every already-instantiated agent**, writer and
  characters, even one authored with its own `model:` — a live override of what is running, not a
  rewrite of how the story was authored. Picked *before* a run it instead beats the story's
  `## Models → default:` ([STORY-FORMAT.md](STORY-FORMAT.md#sharp-edges)).
