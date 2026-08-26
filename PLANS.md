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
  staged walk embeds each stage's fields inline instead, so the example matters most to the one-shot
  walk (`mode: "oneshot"`);
  whether the one-shot path can drop or shrink it is what is left.
- **The handoff prompt grows with the story.** It resends every written chapter, roughly 1,100 tokens
  each. The round now refuses with the numbers rather than letting the model return nothing, but a
  long story needs a correspondingly large context window loaded.
- **Staged-scaffold follow-ups**, held behind live-run evidence like everything else in that
  pipeline: the **verify** pass could flag a cast where nobody has any restrictions (two early live
  runs produced restriction-less casts; `normalizeSpec` warns but nothing pushes back); and
  the story editor has no view of the session's **tension** sentence, which steers the cast and scene
  stages but lives only in the conversation.
- **A later chapter's writer has no continuity but what the handoff formalized.** Chapter *n*'s writer
  is built from the revised premise, the scene definition, `facts`, the cast summary and the style —
  and nothing else. No previous prose, no ending, no recap, no note of where anyone physically is,
  what they are holding, or what they promised each other last chapter. Whatever the handoff fails to
  promote into a formal field is simply gone: the agents carry no memory across chapters by design, so
  `story.json` is the entire channel, and the handoff is a lossy encoder with no signal when it drops
  something. Candidates, cheapest first: give the writer the previous chapter's closing paragraphs
  verbatim as an opening `[PREVIOUSLY]` block (no new model call, bounded by what is already on disk);
  add a `standing:` list to the scene definition for positions and held objects, which the handoff
  fills and the story editor shows; and, only if those fall short, a durable per-character `carrying`
  field. The risk in all three is the one the asymmetry exists to prevent — continuity that reaches the
  writer must not reach a character as something they were never told.
- **Approvable, promotable skill bible.** The in-code `SPECIAL_SKILL_CATALOG` is the seed; the second
  half of the plan is a shared, persistent bible that bespoke per-story `custom` skills can be
  **promoted** into — natural home alongside `defaults.json`, loaded by `loadDefaults` and merged over
  the in-code seed. The architect may **propose** a bible addition; it lands only after the owner
  **approves** it — a real gate distinct from accepting the story. That gate is what turns "prefer an
  existing skill" into a hard constraint; until it exists, custom skills stay allowed.
- **Reach may eventually want scoped targets.** A reach entry is today one flat
  `thing :: meaning` string; scoping it (`camera 3 but not camera 7`, `the lobby doors but not the
  vault`) would mean *character → interface → capability → scope* instead. Not built — the flat form
  is the deliberate floor, recorded here so it is not mistaken for the ceiling.

## Asymmetry follow-ups

Found by asking how the engine handles stories where several characters face interdependent
choices without seeing each other's reasoning. Each is a place where the engine permits something
the asymmetry forbids.

A possible future improvement, parked because it adds runtime cost rather than closing a gap: a
fourth judge variant beside `newJudge`/`newBatchJudge`/`newNarrationJudge` (0.3, no history, one
response schema) asked whether the scene honoured both characters' stated choices at a shared fork —
one extra LLM call per multi-character fork if it were ever wanted.

## Reliability follow-ups

- **Small-model coherence limits, observed live and parked.** Two failure classes from the doorway
  runs that prompt text has not fixed and arguably cannot: the writer contradicting its own
  established facts (a keyless card-slot lock picked, then opened by "the key turning"; hinges
  groan-risked, then "well-oiled"), and the judge reading binary forks hyper-literally even with
  calibration lines in place (rejecting an answer for carrying *extra* fields; rejecting a slide
  because it stopped short of a literal drop). A fact-ledger check across drafted pieces — one more
  stateless judge call per piece — is the candidate fix for the first; the second may just be a
  model-size floor.
- **The viewer has no automated coverage at all.** `npm test` covers the engine and the route modules;
  everything under `server/gui/` is verified by reading it and by running
  [`GUI-CHECKLIST.md`](GUI-CHECKLIST.md). Any change there is only as good as the live check that
  followed it.
- **There is no moment at which an owner accepts anything.** Overwrite protection and chapter
  contiguity shipped (Writer.MD, "One run writes one chapter"), but "accepted" still just means "a
  file the run wrote" — if an explicit acceptance step is ever wanted, it starts there.
- Add coverage for `runAndSave` write-failure paths if that logic is extracted from the composition root.
- Keep `liveHistory` growth within a run under observation; it is reset between runs but is currently
  not bounded during a very long run.
- Do not add a bind-address option until the local server has an authentication design.

## The CLI-to-GUI transition

**Partly done.** The interactive console workflows are gone: `--new`, `--oneshot`, `--idea` and
`--next-chapter` are rejected with a pointer at `--serve`, and the new-story interview and the
handoff live only in the viewer. What remains on the CLI is the primary entrypoint (a story run),
`--preflight`, `--consult`, and the console picker when no viewer is wanted.

Still open, in order:

1. **Extract application services.** Move run setup, persistence, and cleanup out of `story-writer.ts`,
   keeping the existing `ServerHost` dependency boundary.
2. **Add a headless bootstrap.** Start the server without a story argument or terminal picker, print
   the local URL, handle graceful shutdown.
3. **Harden the boundary.** Test startup without a TTY, cleanup after failures, SSE reconnects, route
   preconditions, and shutdown.

Add coverage for `run-and-save.ts` write-failure paths once that module exists — it needs `runChapter`
injectable or the artifact writer split out of `runAndSave` before the failure branches are reachable
from a test.

Constraints that hold whether or not that happens: the process supports **one active run** and must
not imply otherwise; the viewer is localhost-only and unauthenticated, and a wider bind needs
authentication before anything else; route modules receive behaviour through `ServerHost` and never
import `engine/`; operational messages stay in the console and run data stays in the JSONL logs, so
the GUI never becomes a second source of truth.
