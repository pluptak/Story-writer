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
  reads `tests/fixtures/doorway/story.json`, ~1,870 estimated tokens. The handoff no longer carries
  it (`buildArchitect(d, false)`), which is where the context pressure actually was; the scaffold
  still does, because a whole-story proposal has no story yet to demonstrate the format with. The
  staged walk embeds each stage's fields inline instead, so the example matters most to `--oneshot`;
  whether the one-shot path can drop or shrink it is what is left.
- **Refused edits are never told to the model.** `applyEdits` and `refuse()` report ignored fields to
  the author, but `architectChange` sends only the author's text and the spec — so an architect that
  invents a field (`scene_1` rather than `scene_1.question`, observed) can repeat it every round.
  Feeding refusals into the next prompt is the fix; it touches `prompts.ts`, so it is its own block.
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

## Asymmetry follow-ups

Found by asking how the engine handles stories where several characters face interdependent
choices without seeing each other's reasoning. Each is a place where the engine permits something
the asymmetry forbids.

- **No simultaneity guard on sequential consults.** The reaction fan-out shares one situation blind
  (`normalizeReactionConsult`), but ordinary sequential consults let the writer fold character A's
  just-received answer into B's situation unchecked. The fix starts in `prompts.ts`
  (`writeInstruction`): when more than one character faces the same fork, each consult's situation
  may only contain facts that predate every answer in the beat. Whether anything engine-side should
  also enforce it (a heuristic check in `scene-loop.ts` flagging a consult whose situation contains
  another character's accepted answer from the same beat) is the open fork — detection is heuristic
  and may not be worth the false positives.
- **The clarifier has no per-character knowledge boundary.** A character's `need` question is answered
  from whatever the writer knows (`consult.ts`, via the `clarify` seat), including facts that
  character has no in-fiction way to hold. Fix shape: the writer's clarify-answer instruction gains
  the rule "answer only from facts this character could know"; the stronger variant — passing the
  character's `knows`/`belief` alongside the request so the seat can actually be checked — touches
  `scene-loop.ts`'s clarifier construction and is its own block if ever wanted.
- **Learned facts don't survive the handoff mechanically.** If chapter 2 turns on "she betrayed me
  last round", landing that in `belief` depends on the architect remembering prose. Proposal: an
  optional per-character `learned:` field in the handoff spec (what changed for them this chapter),
  which `story-spec.ts` normalizes and folds into `knows:`/`belief:` at render time — no change to
  `story.json` itself. Touches `architect.ts` (vocabulary), `story-spec.ts` (normalize/render), and
  `prompts.ts`.

A possible future improvement, parked because it adds runtime cost rather than closing a gap: a
fourth judge variant beside `newJudge`/`newBatchJudge`/`newNarrationJudge` (0.3, no history, one
response schema) asked whether the scene honoured both characters' stated choices at a shared fork —
one extra LLM call per multi-character fork if it were ever wanted.

(The unused reaction fan-out these stories would lean on most is tracked above under Writing-quality
follow-ups.)

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
