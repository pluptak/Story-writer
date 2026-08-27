# Plans

**Every unbuilt plan lives here.** Built behaviour belongs to the document that owns its surface —
[`GUI-SPEC.md`](GUI-SPEC.md) for routes and SSE, [`Architect.MD`](Architect.MD) for the architect and
the handoff, [`Writer.MD`](Writer.MD) for the writer and the live screen. When something here ships,
its behaviour moves into one of those and **the entry is deleted rather than annotated**; git history
is where implementation notes belong.

Nothing below is committed work. Within a section the order is a preference, not a schedule. The one
exception is **Next**, which is the short list of what should be picked up first.

**Verification, once, for all of it:** `npx tsc --noEmit` and `npm test` are the cheap checks. Anything
touching `server/gui/` also needs the matching section of [`GUI-CHECKLIST.md`](GUI-CHECKLIST.md), since
the viewer has no automated coverage. Anything touching `prompts.ts` or model behaviour needs a live
run, which is the owner's to make, batched.

---

## Next

Five items promoted out of the sections below, in the order they should be picked up. Each is
decidable now and has live-run evidence behind it. The first two are reasons to distrust what the
architect hands the writer; items 3–5 are reasons to distrust what the writer hands everyone else.

Their evidence is four doorway runs of 2026-08-27 — `14-54-12-677Z`, `16-23-17-001Z`,
`19-33-16-122Z` and `19-47-04-293Z`. The first three ran `google/gemma-4-e4b` throughout; the fourth
put the writer, judge, narration lint and clarifier on `gemma-4-12b-it-qat-uncensored-heretic` and
left the characters on `e4b`. **Retained-run rotation has since removed `14-54-12-677Z` from disk**,
so figures cited from it are not re-derivable; everything attributed to the other three is. Two
further `e4b` runs, `21-35-36-919Z` (control) and `22-23-22-884Z` (the first under the shipped
sense-lint, consult gate and person clause), are item 2's and item 4's evidence; both are preserved
under `stories/doorway/experiments/` with the runs they are measured against.

That model split is why the order is what it is. Raising the author-side model fixed or nearly fixed
items 3, 4 and 5 on its own — the fourth run finished in 13 steps with no degenerate questions, no
person drift and no repetition — while the prose sense-lint's three holes, which led this list until
they shipped, appeared on the page in both models: the one thing capability did not buy.

### 1. `facts[]` is framed away from the one thing it exists for

The story stage asks for "truths true of the world at large that nobody in particular walks in
holding", and the fill-gaps pass reinforces that a fact one person holds stays in their `knows`.
Neither says what actually decides it: the writer is never shown any character's `persona`, `knows`,
`goal` or `belief` — `writerSystem` tells it so outright — so a fact *everyone in the room* holds is
exactly what belongs at story level, and the current wording reads as excluding it precisely because
both characters do hold it. Two live scaffolds in a row came back with `facts` empty, and in both the
writer then invented the missing world state and got it wrong: in one, which of two patients each
character was arguing for, and the whole scene ran inverted; in the other, nothing bounded what could
be true of the room and the writer invented an electrical fire that dissolved the premise's dilemma.

**Done when** the story stage and the fill-gaps pass state the writer's blind spot and make "two or
more characters both hold it" the test for story level, and verify has a bullet for the omission,
which it does not have at all today. This is a reframe, not a new field.

### 2. Did the instruction pass fix the consult-gate churn?

The gate holds: `normalizeConsult` refuses both menu questions (word-bounded "or") and shrug
questions, and the refusal flows to the writer, the judge's re-ask and the fan-out alike. The first
run under it (`22-23-22-884Z`) measured the cost of teaching a small model a shape it does not
have: eight of 24 steps spent on refused consults, three thin questions sent, one of them the
vagueness dodge — "Do you speak, or remain silent?" refused, "What do you choose regarding the
lock?" sent — and the scene ending `done: false` at the step cap with `answer_unwritten`.

The instruction passes shipped in response: `NAME_THE_FORK` now carries the worked example that
transferred in live evidence ("What do you say to the group about the state of the hardware?") and
names both refused shapes; the two refusal whys cross-reference each other's failure so a writer
corrected off one shape does not walk into the other; and `DEGENERATE_QUESTIONS` knows the dodge —
"What do you choose regarding X?" is refused beside the menu.

