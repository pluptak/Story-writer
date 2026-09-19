# Judge

**Status: built.** "Judge" names a family of five author-side agents, not one role: each is a
single-purpose model call that guards one door the writer's own judgement cannot be trusted to
guard alone. This document owns all of them — their shared contract, one section per variant, and
the failure behaviour each fails with. The writer's side of the consult protocol is in
[`Writer.MD`](Writer.MD); the cast gate's session behaviour is in [`Architect.MD`](Architect.MD).

## The family

All five share one contract, and it is what makes them judges rather than helpers:

- **Stateless.** No history, ever — each is built fresh per call and given everything it needs in
  the payload. A verdict needs no memory, and consistency beats invention.
- **Temperature `0.3`** (`JUDGE_TEMPERATURE`, defined once per chain in `engine/scene-loop.ts` and
  `engine/architect.ts`). The three scene-loop judges take the writer's think level; the cast judge
  takes the architect's.
- **One response schema each.** Nothing else in the engine holds exactly one shape.
- **The shared cast block** (`castBlock`, `prompts/internal.ts`) — each character's delta from the
  human baseline (`can:`, `REACH:`, `CANNOT:`; see [`Writer.MD`](Writer.MD)) — plus a closing
  absolute: *a CANNOT is absolute; anything that reaches through one is unusable however good it
  reads.* Three of the four scene-loop judges share it. The cast judge does not: no scene exists yet,
  so there are no per-scene capabilities to show, and it reads the authoring-time cast sheet (goals,
  skills, restrictions) instead. Nor does the done judge, for the opposite reason: it weighs a
  question against what the page settled, and no CANNOT bears on whether it was settled.

