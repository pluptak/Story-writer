# Plans

**Every unbuilt plan lives here.** Built behaviour belongs to the document that owns its surface —
[`GUI-SPEC.md`](GUI-SPEC.md) for routes and SSE, [`Architect.MD`](Architect.MD) for the architect and
the handoff, [`Writer.MD`](Writer.MD) for the writer and the live screen, [`Judge.MD`](Judge.MD) for
all five judge variants, [`Character.MD`](Character.MD) for the character agent,
[`Clarifier.MD`](Clarifier.MD) for the clarifier. When something here ships, its behaviour moves into
one of those and **the entry is deleted rather than annotated**; git history is where implementation
notes belong.

One annex, kept separate at the owner's request and under the same delete-on-ship rule:
[`PLANS-playwright.md`](PLANS-playwright.md) — which of `GUI-CHECKLIST.md`'s manual checks the
Playwright suite could take over, in blocks. It goes away with its last block.

Nothing below is committed work. **Sections are kinds of work, not subsystems** — a defect with a
known fix, a run owed before a decision, a decision owed before code, a direction, a cost, and a note
that exists only to stop something being re-proposed. Within a section the order is a preference, not
a schedule. The one exception is **Next**, which is the short list of what to pick up first; it is
deliberately mixed-kind, and an entry promoted into it is not repeated in the section it came from.

**Verification, once, for all of it:** `npx tsc --noEmit` and `npm test` are the cheap checks. Anything
touching `server/gui/` also needs `npm run test:gui` and then the matching section of
[`GUI-CHECKLIST.md`](GUI-CHECKLIST.md), for what that suite cannot see. Anything touching `prompts.ts`
or model behaviour needs a live run, which is the owner's to make, batched.

---

## Next

Two items, in the order they should be picked up. Each is decidable now and has live-run evidence
behind it, and each is a reason to distrust what the writer hands everyone else.

Their evidence is doorway runs of 2026-08-27 (`16-23-17-001Z`, `19-33-16-122Z`, `19-47-04-293Z`;
a fourth run from that day has since rotated off disk, so figures cited from it are not
re-derivable) plus two further `e4b` runs, `21-35-36-919Z` (control) and `22-23-22-884Z` (first run
under the shipped sense-lint, consult gate and person clause), both preserved under
`data/stories/doorway/experiments/`. Raising the author-side model fixed or nearly fixed both on
its own — but the prose sense-lint's three holes, which led this list until they shipped, appeared
on the page under both models: the one thing capability did not buy.

### 1. Was the person clause the thing that cleaned the page, or was the run clean anyway?

The clause shipped (`prompts/writer.ts`, the POV line): person is the house style's to set, never
the consult rhythm's. The first `e4b` run under it (`22-23-22-884Z`) had a clean page and clean
drafts — but so did the control immediately before it (`21-35-36-919Z`, same model, no clause:
0 `you` across 31 drafts), while earlier controls drifted pervasively (7 and 3 per page). One clean
run next to one clean control credits nothing; the clause is unproven, not disproven.

**Done when** another clause-era `e4b` run is read: if clause-era pages stay clean where the
control era drifted, the clause takes the credit and this entry is deleted; if a clause-era page
drifts, the clause failed and the approach (prompt clause vs. mechanical detection) is reopened.

**Evidence since (2026-08-29):** both `alarm-wing` runs — heretic author-side, four characters —
drifted, a different character each time (HALE `they` all page → `his`/`he` in the closing pieces;
TIBBS to `he` from the opening paragraph). The duo control on the same model and style stayed clean
both times, so the stress is the cast size, not the model. Two runs is still not a verdict, but it
is no longer one clean run next to one clean control.

### 2. A scene has no representation of its own question being answered

The doorway run ended `done: false` at 64 steps against a `maxSteps` of 24 with 933 words against a
700 target. Its question — "Does Riven get through the door before Merritt decides what to do about
them?" — was answered at the midpoint; everything after is epilogue, and item 1's person drift lives
**entirely** inside that epilogue, which is why this is ordered last: some of its evidence is not
independent.

Runs three and four both ended `done: true` at 30 and 13 steps, and a better author model ends
scenes on its own — so there is no live overrun to fix, and building a budget policy against stale
evidence would be building it blind. What has *not* changed is the absence below: no run of any
model gave the loop a way to know its question was answered.

**Evidence since (2026-08-29, the event-driven stories):** the gap reproduced under the heretic
author exactly as predicted. The duo control (`alarm-corridor`) terminated clean (`done: true`, 17
steps, +9%); the four-hander (`alarm-wing`) did not — the alarm fired in the opening lines, stayed
a background chime for all 24 steps, and the scene ended `done: false` at the cap, 1028 words
(+47%), with 22 consults for a question whose event never got to do its work. The rerun terminated
(`done: true`, 31 steps, one grant) but overran worse (1485 words, +112%), settling the crate around
the alarm through deferral paperwork — a real answer, but the loop still had no way to know the
event chose not to fire.

