# Judge

**Status: built.** "Judge" names a family of four author-side agents, not one role: each is a
single-purpose model call that guards one door the writer's own judgement cannot be trusted to
guard alone. This document owns all of them — their shared contract, one section per variant, and
the failure behaviour each fails with. The writer's side of the consult protocol is in
[`Writer.MD`](Writer.MD); the cast gate's session behaviour is in [`Architect.MD`](Architect.MD).

## The family

All four share one contract, and it is what makes them judges rather than helpers:

- **Stateless.** No history, ever — each is built fresh per call and given everything it needs in
  the payload. A verdict needs no memory, and consistency beats invention.
- **Temperature `0.3`** (`JUDGE_TEMPERATURE`, defined once per chain in `engine/scene-loop.ts` and
  `engine/architect.ts`). The three scene-loop judges take the writer's think level; the cast judge
  takes the architect's.
- **One response schema each.** Nothing else in the engine holds exactly one shape.
- **The shared cast block** (`castBlock`, `prompts/internal.ts`) — each character's delta from the
  human baseline (`can:`, `REACH:`, `CANNOT:`; see [`Writer.MD`](Writer.MD)) — plus a closing
  absolute: *a CANNOT is absolute; anything that reaches through one is unusable however good it
  reads.* The three scene-loop judges share it. The cast judge does not: no scene exists yet, so
  there are no per-scene capabilities to show, and it reads the authoring-time cast sheet (goals,
  skills, restrictions) instead.

They exist as separate agents because they were once sections of the writer's system prompt,
answered on the writer's own history. With some twenty messages of `[WRITE]` → `{"prose": …}`
behind it, the dominant pattern won often enough to matter: in one two-chapter run, six of thirty
judgements came back as prose and were silently accepted, and a clarification came back as a
verdict, costing a character its answer. Each job holds exactly one schema now, so there is no
second shape to fall into (`prompts/judge.ts`'s header keeps the record).

| agent | built by | model | shown | verdict | call fails |
| --- | --- | --- | --- | --- | --- |
| **JUDGE** | `newJudge` per call (`engine/scene-loop.ts:215`) | writer's | the situation, the question, the answer, the cast's limits | `accept` \| `retry` | `judge_failed` → answer accepted |
| **NARRATION-JUDGE** | `newNarrationJudge` (`engine/scene-loop.ts:229`) | writer's | the drafted piece, the granted ledger, any outgoing consult | `ok` true/false + why | `lint_failed` → piece goes to the page |
| **BATCH-JUDGE** | `newBatchJudge` (`engine/scene-loop.ts:222`) | writer's | every volunteered deed in one call | one `promotable` flag each | `batch_judge_failed` → nothing promoted |
| **CAST-JUDGE** | `newCastAsymmetryJudge` (`engine/architect.ts:52`) | architect's | the tension, the cast sheet | `ok` true/false + why | gate passes |

Every one fails **open** — the same policy as every other model-in-the-loop check in this engine —
but each failure is recorded under its own event, so the run record distinguishes a model getting a
shape wrong from the connection dropping out from under a chapter mid-write. The judge and the
narration lint ask a shapeless reply once more against `schema_mismatch` before any default is
taken; the batch judge and the cast judge do not retry — the batch judge tolerates a malformed
reply per reactor (an omitted reactor is simply not promotable), and the cast judge reads a reply
with no verdict as no verdict. A reply in the wrong shape is not a judgement and must not read as
one: only an explicit verdict is a verdict.

## JUDGE — the per-answer gate

When a consult comes back, one judge call decides whether the answer is usable. It is shown the
situation the character was given, the question asked of them, what the author needed from the
answer (`wants`), the answer itself (thought, speech, action, note), any forced-answer flags, and
whether the answerer is the point-of-view character — the cast's limits ride along in the system
prompt. It is **not** shown the scene's prose: it judges the answer, not the page.

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
(`engine/quote-lint.ts`), and restricted senses are matched by verb against the character's own
CANNOT list mechanically too (`engine/sense-lint.ts`). The mechanical halves are deliberately
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
The three checks run **alongside** each other and their `why` strings join into the one
`narration_flag`, because there is only one redraft: reported serially, the budget would be spent
on the first finding and the second accepted unfixed. A mechanical hit also survives an LLM outage,
since it needed no model to begin with.

The verdict is `{"ok": true}` or `{"ok": false, "why": "..."}` — and only an explicit one counts
(`parseLintVerdict`): a reply carrying neither is asked once more against `LINT_ONLY`, and a second
miss sends the piece to the page with `schema_mismatch` on the record. A check nobody made must not
read as a check that passed.

**The lint warns; it never blocks.** One redraft from the same `[WRITE]` instruction — nothing has
reached `pieces[]`, the writer's history, or the writing log, so it is a clean redo, not an
undo — and a retry that is flagged again, or fails outright, is accepted anyway and logged with the
flag's `retried` set. THE ONE RULE itself is enforced by the consult protocol, which decides
whether a line exists to be written at all; the lint is advisory quality control that reports its
own gaps.

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