They exist as separate agents because they were once sections of the writer's system prompt,
answered on the writer's own history. With some twenty messages of `[WRITE]` → `{"prose": …}`
behind it, the dominant pattern won often enough to matter: in one two-chapter run, six of thirty
judgements came back as prose and were silently accepted, and a clarification came back as a
verdict, costing a character its answer. Each job holds exactly one schema now, so there is no
second shape to fall into (`prompts/judge.ts`'s header keeps the record).

| agent | built by | model | shown | verdict | call fails |
| --- | --- | --- | --- | --- | --- |
| **JUDGE** | `newJudge` per call (`engine/scene-loop.ts`) | writer's | the situation, the question, the answer, the cast's limits | `accept` \| `retry` | `judge_failed` → answer accepted |
| **NARRATION-JUDGE** | `newNarrationJudge` (`engine/scene-loop.ts`) | writer's | the drafted piece, the granted ledger, any outgoing consult | `ok` true/false + why | `lint_failed` → judge fails open; mechanical blocking still applies |
| **BATCH-JUDGE** | `newBatchJudge` (`engine/scene-loop.ts`) | writer's | every volunteered deed in one call | one `promotable` flag each | `batch_judge_failed` → nothing promoted |
| **DONE-JUDGE** | `newDoneJudge` (`engine/scene-loop.ts`) | writer's | the scene's question, the whole page | `status` resolved/open/unclear (+ evidence, why) | `done_judge_failed` → `unavailable` recorded |
| **CAST-JUDGE** | `newCastAsymmetryJudge` (`engine/architect.ts`) | architect's | the tension, the cast sheet | `ok` true/false + why | gate passes |

Every one fails **open** — the same policy as every other model-in-the-loop check in this engine —
but each failure is recorded under its own event, so the run record distinguishes a model getting a
shape wrong from the connection dropping out from under a chapter mid-write. The judge, the
narration lint and the done judge ask a shapeless reply once more against `schema_mismatch` before
any default is taken; the batch judge and the cast judge do not retry — the batch judge tolerates a malformed
reply per reactor (an omitted reactor is simply not promotable), and the cast judge reads a reply
with no verdict as no verdict. A reply in the wrong shape is not a judgement and must not read as
one: only an explicit verdict is a verdict.

## JUDGE — the per-answer gate

When a consult comes back, one judge call decides whether the answer is usable. It is shown the
situation the character was given, the question asked of them, the answer itself (thought, speech,
action, note), any forced-answer flags, and whether the answerer is the point-of-view character —
the cast's limits ride along in the system prompt. It is **not** shown the scene's prose: it judges
the answer, not the page.

Most beats are open and carry no question, so the ask line says so in words rather than printing an
empty label; and the non-POV flag is bracketed, like the `[FLAGGED]` line beside it. Both are there
because the bare label used to leave the flag sitting in the question's own slot, where it read as
the question — see [`PLANS.md`](PLANS.md) for what that cost.

The verdict is one of two shapes:

- `{"verdict": "accept"}`
- `{"verdict": "retry", "note": "...", "revised": {"situation": "...", "question": "...", "wants": "..."}}`

**Retry only when the answer is unusable**: it engages nothing that is happening to them, they
plainly lacked something they needed in order to answer (then fix the situation), or they did
something they are not able to do. "It is not the fork I had in mind", "it is quieter than I
wanted", and "it goes somewhere I had not planned" are the scene telling the author something true
— never grounds. Nor is giving *more* than expected: a line, a deed and a thought at once is a
person being alive in the scene. A decision is carried by one clear side: "speech" or "action"
naming one branch settles it even when neither of the author's words appears in it.

### The retry's revision

A retry does not re-send the old ask. The judge must re-author all three `revised` fields, and they
pass through exactly the gate a first consult does — `reviseConsult` (`engine/consult.ts`), checked
as **directed**, since a revision is always a named fork:

- **The situation is the only one of the three that stands on its own.** The question never travels
  to the character at all — `askBlock` shows the situation, and the `wants` name only as the ask's
  one-word shape with its gloss — so a revision that sharpens the question and leaves the situation
  alone re-sends a fresh instance the byte-identical message the last one just answered: refused
  outright (`noNewSituation`), and the answer already in hand is kept. As an author-side string
  entering a character as ground truth, the situation passes the same CANNOT gate the first ask
  did.
- **The escalation is one-way.** An open beat carries no question; a judge retrying one may name
  the fork in words for the first time, with `wants` coming with it. Once named, `wants` is pinned:
  the judge may reframe a fork it asked badly, never turn one fork into another — a changed `wants`
  is recorded as `wantsRefused` rather than honored. Every revision is checked as directed
  whichever way it started, so an escalated ask can never decay back into an open beat.
- **The drift record.** Whether a rewritten *question* is still the same fork is not decidable in
  code — the model that could judge it is the one being checked — so each `retry` event carries
  `was`, the question it replaced. Reading that is the check.

A revision that cannot be sent keeps the answer in hand; spending the attempt on an ask the gate
has already refused would buy nothing.

### The split, as a prototype — `--split-judge`

Deciding the retry and authoring its revision are one completion, and they are not one skill.
`scripts/judge-diagnostic.ts` scored them apart: three of four measured models author a revision that
survives `reviseConsult` 87–100% of the time when the contradiction is handed to them, against 13%
when they have to find it and write it in the same breath. `--split-judge` runs the gate as two calls
on that evidence — a **JUDGE** call over `VERDICT_JUDGE_FORMAT`, which holds the same cast block and
the same decision ladder with the revision taken out of its job entirely, and a **REPAIR-JUDGE** call,
made only on a retry, which is given the verdict's own `note` as its reason and asked for the
situation and question alone (`REPAIR_ONLY_FORMAT`, shared with the diagnostic that motivated it).

Nothing downstream knows which path ran: whatever the second call returns lands where an inline
`revised` would and passes the identical `reviseConsult` gate. Everything that goes wrong returns no
revision, which is the unusable-revision path the gate already had — the answer in hand is kept and
the attempt is not spent — and says so under `repair_failed`, including the one case the split alone
can reach, a retry whose note named no contradiction for the second call to work from. The repair
call fails open like every other judge here; it never throws into the gate.

It is a **run-level CLI toggle, off by default** and never persisted to `story.json`, the same shape
`--open-consult` and `--free-consult` take. What it does not fix, and what the flag exists to measure:
the second call is conditioned on the first call's diagnosis, and the diagnostic's three findings
(`PLANS.md`) are that the diagnosis itself is wrong or unstable a meaningful fraction of the time.
Splitting isolates the load per call; it does not stop a wrong reason from reaching a repair stage
that is now better at acting on one.

### What the CANNOT says, as prototypes — `--cannot-meaning`, `--cannot-none`, `--cannot-testimony`

The judge's cast block renders a restriction as its bare canon name, `CANNOT: sight`, and renders a
character with no restrictions as nothing at all — the segment is dropped for an empty list. Both
are implicated in measured failures (`PLANS.md`): a bare token says nothing about what the absence
*leaves*, and the sight-into-hearing collapse is a model reading it as removing perception
generally; and an absence that renders as no tokens has nothing for the model to weigh, which is how
a `CANNOT: sight` got invented for a character whose `restrictions` is `[]` — a fact every measured
model states correctly, 20/20, when asked in isolation.

A restriction may therefore carry `:: what its absence leaves`, the way a skill carries `:: what it
does`. `splitMeaning` always parsed it and the resolver used to discard it; it now travels to the
prompt renderers on `CharacterDef.limitMeanings`, beside — never inside — the `limits` list. That
separation is structural, not conventional: `limits` is the matching key every CANNOT check reads and
the sense lints canon-key off, so the meaning reaches no matcher, and I2 stays literal. `sight ::
cannot perceive light` removes `sight`, never `light`. A restriction authored without a meaning
warns once per load (`restrictionMeanings`, never the per-scene `resolveReach` path) and is otherwise
unchanged.

Three arms switch independently, because they target different findings and a bundle cannot be
attributed to one of them:

- **`--cannot-meaning`** renders each restriction's authored meaning, in the same `name -- meaning`
  idiom `can:` and `REACH:` already use, in the cast block and in the character's own HARD LIMITS.
- **`--cannot-none`** gives an unrestricted character `CANNOT: (none)`. Author-side only: an absence
  that renders as nothing is what the judge failed to weigh, and a character has no measured reason
  to be told it has no limits.
- **`--cannot-testimony`** restates the answerer's own limits in the judge's payload, beside the
  answer rather than only in the system prompt ~700 words above it, and marks the answer as the
  character's own account rather than as established fact.

All three are **run-level CLI toggles, off by default** and never persisted to `story.json`, the
shape `--open-consult`, `--free-consult` and `--split-judge` take. With every arm off every prompt is
byte-identical to the pre-arm engine, including for a story that authors meanings — a test pins that,
because without it there is no baseline the arms can be measured against.

### `SceneDef.constraint` — the negative twin of reach

A restriction (`CharacterDef.restrictions`) is the total, source-independent kind: bound to the
character, true in every scene, never partial. A scene sometimes needs the other kind — bound to a
chair still permits a shrug, so `CANNOT: movement` would be the wrong statement even if `movement`
were still a general skill (it isn't — see `engine/skills.ts`'s catalog). `constraint` gives that
situational kind a home on the scene instead of forcing it onto the character: `{"MERRITT": ["hands
:: bound to the chair, cannot reach or handle anything"]}`, scene-scoped and I4-style like `reach`
and `presence` — never persisted at character level, absent from every character-level view.

Unlike a restriction, its name is not resolved against any catalog — the vocabulary a physical or
situational constraint needs can't be closed the way a sense can, so it is free prose end to end,
`"name :: meaning"`, and the meaning is the whole of it. It reaches three surfaces: the answering
character's own prompt (`CONSTRAINED HERE`, beside HARD LIMITS, so the character itself answers
consistently with it), the writer's cast block (`CONSTRAINED:`, beside `CANNOT:`, so the writer does
not write an action it forecloses), and the judge's payload (`CONSTRAINED HERE (this scene only)`,
restated beside the answer under the same `[WHAT IS ESTABLISHED ABOUT name]` /
`[WHAT name SAID -- their own account, not established fact]` framing `--cannot-testimony` uses).