Open, if the next `e4b` run still churns: **whether a refused consult should cost a step at all.**
Eight steps of a 24-step scene is the observed price of the writer learning by refusal; if the
instruction pass does not quiet it, the candidates are a cheaper retry shape (the rewrite requested
inside the same step) or a second refusal spending budget only on demonstrated repeat offenders.

**Done when** an `e4b` run sends consults that are both open and forked, refusal churn is a small
fraction of steps, the scene terminates `done: true`, and clarification is asked for when a
character lacks a fact.

### 3. An accepted piece can repeat what is already on the page

Draft #2 of the doorway run re-emitted draft #1 **verbatim** — 386 identical characters, the whole
opening paragraph — and appended one new sentence. Both were accepted and both were appended, so the
scene opens with the same paragraph twice. Draft #3 then repeated Riven's `"Just delivering
something…"` line from draft #2. Nothing between an accepted draft and the append to `scene.md`
compares the new piece against the tail of the page.

The writer restating is model behaviour; the page corruption is not, and this is the cheapest of
these to close because it needs no model call.

**Evidence since:** the class is intermittent rather than model-bound. It appeared in the first two
runs (386 and 311 characters) and in neither of the last two — including run three, which was the
same `e4b` model throughout. Run four left one 54-character repeat, a phrase rather than a paragraph.
So a better author model is not the fix, but the defect is rarer than the first two runs implied, and
that argues for the cheap guard rather than against it.

Two decisions the plan has to make:

- **Leaf home.** A new module in `engine/quote-lint.ts`'s shape — no engine dependencies, one pure
  function — rather than a branch inside the scene loop.
- **Threshold and event.** A verbatim prefix is the easy case; near-verbatim needs a similarity
  measure, and `quote-lint.ts:94` is the precedent in this repo (Dice coefficient ≥ 0.8). If it emits
  an event at all, it inherits the same fold-or-case question `narration_quote_flag` is still open
  on — decide it here rather than adding a second event nothing renders.

**Done when** an accepted piece that repeats the page's tail is stripped or refused before the
append, the threshold is chosen with the doorway 386-char case and quote-lint's 0.8 as the two
reference points, and the event decision is made rather than deferred.

### 4. Was the person clause the thing that cleaned the page, or was the run clean anyway?

The clause shipped (`prompts/writer.ts`, the POV line): person is the house style's to set, never
the consult rhythm's. The first `e4b` run under it (`22-23-22-884Z`) had a clean page and clean
drafts — but so did the control immediately before it (`21-35-36-919Z`, same model, no clause:
0 `you` across 31 drafts), while the controls before that drifted pervasively (7 and 3 per page in
`16-23` and `19-33`). One clean run next to one clean control credits nothing; the clause is
unproven, not disproven.

**Done when** another clause-era `e4b` run is read: if clause-era pages stay clean where the
control era drifted, the clause takes the credit and this entry is deleted; if a clause-era page
drifts, the clause failed and the approach (prompt clause vs. mechanical detection) is reopened.

### 5. A scene has no representation of its own question being answered

The doorway run ended `done: false`, at 64 steps against a `maxSteps` of 24 (four `budget` grants)
and 933 words against a 700 target. Its question — "Does Riven get through the door before Merritt
decides what to do about them?" — was answered at the midpoint: door open, satchel handed over,
ledger signed. Everything after is epilogue, and in it Riven is consulted four more times about how
fast to walk away while Merritt is asked five times whether to stand up. Item 4's person drift lives
**entirely** inside that epilogue, which is why this is ordered last: some of its evidence is not
independent.

**Evidence since, and it is most of the case against acting:** runs three and four both ended
`done: true`, at 30 and 13 steps, 11% and 18% over target. The pathology was concentrated in the two
runs that never terminated, and a better author model ended scenes on its own. What has *not* changed
is the absence below — no run of any model gave the loop a way to know its question was answered —
but there is now no live overrun to fix, and building a budget policy against evidence this stale
would be building it blind.

This is a policy question, not a defect with an obvious fix — whether a scene may outrun its own
question, and what should happen when it does, is a judgement about pacing. It overlaps "A reaction
fan-out does not differentiate" under Asymmetry follow-ups, whose live evidence is also a
post-crisis overrun.

