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

- **The chapters-written column on the handoff panel.** `GET /chapter?dir=&n=` serves the prose, so
  nothing is blocked at the API, but the word counts mean one fetch per chapter. Designed in
  [`Architect.MD`](Architect.MD).
- **Keep current-run rendering scoped to one chapter.** Aggregate story-level totals only when the UI
  is explicitly showing more than one run.

## Architect follow-ups

- **The worked example still costs the scaffold a quarter of its prompt.** `architectExample()`
  hard-codes `stories/doorway/story.json`, ~1,870 estimated tokens. The handoff no longer carries it
  (`buildArchitect(d, false)`), which is where the context pressure actually was; the scaffold still
  does, because it has no story yet to demonstrate the format with. Making it story-independent is
  what is left.
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

## Writing-quality follow-ups

Found by reading the run logs of `stories/the-watchfire` against the writer's own rules. Each is a
place where the engine permits something the prompts forbid.

- **`reaction` is never used.** Zero consults of 76 across three runs asked for one; the split is
  decision 49, speech 22, action 5. It is the one shape that lets a present-but-not-acting character
  stay a person, and it is also the honest thing to ask when there is no fork — exactly the situation
  that currently produces `"What do you do?"`. The neglect nudge in `writeInstruction` should name it.
  The group-reaction fan-out (see [Writer.MD](Writer.MD)) now gives the writer a distinct, cheap reason
  to reach for `reaction`; whether it actually shifts the split is still to be measured on a live run.
- **The judge and the clarifier are named `WRITER`,** so they share the writer's transcript and, now
  that per-call stats exist, its stats row too — one line blending three jobs at three temperatures.
  Splitting them needs `llmLogEntry`'s `role` rule widened past `name === "WRITER" ? … : "character"`
  and a `.tag` colour per role; see [Writer.MD](Writer.MD).

## Reliability follow-ups

- **The viewer has no automated coverage at all.** `npm test` covers the engine and the route modules;
  everything under `server/gui/` is verified by reading it and by running
  [`GUI-CHECKLIST.md`](GUI-CHECKLIST.md). Any change there is only as good as the live check that
  followed it.
- Four routes are handled inline in `server.ts` rather than in a route module (`/stories`, `/chapter`,
  `/log.jsonl`, `/runs/log`), so `callRoute` in the tests cannot reach them. Their engine-side helpers
  are tested instead. `tests/helpers.ts` has `callGet` for query-string GET routes, so moving them into
  a module is all that stands between them and coverage.
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