Telling the character is the primary defence; the backstop is mechanical. `lint/constraint-lint.ts`
reads the answer's `action` against the constraint before the judge ever sees it, with no model call.
A high-confidence verb hit is **kept as a beat, not retried** — re-asking an unchanged situation
sends a fresh instance the identical message it just answered, which is the move `reviseConsult`
refuses on the judge path for the same reason. Instead the character is told the act did not land,
the writer is handed the attempt and its failure to write, and the granted ledger marks the deed
`attempted` so the narration lint permits narrating the attempt without letting it pass as done.

The matcher reads the sign, not just the verb: barred verbs come only from negated spans, because a
constraint's meaning routinely names what the character *can* still do ("bound to the chair, cannot
reach or handle anything; your head and shoulders can move"). Ambiguous prose permits and warns —
a miss is acceptable, a false refusal is not, since the answer is kept rather than discarded.
Whatever the matcher cannot assess stays the judge's call, the same call it already makes for a
restriction's meaning; measuring that call is `--cannot-testimony`'s job. The rendering is
unconditional rather than behind a flag: a scene with no `constraint` authored renders nothing on
any of the three surfaces, so this is safe as a default rather than a prototype.

### Template slots — the opposite call from the constraint gate

A model sometimes emits a literal template slot — "My name is [Name]." — where nothing in
prompts/ or the story contains one. The judge accepts it (it reads as an answer), it enters
the granted ledger verbatim, and the writer then does the right thing ("My name is Mara,"),
which the quote lint correctly flags: no faithful prose ever matches the granted slot. Every
link behaves correctly and the result is an unwinnable redraft, so the slot must never reach
the ledger. `engine/lint/placeholder-lint.ts` reads speech, action and thought against a
conservative pattern — a short bracketed run of letters, never a long or sentence-like aside —
beside the constraint check, with no model call, logging `placeholder_refused`.

