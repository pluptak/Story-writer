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

Two items promoted out of the sections below. Each is decidable now, has live-run evidence behind
it, and is a reason to distrust what the architect currently hands the writer.

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

### 2. The writer supplies both answers, and that suppresses clarification

Across three runs of one story every consult without exception was an either/or with both branches
written by the writer ("Do you concede and sign for A, or do you double down?"), and across four runs
there was exactly one clarification request in 37 consults. The two look causally linked: a situation
carrying both options and all the context leaves a character nothing to ask for.

**Done when** `normalizeConsult` refuses a question carrying its own answers, the way
`DEGENERATE_QUESTIONS` already refuses one with no fork in it, and the writer prompt's instruction on
question shape is reworked to match. Those are two halves of one change.

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
- **The LLM half of the narration lint has still never fired.** The quotation check is mechanical
  now (`engine/quote-lint.ts`), which closes the empty-ledger free pass; deeds, restricted senses and
  consult-situation quality remain the model's. That half returned `{"ok": true}` on all 45 pieces of
  four live runs, typically in nine completion tokens behind the `{` prefill, and among them it
  passed "Marsh watches them from his corner" for a character with `restrictions: ["sight"]` — the
  prompt's own worked example ("no watching, no glancing, no gaze for someone who cannot see"). The
  per-answer judge and the batch judge do fire on that same cast — the judge caught "eyes
  half-closed" from that character, and the batch judge twice refused to promote his reaction glances
  to deeds — so a restricted sense is not beyond the model; it is that the lint asks for a four-part
  sweep in one call and returns an assertion. Restricted senses are the next mechanically tractable
  piece: a CANNOT list is a closed set of names, and the verbs that violate each sense are
  enumerable. Worth noting for whoever takes it: the two checks are exclusive in `writeScene`, so a
  piece carrying both an unmatched quotation and a restricted-sense violation reports only the
  quotation. A drafted piece contradicting an established fact is the same shape of problem and is
  filed above under small-model coherence limits.
- **The quote lint attributes a speaker by looking backwards only.** `attribute()` scans the 120
  characters *before* the quote and takes the nearest cast name, so `Riven reaches for the door.
  "No," Merritt says` is reported as `(near RIVEN)`. Post-dialogue attribution — `"..." NAME says` —
  is the ordinary form in the prose this engine asks for, so the hint is probably wrong more often
  than right. Nothing about the flag itself depends on it: whether a quotation matched the granted
  ledger is decided before any name is looked up, and the only live reader of the attribution is the
  `(near X)` clause in the user-visible `why`. Candidate: check for a trailing attribution first and
  fall back to the preceding-name guess, with a test for both orders. Worth settling what "nearest"
  should mean before writing it — a quote between two named characters has two defensible answers.
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
  that a clarification addresses its question.
- **There is no moment at which an owner accepts anything.** Overwrite protection and chapter
  contiguity shipped (Writer.MD, "One run writes one chapter"), but "accepted" still just means "a
  file the run wrote" — if an explicit acceptance step is ever wanted, it starts there.
- **`run-and-save.ts`'s write-failure paths have no coverage.** The module exists; the branches are
  not reachable from a test until `runChapter` is injectable or the artifact writer is split out of
  `runAndSave`.
- Keep `liveHistory` growth within a run under observation; it is reset between runs but is currently
  not bounded during a very long run.

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