This is a policy question, not a defect with an obvious fix — whether a scene may outrun its own
question, and what should happen when it does. It overlaps "A reaction fan-out does not
differentiate" under Open design questions, whose live evidence is also a post-crisis overrun.

The one thing worth pinning before any of that is decided: **the loop has no representation of the
scene's question having been answered.** `scene_done` is the writer's to declare; budget grants are
spent against word and step counts, neither of which knows what the scene was for. Whatever the
budget policy becomes, that absence is the thing it answers. Half of it is now filled as a
measurement — the done judge ([`Judge.MD`](Judge.MD)) reads the page against the question and logs
`done_flagged` without gating — but it has twice passed an `alarm-corridor` ending that reads as
undecided without flagging, and nobody has yet read a run where it fired. The done judge is the
instrument any budget policy is measured with; the world timeline (below) is the candidate lever,
asking what keeps a scene under pressure toward its question rather than what happens once the
question is spent.

**Done when** — deliberately open. Do not start this one until the item above is settled and a fresh
`e4b` run has been read, since both change what its evidence looks like and only `e4b` still
produces the failure.

## Defects

Something is demonstrably wrong and the fix is known or nearly known. The split is by what verifies
it: a code defect falls to `npx tsc --noEmit` and `npm test`, a prompt defect needs a live run.

### In code

- **A character is written out of the scene and never declared gone.** Across six `alarm-*` runs the
  writer emitted `exit` **zero** times, including a run where it narrated Tibbs leaving across seven
  pieces and thirteen steps while the loop kept Tibbs in `active`, kept consulting them, and kept
  naming them in the neglect nudge from a stairwell they had already left. The departure is gradual,
  so there is never one piece the writer would recognise as *the* exit, and nagging harder about the
  field fights that. `exit_refused` has also never fired, so nothing distinguishes "declared and
  refused" from "never declared". (The mechanism itself — `exit`, the nudge's exit reading
  (`52c0649`), `exit_refused` — is shipped; see [`Writer.MD`](Writer.MD).) The nudge's exit reading
  is unverified: it renders only alongside the nudge, and the same commit correctly stops the nudge
  firing in the four-hander that would have exercised it. Either give it a second carrier or accept
  it is decoration. Why it matters beyond tidiness: a POV exit ends the chapter, so an undeclared
  one silently costs the loop its ending — one `alarm-wing` run had HALE walk downstairs and the
  scene ran on to the cap.

- **`sceneDrift` compares neither `reach` nor `constraint`.** The snapshot-desync warning guarding
  the handoff compares place, question, pov, length and roster — but neither scene-scoped capability
  field, so a written chapter whose `reach` or `constraint` was hand-edited afterwards re-authors
  silently. Two comparisons, once it is decided what such a drift means for the chapter that already
  ran under the old grant — and the same decision covers both, since `constraint` is reach's negative
  twin and arrived after this entry was first written.

(The quote-lint's per-character attribution fix — `attribute()` checking the trailing name,
per-character matching with all-grants fallback, tests for all four shapes — is shipped; its
live-run risk is under Measurement owed.)

### In the architect's prompts

Each has live scaffold evidence and a candidate fix; all four need a run to confirm.