This one retries, deliberately the reverse of the constraint call: a slot is a formatting
failure, not a choice, so a fresh fork at temperature 0.9 will very likely produce real words
from the same situation. It reuses the judge path's budget machinery exactly. When the budget
is spent the answer is discarded, not accepted — a placeholder in the ledger recreates the
unwinnable redraft — and the scene loop routes it into its no-answer path (`P.noAnswer`),
which already handles a character that produced nothing usable.

### Ceilings

Retries are bounded by one effective ceiling per character: the story's per-character `maxRetries`
when the character sets one, otherwise the story's chapter-wide `maxCharacterRetries` — counted
cumulatively per character across the scene. When the ceiling is reached, a `retry` verdict
force-accepts the last answer and logs `retry_capped`; when the per-consult attempt budget
(`retries`) runs out, the last answer is taken too. The judge warns; the scene never stalls on a
character the judge is dissatisfied with.

## NARRATION-JUDGE — the lint

Every drafted piece is checked once, before any of it reaches the page, by one lint call
(`narrationLintRequest`): the point of view, the piece itself, the ledger of everything granted
this scene (lines, deeds, and the felt reactions handed to the writer as interiority to render),
and — when the same reply opens one — the consult it is about to send. It checks, in order:

1. **THE ONE RULE** — did the prose invent a *new consequential choice* for someone not already
   granted it: an action that changes the scene, or a decision at a fork that would have needed a
   consult. Involuntary continuity of a body that is simply present — a breath, a flinch, weight
   shifting — is exempt; **staying still, saying nothing, waiting are choices**, and they need an
   answer behind them like any other.
