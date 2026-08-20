# Next Steps

This is the short backlog after the recent reliability work. Completed implementation notes belong in
git history, not in an evergreen planning document.

## Highest value

1. ~~**Run inspector.**~~ Built. `writing-log.jsonl` was already served by `/runs/log` and rendered by
   the read tab; the per-agent `llm/*.jsonl` transcripts, which nothing could read back at all, are
   `runLlmLogs`/`readLlmLog` in `engine/preflight.ts` behind `GET /runs/llm` and `GET /runs/llm/file`
   (`server/run-log-routes.ts`, read-only by construction), and `server/gui/viewer/agents.js` renders
   them on the read tab. Volumes are lopsided — a real 6-step chapter logged 57 writer calls and
   ~1.07M prompt characters against ~7 calls per character — which is why a transcript is fetched only
   on demand and rendered one call at a time. Viewer half checked statically only; see
   [`GUI-CHECKLIST.md`](GUI-CHECKLIST.md) §7.
2. ~~**Multi-chapter reader.**~~ Built — [`SPEC-GUI-MULTISCENE.md`](SPEC-GUI-MULTISCENE.md) items 1–4:
   the chapter list, the per-chapter write action, reading accepted prose, and runs grouped by the
   chapter they wrote. Checked live against [`GUI-CHECKLIST.md`](GUI-CHECKLIST.md) on 2026-08-20 —
   still no automated coverage, so any further change there needs that pass run again.
3. ~~**Handoff screen.**~~ Built — the `#/handoff?dir=` page consumes `/next-chapter/*` and the
   `handoff` SSE state. What is left is the chapters-written column in `Architect.MD`'s Mockup B;
   `GET /chapter?dir=&n=` unblocks it, but the word counts mean one fetch per chapter. Design in
   [`Architect.MD`](Architect.MD), behaviour in [`SPEC-H-handoff.md`](SPEC-H-handoff.md).
4. **Story editor.** Design and implement the JSON-backed draft and validation flow in
   [`SPEC-E-editor.md`](SPEC-E-editor.md).
5. ~~**Live writer screen redesign.**~~ Built — controls and cast in the rail as cards, the
   eyebrow/headline/lede block, and the prose in a card with a phase-derived title and chip row. Two
   departures from [`writer-mockup.html`](writer-mockup.html), both recorded in
   [`Writer.MD`](Writer.MD): the consult blocks keep their per-attempt detail rather than being
   simplified to the mockup's single happy path, and the POV chip is dropped as a writer-side hint
   with no reader value.

## Architect follow-ups

- **The worked example still costs the scaffold a quarter of its prompt.** `architectExample()`
  hard-codes `stories/doorway/story.json`, ~1,870 estimated tokens. The handoff no longer carries it
  (`buildArchitect(d, false)`), which is where the context pressure actually was; the scaffold still
  does, because it has no story yet to demonstrate the format with. Making it story-independent is
  what is left, and `Architect.MD` lists it as a portability problem.
- **Refused edits are never told to the model.** `applyEdits` and `refuse()` report ignored fields to
  the author, but `architectChange` sends only the author's text and the spec — so an architect that
  invents a field (`scene_1` rather than `scene_1.question`, observed) can repeat it every round.
  Feeding refusals into the next prompt is the fix; it touches `prompts.ts`, so it is its own block.
- **Scaffold acceptance is not transactional.** A new story that writes but fails preflight is left on
  disk as `kind: "unloadable"`. The handoff restores the previous file in the same situation; the
  scaffold should match it.
- **The handoff prompt grows with the story.** It resends every written chapter, roughly 1,100 tokens
  each. The round now refuses with the numbers rather than letting the model return nothing, but a
  long story needs a correspondingly large context window loaded.

## Reliability follow-ups

- **The viewer has no automated coverage at all.** `npm test` covers the engine and the route modules;
  everything under `server/gui/` is verified by reading it and by running the app. Any change there is
  only as good as the live check that followed it.
- Four routes are handled inline in `server.ts` rather than in a route module (`/stories`, `/chapter`,
  `/log.jsonl`, `/runs/log`), so `callRoute` in the tests cannot reach them. Their engine-side helpers
  are tested instead. `tests/helpers.ts` now has `callGet` for query-string GET routes, so moving them
  into a module is all that stands between them and coverage.
- Add coverage for `runAndSave` write-failure paths if that logic is extracted from the composition root.
- Keep `liveHistory` growth within a run under observation; it is reset between runs but is currently
  not bounded during a very long run.
- Do not add a bind-address option until the local server has an authentication design.

## Design question

A continuity checker would need to read several chapters in one model call. Before designing it,
decide which agent owns that call and what it may see. The writer/character information boundary is a
core product invariant, so a checker cannot be added as an ordinary post-processing helper.