- **The ZERO-SUM TEST passes goals that have no agency.** "Convince B to sign" against "get the
  signature on my patient's chart" passes — only one side can act — and every run of that story
  ended with the same character conceding. The same hole admits goals satisfied by inaction ("not be
  the one who called it", "not get out of bed"). Candidate: an agency test beside the zero-sum one —
  each goal must name something that character can do themselves toward it; a goal reached by doing
  nothing, or only through another's compliance, fails it.
- **A scene question may presuppose its own answer.** The scene stage accepted "Will X yield his
  clinical authority to Y's protocol?" — naming the conceding party in advance. Candidate rule: the
  question may not name which character concedes or whose authority is at stake.
- **A skill the scene never touches is decoration, and nothing says so.** Verify has a bullet for a
  restriction that cannot bite in this scene and no equivalent for a skill. One live scaffold
  produced two bespoke skills, both inert in the argument the scene turned out to be.
- **Cast-sheet defects that need prompt work rather than a string check.** From two live scaffolds:
  an editorial parenthetical written into a `goal` and rendered verbatim into that character's
  prompt; a `goal` in the third person naming the character to itself while the persona is second
  person (`CHARACTER_FIELDS` fixes person for `persona` only); and a cast sheet whose pronouns
  disagree with the prose the writer then produces. A third class needs judgement, not a check. (The
  mechanically checkable class — roster/pov/reach/skill-name string checks — is shipped in
  `normalizeSpec`.)

## Measurement owed

The next action is reading a run, not writing code. These are the owner's, batched. Each names what
would settle it, and several gate work in the sections below.

**In Next:** item 1.

- **The quote-lint's per-character match trusts a heuristic attribution, and that trust is
  unmeasured.** `attribute()` is a best-effort guess, so a quote correctly granted to its speaker but
  mis-attributed on the page would now flag as a false reassignment where the old all-speeches match
  passed silently. **Done when** a run's quote flags are checked against the page: every "granted to
  a different character" flag should be a real reassignment, not an attribution miss.
- **The question gates now guard only the judge's re-ask, and that path is unmeasured.** Since
  `14022cf` the writer's consult carries no `question` and no `wants`, so `normalizeConsult`'s
  `"directed"` branch (`DEGENERATE_QUESTIONS`, the word-bounded `or`, the `wants` floor) runs at
  exactly one call site: `reviseConsult`, where a judge escalating a retry names the fork in words.
  Unmeasured is whether a judge's escalation still writes a question that passes them, or whether the
  gates now only ever fire on the one caller that cannot learn from them. The writer's own refusals
  are a different gate (thin situation against `MIN_OPEN_SITUATION_WORDS`) and the churn figure worth
  watching instead.
- **A stage-3 consult has never been read for `narration_flag` on invented deeds and stillness.**
  Stage 3 gave up the question field that receipted the writer's stops, leaving THE ONE RULE and the
  stop-while-the-pressure-is-live rule as the only pressure toward stopping at choices. The failure
  would be quiet: competent, low-consequence answers that break no rule, pass the judge and the lint,
  and let the scene die politely. The one check that would catch it is the narration lint's
  deeds-and-stillness read — and until `9fd2410` every quotation hit short-circuited that check for
  its piece, so it has effectively never run on a stage-3 scene. **Done when** a post-`9fd2410`
  stage-3 run is read for that flag — a clean page closes the question; a dirty one reopens the
  writer's receipt as a defect.
- **The LLM half of the narration lint has still never fired.** Quotations and restricted senses are
  mechanical now; deeds and consult-situation quality are the model's, and that half returned
  `{"ok": true}` on all 55 pieces of five live runs — passing "Marsh watches them from his corner"
  for a character with `restrictions: ["sight"]`, the prompt's own worked example. The per-answer
  judge and batch judge do fire on the same cast, so a restricted sense is not beyond the model; the
  lint asks for a four-part sweep in one call and returns an assertion. Both remaining checks resist
  mechanical treatment for the same reason: neither a deed nor a situation has a closed set to match
  against. The blind-POV probe (2026-08-29) measured neither half — the style clause kept the page
  sight-clean on its own — so the miss-rate question stays open, and what the run established is that
  the style clause is the effective first control and the mechanical lint the backstop.
- **The writer appears to treat short technical dialogue as environmental texture.** Five defective
  pieces across two cooling-loop chapters (~14% of drafted pieces; 2 of the 13 quoted lines in the
  accepted chapters were never granted by anybody), every one a line like *"The harmonic is
  shifting"* generated with nobody consulted — two against a completely empty ledger, before anyone
  had been consulted about anything. The alarm runs confirm the shape: four quote flags, every one a
  real fabrication, every redraft clean — except the Wren case, where removing the fabrication
  removed the scene's only escalation (see Next item 2), and one rerun case where the redraft itself
  fabricated and the piece was accepted with the line on the page. What not to do first: raise
  `NARRATION_LINT_RETRIES`. Fix the speaker hint, re-measure, and only then ask whether the budget
  is short; if it still is, a single retry carrying an explicit prohibition on adding any quotation
  is the cheaper test.
- **The clarifier can answer a different question than the one asked.** One live observation
  (telemetry stabilising vs. increasing, answered with what a different system sounded like), against
  one later near-identical question answered squarely. Two data points, opposite outcomes — worth
  watching before it is worth building a check for. Nothing checks that a clarification addresses
  its question.
- **The writer has one idle-body move per character and reuses it.** Doorway: *"Merritt shifts their
  weight on the upturned crate"* three times near-verbatim in one chapter; the cooling loop, different
  cast: *"Marsh leans his head back … squeezes his eyes shut"* variants five times in one chapter.
  Neither violates a rule — which is why nothing flags it. A vocabulary problem, the writer's rather
  than any one character's (it replicates across casts). Distinct from the fan-out entry below (several
  characters answering alike vs. one character rendered alike every time). Count repeated body-move
  phrasings per chapter before fixing.
