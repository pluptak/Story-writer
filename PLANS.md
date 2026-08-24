# Plans

**Every unbuilt plan lives here.** Built behaviour belongs to the document that owns its surface —
[`GUI-SPEC.md`](GUI-SPEC.md) for routes and SSE, [`Architect.MD`](Architect.MD) for the architect and
the handoff, [`Writer.MD`](Writer.MD) for the writer and the live screen. When something here ships,
its behaviour moves into one of those and **the entry is deleted rather than annotated**; git history
is where implementation notes belong.

Nothing below is committed work, and the numbering is an ordering, not a schedule.

**Verification, once, for all of it:** `npx tsc --noEmit` and `npm test` are the cheap checks. Anything
touching `server/gui/` also needs the matching section of [`GUI-CHECKLIST.md`](GUI-CHECKLIST.md), since
the viewer has no automated coverage. Anything touching `prompts.ts` or model behaviour needs a live
run, which is the owner's to make, batched.

---

## Smaller viewer work

- **Keep current-run rendering scoped to one chapter.** Aggregate story-level totals only when the UI
  is explicitly showing more than one run.

## Architect follow-ups

- **The worked example still costs the scaffold a quarter of its prompt.** `architectExample()`
  reads `tests/fixtures/doorway/story.json`, ~1,870 estimated tokens. The handoff no longer carries
  it (`buildArchitect(d, false)`), which is where the context pressure actually was; the scaffold
  still does, because a whole-story proposal has no story yet to demonstrate the format with. The
  staged walk embeds each stage's fields inline instead, so the example matters most to `--oneshot`;
  whether the one-shot path can drop or shrink it is what is left.
- **The handoff prompt grows with the story.** It resends every written chapter, roughly 1,100 tokens
  each. The round now refuses with the numbers rather than letting the model return nothing, but a
  long story needs a correspondingly large context window loaded.
- **Staged-scaffold follow-ups**, held behind live-run evidence like everything else in that
  pipeline: the **verify** pass could flag a cast where nobody has any restrictions (two early live
  runs produced restriction-less casts; `normalizeSpec` warns but nothing pushes back); the console
  has no way to ask an empty gate to re-propose itself (edits vocabulary covers it, awkwardly); and
  the story editor has no view of the session's **tension** sentence, which steers the cast and scene
  stages but lives only in the conversation.
- **Approvable, promotable skill bible.** The in-code `SPECIAL_SKILL_CATALOG` is the seed; the second
  half of the plan is a shared, persistent bible that bespoke per-story `custom` skills can be
  **promoted** into — natural home alongside `defaults.json`, loaded by `loadDefaults` and merged over
  the in-code seed. The architect may **propose** a bible addition; it lands only after the owner
  **approves** it — a real gate distinct from accepting the story. That gate is what turns "prefer an
  existing skill" into a hard constraint; until it exists, custom skills stay allowed.

## Asymmetry follow-ups

Found by asking how the engine handles stories where several characters face interdependent
choices without seeing each other's reasoning. Each is a place where the engine permits something
the asymmetry forbids.

A possible future improvement, parked because it adds runtime cost rather than closing a gap: a
fourth judge variant beside `newJudge`/`newBatchJudge`/`newNarrationJudge` (0.3, no history, one
response schema) asked whether the scene honoured both characters' stated choices at a shared fork —
one extra LLM call per multi-character fork if it were ever wanted.

## Reliability follow-ups

- **The viewer has no automated coverage at all.** `npm test` covers the engine and the route modules;
  everything under `server/gui/` is verified by reading it and by running
  [`GUI-CHECKLIST.md`](GUI-CHECKLIST.md). Any change there is only as good as the live check that
  followed it.
- Add coverage for `runAndSave` write-failure paths if that logic is extracted from the composition root.
- Keep `liveHistory` growth within a run under observation; it is reset between runs but is currently
  not bounded during a very long run.
- Do not add a bind-address option until the local server has an authentication design.

## The CLI-to-GUI transition

**A direction, not a commitment.** The application supports both the console workflows and the local
viewer today: `--serve` starts the viewer, `--preflight` is the maintenance and CI check, and `--new`,
`--next-chapter` and `--consult` remain interactive console workflows.

Should that change, the order is:

1. **Complete the viewer** — plans 1-3 above.
2. **Extract application services.** Move run setup, persistence, and cleanup out of the CLI-specific
   parts of `story-writer.ts`, keeping the existing `ServerHost` dependency boundary.
3. **Add a headless bootstrap.** Start the server without a story argument or terminal picker, print
   the local URL, handle graceful shutdown.
4. **Deprecate console interaction.** Keep `--preflight` and scripted runs; remove console flows only
   after equivalent browser workflows are verified.
5. **Harden the boundary.** Test startup without a TTY, cleanup after failures, SSE reconnects, route
   preconditions, and shutdown.

Constraints that hold whether or not that happens: the process supports **one active run** and must
not imply otherwise; the viewer is localhost-only and unauthenticated, and a wider bind needs
authentication before anything else; route modules receive behaviour through `ServerHost` and never
import `engine/`; operational messages stay in the console and run data stays in the JSONL logs, so
the GUI never becomes a second source of truth.
