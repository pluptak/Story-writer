# Plans

**Every unbuilt plan lives here.** Built behaviour belongs to the document that owns its surface —
[`GUI-SPEC.md`](GUI-SPEC.md) for routes and SSE, [`Architect.MD`](Architect.MD) for the architect and
the handoff, [`Writer.MD`](Writer.MD) for the writer and the live screen. When something here ships,
its behaviour moves into one of those and **the entry is deleted rather than annotated**; git history
is where implementation notes belong.

Nothing below is committed work. **Sections are kinds of work, not subsystems** — a defect with a
known fix, a run owed before a decision, a decision owed before code, a direction, a cost, and a note
that exists only to stop something being re-proposed. Within a section the order is a preference, not
a schedule. The one exception is **Next**, which is the short list of what to pick up first; it is
deliberately mixed-kind, and an entry promoted into it is not repeated in the section it came from.

**Verification, once, for all of it:** `npx tsc --noEmit` and `npm test` are the cheap checks. Anything
touching `server/gui/` also needs the matching section of [`GUI-CHECKLIST.md`](GUI-CHECKLIST.md), since
the viewer has no automated coverage. Anything touching `prompts.ts` or model behaviour needs a live
run, which is the owner's to make, batched.

---

## Next

Two items promoted out of the sections below, in the order they should be picked up. Each is
decidable now and has live-run evidence behind it, and each is a reason to distrust what the writer
hands everyone else.

Their evidence is four doorway runs of 2026-08-27 — `14-54-12-677Z`, `16-23-17-001Z`,
`19-33-16-122Z` and `19-47-04-293Z`. The first three ran `google/gemma-4-e4b` throughout; the fourth
put the writer, judge, narration lint and clarifier on `gemma-4-12b-it-qat-uncensored-heretic` and
left the characters on `e4b`. **Retained-run rotation has since removed `14-54-12-677Z` from disk**,
so figures cited from it are not re-derivable; everything attributed to the other three is. Two
further `e4b` runs, `21-35-36-919Z` (control) and `22-23-22-884Z` (the first under the shipped
sense-lint, consult gate and person clause), are item 1's evidence; both are preserved
under `stories/doorway/experiments/` with the runs they are measured against.

That model split is why the order is what it is. Raising the author-side model fixed or nearly fixed
both on its own — the fourth run finished in 13 steps with no degenerate questions, no
person drift and no repetition — while the prose sense-lint's three holes, which led this list until
they shipped, appeared on the page in both models: the one thing capability did not buy.

### 1. Was the person clause the thing that cleaned the page, or was the run clean anyway?

The clause shipped (`prompts/writer.ts`, the POV line): person is the house style's to set, never
the consult rhythm's. The first `e4b` run under it (`22-23-22-884Z`) had a clean page and clean
drafts — but so did the control immediately before it (`21-35-36-919Z`, same model, no clause:
0 `you` across 31 drafts), while the controls before that drifted pervasively (7 and 3 per page in
`16-23` and `19-33`). One clean run next to one clean control credits nothing; the clause is
unproven, not disproven.

**Done when** another clause-era `e4b` run is read: if clause-era pages stay clean where the
control era drifted, the clause takes the credit and this entry is deleted; if a clause-era page
drifts, the clause failed and the approach (prompt clause vs. mechanical detection) is reopened.

**Evidence since (2026-08-29):** both `alarm-wing` runs — heretic author-side, four characters —
drifted, a different character each time: run one's HALE is `they` for the whole page and becomes
`his`/`he` in the closing pieces ("his shadow falling over the trolley"); run two's TIBBS goes to
`he` from the opening paragraph on. The duo control on the same model and the same style stayed
clean both times, so the stress is the cast size, not the model — two runs is still not a verdict,
but it is no longer one.

### 2. A scene has no representation of its own question being answered

The doorway run ended `done: false`, at 64 steps against a `maxSteps` of 24 (four `budget` grants)
and 933 words against a 700 target. Its question — "Does Riven get through the door before Merritt
decides what to do about them?" — was answered at the midpoint: door open, satchel handed over,
ledger signed. Everything after is epilogue, and in it Riven is consulted four more times about how
fast to walk away while Merritt is asked five times whether to stand up. Item 1's person drift lives
**entirely** inside that epilogue, which is why this is ordered last: some of its evidence is not
independent.

**Evidence since, and it is most of the case against acting:** runs three and four both ended
`done: true`, at 30 and 13 steps, 11% and 18% over target. The pathology was concentrated in the two
runs that never terminated, and a better author model ended scenes on its own. What has *not* changed
is the absence below — no run of any model gave the loop a way to know its question was answered —
but there is now no live overrun to fix, and building a budget policy against evidence this stale
would be building it blind.

**Evidence since (2026-08-29, the event-driven stories):** the gap reproduced under the heretic
author exactly as this entry predicts. The duo control (`alarm-corridor`, same beat, cast of two)
terminated clean — `done: true` at 17 steps, +9% over target. The four-hander (`alarm-wing`) did
not: the fault alarm fired in the scene's opening lines and then stayed a background chime for all
24 steps; the one line that gave it a consequence (Wren: sixty seconds to a full wing evacuation)
was a fabricated quotation, the mechanical lint correctly flagged it, and the redraft that removed
the fabrication removed the escalation with it. The scene ended `done: false` at the cap, 1028 words
(+47%), WREN's answer unwritten — 22 consults for a question whose own event never got to do its
work. The loop had no way to know the event was being parked; that absence is this entry.

The rerun (`10-36-42`) terminated — `done: true` at 31 steps with one budget grant — but overran
worse, not better: 1485 words (+112%) on 27 consults, against the duo control's +9%. The alarm
stayed a background pulse in both runs; the rerun settled the crate around it, through the
technician's own deferral paperwork, which is a real answer to the scene question — but the loop
still has no way to know the event chose not to fire.

This is a policy question, not a defect with an obvious fix — whether a scene may outrun its own
question, and what should happen when it does, is a judgement about pacing. It overlaps "A reaction
fan-out does not differentiate" under Open design questions, whose live evidence is also a
post-crisis overrun.

The one thing worth pinning before any of that is decided: **the loop has no representation of the
scene's question having been answered.** `scene_done` is the writer's to declare and it never did;
budget grants are spent against word count and step count, neither of which knows what the scene was
for. Whatever the budget policy becomes, that absence is the thing it answers.

**Half of that absence is now filled, as a measurement.** The done judge
([`Judge.MD`](Judge.MD)) reads the page back against the scene's question when the writer declares
it over and logs `done_flagged` when it is not settled there. **Unmeasured, and now worth watching:
whether it is too lenient.** It has twice passed an `alarm-corridor` ending that reads as undecided
— the most recent closes with Hale reaching for the ledger and Oduya shielding it — without
flagging. Both are defensible as the question answered *no*, which the judge is explicitly told
counts, but a judge that never flags anything is not an instrument. Nobody has yet read a run where
it fired. What it does not do is act: it gated
once, and the refusal was a nudge nobody could satisfy — told its question was unanswered, the writer
wrote four more steps of the same deadlock, never declared done again, and ran out its budget,
turning a bad ending into no ending. A deadlock breaks when a character chooses differently, which
is never the writer's to write, so the refusal named a lever the writer does not hold. Re-arm it as
a gate when a refusal can arrive with one.

**The world timeline** below is the candidate for that lever, and it reaches the same absence from
the other side: it asks what keeps a scene under pressure toward its question rather than what should
happen once the question is spent. The done judge is the instrument either one is measured with.

