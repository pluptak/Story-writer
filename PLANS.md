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
  pipeline: the **verify** pass could flag a cast where nobody has any restrictions — that check now
  has more evidence than it wanted, gathered under *The verify pass has never changed anything*
  below; and the story editor has no view of the session's **tension** sentence, which steers the
  cast and scene stages but lives only in the conversation.
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

- **`facts[]` is framed away from the one thing it exists for.** The story stage asks for "truths
  true of the world at large that nobody in particular walks in holding", and the fill-gaps pass
  reinforces that a fact one person holds stays in their `knows`. Neither says what actually decides
  it: the writer is never shown any character's `persona`, `knows`, `goal` or `belief` —
  `writerSystem` tells it so outright — so a fact *everyone in the room* holds is exactly what
  belongs at story level, and the current wording reads as excluding it precisely because both
  characters do hold it. Two live scaffolds in a row came back with `facts` empty, and in both the
  writer then invented the missing world state and got it wrong: in one, which of two patients each
  character was arguing for, and the whole scene ran inverted; in the other, nothing bounded what
  could be true of the room and the writer invented an electrical fire that dissolved the premise's
  dilemma. The fix is a reframe, not a new field — state the writer's blind spot, and make "two or
  more characters both hold it" the test for story level rather than "nobody in particular holds it".
  A matching verify bullet for the omission does not exist at all.
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
- **Cast-sheet defects that are mechanically checkable and unchecked.** From two live scaffolds: a
  `knows` naming a character who is not in the cast — a rename or a hallucination, and a name in
  `knows`/`goal`/`belief` absent from `characters` is a pure string check; an editorial parenthetical
  written into a `goal` and rendered verbatim into that character's prompt ("be gone by 5:00 PM (or
  in this case, end his shift/contractual window immediately)"); and a `goal` in the third person
  naming the character to itself while the persona is second person, since `CHARACTER_FIELDS` fixes
  the person for `persona` and for no other field. A fourth needs judgement rather than a check: a
  cast sheet whose pronouns disagree with the prose the writer then produces from it.
- **The verify pass has never changed anything.** Across four live runs of two stories it returned no
  edits every time, including on drafts where checks it already holds should have fired: a cast with
  no restrictions at all, which `normalizeSpec` had already detected and handed to it under
  `[ALREADY FLAGGED]`, and a `reach` grant naming a phone that neither `place` nor `facts` ever
  established — the I5 bullet, verbatim. Detection is not the gap; `problems` are advisory and never
  block acceptance. Two directions, and they combine. Move the mechanically decidable checks out of
  the prompt and into `normalizeSpec`, where `problems` already exists and already feeds
  `[ALREADY FLAGGED]`: a roster name absent from `characters`; `pov` absent from the *roster* (only
  pov-absent-from-*characters* exists today); reach granted to someone absent from the roster (the
  same gap); and a reach entry whose name collides with a general or bible skill. Then make at least
  the no-asymmetry finding gate the cast stage, needing an explicit author override rather than
  passing silently. The genuinely semantic checks — a fact restating a private `knows`, a restriction
  that cannot bite, I5's does-the-thing-exist — stay with the model, which is what I5 already asks
  for.
- **The no-restrictions check is satisfied by a token.** `normalizeSpec` asks only whether *anyone*
  in the cast has a restriction. A live four-hander passed it with one restriction on one character
  while the POV and two others had none. What the check wants to ask is whether the asymmetry touches
  the fork the scene turns on — the same judgement the verify bullet already tries to make, which is
  why the two probably ship together.

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
- **The writer supplies both answers, and that suppresses clarification.** Across three runs of one
  story every consult without exception was an either/or with both branches written by the writer
  ("Do you concede and sign for A, or do you double down?"), and across four runs there was exactly
  one clarification request in 37 consults. The two look causally linked: a situation carrying both
  options and all the context leaves a character nothing to ask for. `DEGENERATE_QUESTIONS` already
  refuses a question with no fork in it; the mirror case — a question carrying its own answers — has
  no check. Refusing it in `normalizeConsult` and reworking the writer prompt's instruction on
  question shape are two halves of one change.
- **A reaction fan-out does not differentiate.** Given one situation, several characters return the
  same beat: in a live four-hander two of them answered a post-crisis fan-out with near-identical
  shaking hands and a long exhale, and one then repeated his own line almost verbatim in a later
  fan-out. Four of that scene's six fan-outs came after the crisis had resolved, and the scene
  overran its 900-word target by 43%. Whether the fix belongs in the fan-out's situation text, in a
  cross-reaction check like the parked fourth judge variant above, or simply in not fanning out once
  the scene's question is answered, is open.
- **The clarifier can answer a different question than the one asked.** The single live clarification
  observed asked whether telemetry was stabilising or the oscillation increasing, and was answered
  with what a different system sounded like. The answer was accepted and folded in. Nothing checks
  that a clarification addresses its question.
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