2. **CANNOT** — is a character shown perceiving through a sense their CANNOT list removes; and in
   the other direction, is another character's inner life narrated as fact — a thought, knowledge,
   or certainty nobody gave the scene — when the one exception is interiority the scene was
   actually handed, a felt entry under ALREADY GRANTED.
3. **The consult's situation** — does it name the concrete fact the piece just established (what
   was taken, broken, said, done, and by whom), or only the fact's abstract consequence; and does
   it answer itself by naming the choice, laying out the options, or telling the character which
   part of the moment matters. Give the character the moment; let them find the fork in it.

It is told **not** to re-check quotations — they are matched against the ledger mechanically first
(`engine/lint/quote-lint.ts`), and restricted senses are matched by verb against the character's own
CANNOT list mechanically too (`engine/lint/sense-lint.ts`). The mechanical halves are deliberately
conservative, because a mechanical flag has no model to soften it. The quotation check skips a
quoted span of one bare word — read as a machine label, not a line: a lever thrown to the
`'Shutdown'` position, a status reading `"Fatal"`; missing an invented one-word line is the cheap
failure beside flagging a real one, which costs the scene its redraft. The sense check matches only
a verb its own subject governs by name and only verbs that cannot be read figuratively — `see` and
`saw` are absent from its table; `watch`, `observe`, `glance`, `gaze`, `stare` and `peer` are in
it, and `look` counts only with a directional particle (`look up` flags, bare `look` does not) —
and it is addressee-anchored when it reads a consult's situation, which inverts how the same
spellings read: `you watch` and `your gaze` are the incriminating forms there, where in prose
`your` before a verb spelling marks a noun.
An unmatched quote explicitly attributed to a character this same reply consults is the writer
answering its own question — the line was written before it was chosen, so no grant could cover
it yet. That hit carries its own why and its own event, and the redraft prompt names the repair
instead of the rule: cut the line, keep the consult, write the answer when it arrives next turn.
Only an explicit speech tag carries the accusation; a nearest-name guess still gets today's
plain hit.
The **repair** reaches further than that accusation does, because the commoner shape is a line
invented for someone the reply is not asking — the writer opening a scene in a character's mouth
before anyone has been consulted. So the redraft prompt routes on attribution rather than on the
self-answer flag: a blocking quote hit pinned to a named character gets the repair naming that
character — cut the line, and ask them if their words are what the scene needs next — where only
a self-answer keeps the "keep the consult" clause, since only then is the invented speaker the
one being asked. A quote nobody could be pinned to falls back to the general instruction, and so
does a line **granted to a different character**: that is a distinct sin with a distinct repair
(give it back, or cut it), and telling the writer those words were never granted would be false.
Measured over two runs of one story, the general instruction reworded the frame and kept the
invented line every time; naming the speaker cut it every time.
The three checks run **alongside** each other and their `why` strings join into the one
`narration_flag`, because there is only one automatic redraft: reported serially, the budget would be spent
on the first finding and the second accepted unfixed. A mechanical hit also survives an LLM outage,
since it needed no model to begin with.

The verdict is `{"ok": true}` or `{"ok": false, "why": "..."}` — and only an explicit one counts
(`parseLintVerdict`): a reply carrying neither is asked once more against `LINT_ONLY`, and a second
miss fails the judge open with `schema_mismatch` on the record; mechanical blocking still applies.
A check nobody made must not
read as a check that passed.

**One automatic redraft; persistent mechanical blocking needs a human decision.** Both mechanical
and judge findings feed the same first redraft from the same `[WRITE]` instruction — nothing has
reached `pieces[]`, the writer's history, or the writing log, so it is a clean redo, not an undo.
If mechanical blocking remains afterwards, the unpublished prose and separate blocking/advisory
findings are shown to the operator. A failed redraft with mechanical blocking still outstanding also
opens this decision; failure is not permission to publish the original flagged piece.