**Done when** — deliberately open. Do not start this one until the item above is settled and a fresh
`e4b` run has been read, since both change what its evidence looks like and only `e4b` still
produces the failure.

## Defects

Something is demonstrably wrong and the fix is known or nearly known. The split is by what verifies
it: a code defect falls to `npx tsc --noEmit` and `npm test`, a prompt defect needs a live run.

### In code

- **A character is written out of the scene and never declared gone.** Across six `alarm-*` runs the
  writer emitted `exit` **zero** times, including a run where it narrated Tibbs leaving across seven
  pieces and thirteen steps — *"Tibbs pushes off the wall and moves toward the exit"* through to
  *"Tibbs is gone."* — while the loop kept Tibbs in `active`, kept consulting them, and kept naming
  them in the neglect nudge from a stairwell they had already left. The departure is the problem: it
  is gradual, so there is never one piece the writer would recognise as *the* exit, and nagging
  harder about the field fights that. `exit_refused` has also never fired, so nothing in the record
  distinguishes "declared and refused" from "never declared".

  Partly addressed: the neglect nudge now offers the exit as its second reading (`52c0649`) — "X has
  gone unconsulted" meant only *you forgot them* when it can equally mean *they left*. **That half is
  unverified**, because it renders only alongside the nudge and the same commit correctly stops the
  nudge firing in the four-hander that would have exercised it. Either give it a second carrier or
  accept it is decoration.

  Why it matters beyond tidiness: a POV exit ends the chapter, so an undeclared one silently costs
  the loop its ending. One `alarm-wing` run had HALE walk downstairs and the scene ran on to the cap.

The next four are one chain, in dependency order — the attribution hint has to be worth trusting
before the match can be made to use it.