- **Judge-conditioned revision is a real but low and lopsided capability.** Tracing every judge
  "retry" across nine live doorway runs found 0 of 6 revisions surviving `reviseConsult`; but
  `scripts/revision-benchmark.ts` replaying the same six cases 5x each in isolation on
  `google/gemma-4-e4b` found 4/30 usable (13%), 25/30 recognising the answer as unusable — 0/6 in
  production is within binomial variance of ~13%, not evidence of zero capability. Lopsided: all 4
  successes came from 1–2 of the 6 cases; the four cases where MERRITT's sight-CANNOT is what made
  the answer unusable never produced a working revision in 20 tries — a specific weak spot
  (constructing an open question around a stated sensory restriction), not uniform unreliability.
  Cross-model, six alternatives (8B–35B, general/roleplay/coding, stock/uncensored/fine-tuned) never
  produced one surviving revision; every alternative is a worse judge than the story's own small
  model. A judge's job is refusal, and permissive creative-writing tunes default to accept — the
  useful next model to try is one selected for critique strength, not size; instruction-following
  benchmarks have now failed twice as a predictor here (`qwen3-8b` 0/30 even at full reasoning).
  Caveats: the quill model's 0/30 is a JSON-schema failure over substantively the best reasoning
  observed — retry it with stricter JSON-mode before writing it off; `qwen3-30b` scored 0/30 in both
  modes, killing "a bigger model fixes this".
- **Splitting detection from repair is the evidence-backed candidate fix — and the diagnosis feeding
  it is wrong a meaningful fraction of the time.** `scripts/judge-diagnostic.ts` isolated the three
  sub-skills the judge bundles: with the contradiction handed over, `gemma-4-e4b` jumps from 13% to
  13/15 (87%) on repair alone, `qwen2.5-coder-14b` to 15/15, `qwen3-8b` to 13/15 — the pipeline
  bottleneck is detection, not repair-writing (`glm-4.7-flash` is the exception: 1/15 even handed
  the diagnosis). But reading the six live retry verdicts against the cast's actual arrays found two
  of six flatly wrong (retried RIVEN for "no lockpicking skill" while RIVEN lists `lockpicking`;
  invented a `CANNOT: sight` for a character with `restrictions: []`), two defensible-but-imprecise
  (the sight-into-hearing collapse, below), and only two unambiguously correct. The diagnostic then
  isolated the mechanisms: the `seq78` error is fact *application* overridden by narrative content
  (the same fact scores 20/20 in isolation); the sight-into-hearing collapse is real and
  deterministic for `gemma-4-e4b` (0/10 on Merritt's hearing/inference cases — `CANNOT: sight` read
  as removing perception generally); and verdict application is unstable even on the judge's own
  explicit rules (0/5 on one non-POV-thought case, 4/5 on its structural twin). Consequence:
  judge-retry-based measurements should not be trusted as evidence about anything else until
  constraint-interpretation accuracy has its own validated benchmark; the Free Consult findings stand
  because they were read from first-pass content, not judge behaviour — a now load-bearing
  distinction.
- **The split judge is built as `--split-judge`, and its baselines need re-establishing.** The
  prototype (JUDGE verdict call + REPAIR-JUDGE call on retry only; behaviour in [`Judge.MD`](Judge.MD))
  measured, pre-fix: `gemma-4-e4b` 6/30→9/30 surviving, `qwen2.5-coder-14b` 0/30→14/30 — and the
  verdict call stopped issuing the two known false-positive retries *entirely* while holding 15/15
  on genuine ones (a precision gain the aggregate hides). But roughly half the surviving revisions
  rest on a wrong or empty diagnosis that `reviseConsult` cannot see (it checks newness and CANNOTs,
  not truth), and the verdict-call notes came back as bare fragments ("Merritt CANNOT sight") now
  that the note is the whole input to call two. Two fixes shipped together — the `You asked:`
  empty-question payload fix (which sat directly on top of the non-POV rule every under-detecting
  model misses) and a tightened `note` gloss demanding both halves of the collision. **Every
  pre-fix number is superseded: re-run `gemma-4-e4b` and `qwen2.5-coder-14b` in both modes first.**
  The payload fix should move detection on the three non-POV cases; the gloss should move the share
  of surviving revisions resting on a wrong note. A live run can then ask whether it helps a whole
  chapter — but no run can settle diagnosis correctness; reading `retry` notes by hand is that check.
- **Restriction meanings — the verdict-mode result is the strongest single number this record holds,
  and it is independent of the Next ordering (diagnostic-level, no live run needed).**
  (`--cannot-meaning` / `--cannot-none` / `--cannot-testimony`; mechanism in
  [`Judge.MD`](Judge.MD).) Against `google/gemma-4-e4b`, 20 samples/case: cast-mode hearing baseline
  0/20→20/20 under `--cannot-meaning` alone (cleanest before/after on record); verdict-mode
  non-POV-thought cases 0/20→20/20 each under the full arm with zero regression on the accept cases.
  **A confirmed, repeatable regression:** adding `--cannot-none` collapses the inference case
  (`merritt-infers-from-sound`) from 10/20 back to 0/20, twice — a change to a *different*
  character's rendering coinciding with a complete flip on Merritt's hardest case. So the full
  verdict-mode arm is worth promoting toward a default, `--cannot-meaning` alone in cast mode is
  real but incomplete, and `--cannot-none` must **not** be bundled with `--cannot-meaning` by
  default wherever the inference case matters — while the same flag helps verdict mode, a targeted
  follow-up in its own right. (Earlier CI numbers against hosted models are discarded: an
  auto-router pool and a shared free-tier quota made both runs uninterpretable; the `callOnce`
  hardening they forced is the only thing kept.)

