# Next Steps

This is the short backlog after the recent reliability work. Completed implementation notes belong in
git history, not in an evergreen planning document.

## Highest value

1. **Run inspector.** Render retained `writing-log.jsonl` and per-agent `llm/*.jsonl` data through the
   existing `/log.jsonl` and `/runs/log` routes. Keep inspection read-only and separate from run control.
2. **Multi-chapter reader.** Implement the UI in [`SPEC-GUI-MULTISCENE.md`](SPEC-GUI-MULTISCENE.md):
   chapter list, accepted prose, chapter-specific write action, and runs grouped by chapter.
   [`Writer.MD`](Writer.MD) tracks the matching API gaps on the live-run side (`chapter` missing from
   `RunMeta` and `RunSummary`).
3. ~~**Handoff screen.**~~ Built — the `#/handoff?dir=` page consumes `/next-chapter/*` and the
   `handoff` SSE state. What is left of it is the chapters-written column, which needs the chapter
   prose route in (2). Design in [`Architect.MD`](Architect.MD), behaviour in
   [`SPEC-H-handoff.md`](SPEC-H-handoff.md).
4. **Story editor.** Design and implement the JSON-backed draft and validation flow in
   [`SPEC-E-editor.md`](SPEC-E-editor.md).

## Reliability follow-ups

- Add coverage for `runAndSave` write-failure paths if that logic is extracted from the composition root.
- Keep `liveHistory` growth within a run under observation; it is reset between runs but is currently
  not bounded during a very long run.
- Do not add a bind-address option until the local server has an authentication design.

## Design question

A continuity checker would need to read several chapters in one model call. Before designing it,
decide which agent owns that call and what it may see. The writer/character information boundary is a
core product invariant, so a checker cannot be added as an ordinary post-processing helper.
