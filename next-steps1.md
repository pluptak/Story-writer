# Next Steps

This is the short backlog after the recent reliability work. Completed implementation notes belong in
git history, not in an evergreen planning document.

## Highest value

1. **Run inspector.** Render retained `writing-log.jsonl` and per-agent `llm/*.jsonl` data through the
   existing `/log.jsonl` and `/runs/log` routes. Keep inspection read-only and separate from run control.
2. **Multi-chapter reader.** The chapter list, the per-chapter write action and reading accepted prose
   are built ([`SPEC-GUI-MULTISCENE.md`](SPEC-GUI-MULTISCENE.md) items 1–3). What is left is grouping
   retained runs by chapter, which waits on the API gaps [`Writer.MD`](Writer.MD) tracks: `chapter` is
   absent from both `RunMeta` and `RunSummary`, so a run cannot be attributed to a chapter without
   reading its log.
3. ~~**Handoff screen.**~~ Built — the `#/handoff?dir=` page consumes `/next-chapter/*` and the
   `handoff` SSE state. What is left is the chapters-written column in `Architect.MD`'s Mockup B;
   `GET /chapter?dir=&n=` unblocks it, but the word counts mean one fetch per chapter. Design in
   [`Architect.MD`](Architect.MD), behaviour in [`SPEC-H-handoff.md`](SPEC-H-handoff.md).
4. **Story editor.** Design and implement the JSON-backed draft and validation flow in
   [`SPEC-E-editor.md`](SPEC-E-editor.md).
5. **Live writer screen redesign.** [`Writer.MD`](Writer.MD) verdict is build it now: every route the
   screen needs already works and is already driven by the shipped viewer, and
   [`writer-mockup.html`](writer-mockup.html) is faithful to the engine — including the reader round,
   which offers directions rather than a character's answer. The one thing the mockup wants and cannot
   have is the chapter label, which is the `RunMeta` gap in (2).

## Architect follow-ups

- **The worked example is a quarter of every architect prompt.** `architectExample()` hard-codes
  `stories/doorway/story.json`; it measures ~1,770 tokens of an opening handoff round's ~6,950. Making
  it story-independent, or dropping it once the format is stable, is the cheapest context saving
  available, and `Architect.MD` already lists it as a portability problem.
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
- Two routes are handled inline in `server.ts` rather than in a route module (`/stories`, `/chapter`),
  so `callRoute` in the tests cannot reach them. Their engine-side helpers are tested instead.
- Add coverage for `runAndSave` write-failure paths if that logic is extracted from the composition root.
- Keep `liveHistory` growth within a run under observation; it is reset between runs but is currently
  not bounded during a very long run.
- Do not add a bind-address option until the local server has an authentication design.

## Design question

A continuity checker would need to read several chapters in one model call. Before designing it,
decide which agent owns that call and what it may see. The writer/character information boundary is a
core product invariant, so a checker cannot be added as an ordinary post-processing helper.