## Open design questions

The engine permits something it should not, or has no representation for something it needs, and the
fix is not decided. Nothing here should be built before its question is answered.

**In Next:** item 2, a scene having no representation of its own question being answered.

- **The architect hands the writer future knowledge through the scene framing; [HOLD] only contains
  it.** "Does the fault alarm empty the wing before anyone settles where the crate goes?" tells the
  writer the alarm exists, the wing may empty, the crate is unresolved, and the events are related —
  before the first piece is written. This is an ARCHITECT problem (writer-facing framing foreshadows
  hidden timeline state), distinct from the information-authority question under the world timeline
  (what a character could perceive). Out of scope by definition: another character filter, changing
  `[HOLD]`, an arbiter, filtering events, or touching the writer/character prompts. `[HOLD]` stays
  as it is.
- **The handoff prompt grows with the story.** It resends every written chapter (~1,100 tokens
  each); a long story fails loudly rather than silently, but nothing shrinks the input. Summarize,
  window, or require a large context window — the first two risk dropping exactly the continuity the
  next item is about. (The chapter-summary review step under Directions is one candidate answer.)
- **A later chapter's writer has no continuity but what the handoff formalized.** No previous prose,
  no ending, no recap, no positions, holdings or promises — whatever the handoff fails to promote
  into a formal field is gone. Candidates, cheapest first: the previous chapter's closing paragraphs
  verbatim as `[PREVIOUSLY]`; a `standing:` list for positions and held objects; only if those fall
  short, a durable per-character `carrying` field. The decision first: continuity reaching the
  writer must not reach a character as something they were never told.
- **A reaction fan-out does not differentiate.** One situation, several characters, the same beat:
  two reactors in a live four-hander answered a post-crisis fan-out with near-identical shaking
  hands and long exhales; four of that scene's six fan-outs came after the crisis resolved, and the
  scene overran 900 words by 43%. Three possible owners — the fan-out's situation text, a
  cross-reaction check (cf. the parked fourth judge variant), or simply not fanning out once the
  scene's question is answered. Decide before building; overlaps Next item 2, whose live evidence is
  also a post-crisis overrun.

**From the asymmetry review.** Places where the engine permits something the asymmetry forbids.

- **A bespoke capability one character holds can only ever be an absence on another, never a CANNOT.**
  "B cannot sign the line that is A's to sign" is inexpressible: declaring it in B's own `skills`
  hands it back with a warning, and as an absence the narration lint has no negative to check —
  live cost, one character's signature on the other's line. Whether the answer is a story-level skill
  catalog, a cross-character restriction form, or leaving this to `facts` is open. Same distinction
  as the settled general/bible work; currently holds only for those.
- **Skill Bible aliases are resolution semantics, not a UI field.** Resolution is by name through
  `nameKey`/`sameName`; aliases change which name a restriction matches and whether a removed skill
  reads as CANNOT or absence. Design against `engine/skills.ts`'s invariants before any editor shows
  an alias field.
- **A "Draft · architect" badge on the shelf.** Three readings, ascending in cost: derive from
  `chapters.length === 0` (free; blind to interviews abandoned before accept); a session badge while
  this process holds the session (free; vanishes on restart — the "continue new story…" card already
  does a version of this); persisting scaffold drafts to disk (engine work, half-written stories that
  do not preflight). Only the owner can say which; nothing is built until then.
- **A re-consulted character never learns what followed its last answer — and the carrier for that
  already exists as a flag.** A character consulted at step 2 and again at step 24 holds only its
  answer as decided: no record of what the page did with it, nor of the intervening beats. The
  measurement that opened this (`scripts/measure-situation-coverage.ts` against the recorded-run
  fixture: 16 re-consults, 15 of them stale) found the mechanical screen in
  `engine/situation-coverage.ts` uncalibrated (0/15) but the human read 15/15 carrying the
  decision-relevant intervention — including the one-word "Clear." rendered as "a single word of
  confirmation". That clears the 70% bar fixed before the run, which sends this to enforcement, with
  caveats (one fixture, one story, one model; confirm on a second live run). The carrier is already
  built: `--consult-since` — CLI-only and **off by default** — makes a stale consult carry `since`
  (what its last answer came to, plus perceivable surroundings), joining the situation before the
  gate, and refuses a stale consult without it ([`Writer.MD`](Writer.MD)). So what is left is
  enforcement and measurement, not the carrier: read a live run under the flag, mechanically confirm
  the granted speech a `since` claims (`matchQuote` gives a real test; deeds have none) — and only
  then decide whether the flag becomes the default. If a required, refusal-forced `since` still
  measures insufficient, the fallback is a batched authored digest at the next consult,
  paraphrase-only except the character's own verified speech, with a real third-person
  presence/CANNOT gate; that one costs a model call, which is why it is last. The answer itself is
  never withheld
  (`answer_unwritten` aside): the gap is page-consequence, not answer-availability.