The one thing worth pinning before any of that is decided: **the loop has no representation of the
scene's question having been answered.** `scene_done` is the writer's to declare and it never did;
budget grants are spent against word count and step count, neither of which knows what the scene was
for. Whatever the budget policy becomes, that absence is the thing it answers.

**Done when** — deliberately open. Do not start this one until 3 and 4 have shipped and a fresh
`e4b` run has been read, since both change what its evidence looks like and only `e4b` still
produces the failure.

## Smaller viewer work

- **Keep current-run rendering scoped to one chapter.** No defect has been observed; this is a
  constraint on whatever aggregate display comes next. Story-level totals are aggregated only when
  the UI is explicitly showing more than one run, and the grouping section of
  [`GUI-CHECKLIST.md`](GUI-CHECKLIST.md) is what checks it.

## Architect follow-ups

- **A `knows`/`goal`/`belief` name absent from `characters` — the hallucinated half only.** When the
  cast-sheet checks moved into `normalizeSpec` (Next item 1, shipped), the original fifth check —
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
- **The one-shot scaffold still spends a quarter of its prompt on the worked example.**
  `architectExample()` reads `tests/fixtures/doorway/story.json`, ~1,870 estimated tokens. The handoff
  no longer carries it (`buildArchitect(d, false)`) and the staged walk embeds each stage's fields
  inline, so only `mode: "oneshot"` still pays — a whole-story proposal has no story yet to
  demonstrate the format with. Whether that path can drop or shrink the example is what is left.
- **The handoff prompt grows with the story.** It resends every written chapter, roughly 1,100 tokens
  each. The round refuses with the numbers rather than letting the model return nothing, so a long
  story fails loudly instead of silently — but nothing shrinks the input. The open decision is which
  of summarizing prior chapters, windowing them, or requiring a correspondingly large context window
  is the answer; the first two both risk dropping exactly the continuity the item below is about.
- **The story editor has no view of the session's tension sentence.** It steers the cast and scene
  stages but lives only in the conversation, so an author editing the story afterwards cannot see
  what the cast was built to serve.
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
- **Approvable, promotable skill bible.** The in-code `SPECIAL_SKILL_CATALOG` is the seed; the second
  half of the plan is a shared, persistent bible that bespoke per-story `custom` skills can be
  **promoted** into — natural home alongside `defaults.json`, loaded by `loadDefaults` and merged over
  the in-code seed. The architect may **propose** a bible addition; it lands only after the owner
  **approves** it — a real gate distinct from accepting the story. That gate is what turns "prefer an
  existing skill" into a hard constraint; until it exists, custom skills stay allowed.
- **Reach may eventually want scoped targets. Not planned.** A reach entry is today one flat
  `thing :: meaning` string; scoping it (`camera 3 but not camera 7`, `the lobby doors but not the
  vault`) would mean *character → interface → capability → scope* instead. Recorded so the flat form
  is read as the deliberate floor it is, and not as the ceiling.
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
- **A structured personality selector.** `CharacterDef.persona` (with belief, impulse and voice)
  drives per-character phrasing as free text today, and persona is documented as exactly the vehicle
  for personality. The owner's goal is a dedicated personality editor where the architect picks from
  a managed list instead of generating persona text on the spot — a bigger, separate feature to
  design then, not an extension to bolt onto the cast stage now.

## Asymmetry follow-ups

Found by asking how the engine handles stories where several characters face interdependent
choices without seeing each other's reasoning. Each is a place where the engine permits something
the asymmetry forbids.

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
- **Model-specific prompt variants. Parked.** Selecting prompt text by which model is running: no
  concrete misbehaving model/prompt pair is in hand, so building the selection mechanism now would
  be speculative infrastructure with nothing to select between. Revisit when a live run names a
  prompt that needs different wording for a different model.
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
  problem and is filed above under small-model coherence limits.
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

  What not to do first: raise `NARRATION_LINT_RETRIES`. The attribution entry below is implicated in
  both failures, so the order is fix the speaker hint, re-measure, and only then ask whether the
  budget is short. If it still is, a single retry carrying an explicit prohibition on adding any
  quotation is the cheaper thing to test, and a second retry granted only when the same mechanical
  invariant fails twice spends generation on demonstrated repeat offenders rather than on everyone.
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
- **`narration_quote_flag` reaches no reader.** The event is emitted in `writeScene` and typed in
  `RunEvent`, but the viewer's event switch handles only `narration_flag`, so its `quote` and
  `character` fields are dropped on arrival. Nothing is lost to the author today, because
  `narration_flag` follows immediately carrying the same `why` — which is exactly why this went
  unnoticed. Either the viewer grows a case for it (a `GUI-CHECKLIST.md` pass, and the grouping
  question of whether it renders beside or instead of the flag that follows), or the event is
  deleted and its two fields fold into `narration_flag`. Deciding which is the whole of the work.