- **The quote lint attributes a speaker by looking backwards only.** `attribute()` scans the 120
  characters *before* the quote and takes the nearest cast name, so `Riven reaches for the door.
  "No," Merritt says` is reported as `(near RIVEN)`. Post-dialogue attribution — `"..." NAME says` —
  is the ordinary form in the prose this engine asks for, so the hint is probably wrong more often
  than right. Nothing about the flag itself depends on it: whether a quotation matched the granted
  ledger is decided before any name is looked up, and the only live reader of the attribution is the
  `(near X)` clause in the user-visible `why` — which is also the text the writer is handed for its
  one redraft. Candidate: check for a trailing attribution first and
  fall back to the preceding-name guess, with a test for both orders. Worth settling what "nearest"
  should mean before writing it — a quote between two named characters has two defensible answers.

  Evidence since, recorded as evidence and not as a conclusion: in both cooling-loop cases where a
  redraft failed to remove a fabricated quotation, the hint the writer was given was wrong (`near
  HALE`) or absent (`unknown`), and both surviving lines were in fact Nkem's, written in the ordinary
  post-quote form `"...," Nkem says` that a backwards scan cannot see. That is consistent with a
  wrong hint impairing the redraft. It does not establish it: n = 2, one story, one model. It does
  make this worth fixing before any further quote-lint measurement, so that the next set of retry
  failures is measured against a hint that is at least trying to be right.

  The four alarm-run flags (2026-08-29) were all attributed `unknown`, and every one was in the
  post-quote form (`"...," NAME says`) a backwards scan cannot see — including the one the writer's
  redraft most needed the hint for. The rerun's two flags split the hint: one correct (`near
  TIBBS`), one wrong (`near HALE` for a line the page gives to Tibbs) — both still in the post-quote
  form, and the wrong hint sat on the one flag whose redraft fabricated again.
- **The mechanical quote match is attribution-blind.** `matchQuote` folds every granted speech into
  one list and asks only "did anyone say this", while the flag's `why` says "no character was
  granted that line" — implying a per-character check the code does not do. A line granted to one
  character can be put in another's mouth with no flag; it is the check the retired LLM dialogue
  pass used to make. Fixing it depends on the attribution entry above: match against the attributed
  character's grants only once the hint is worth trusting.
- **The mechanical half and the LLM half disagree on rendered interiority.** `matchQuote` reads only
  `g.speech`, but the narration lint's own format and `narrationLintRequest` explicitly exempt a
  granted POV thought rendered in quotation marks — and the loop's two grant paths do not agree with
  each other either: the fan-out path grants a thought-and-speech reply as both, while the POV path
  grants only the speech (engine/scene-loop.ts). So the writer can be handed interiority the
  mechanical half then flags as fabricated, spending the scene's one redraft on a false positive.
  Grant `felt` into the mechanical ledger — after the two grant paths are made to agree about which
  replies carry it.
- **`sceneDrift` does not compare `reach`.** The snapshot-desync warning that guards the handoff
  compares place, question, pov, length and roster — but not the field the capability layer added,
  so a written chapter whose `reach` was hand-edited afterwards re-authors silently and the warning
  that exists to report exactly that kind of drift never fires. One comparison, once it is decided
  what a reach drift means for the chapter that already ran under the old grant.
- **`refuse()` matches the raw field string, but `applyEdits` canonicalizes first.** Bracketed
  spellings are canonicalized before edits apply, while the already-written guard tests the raw
  string — so `scene[0].reach` (like the pre-existing `scene[0].place`) can edit a written chapter's
  definition without tripping it. The fix is to run the guard against the canonical form
  `applyEdits` will actually write, which for `place` has been wrong since before `reach` existed.
- **The story.json lock does not cover the span it claims.** The lock runs "from the pick through
  the handoff" ([live.ts](live.ts)), with three holes. `/select` never consults `storyWriteBlocked`,
  and the shelf's play button is enabled during a handoff, so a run can start on the very story a
  handoff holds. `newHandoffSession` checks the lock before a multi-await session build and sets it
  only after it returns — an editor save in that gap wins. And the handoff's `abandoned()` path
  clears `LIVE.storyLock` unconditionally, so a stale round landing after the user abandoned and
  opened a new handoff wipes the newer session's lock. Each hole is a small fix; the second wants
  the check and the set inside `newHandoffSession` itself.

### In the architect's prompts

Each has live scaffold evidence and a candidate fix; all four need a run to confirm.

- **The ZERO-SUM TEST passes goals that have no agency.** As written it asks only whether A getting
  what they want stops B getting what they want. "Convince B to sign" against "get the signature on
  my patient's chart" passes that, but only one of the two can act — every run of that story ended
  with the same character conceding, because the other never had a move of their own. The same hole
  admits goals satisfied by inaction: a live four-hander whose goals were "not be the one who called
  it", "not get out of bed" and "be gone by five" had nothing that could collide. Candidate: an
  agency test beside the zero-sum one — each goal must name something that character can do
  themselves that moves them toward it, and a goal reached by doing nothing, or reachable only
  through another character's compliance, fails it.
- **A scene question may presuppose its own answer.** The scene stage asks for the point where
  colliding goals force a choice, and accepted "Will X yield his clinical authority to Y's protocol?"
  — which names the conceding party in advance. Candidate rule: the question may not name which
  character concedes or whose authority is at stake, and is phrased on the disputed outcome, so that
  either side answering it is a real answer.
- **A skill the scene never touches is decoration, and nothing says so.** Verify has a bullet for a
  restriction that cannot bite in this scene and no equivalent for a skill. One live scaffold
  produced two bespoke skills, both inert in the argument the scene actually turned out to be, and
  neither drawn from the bible the cast stage says to prefer.
- **Cast-sheet defects that need prompt work rather than a string check.** From two live scaffolds: an
  editorial parenthetical written into a `goal` and rendered verbatim into that character's prompt
  ("be gone by 5:00 PM (or in this case, end his shift/contractual window immediately)"); and a `goal`
  in the third person naming the character to itself while the persona is second person, since
  `CHARACTER_FIELDS` fixes the person for `persona` and for no other field. A third needs judgement
  rather than a check: a cast sheet whose pronouns disagree with the prose the writer then produces
  from it. The mechanically checkable defect found alongside these (roster/pov/reach/skill-name
  string checks) now lives in `normalizeSpec`, shipped.

## Measurement owed

The next action is reading a run, not writing code. These are the owner's, batched. Each names what
would settle it, and several gate work in the sections below.

**In Next:** item 1.

- **The question gates now guard only the judge's re-ask, and that path is unmeasured.** Since
  `14022cf` the writer's consult carries no `question` and no `wants`, so `normalizeConsult`'s
  `"directed"` branch — `DEGENERATE_QUESTIONS`, the word-bounded `or`, the `wants` floor — runs at
  exactly one call site: `reviseConsult` (`engine/consult.ts`), where a judge escalating a retry
  names the fork in words. The churn those gates used to charge the writer is gone and the number is
  already recorded below (18 refused consults across three stage-2 runs, 0 across two stage-3 runs);
  what nobody has read a run for is whether a judge's escalation still writes a question that passes
  them, or whether the gates now only ever fire on the one caller that cannot learn from them. The
  writer's own refusals are a different gate — a thin situation against `MIN_OPEN_SITUATION_WORDS` —
  and that is the churn figure worth watching instead. Entered here because the entry it replaces
  (*"Did the instruction pass fix the consult-gate churn?"*, formerly Next item 1) asked about a
  field the writer no longer sends.
- **A stage-3 consult has never been read for `narration_flag` on invented deeds and stillness.**
  Stage 3 (the consult is a character and a situation, shipped at `14022cf`) gave up the question
  field that receipted the writer's stops, leaving THE ONE RULE and the stop-while-the-pressure-is-live
  rule as the only pressure toward stopping at choices. The failure would be quiet: competent,
  low-consequence answers that break no rule, pass the judge, pass the lint, and let the scene die
  politely. The one check that would catch it is the narration lint's deeds-and-stillness read — and
  until `9fd2410` every quotation hit short-circuited that check for its piece, so it has effectively
  never run on a stage-3 scene: the one run read as clean put three unasked-for stillnesses on the
  page ("Jules remains glued to the terminal", "Sara remains anchored to the console", "Kane remains
  hunched over the lever"). **Done when** a post-`9fd2410` stage-3 run is read for that flag — a
  clean page closes the question this entry keeps alive; a dirty one reopens the writer's receipt as
  a defect.
- **The LLM half of the narration lint has still never fired.** Two of its four checks are mechanical
  now — quotations against the granted ledger (`engine/quote-lint.ts`) and restricted senses against
  the CANNOT list (`engine/sense-lint.ts`) — leaving deeds and consult-situation quality to the
  model. That half returned `{"ok": true}` on all 55 pieces of
  five live runs — nine completion tokens behind the `{` prefill on every one of the ten most recent,
  across two stories and two models — and among them it
  passed "Marsh watches them from his corner" for a character with `restrictions: ["sight"]` — the
  prompt's own worked example ("no watching, no glancing, no gaze for someone who cannot see"). The
  per-answer judge and the batch judge do fire on that same cast — the judge caught "eyes
  half-closed" from that character, and the batch judge twice refused to promote his reaction glances
  to deeds — so a restricted sense was not beyond the model; it is that the lint asks for a four-part
  sweep in one call and returns an assertion. Both remaining checks resist the same treatment for the
  same reason: neither a deed nor a situation has a closed set to match against, which is exactly what
  made the other two tractable. A drafted piece contradicting an established fact is the same shape of
  problem and is filed under Parked, with the reason.

  The blind-POV probe (2026-08-29) measured neither half: the run's writerStyle carried doorway's
  no-omniscience clause plus an explicit "nothing that is only visible" line, and the page came back
  sight-clean — every perception in touch, sound or inference, pronoun subjects throughout, zero
  restricted-sense flags, zero quote flags, zero quoted dialogue at all. So the miss-rate question
  stays open, and what the run actually established is that the style clause is the effective first
  control; the mechanical lint is the backstop for the run where the clause fails.
- **The writer appears to treat short technical dialogue as environmental texture.** That is the
  narrow form of the hypothesis, and it is the one the evidence supports: the writer may generate a
  line like *"The harmonic is shifting"*, *"Status update? The loop is screaming on my monitor"* or
  *"Two minutes"* without treating it as an event that required consulting anybody — the same way it
  generates a hiss or a vibration. Two of the five cases fired against a **completely empty ledger**,
  in the scene's opening beats before anyone had been consulted about anything, which is the
  strongest evidence for the texture reading: there was nobody who could have said them. None of
  these was punctuation around a granted line — the best similarity between any flagged quote and any
  granted speech, searching forward as well as backward in case the writer wrote a line before asking
  for it, was 0.28 against the lint's 0.8 threshold.

  **Count defective pieces, not flags.** Seven `narration_quote_flag` events across two cooling-loop
  chapters are five distinct defective pieces, because a redraft that fabricates again flags a second
  time. Of the five, three were corrected by the one redraft and two were not: the writer
  re-fabricated on its only retry, and `retried: true` correlates exactly with reaching the page.
  Both survivors are in the durable record (`chapters/1.md`, `chapters/2.md`), and chapter 2's is
  both of that run's flagged quotes merged into one sentence rather than removed.

  Rates, with the caveat that both denominators are small and from one story and one model: five of
  roughly 35 drafted pieces carried an ungranted quotation (~14%), and **two of the 13 quoted lines
  in the two accepted chapters were never granted by anybody** (~15%). The second is the number that
  answers the practical question; "seven lint flags" does not.

  **Evidence since (2026-08-29, the alarm runs):** four quote flags across the two alarm stories,
  every one a real fabrication and every redraft clean — two near-variants of Oduya's own voice
  sample ("The paperwork says Monday,"), one invented ledger passage voiced through Oduya reading
  aloud, and one invented escalation voiced through Wren. The texture reading holds, and the
  mechanical half now catches the whole class without a machine-label false positive among them.
  The Wren case cuts the other way too: the redraft that removed the fabrication removed the
  scene's only escalation with it (see Next item 2).

  The rerun reproduced the acceptance shape live in these stories: the redraft itself fabricated
  ("Better move it now,"), the second flag came back `retried: true`, and the piece was accepted
  with the line on the page.

  What not to do first: raise `NARRATION_LINT_RETRIES`. The attribution entry under Defects is
  implicated in both failures, so the order is fix the speaker hint, re-measure, and only then ask
  whether the budget is short. If it still is, a single retry carrying an explicit prohibition on
  adding any quotation is the cheaper thing to test, and a second retry granted only when the same
  mechanical invariant fails twice spends generation on demonstrated repeat offenders rather than on
  everyone.
- **The clarifier can answer a different question than the one asked.** The single live clarification
  observed asked whether telemetry was stabilising or the oscillation increasing, and was answered
  with what a different system sounded like. The answer was accepted and folded in. Nothing checks
  that a clarification addresses its question. One observation against it since: a near-identical
  question in a later run ("Are the temperature readings currently increasing or stabilizing?") was
  answered squarely ("the needle is jumping further into the red zone with every pulse of the
  alarm"). Two data points, same question shape, opposite outcomes — so this is worth watching before
  it is worth building a check for.
- **The writer has one idle-body move per character and reuses it.** A character who is present but
  not acting gets the same filler every time they appear. Doorway: *"Merritt shifts their weight on
  the upturned crate"* three times near-verbatim in one chapter, plus two near-misses. The cooling
  loop, different cast, different story: *"Marsh leans his head back ... squeezes his eyes shut"* /
  *"closes his eyes"* / *"his eyes squeezed shut"* five times in one chapter. Neither is a rule
  violation — weight-shifting on a crate is the narration prompt's own example of good involuntary
  continuity, and a blind man may close his eyes — which is why nothing flags it. It is a vocabulary
  problem, and it replicates across casts and stories, so it is the writer's and not any one
  character's. Related to the fan-out differentiation entry under Open design questions, but
  distinct: that one is several characters answering alike, this one is a single character rendered
  alike every time. Worth measuring before it is worth fixing — count repeated body-move phrasings
  per chapter first.

## Open design questions

The engine permits something it should not, or has no representation for something it needs, and the
fix is not decided. Nothing here should be built before its question is answered.

**In Next:** item 2, a scene having no representation of its own question being answered.

- **The handoff prompt grows with the story.** It resends every written chapter, roughly 1,100 tokens
  each. The round refuses with the numbers rather than letting the model return nothing, so a long
  story fails loudly instead of silently — but nothing shrinks the input. The open decision is which
  of summarizing prior chapters, windowing them, or requiring a correspondingly large context window
  is the answer; the first two both risk dropping exactly the continuity the item below is about.
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
  writer must not reach a character as something they were never told. That risk is the decision to
  make before any of the three is built.
- **A reaction fan-out does not differentiate.** Given one situation, several characters return the
  same beat: in a live four-hander two of them answered a post-crisis fan-out with near-identical
  shaking hands and a long exhale, and one then repeated his own line almost verbatim in a later
  fan-out. Four of that scene's six fan-outs came after the crisis had resolved, and the scene
  overran its 900-word target by 43%. The fix has three possible owners — the fan-out's situation
  text, a cross-reaction check like the fourth judge variant parked below, or simply not fanning out
  once the scene's question is answered. Which one it is has to be decided before anything is built.

**From the asymmetry review.** Found by asking how the engine handles stories where several
characters face interdependent choices without seeing each other's reasoning. Each is a place where
the engine permits something the asymmetry forbids.

- **A character present but not in the room has no representation.** A live scene wanted one
  participant on a speakerphone: rostered, so consulted; not in the room, so unable to perceive it
  directly. The engine has no way to say that. `wrapCharacter` hands the character agent the scene's
  `place`, so they believe they are standing in it; `reach` grants an interface but cannot establish
  absence; and the roster is binary — in it means in the room, out of it means never consulted. The
  scaffold reached for `restrictions: ["sight"]` as the nearest available thing, which makes the
  character blind rather than elsewhere, and the writer duly seated them on a bench in the room for
  the whole scene while the judge spent its effort policing their eyelids. This is a design question
  about the roster, not a bug in reach.
- **A bespoke capability one character holds can only ever be an absence on another, never a CANNOT.**
  `parseRestrictions` resolves a restriction naming a general skill, a bible skill, one of that
  character's own skills, or a scene reach grant — so "B cannot sign the line that is A's to sign" is
  inexpressible, because the capability is A's bespoke skill. Declaring it in B's own `skills` to make
  it resolvable does not help: precedence then hands it back with a warning, so that branch can never
  produce a CANNOT. Observed cost, live: with the capability an absence rather than a CANNOT the
  narration lint had no negative to check against, and the writer put one character's signature on the
  line the facts reserved for the other. Whether the answer is a story-level skill catalog, a
  cross-character restriction form, or leaving this to `facts`, is open — it is the same distinction
  the "a removed special skill is a cannot, not an absence" work was about, and it currently holds
  only for general and bible skills.
- **Skill Bible aliases are resolution semantics, not a UI field.** `engine/skills.ts` resolves
  skills, restrictions and reach **by name**, through `nameKey`/`sameName` — the single funnel every
  case-insensitive identity comparison goes through. Aliases would change which name a restriction
  matches, and whether a removed skill reads as a CANNOT or an absence — the same distinction the
  "a removed special skill is a cannot, not an absence" work settled. Design against that module's
  invariants (its docstring carries all five) before any editor shows an alias field.
- **A "Draft · architect" badge on the shelf.** A story reaches the shelf only once `story.json`
  exists, and the scaffold session is session-only that dies on restart — so the mockup's badge has
  three readings, ascending in cost: derive it from `chapters.length === 0` (free; cannot see an
  interview abandoned before accept, because nothing is on disk yet), a session badge while this
  process holds that story's session (free; vanishes on restart — the new-story card's
  "continue new story…" already does a version of this), or persisting scaffold drafts to disk
  (engine work, half-written stories that do not preflight, a directory before a name). Only the
  owner can say which they wanted; nothing is built until then.

## Directions

Big, unbuilt, and shaping rather than corrective. One carries enough design to have its own section
below: **The world timeline**.

- **"Prefer an existing skill" is still advice, not a rule.** Promotion is built — the architect
  reads the author's bible on both sides, a bespoke `name :: meaning` in a landed cast is derived as
  a promotion candidate, and `/scaffold/promote` is the owner's gate
  ([`Architect.MD`](Architect.MD), *Skill bible → Promotion*). What the gate has not yet bought is
  the constraint it was supposed to enable: a bespoke skill is still accepted everywhere, so an
  author who never promotes anything gets the same behaviour as before, and one who promotes
  diligently still sees the architect coin a fresh synonym whenever it does not recognise a name.

  Making it hard means refusing a bespoke skill whose meaning matches something already in the
  bible — and *matches* is the problem. Name equality is already enforced. Meaning equality is a
  judgement, which puts it in the advisory reviewer's territory rather than the schema's. **Done
  when** a scaffold has been run twice against a bible the first run filled, and the second run's
  cast is read for whether it reused the promoted names or reinvented them. That measurement is
  worth more than the rule: if reuse is already high, the rule buys nothing.

  Two smaller things this left behind. **The system prompt is not re-rendered mid-session**, so a
  skill promoted during a scaffold is accepted by validation immediately but absent from the
  architect's own list until the next session; re-rendering means rebuilding the agent and losing
  the conversation. And **`directEdit` still normalizes against the in-code bible** — it
  re-normalizes the whole spec to change `scene.length`, so it can report a bible problem against
  the wrong catalog. Fixing it means making `ServerHost.directEdit` async for an advisory-only
  effect.
- **Casting from the library, past the opening cast.** The import path itself is built — the tray,
  the cast gate's own stage prompt, and the adaptation contract the engine enforces rather than
  requests ([`Architect.MD`](Architect.MD), *Casting from the library*). What is unbuilt is
  everything that follows from a cast the author picked rather than the architect invented:

  - **The contract has never met a real model.** Preservation is enforced, so it cannot fail
    quietly — but the notes it emits are the measurement. A run whose proposal reverts nothing says
    the prompt is carrying the rule; a run that reverts on every character says the prompt is not,
    and the enforcement is all that stands between the author and a rewritten restriction. **Done
    when** one imported scaffold is read for which of those it is.
  - **An imported cast may make the cast judge ask the wrong question.** Its single question is
    whether the cast's asymmetry bites on the tension. With an imported cast the author has already
    committed to these people, so a refusal is advice about the *tension*, not the cast — and the
    gate's overrule wording is written for a cast the architect proposed.
  - **A tray larger than the opening cast has no representation.** Four chosen, two in scene 1 is
    the deferred-introduction fork below, and the tray is where it would live.

- **The catalog's advisory reviewer.** Deferred deliberately until real entries exist to test it
  against, and specified where it will live ([`Architect.MD`](Architect.MD)): architect-shaped rather
  than judge-shaped, non-blocking, with mechanical validation still running after it. It exists
  because a catalog amplifies the cast-sheet defects already logged above — one bad character, every
  story after it.
- **The GUI redesign's remainder.** Built: the persistent shell (Stories / Workspace / Libraries),
  the mockup's warm-paper restyle with an authored dark palette, the architect's stepper with the
  gate-labelled approve and the tension as its text, the story map's scene detail (roster, reach,
  hold-only beats), the catalog's derived usage lines, and the concept's **voice picker** — a style
  preset reaches the settings gate, whose voice becomes `writerStyle` while the clauses it derives
  become `writerStyleConstraints` ([Architect.MD](Architect.MD), *The voice*). What the mockups
  proposed and nothing carries yet: the **conversation transcript** as the architect's primary UI —
  needs a host method publishing the session's turns, and the owner has chosen to keep the plain
  last-round narration until they ask for the history; the tag editor's **description** and
  **related-tags** fields (schema work on `TagEntry`); the story editor's **`writerStyleConstraints`
  field** — the settings gate writes the derived half now, and the editor shows only the voice, so
  the one place an author could correct a clause does not display it; and the shelf's
  **"Draft · architect" badge** under Open design questions below.

## The world timeline

**Partly shipped — everything but the repair entity is in.** The ledger, the zero-inference firing
mechanism, the architect's world gate and the handoff's re-aim all ship; what remains is the reader
that decides a beat was preempted, contradicted or ignored. The mechanism was spiked and measured
first — see *What the spike established* below before designing against this. The architect authors
a timeline of **world
events** — a fault alarm firing, an incoming call, the thing in the dark reaching the door — and an
author-side agent fires them into the writer one at a time, revising what remains when a character's
choice makes the next one impossible. It exists to keep a chapter under pressure toward the question it has to answer
**without telling the writer the answer**, which is the fork every previous attempt at story
direction has been impaled on: a writer given no destination stagnates, and a writer given the
destination stops protecting who knows what.

### Why this is not the Director again

A planner that decides what happens turns the consult into theatre — if the beats are fixed, a
character's answer cannot change what comes next, and the asymmetry that is the whole product becomes
decoration. That is the parent project's failure and it is not this one, because a **world event is
the one category no character decides**.

That category already exists here and currently has no author but the writer's improvisation.
[`Writer.MD`](Writer.MD) permits the writer setting, atmosphere, time passing and established facts,
and says outright that a world-caused removal — a trapdoor, the floor giving way — is the writer's to
narrate *while the choice that carried them into it still had to be asked for first*. The timeline
takes ownership of that lane and touches nothing else. No invariant bends: characters still own every
choice, the writer still consults for them, and the entity never answers a fork.

### One ledger, not two systems

A beat is an obligation with a trigger condition. `must: ["the alarm forces a decision about the
wing"]` and `fires: "the fault alarm sounds"` are the same row read as a check and as a cause. Build
them as one structure or the loop ends up with two competing accounts of what the chapter still owes.

The unification is forced by the evidence, not chosen for tidiness. In the four-hander `alarm-wing`
run the alarm **fired in the scene's opening lines and never landed**: the one line that gave it a
consequence was a fabricated quotation, the mechanical lint correctly flagged it, and the redraft
that removed the fabrication removed the escalation with it. The scene ran to the cap, `done: false`,
1028 words (+47%) across 22 consults. The rerun terminated but overran worse — 1485 words (+112%) on
27 consults — and the alarm stayed a background pulse in both. An entity that only fires events would
have marked that beat spent in step one. **Firing and landing are different questions and the entity
needs both.**

### The entity is author-side, not cast

"Quasi-character" is the right metaphor and the wrong data model. An entry in `characters[]` lands in
the roster, `/cast`, the preflight cards, the story editor, the handoff, the neglect nudge and
reaction fan-outs — and this thing has no persona, no goal, no skills, no restrictions, and never
answers a consult. It belongs with the agents that share the writer's seat and hold one response
schema each (judge, batch judge, narration judge, clarifier), listed in
[`CLAUDE.md`](CLAUDE.md)'s agent paragraph.

Give it the writer's blindness deliberately: it sees the timeline, `facts[]`, the scene's question and
the page so far. **Not personas, not goals, not private knowledge.** An entity that knows what
characters want and times events against them is the Director wearing a hat, and it would break the
same asymmetry through a door the consult protocol does not guard.

### A broken timeline needs four repairs, not one

"Revise the next event" is four verbs, and the common case is not the one the word suggests:

| what happened | the repair |
| --- | --- |
| **Preempted** — they evacuated before the alarm fired | the beat is void; **replace** it |
| **Contradicted** — the monster cannot come through a door someone sealed | **revise** it; it comes through differently |
| **Fired but did not land** — both `alarm-wing` runs | **escalate**: the same beat, with more force, again |
| **Stranded** — the scene ended with the beat unfired | **re-aim** it at the next chapter, or drop it |

Escalation is the one with live evidence behind it twice, and it is the one a single `revise` verb
would blur into rewriting a beat that was fine.

### Firing is injected, not offered

The soft version — telling the writer an event is *available* — is what `alarm-wing` already
produces without any timeline at all, and it produced 24 steps of background chime. Hand the writer
the event as something that **has happened**, inside `[WRITE]`, the way the length budget already
arrives (`prompts/writer.ts`).

That creates a contradiction risk, and it is the entity's to absorb rather than the writer's: give it
the last piece of prose before it decides, for exactly the reason the clarifier is already given one
— *so a fact it decides on the spot cannot contradict the page*.

### The risk it carries: an entity that can always rescue the ending

If the entity may revise toward a planned outcome without limit, it can always reach that outcome,
and the characters' choices stop mattering — the theatre problem returns through the side door.

The best run on record is the argument. In the stage-3 scene of the open-beat experiment, *Elias does
not convince Sara; he and Kane overpower her at the lever and she concedes after* — the scene answered
its question by a better route than the premise anticipated. An entity steering to a scripted route
would have prevented exactly that.

So point the entity at the **question**, not the answer: its revision trigger is *is the question
still live and under pressure*, never *are we on the planned path*. The outcome stays a chapter-level
obligation the handoff carries. The timeline is the pressure that makes it likely, not the rail that
guarantees it.

### What the spike established (2026-08-29 → 09-01, deleted in `1d18577`)

Four env-gated experiments ran on `alarm-corridor` (duo) and `alarm-wing` (four-hander), then were
removed. The code is recoverable from `ad670c6` and `6704279`; what it bought is below.

**Injection works, and withholding is half of it.** A beat handed to the writer as established fact
— *this happened, nobody chose it, nobody can decline it, write it as already true* — reaches the
page every time it fired. But injection alone is nearly redundant: the writer already fires the
event unprompted in line one, because the scene's `question` names it, so pre-firing is obedience
rather than error. The `[HOLD]` half — naming what the writer may not start until told — is what
made the beat an event rather than a setting. **Both halves are load-bearing and neither is
optional.**

**A memory lands, hides, and changes reasoning without being quoted.** A per-character fact
implanted at the moment the beat fires — a `knows` entry with a trigger, what they always knew and
had no reason to think about — surfaced in three of four character-instances as a visible shift in
their own `thought` field, with the wording never appearing in the prose or in their speech. HALE
went from *"I need Oduya to help stabilize it through the door"* to *"this isn't about paperwork;
the panel fault needs immediate attention"*; ODUYA went from *"the ledger must accurately record"*
to *"my name is tied to the failure"*. It goes in `Agent.system`, not history: history is trimmed
into a rolling digest and a memory summarized away mid-scene is a bug. `fork()` copies `system`, so
a retry keeps it without learning it was a retry.

**Why the alarm was inert before memories.** Read from `story.json`, needing no run: the two
characters the scene's question turns on had nothing in `knows` the event could attach to — HALE
holds the contract, the cage key and the ferry; ODUYA holds the paperwork, the log and head office.
Neither held a consequence for ignoring a siren. Worse, both `impulse` fields are authored to
entrench under pressure (*get more precise about the timetable*; *get slower and more procedural*),
so an event carrying pressure and no stake **tightens** a deadlock rather than breaking it.

**Both memory misfires were authoring, not plumbing**, and both are constraints on the architect:

- *A memory about liability attaches to whatever the character already fears, not the cost you
  meant.* ODUYA's named exposure in the log; it was written about the building standing occupied and
  was read as exposure for granting an exception — so ODUYA got more obstructive, the opposite of the
  intent. A memory must name its specific cost, not a general liability.
- *A memory that contradicts its own beat loses to the beat.* HALE's said the cage stays shut while a
  zone is in fault; the beat said the magnetic lock released and the door stands open. HALE reasoned
  entirely from the open door and showed no uptake at all — the one instance of four with none. **A
  beat and its memories are one authoring act and must agree about the world.**

**What the spike could not establish, and no successor should claim without more runs:** anything
about pacing or termination. Step counts swung 12→24 on the duo and 14→24 on the four-hander with
the code path *unchanged*. Single-run comparisons do not survive that variance. Four runs were also
wasted on a placeholder beat (`<same beat>` pasted literally from a command template), which is its
own lesson about handing over run commands with holes in them.

### Open decisions

- **~~Where the timeline lives.~~ Story-level `timeline[]`.** Settled by the memories: an entry is
  per-(event, character), so it carries a map of memories beside the beat and hold text, which
  `SceneDef` has no shape for. Story-level is also what lets the handoff re-aim a stranded beat.
- **~~What it costs per step.~~ Nothing.** Firing, holding and implanting need no model call at all —
  the spike ran on a fixed fractional trigger with zero inference. Only *repair* needs a model, and
  repair is rare. This kills the per-step cost concern and means a working timeline ships before any
  agent exists.
- **Who decides a beat landed** — still open, and now open on both halves. "Landed" meant only *the
  writer wrote it*; it never meant *it changed a decision*, and those came apart in every run. The
  *wrote it* half looked mechanical and is not — see block 1 below for the measurements that killed
  the bigram check. The *changed a decision* half no mechanical check can reach at all; the
  `done_flagged` verdict from the done judge ([`Judge.MD`](Judge.MD)) is the closest instrument the
  engine has, but it reads the scene's question, not the beat.
- **History or none**, for the repair entity. Unchanged: judge-shaped (fresh, `0.3`) or
  clarifier-shaped (one per scene, remembers). Now a smaller question, since the entity only handles
  repair.
- **A world event that speaks needs a grant.** Unchanged. An incoming call has a voice on it, and
  [`engine/quote-lint.ts`](engine/quote-lint.ts) matches every quoted line against the granted ledger.
  A fired beat carrying dialogue must reach that ledger or the lint flags the writer for rendering
  precisely what it was handed — the trap the promote path already solves by being processed just
  after the lint.

### Blocks

Only the repair entity is left. Everything else in this feature has shipped and its behaviour has
moved to the document that owns it: the ledger and the schema to [`Architect.MD`](Architect.MD), what
the writer receives to [`Writer.MD`](Writer.MD), what a memory is to
[`Character.MD`](Character.MD), and the events to [`GUI-SPEC.md`](GUI-SPEC.md). What ships without it
is a held-then-fired beat carrying stakes on a fixed trigger, authored by the architect's world gate
and re-aimed by the handoff when a chapter never reaches it.

**Landing, and the four repairs.** The entity, and the first model call in this feature:
preempted / contradicted / fired-but-did-not-land / stranded. Only the last of those is handled
today, and mechanically: a beat the scene never reached is recorded as `beat_stranded` and the
handoff is asked to re-aim or void it. The other three need a reader.

**A mechanical landing check was built and removed — do not rebuild it the same way.** It scored
character-bigram Dice between the fired text and every window of the piece the injection asked
for, at a threshold of `0.8` borrowed from quote-lint's near-verbatim precedent. Measured against
the `alarm-wing` spike run, the piece that faithfully rendered the beat scores **0.73** — below
the shipped threshold, so a clean landing read as a failure — while pieces with nothing to do
with the beat score **0.49–0.64**. The whole dynamic range is 0.49–0.73 and the boundary would
have to sit in the ~0.09 gap between one true positive and the worst false positive, fitted to a
single event. Character bigrams have a high floor on any two English passages; that is fine for
quote-lint, whose true positive is a *copied* string scoring ~1.0, and useless for a world beat,
which is *rendered*. Content-word coverage of the beat separated better on the same run (0.43 for
the true landing against 0.00–0.33) but is equally uncalibrated on n=1. Either metric needs
several beats across several runs before it decides anything, and the model may simply be the
right instrument here.

**The escalation it drove carried a defect worth not repeating.** A beat awaiting its check and a
beat that has *failed* one are different states, and the loop conflated them: any turn where the
writer answered with a consult and no prose — legal, and common — drew the escalated injection,
*"You were told last turn and the piece did not carry it"*, when there had been no piece. Whatever
re-injects a beat must key on a check that ran and failed, never on one that has not run yet.

The repairs have no live evidence behind them yet: no run has produced a choice that voids a beat.
That is why this is last, and why building it against imagined breakage would repeat the landing
check's mistake.

### Done when

**Not a step count.** The variance above makes any single-run pacing comparison meaningless, and the
old criterion (`alarm-wing` terminates near target, duo control does not regress) was written before
that was known. What replaces it:

- ~~**The mechanism, per run and cheap to check:**~~ **Met** (`alarm-corridor`, 2026-09-01, one beat
  authored into `story.json`, no environment variables): steps 1–5 carry no alarm word at all, the
  beat fires into step 6 and the alarm appears exactly there, both memories implant, and neither
  memory's wording reaches the prose. The scene closed `done: true` at 14 steps, 737 words (+5%),
  nothing flagged and no answer owed.
- **The effect, and it needs several runs per condition:** characters who received a memory reason
  differently after it lands than before — read from their own `thought` fields, not from whether
  they mention the event. That is the measurement that separates a beat that landed from a beat that
  mattered, and it is the only one that distinguishes this feature from scenery with a volume knob.
  One instance of each so far, in the same run: ODUYA's memory visibly redirected their reasoning
  for two replies before their authored `impulse` reasserted; HALE's did not land at all. Both
  readings, and the constraints drawn from them, are in [`Architect.MD`](Architect.MD).
- **The guard:** a run where a character's choice voids a beat, and the repair points at the scene's
  question rather than at the planned path. Without this the entity is a rail.

## Decoupling GUI / host / engine / provider

A ports-and-adapters restructuring (`application/` `domain/` `ports/` `adapters/` `presentation/`,
view models and presenters, commands everywhere) was proposed to cut coupling between `story.json`,
the engine, the provider and the GUI. Evaluated against the repo and 228 commits of history: **most
of it is already built under the existing names, most of the rest would cost more than it buys, and
the largest real coupling in the codebase is one the proposal never named.**

**Already true, no work needed:** zero runtime imports of `engine/` under `server/` (only the
CLAUDE.md invariant needs policing — see Block 1); an application layer already split across
[app.ts](app.ts) (run lifecycle) and [host.ts](host.ts) (everything the GUI drives); three
representations of a story already exist (`StoryJson` persisted/wire, `StoryConfig` engine-flattened,
`StorySpec` architect/editor); most routes are already commands (`/select`, `/story/discard`, all
run-control, all nine scaffold actions) except the two form editors, which round-trip documents on
purpose; presenters already exist under other names (`StoryCard`, `fullCast`); the provider port
shipped in `a2344de` and no file outside `engine/provider-*.ts` branches on a provider.

**Where the proposal is wrong:** its own success test — *split one `story.json` field into three
persisted fields, the GUI should not need touching* — fails to find the actual pain. Of 12 commits
touching `engine/story-schema.ts`, only 6 touched `server/gui/`, and in each the GUI change was
the point (a new field needs an editor). The ripple that actually hurts is intra-engine on the same
12 commits: `story-format.ts` 10 times, `scene-loop.ts` 10, `story-spec.ts` 9, `architect.ts` 7 —
presenters and view models do nothing about that. And a DTO layer under the story editor
([story-edit.js](server/gui/viewer/story-edit.js), a faithful round-trip form over `StoryJson`) is
the worst possible place for one: any view model there must be information-preserving and isomorphic
or a save silently drops fields — maximum ceremony, a new silent-data-loss mode, zero decoupling.

**What it misses — the actual biggest coupling.** CLAUDE.md's "`server/` never imports `engine/`"
invariant is syntactically true and semantically false for the two largest route modules.
`ServerHost.newScaffoldSession()` hands the route a **live `ScaffoldSession` engine object**, and
[server/scaffold-routes.ts](server/scaffold-routes.ts) reads ~20 of its fields including
`SCAFFOLD.spec.*` internals ([:72-117](server/scaffold-routes.ts#L72)), **assigns six of them**
directly (`.imported` [:180](server/scaffold-routes.ts#L180)/[:216](server/scaffold-routes.ts#L216),
`.tags`/`.castSize` [:203-204](server/scaffold-routes.ts#L203), `.bible`
[:229](server/scaffold-routes.ts#L229), `.spec`/`.problems`
[:244](server/scaffold-routes.ts#L244), `session.style` [:63-65](server/scaffold-routes.ts#L63)),
and **derives four domain predicates in the HTTP layer** — `tagsSteer`, `castSizeSteers`,
`importsSteer`, `styleSteers` ([:99-105](server/scaffold-routes.ts#L99)), which is an architect rule
("would the next build of that stage's prompt read this?") answered from the route module. That is
486 lines — 38% of all route code — driving engine objects directly. This is the coupling worth
spending on, and it is the proposal's own "evolve `ServerHost` into a façade" idea applied to the one
place that needs it instead of everywhere.

### Blocks

1. ~~**One shared `ServerHost` fake, and a boundary test.**~~ **Done.** `tests/helpers.ts` exports
   `makeHost(overrides)`; `server-routes`, `catalog-routes`, `story-edit-routes` and
   `story-read-routes` all build on it (`tests/gui/harness.ts`'s `fixtureHost()` was left alone — it
   spreads the real `HOST` for genuine engine behaviour, never was a hand-faked stub). Overrides are
   deliberately untyped against `ServerHost` (`Record<string, any>`), matching the looseness every
   fake's own trailing `as unknown as ServerHost` already had. `tests/boundaries.test.ts` checks all
   eight `server/*.ts` files for a non-`import type` import of `engine/`; none found.
2. ~~**Provider-work residue.**~~ **Done.** `preflight.ts` reads `PROVIDER.displayName`.
   `explicitLoad`/`explicitUnload`/`modelPreparation` deleted from `ProviderCapabilities` and all
   three adapters, along with the test that only checked their shape. `tests/world-timeline.test.ts`
   is in `npm test` (was already green). `LM_STUDIO_URL` untouched.
3. ~~**An editor-configuration contract.**~~ **Done, two commits.** `GET /story/edit-config` serves
   `{defaults, thinkingLevels, caps}` (host.ts, derived from `StoryJson.parse({})` and
   `THINK_LEVELS`/`VOICE_SAMPLE_CAP`); `story-edit.js` fetches it once at boot and every hand-copied
   default is gone. Second commit did the same for the catalog: `GET /catalog/config` serves
   `{tagFacets, caps}`, replacing `catalog-view.js`'s and `interview.js`'s own hardcoded facet
   lists/`<select>` options (four call sites, two files) and merging their duplicate
   `facetLabels`/`FACET_LABELS` maps into one export. `catalog-schema.ts`'s own independent voice-cap
   literal now reuses `story-schema.ts`'s `VOICE_SAMPLE_CAP`. Left alone, and why: `CATALOG_KINDS` —
   `pages.js`'s own comment already shows it single-sourced to `state.js`, so the duplication this
   entry named was stale; `catalog.js`'s `toDraft`/`fromDraft` — the prose-vs-list knowledge per field
   is presentation logic a route can't cheaply hand over without introspecting the Zod schemas'
   shapes at runtime, which is more machinery than four kinds that essentially never change shape
   justify.
4. ~~**One faithful `StoryJson` shape for the editor.**~~ **Done.** `storyJsonShape(spec, models)`
   (extracted from `renderStory`) is exposed through `ServerHost.storyJsonShape`; `scaffoldState()`
   sends it as `storyDraft` alongside the unchanged, specView-shaped `spec`. `story-edit.js`'s
   `editNew` branch loads `storyDraft` directly; `scaffoldStory()` is deleted. `specView` stays for
   the interview's own proposal card, untouched. `tests/gui/story-edit.spec.ts` gained the first
   automated coverage of the "review new story" screen at all — writing it surfaced a real
   pre-existing gap, `SCAFFOLD` (a module-level singleton in `scaffold-routes.ts`) leaking between
   Playwright tests in the same worker; both scaffold-session tests now abandon in `finally`.
5. **Make `ServerHost` the only boundary the scaffold domain crosses.** After this block
   `scaffold-routes.ts` should not know what a `ScaffoldSession` is — only HTTP, wire validation
   (`MAX_TAGS` etc., already correctly at the route), SSE, the busy/abandon lifecycle, and
   `ServerHost.scaffold*()` calls. `ServerHost` loses `newScaffoldSession`/`directEdit`/`specView` and
   gains `scaffoldStart/Say/Approve/Concept/Import/Promote/Set/Accept/Abandon/State`, each taking
   wire-shaped input and returning one plain state type declared in `server/server.ts` (beside the
   existing `Concept`/`CatalogUsage`). The four `*Steer` predicates and every `SCAFFOLD.*` read/assign
   move into [host.ts](host.ts); the session handle becomes private to it. Wire contract unchanged —
   `GUI-SPEC.md` and the GUI stay untouched. Tighten `tests/boundaries.test.ts` to assert
   `server/scaffold-routes.ts` never mentions `ScaffoldSession` or `SCAFFOLD`, and `server/` never
   imports `engine/architect.ts` or `engine/story-spec.ts` even as a type.
6. **Same for the handoff**, roughly a third the scope:
   [next-chapter-routes.ts](server/next-chapter-routes.ts) reads seven `HANDOFF.*` fields
   ([:29-38](server/next-chapter-routes.ts#L29)) and assigns none. Extend the boundary test to
   `NextChapterSession`/`HANDOFF`; after this `server/` has no type-level dependency on
   `engine/architect.ts` at all.

Blocks 1–4 are small, uncontroversial, and make 5–6 cheaper; 5–6 are the actual work and can be
deferred or dropped without stranding 1–4.

### Explicitly not doing

Generic `ports/`/`adapters/`/`application/`/`presentation/` folders — the dependency direction they'd
enforce already holds and Block 5 makes it a test, and renaming `host`/`engine`/`app` to a familiar
taxonomy would describe this system worse than the current names. View models for reads that already
have them (`/cast`, `/stories`, `/run`, `/catalog/usage`). DTOs for the faithful round-trip editors —
Block 3 removes the real harm without one. Injecting `PROVIDER` — it's a monkey-patched import-time
singleton in tests ([tests/model-ready.test.ts:20](tests/model-ready.test.ts#L20),
[tests/run-gate.test.ts:16](tests/run-gate.test.ts#L16)), correct for a single-user local tool.
Multi-client/concurrency architecture — one process, one run, one GUI stays the constraint.

### Done when

Per block: `npx tsc --noEmit && npm test && npm run lint`. Blocks 1–2: `npm test` alone is decisive.
Blocks 3–4: also `npm run test:gui` plus the story-editor/catalog sections of
[GUI-CHECKLIST.md](GUI-CHECKLIST.md) — reload rather than hash-navigate. Blocks 5–6: three gates —
`tests/boundaries.test.ts` tightened and green; `tests/scaffold-routes.test.ts` and the
scaffold/handoff Playwright specs pass **unchanged** (an assertion needing to change means the wire
contract moved, which this program doesn't authorize); `npx tsc --noEmit` after deleting the
`import type` lines. No live model run needed anywhere in this program — nothing here touches
`prompts/` or model behaviour. Afterwards: update the `server/`/`host.ts` rows in
[CLAUDE.md](CLAUDE.md) and `GUI-SPEC.md`'s `ServerHost` claim, which Block 5 finally makes true.

## Polish and cost

No defect and no decision owed: smaller quality work, prompt cost, and coverage.

- **The one-shot scaffold still spends a quarter of its prompt on the worked example.**
  `architectExample()` reads `tests/fixtures/doorway/story.json`, ~1,870 estimated tokens. The handoff
  no longer carries it (`buildArchitect(d, false)`) and the staged walk embeds each stage's fields
  inline, so only `mode: "oneshot"` still pays — a whole-story proposal has no story yet to
  demonstrate the format with. Whether that path can drop or shrink the example is what is left.

  **And it now carries the world-event rules too.** `TIMELINE_FIELDS` is ~888 estimated tokens and
  `ARCHITECT_FORMAT` went from ~3,217 to ~4,105 with it — 28% growth on every one-shot prompt, for a
  field the block itself says is usually `[]`. It is shared with the staged world gate rather than
  duplicated, so the cost is paid once in source; the question is whether the one-shot path should
  pay it at runtime. The cheap alternative is a short block there (what a world event is, the field
  shapes, "usually empty") with the four memory rules left to the staged gate — at the price that a
  beat authored in one-shot mode is authored without the rules that stop it misfiring. Not decided:
  nobody has yet read a one-shot proposal that produced a beat.
- **The story editor has no view of the session's tension sentence.** It steers the cast and scene
  stages but lives only in the conversation, so an author editing the story afterwards cannot see
  what the cast was built to serve.
- **Keep current-run rendering scoped to one chapter.** No defect has been observed; this is a
  constraint on whatever aggregate display comes next. Story-level totals are aggregated only when
  the UI is explicitly showing more than one run, and the grouping section of
  [`GUI-CHECKLIST.md`](GUI-CHECKLIST.md) is what checks it.
- **`run-and-save.ts`'s write-failure paths have no coverage.** The module exists; the branches are
  not reachable from a test until `runChapter` is injectable or the artifact writer is split out of
  `runAndSave`.
- Keep `liveHistory` growth within a run under observation; it is reset between runs but is currently
  not bounded during a very long run.
- **A run's manifest is not surfaced anywhere but the file.** `out/<id>/manifest.json` now records
  which engine wrote a run ([run-manifest.ts](run-manifest.ts)), and a stale process says so on the
  console before the first model call. Nothing reads it back: `RunSummary` does not carry `engine` or
  `engineStale`, so the shelf and the run list cannot group runs by condition or grey out a run whose
  engine is not the one on disk. That is the display half, and it is worth doing only once more than
  one condition is routinely being compared.

## Parked, with the reason

Nothing here is work. Each entry exists to stop a future decision going wrong — a thing already tried
that does not work, a cost not worth paying yet, or a constraint on whatever comes next.

- **A `knows`/`goal`/`belief` name absent from `characters` — the hallucinated half only.** When the
  cast-sheet checks moved into `normalizeSpec` (the facts[] reframe, shipped), the original fifth check —
  "a name in `knows`/`goal`/`belief` absent from `characters`" — was split in two. The **rename** half
  now lives in `applyEdits`: it holds the `renames` map, so it scans every character's `knows`/`goal`/
  `belief` for the exact old name and flags a stale reference with zero false positives. The
  **hallucinated-name** half has no such history and was deliberately left with the model's
  "anything else" backstop, because the obvious mechanical detector does not work: a proper-noun
  regex (`/\b[A-Z][a-z]+\b/` + stoplist) run against `tests/fixtures/doorway/story.json` returns **5
  false positives and 0 true** — `There`, `Get`, `Whoever`, `Head`, `Get` — since those fields are
  multi-sentence prose where sentence-initial capitals dominate. Do not re-propose that regex. The
  real detector, if wanted, needs rename history at proposal time or a names-known-to-the-draft graph
  that `normalizeSpec` does not have; until then it stays a model judgement.
- **Reach may eventually want scoped targets. Not planned.** A reach entry is today one flat
  `thing :: meaning` string; scoping it (`camera 3 but not camera 7`, `the lobby doors but not the
  vault`) would mean *character → interface → capability → scope* instead. Recorded so the flat form
  is read as the deliberate floor it is, and not as the ceiling.
- **Small-model coherence limits, observed live and parked.** Two failure classes from the doorway
  runs that prompt text has not fixed and arguably cannot: the writer contradicting its own
  established facts (a keyless card-slot lock picked, then opened by "the key turning"; hinges
  groan-risked, then "well-oiled"), and the judge reading binary forks hyper-literally even with
  calibration lines in place (rejecting an answer for carrying *extra* fields; rejecting a slide
  because it stopped short of a literal drop). A fact-ledger check across drafted pieces — one more
  stateless judge call per piece — is the candidate fix for the first; the second may just be a
  model-size floor.
- **Model-specific prompt variants. Parked.** Selecting prompt text by which model is running: no
  concrete misbehaving model/prompt pair is in hand, so building the selection mechanism now would
  be speculative infrastructure with nothing to select between. Revisit when a live run names a
  prompt that needs different wording for a different model.
- **A fourth judge variant for a shared fork.** Parked because it adds runtime cost rather than
  closing a gap: a variant beside `newJudge`/`newBatchJudge`/`newNarrationJudge` (0.3, no history,
  one response schema) asked whether the scene honoured both characters' stated choices at a shared
  fork — one extra LLM call per multi-character fork if it were ever wanted.
- **There is no moment at which an owner accepts anything.** Overwrite protection and chapter
  contiguity shipped (Writer.MD, "One run writes one chapter"), but "accepted" still just means "a
  file the run wrote" — if an explicit acceptance step is ever wanted, it starts there.