## Directions

Big, unbuilt, and shaping rather than corrective. One carries enough design to have its own section
below: **The world timeline**.

- **Free Consult — strip authorial behavioral steering from the character prompt (spike).**
  (`FREE_CHARACTER_FORMAT`, `--free-consult`/`-v2`, reversible, CLI-only; `REACTION_OUTWARD`
  excluded from both as an architectural boundary, not prose style.) v1 sustained-asks nearly every
  consult (13/16 vs. gated 0/17); v2's ladder addendum (missing-fact vs. uncertain-interpretation)
  did not reliably reproduce the gated near-zero rate — pooled 60/97 across six runs, 5 of 6
  sustained, the one scattered run reading as outlier. Verdict: the removed lines ("this is your
  moment", "not a request you owe compliance to", the attempt-3 nudge) were an anti-stalling
  counterweight, not rhetoric; restating the ladder is at best an unreliable substitute. v3
  (`--free-consult-v3`, putting back only the attempt-3 nudge) never fired — reaching attempt 3
  needs two consecutive surviving revisions, and `attempt` never exceeded 1 in eight of ten runs —
  so its three runs are folded into the v2 pool; whether the nudge matters is still untested and
  needs the judge-revision work above first. (The old "model cannot do this task at all" reading is
  corrected by the revision entry under Measurement owed.)
- **"Prefer an existing skill" is still advice, not a rule.** Promotion is built (bible read on both
  sides, derived candidates, `/scaffold/promote` as the owner's gate). What it has not bought is the
  constraint: a bespoke skill is still accepted everywhere, so diligence buys nothing and the
  architect still coins synonyms. Making it hard means refusing a bespoke skill whose *meaning*
  matches the bible — a judgement, so advisory-reviewer's territory, not the schema's. **Done
  when** a scaffold run twice against a bible the first run filled is read for reuse vs.
  reinvention; that measurement is worth more than the rule. Left behind: the system prompt is not
  re-rendered mid-session (promoted skill validates immediately, appears next session), and
  `directEdit` still normalizes against the in-code bible (fix = async `ServerHost.directEdit` for
  an advisory-only effect).
- **Casting from the library, past the opening cast.** Import path built (tray, cast gate's own stage
  prompt, enforced adaptation contract). Unbuilt: (1) the contract has never met a real model —
  preservation is enforced so it cannot fail quietly, and the revert notes are the measurement
  (**done when** one imported scaffold is read for prompt-carrying vs. enforcement-standing); (2) an
  imported cast may make the cast judge ask the wrong question — its refusal is written for a cast
  the architect proposed, but with an imported cast the author already chose the people, so it reads
  as advice about the *tension*; (3) a tray larger than the opening cast has no representation
  (deferred introductions would live there).
- **The catalog's advisory reviewer.** Deferred until real entries exist; specified in
  [`Architect.MD`](Architect.MD): architect-shaped not judge-shaped, non-blocking, mechanical
  validation still last. It exists because a catalog amplifies the cast-sheet defects above — one bad
  character, every story after it.
- **The GUI redesign's remainder.** Built: persistent shell, warm-paper restyle, architect stepper,
  scene detail (roster, reach, hold-only beats), usage lines, voice picker. Unbuilt: the
  **conversation transcript** as the architect's primary UI (needs a host method publishing turns;
  owner keeps the plain last-round narration until asked); the tag editor's **description** and
  **related-tags** fields (schema work on `TagEntry`); the story editor's
  **`writerStyleConstraints` field** (the settings gate writes the derived half; the editor shows
  only the voice, so the one place to correct a clause does not display it).
- **The dedicated character library needs its backend contract.** The GUI's character workspace
  (from `mockups/architect/character-editor.html`) deliberately uses `/catalog?kind=characters` and
  `/catalog/save` where they work and mocks the rest; the mock boundary must not become a second
  browser-only store. `LibraryCharacter` stays the portable half only (`id, version, name, hidden,
  updatedAt, portablePersona, belief, impulse, voice[], skills[], restrictions[]` — no `tags`, no
  `goal`/`knows`/reach (I4), no `model`/retries; `voice` capped as in the story schema). Endpoint
  contract: `GET /characters?includeHidden=`, `POST /characters`, `PUT /characters/:id`, `POST
  /characters/:id/duplicate|hide|restore|import`, `DELETE /characters/:id` (real delete, 404
  unknown), `POST /characters/assist` (`create`|`revise`, server-constrained fields, validated
  proposal, never persists) — reusing `/catalog/check` validation rather than copying it; keep the
  catalog routes as a compatibility bridge, then move the GUI client and remove the fallbacks.
  Replace mocks in order: schema/migration/tests (+ remove `tags` with its readers); host
  methods/routes delegating writes to the catalog implementation; response-driven lifecycle in the
  GUI; import route (picker excludes hidden); dedicated `characterAssist` prompt (never whole-story
  `suggestEdits` on a partial); real proposal rendering with Apply vs. Save kept separate; route,
  schema, migration, import and GUI tests. **Done when** the full lifecycle works, failures restore
  the row with the server's reason, proposals name every changed field without persisting, and no
  character request or entry contains `tags`.
- **A chapter-summary review step in the handoff.** Before the re-authoring round, the architect
  compresses the latest accepted chapter into progression / scene changes / characters, the author
  confirms-or-abandons it, and the round runs with the summary in place of that chapter's prose —
  earlier chapters still travel as full text. (One candidate answer to "the handoff prompt grows".)

## The world timeline

**Shipped.** Ledger, zero-inference firing/holding/implanting, the architect's world gate, the
handoff's re-aim, and `adjudicateBeat`/`adjudicateChapter` (`engine/world-repair.ts`) are wired in:
stranded beats adjudicated mechanically (settled question voids silently, live one surfaces to
re-aim), fired beats judged by the architect's one-shot `beat_checks` reply — see
[`Architect.MD`](Architect.MD)'s "Stranded/Fired world events", [`Writer.MD`](Writer.MD)'s
`[HOLD]`/`[WORLD]` injection, [`Character.MD`](Character.MD)'s memories, [`GUI-SPEC.md`](GUI-SPEC.md)'s
events. The spike's load-bearing findings (injection + `[HOLD]` withholding are both required;
memories land in `system`, change reasoning without being quoted, and must name a specific cost and
agree with the beat about the world) are authored into the world gate's four memory rules. What
stays here is the missing live evidence and the two warnings, not the mechanism — and the two rules
that keep this from becoming a planner are under *Parked, with the reason*, because they constrain
what may be proposed for it next rather than anything still owed.