- **A reaction fan-out does not differentiate.** Given one situation, several characters return the
  same beat: in a live four-hander two of them answered a post-crisis fan-out with near-identical
  shaking hands and a long exhale, and one then repeated his own line almost verbatim in a later
  fan-out. Four of that scene's six fan-outs came after the crisis had resolved, and the scene
  overran its 900-word target by 43%. The fix has three possible owners — the fan-out's situation
  text, a cross-reaction check like the parked fourth judge variant above, or simply not fanning out
  once the scene's question is answered. Which one it is has to be decided before anything is built.
- **The clarifier can answer a different question than the one asked.** The single live clarification
  observed asked whether telemetry was stabilising or the oscillation increasing, and was answered
  with what a different system sounded like. The answer was accepted and folded in. Nothing checks
  that a clarification addresses its question. One observation against it since: a near-identical
  question in a later run ("Are the temperature readings currently increasing or stabilizing?") was
  answered squarely ("the needle is jumping further into the red zone with every pulse of the
  alarm"). Two data points, same question shape, opposite outcomes — so this is worth watching before
  it is worth building a check for.
- **There is no moment at which an owner accepts anything.** Overwrite protection and chapter
  contiguity shipped (Writer.MD, "One run writes one chapter"), but "accepted" still just means "a
  file the run wrote" — if an explicit acceptance step is ever wanted, it starts there.
- **`run-and-save.ts`'s write-failure paths have no coverage.** The module exists; the branches are
  not reachable from a test until `runChapter` is injectable or the artifact writer is split out of
  `runAndSave`.
- Keep `liveHistory` growth within a run under observation; it is reset between runs but is currently
  not bounded during a very long run.
- **The writer has one idle-body move per character and reuses it.** A character who is present but
  not acting gets the same filler every time they appear. Doorway: *"Merritt shifts their weight on
  the upturned crate"* three times near-verbatim in one chapter, plus two near-misses. The cooling
  loop, different cast, different story: *"Marsh leans his head back ... squeezes his eyes shut"* /
  *"closes his eyes"* / *"his eyes squeezed shut"* five times in one chapter. Neither is a rule
  violation — weight-shifting on a crate is the narration prompt's own example of good involuntary
  continuity, and a blind man may close his eyes — which is why nothing flags it. It is a vocabulary
  problem, and it replicates across casts and stories, so it is the writer's and not any one
  character's. Related to the fan-out differentiation entry above, but distinct: that one is several
  characters answering alike, this one is a single character rendered alike every time. Worth
  measuring before it is worth fixing — count repeated body-move phrasings per chapter first.
- **Run rotation deletes the control condition of any prompt experiment.** `MAX_RUNS = 3` is right
  for ordinary operation and incompatible with a before/after comparison: a prompt change measured
  against `the-cooling-loop` lost most of its own baseline mid-experiment, leaving 11 pre-edit
  answers against 39 post-edit ones and no interpretable result. The engine is not wrong here — the
  workflow is. Cheapest fix is no code at all: copy the relevant `out/<id>` records into an
  experiment directory before running the next condition. If that proves too easy to forget, the
  candidates are an experiment mode that suspends rotation, or a run manifest recording the prompt
  and engine revisions beside the run so conditions can be told apart after the fact.

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

The constraints that hold whether or not that happens are already written down and are not restated
here: one active run at a time, the localhost-only unauthenticated surface and what widening the bind
would require, in [`GUI-SPEC.md`](GUI-SPEC.md); route modules receiving behaviour through
`ServerHost` and never importing `engine/`, in [`CLAUDE.md`](CLAUDE.md). The one that has no home
elsewhere: operational messages stay in the console and run data stays in the JSONL logs, so the GUI
never becomes a second source of truth.