The choices are **Redraft again**, **Publish anyway**, and **Stop chapter**. Redraft again requests
another attempt and checks it before committing; Publish anyway explicitly accepts the current
flagged draft; Stop chapter discards the pending draft and preserves the already committed page.
When a redraft comes back with the same quote flagged, the advisory carries that redrafting has
not changed it and the granted line itself may be unrenderable — another redraft cannot fix what
the grant made unwritable, so the operator decides knowingly. When the repeated line was never
granted to anyone there is no unrenderable grant behind it: the advisory says instead that the
prose holds words no character chose, and publishing puts them on the page. If nobody can be asked (no viewer and no TTY, or interactive mode is off), stop the chapter with
that committed page intact. Turning interactive off during a pending decision resolves it as stop.

Whichever is chosen is written to the run's log as `lint_decision`, because nothing else records it:
the answer is a human's, not a model's, so no transcript holds it. `scripts/make-replay-fixture.mjs`
carries those answers into the fixture as `lintDecisions`, in order — without them a replay of a run
that published or redrafted past a blocking finding stops at that piece, since a replay is headless
and headless means nobody to ask.

**Judge-only findings remain advisory:** after the one automatic redraft, a repeated judge-only
finding or redraft failure retains the previous accept-with-warning behaviour. An unavailable judge
still fails open, but cannot erase mechanical blocking. THE ONE RULE itself is enforced by the
consult protocol, which decides whether a line exists to be written at all. The HTTP/SSE decision
contract and reconnect behaviour are in [`GUI-SPEC.md`](GUI-SPEC.md).

Two evidence rules keep it from flagging exactly what the engine asked for: a deed the same reply
promotes is already on the ledger when the lint runs (the promote itself is processed just after
the piece survives), and a thought the writer was handed to render — the point-of-view character's
in a single consult, a POV reactor's in a fan-out — lands as a felt entry. A thought withheld from
the writer grants nothing, because the writer was never handed it to render.

## BATCH-JUDGE — volunteered deeds

When a reaction fan-out comes back, some reactors will have volunteered an action alongside their
thought. One batch call weighs all of them at once (`batchJudgeRequest`) and answers one question
per reactor: could this person actually do that, here and now — within what they can do, never
through a CANNOT, and fitting the moment. When in doubt, leave it unpromoted: an impulse that
stays unspoken costs the scene nothing.

A thought is never judged — it always satisfies the reaction floor — so **no volunteered deed means
no judge call at all**. `parseBatchVerdict` reads a reactor the judge omitted, or a malformed
reply, as *not promotable*: a deed lapses safely rather than reaching the page unchecked. The
writer still promotes at most one of those offered (`promote`), and the promote's consequences are
[`Writer.MD`](Writer.MD)'s to describe; the batch judge only decides which deeds are even offered.

## DONE-JUDGE — the ending gate

`scene_done` is the writer's own report that the scene is finished, and it was the only witness to
it. A standoff is the cheapest way out of a hard scene: two live runs closed `done: true` with the
very thing the scene existed to settle still open on the last line — one of them at 14 steps of a
24-step budget, both sides exactly where they had started. The writer is not lying; a deadlock reads
like an ending from inside the last piece.

So one call reads the page back against the scene's question and records whether it is settled. It
is the only judge shown the prose whole — the narration lint sees one piece, the per-answer judge
sees no prose at all — and the only one shown the scene's question, which is otherwise the writer's
alone.

**Settled, not resolved-for-good.** "No" is settled: a refusal that holds, a door that stays shut, a
choice made against the thing. What fails is *open* — both sides where they started, the pressure
still live, the question's fork still pending on the last line. A third shape, `unclear`, is the
judge's own "I cannot tell" — distinct from a reply that fails to parse at all (`schema_mismatch`,
retried once) and from the call itself erroring (`done_judge_failed`); all three land on the same
`unavailable` state, because a check nobody could complete must never read as either verdict.
`resolved` must carry `evidence` — the page event that settled it — or the reply is treated as
unparseable; a positive verdict with nothing to show for it is not one. The judge is told to weigh
nothing else: not whether the writing is good, not whether the ending satisfies, not whether the
scene could have gone somewhere better. A scene ending badly is the story; a scene ending nowhere is
the writer escaping.

