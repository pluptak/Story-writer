# Multi-Chapter Viewer

**Status: proposed.** Chapter execution is already implemented: one run writes one chapter, and the
finished prose is stored in `chapters/<n>.md`. The viewer still treats the story page primarily as a
single-scene page. This document records only the remaining UI work.

## Current contract

- `story.json.scenes[]` is the chapter list; its index is the chapter number minus one.
- `POST /select` accepts `{ dir, chapter }` and starts one selected chapter.
- A completed chapter is written to `chapters/<n>.md`. Partial or stopped runs remain in their run
  directory and do not replace the accepted chapter file.
- `scene_start` and `scene_end` identify the chapter. `scene_end` is the terminal event for a run;
  there is no `story_end` event.
- Run summaries are retained under each story's `runs[]` list. The current retention limit is three
  run directories, so chapter files are the durable reading surface.

The full HTTP and SSE contract belongs in [`GUI-SPEC.md`](GUI-SPEC.md). This document should not
repeat event shapes or route error handling.

## Viewer work

1. ~~Show every `story.json.scenes[]` entry on the story page, including its place, question, POV, and
   whether it is writable.~~ Done — `/stories` carries `scenes[]` and `chapters[]`, and the story page
   draws a row per chapter tagged `written`/`next`.
2. ~~Give each chapter its own write action that posts `{ dir, chapter }` to `/select`.~~ Done.
3. ~~Display the accepted `chapters/<n>.md` text in chapter order.~~ Done — `GET /chapter?dir=&n=`
   serves the prose and each written chapter row on the story page opens it inline.
4. Group retained runs by chapter and make each run's log available through the existing log routes.
5. Keep current-run rendering scoped to one chapter. Aggregate story-level totals only when the UI is
   explicitly showing more than one run.

## Out of scope

- Adding a new server route solely for chapter discovery; `/stories` now carries `scenes[]` and the
  written chapter numbers, so chapter discovery needs no route.
- Reintroducing `story_end` or a multi-scene run.
- Editing chapter prose. The proposed editor is described in [`SPEC-E-editor.md`](SPEC-E-editor.md).