- **Unmeasured: whether the architect's landing judgement is any good.** "Landed" as *written* vs.
  *changed a decision* came apart in every run; the handoff asks the model (three-state
  `landed`: true/false/omitted) because no mechanical check can reach the second half. **Done
  when** live runs are read for whether its landing calls match the page.
- **No live evidence behind the repairs:** no run has yet produced a choice that voids a beat.
  (Unit-proven only: `adjudicateBeat`'s autonomy invariant replays the stage-3 open-beat case —
  *Elias overpowers Sara at the lever* — as `questionLive: false` retiring the beat. That is a proof
  about the pure function, not the wired-in entity.) The effect also needs several runs per
  condition: characters reasoning differently after a memory lands, read from `thought` fields — the
  measurement separating a beat that landed from one that mattered.
- **A mechanical landing check was built and removed — do not rebuild it the same way.** Character-
  bigram Dice scored 0.73 on the faithful rendering against 0.49–0.64 on unrelated pieces — the
  boundary would sit in a ~0.09 gap fitted to a single event. Bigrams have a high floor on any two
  English passages; fine for quote-lint's copied strings (~1.0), useless for a rendered beat.
  Content-word coverage separated better on the same run but is equally uncalibrated on n=1. Either
  metric needs several beats across several runs; the model may simply be the right instrument.
- **The escalation it drove carried a defect worth not repeating.** A beat awaiting its check and a
  beat that *failed* one are different states; the loop conflated them, re-injecting *"you were
  told last turn"* on turns where the writer answered with a consult and no prose — no piece, no
  check, no failure. Whatever re-injects a beat must key on a check that ran and failed, never on
  one that has not run yet.
- **An information authority: restrict-only, and the writer's beat delivery is out of scope.**
  Presence, `"scene"`-scoped implantation, the consult situation-bounds check and the fan-out's
  remote-reactor refusal are shipped ([`Character.MD`](Character.MD)); the clarifier's verbatim
  `[WHAT HAS NOT HAPPENED]`/`[ALREADY TRUE]` block is shipped ([`Clarifier.MD`](Clarifier.MD)).
  Open: whether visibility into a world event ever needs a model-based agent beyond these gates — if
  so, it withholds (*"Bob cannot see the envelope"*) but never infers (*"Bob should suspect Y"*).
  `[WORLD]`/`[HOLD]` reaches the shared writer instruction unfiltered by design
  ([`Writer.MD`](Writer.MD)); gating that channel by presence would be a larger, riskier change than
  any shipped gate.

## Polish and cost

No defect and no decision owed: smaller quality work, prompt cost, and coverage.