**It records; it does not gate.** An `open` (or `unclear`) verdict logs `done_flagged`/nothing and
the ending stands regardless — the writer is told nothing. The three-shape verdict is folded into one
durable `QuestionState` (`engine/scene-loop.ts`), carried on the run result and logged as its own
`question_state` event (`state`, `trigger`, `step`, `words`) alongside whichever of `done_flagged` /
`done_confirmed` a writer-declared ending still logs for `buildChapterBeatOutcome`'s sake
(`run-and-save.ts`) — a viewer or a later chapter's handoff reads the durable state, not the raw
per-call events.

That is a demotion, and the reason is worth keeping. It gated once: a refusal cleared the
declaration and handed the writer back what the page had left open. In the one live run where it
fired, the writer answered by writing four more steps of the identical deadlock, never declared done
again, and ran out its step budget — `done: false` with an answer still owed, where the same story
had closed `done: true` without the gate. The refusal was a nudge nobody could satisfy: a deadlock
breaks when somebody chooses differently, and that is never the writer's to write, so the message
named a lever the writer does not hold. Re-arm it as a gate when a refusal can arrive with one — a
world event that forces the matter is the obvious candidate.

What it is now is the only measurement the engine has of whether a scene answered its question, at
up to one call per place a scene's ending is decided: the writer's own `scene_done` declaration,
every time the step budget runs out (before the engine even asks whether more will be granted — a
silently-declined extension is exactly where an unchecked ending was found live, PLANS.md item 2),
and the hard cap. None of the latter two is the writer's own judgement — a spent budget is budget,
not judgement — so neither ever logs `done_flagged`/`done_confirmed`; only `question_state` records
them, tagged `extension` or `forced_end` rather than `writer_done`. Nor does it run on the turn that
arms a `done_deferred` hold — that turn is not ending the scene, it is buying one more, and the
held-open turn after it is checked like any other ending. A scene whose `question` is empty, or with
no prose on the page yet, is never checked at all: there is nothing to read the page against.

## CAST-JUDGE — the cast gate

The one judge on the architect's side. During a staged scaffold's cast gate, a fresh call reads the
cast sheet against the story's load-bearing tension and answers one question: does this cast's
asymmetry bite on the tension — is there at least one character whose restriction changes what they
can know or do about the very thing the tension turns on? A cast where nobody is restricted fails;
so does one whose restrictions sit only on people the tension does not run through. It judges the
tension as written and is told not to invent a scene that would make a restriction matter.

It is deliberately **not** the architect's own voice: the architect wrote the cast, and a pass
that audits its own draft is the failure mode the gate exists to catch — the verify pass returned
no edits on four consecutive live runs before this judge took the job. It sees the tension and the
cast sheet (names, goals, skills, restrictions — no reach, because no scene exists yet, and reach
never leaks into a character-level representation), nothing else.

A `false` verdict comes back as a `blocked` round — distinct from `nothing`, because the stage did
land — and the author may overrule it with an explicit second approval. It fails open: an outage
or a reply carrying no verdict passes the gate, because an outage must not strand an author
mid-checklist. The gate's place in the checklist and the override's UI behaviour are
[`Architect.MD`](Architect.MD)'s.

## Known weak spots

Unbuilt improvements and observed failure modes are tracked in [`PLANS.md`](PLANS.md): the judge's
escalation path is the one place the question gates still fire, and whether its re-asks still pass
them is unmeasured; the quotation flag's `why` string overstates what the mechanical check does; a
further judge variant — whether a scene honoured both characters' choices at a shared fork — is
parked as runtime cost nobody has wanted yet.