- **The one-shot scaffold still spends a quarter of its prompt on the worked example**
  (~1,870 tokens; the handoff and staged walk no longer carry it). Whether `mode: "oneshot"` can
  drop or shrink it is what is left — a whole-story proposal has no story yet to demonstrate the
  format with. **And it now carries the world-event rules too** (`TIMELINE_FIELDS`, ~888 tokens,
  +28% on the one-shot prompt, for a field usually `[]`). The cheap alternative is a short block
  (what an event is, field shapes, "usually empty") with the four memory rules left to the staged
  gate — at the price that a one-shot beat is authored without the rules that stop it misfiring.
  Not decided: nobody has read a one-shot proposal that produced a beat.
- **The story editor has no view of the session's tension sentence.** It steers the cast and scene
  stages but lives only in the conversation.
- **Keep current-run rendering scoped to one chapter.** No defect observed; a constraint on whatever
  aggregate display comes next (grouping in [`GUI-CHECKLIST.md`](GUI-CHECKLIST.md) checks it).
- **`run-and-save.ts`'s write-failure paths have no coverage.** Branches unreachable from a test
  until `runChapter` is injectable or the artifact writer is split out.
- Keep `liveHistory` growth within a run under observation; reset between runs but unbounded during
  a very long one.
- **A run's manifest is not surfaced anywhere but the file.** `out/<id>/manifest.json` records which
  engine wrote a run and a stale process says so on the console — but `RunSummary` carries neither
  `engine` nor `engineStale`, so the shelf cannot group runs by condition or grey out a stale-engine
  run. Worth doing only once more than one condition is routinely compared.

## Parked, with the reason

Nothing here is work. Each entry exists to stop a future decision going wrong.

- **The world timeline is not a planner, and the next thing proposed for it must not become one.**
  A planner that decides what happens turns the consult into theatre: if the beats are fixed, a
  character's answer cannot change what comes next and the asymmetry stops being the product. What
  keeps the shipped timeline clear of that is exactly one property — **a world event is the category
  no character decides**, the lane [`Writer.MD`](Writer.MD) already gave the writer's improvisation.
  So the entity gets the writer's blindness deliberately: the timeline, `facts[]`, the scene's
  question and the page, and **not** personas, goals or private knowledge. Anything that knows what
  characters want and times events against them is the parent project's Director wearing a hat, and
  it breaks the same invariant through a door the consult protocol does not guard.
- **A repair may point at the question, never at a planned outcome.** The companion rule to the one
  above, and the one that is easy to lose while fixing a beat that failed: an entity free to revise
  toward a planned ending can always reach it, and the characters' choices stop mattering. The best
  run on record is the argument — in the stage-3 open-beat scene *Elias does not convince Sara; he
  and Kane overpower her at the lever and she concedes after*, a better route than the premise
  anticipated, and a steered entity would have prevented it. The revision trigger stays *is the
  question still live and under pressure*, never *are we on the planned path*; the outcome is a
  chapter-level obligation the handoff carries. The timeline is the pressure that makes an ending
  likely, not the rail that guarantees one.
- **A full ports-and-adapters restructuring. Evaluated and rejected, not deferred.** The decoupling
  program shipped the one real piece (route modules no longer hold live engine objects); the rest
  does not apply — dependency direction already holds under test (`tests/boundaries.test.ts`),
  generic taxonomies describe this system worse, view models for reads with presenters buy nothing, a
  DTO layer under the story editor is actively harmful (any view model there must be isomorphic or a
  save silently drops fields), `PROVIDER` injection is ceremony over a monkey-patched singleton, and
  multi-client architecture has no problem to solve (one process, one run, one GUI).
- **A `knows`/`goal`/`belief` name absent from `characters` — the hallucinated half only.** The
  rename half lives in `applyEdits` (holds the `renames` map, zero false positives). The
  hallucinated-name half stays a model judgement: a proper-noun regex returns 5 false positives and
  0 true on the doorway fixture (sentence-initial capitals dominate multi-sentence prose). Do not
  re-propose that regex; the real detector needs rename history or a names-known graph
  `normalizeSpec` does not have.
- **Reach may eventually want scoped targets. Not planned.** Today one flat `thing :: meaning`;
  scoping (`camera 3 but not camera 7`) would mean character → interface → capability → scope. The
  flat form is the deliberate floor, not the ceiling.
- **Small-model coherence limits, observed live and parked.** The writer contradicting established
  facts (keyless lock picked, then "the key turning"; hinges groan-risked, then "well-oiled"), and
  the judge reading binary forks hyper-literally despite calibration lines (extra fields; a slide
  stopping short of a literal drop). Candidate for the first: a fact-ledger check per piece (one
  more stateless judge call); the second may be a model-size floor.
- **Model-specific prompt variants. Parked.** No concrete misbehaving model/prompt pair in hand;
  revisit when a live run names one.
- **A fourth judge variant for a shared fork. Parked.** One extra LLM call per multi-character fork
  to ask whether the scene honoured both choices — runtime cost, no closing gap; cf. the fan-out
  entry above as one candidate owner.
- **There is no moment at which an owner accepts anything.** Overwrite protection and chapter
  contiguity shipped, but "accepted" still just means "a file the run wrote".
