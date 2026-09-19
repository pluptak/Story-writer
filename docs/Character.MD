# Character

**Status: built.** The character agent is the other seat of the engine's central asymmetry: the
writer drafts prose and opens consults; the character decides what its own moment holds. This
document owns the character agent — what it is built from, what it is and is not shown, and the
consult conversation from its side. The writer's side of the same protocol is in
[`Writer.MD`](Writer.MD); the wire and event contract is in [`GUI-SPEC.md`](GUI-SPEC.md); authoring
the definition each agent is built from is in [`Architect.MD`](Architect.MD).

## Role

One character agent per entry in `story.json`'s `characters[]` that the chapter's roster names. It
is the same generic `Agent` class as every other agent in the engine, differing only by system
prompt, model, temperature and thinking level:

- **system prompt** — `characterSystem` (`prompts/consult.ts`), composed by `wrapCharacter`
  (`engine/scene-loop.ts`) from the character's definition plus the scene's place and this scene's
  resolved reach.
- **model** — the character's own `def.model`. Characters are the only agents a story can put on
  different models per person.
- **temperature** — `0.9`.
- **thinking** — the story's `thinking.character` level.

Agents are built fresh for each chapter in `runChapter` (`engine/scene-loop.ts`), keyed by
lowercased name in the agents map. No history crosses chapters — the story file is the only
continuity mechanism, which is the handoff's job to maintain
([`Architect.MD`](Architect.MD)'s operating principle).

### What it holds

The system prompt is `CHARACTER_FORMAT` followed by the persona and the definition's fields, each
rendered as a labelled block (`prompts/consult.ts`):

- `persona` — the character itself, verbatim.
- **WHERE YOU ARE** — the scene's `place`, plus the presence note when the scene sets one
  (below).
- **YOUR SKILLS (all of what you can do; nothing else)** — the resolved skill menu: the general
  skills their `origin` starts them with (all of them when they name no origin), the character's
  own, and — in a `REACH` sub-heading when the scene grants any — what it has
  *only through where it is standing right now; it leaves with this place*. Reach sits inside the
  same fenced block so the "nothing else" stays one sentence, under a heading that names it as
  situational, because the fence the menu exists to build would be broken by a grant that read as
  intrinsic (invariants I1/I4 in [`Architect.MD`](Architect.MD)).
- **WHAT YOU KNOW COMING INTO THIS** — `knows`.
- **WHAT YOU WANT TONIGHT** — `goal`.
- **WHAT YOU BELIEVE** — `belief`, authored to be possibly false and load-bearing.
- **WHEN PRESSURED, YOU** — `impulse`.
- **HOW YOU SPEAK (your own past words)** — the `voice` samples.

`CHARACTER_FORMAT`'s own knowledge paragraph is the boundary in the character's words: what it
knows is its persona, its skills, what it knew coming in, the situation as the author describes it,
and what it has already said in this conversation — nothing else. Mid-scene system implants add
world events and surfaced knowledge through the engine-owned channel below. It is told not to invent facts
about the world but to ask for them; its own body, memory and feelings are its to invent freely.

### What can arrive mid-scene

A **world event**, verbatim. When a world beat fires, the engine appends its authored `fired`
text to each eligible character's system prompt under **[WHAT HAS HAPPENED]**, before the writer's
next turn. This is circumstance, not the writer's paraphrase or an instruction about what to infer,
feel, say, or do. It arrives even when the beat carries no memory for that character. The writer
still receives the same event in its instruction for drafting circumstance.

Event and memory delivery share one gate: the character must be rostered, still active, and have
an agent; a `"scene"`-scoped beat skips anyone `"remote"`. A `"world"`-scoped beat reaches remote
characters too, and `"partial"` does not block delivery. The system implant survives history
trimming and is copied by `fork()`. Each delivery logs `world_event_surfaced` with the character,
verbatim beat text, and chapter in `writing-log.jsonl`.

A **memory**. A world beat that fires may carry per-character knowledge — what that character always
knew and had no reason to think about until the event happened. The memory is appended to the system
prompt (**WHAT YOU ALSO KNOW, NOW THAT IT BEARS ON THE MOMENT**), never to history: history is
trimmed into a rolling digest, and a memory summarized away mid-scene is a bug. One history marker
records the moment (`[YOU REMEMBER] …`) — trimmable like any other message, and the character is
told not to narrate the remembering. A `"scene"`-scoped beat's memory does not implant for a
character marked `"remote"` in that scene. `fork()` copies the system prompt, so a retried instance keeps
the memory without learning it was a retry. The run log records that a memory surfaced and to whom;
its wording reaches nobody but the character it belongs to.

### Heard speech (opt-in)

`--heard-channel` enables an engine-owned **[WHAT YOU HEARD]** block beside the writer's
circumstance-only situation. It is off by default. Only granted speech from other active,
rostered, non-remote speakers is included, in ledger order, as `NAME: "words"` lines with
JSON string escaping. Thoughts, actions, notes, and the listener's own speech never travel here.
A listener whose CANNOT canonically removes hearing receives no block. Remote listeners and
speakers are excluded even with an authored `via`; partial presence adds no restriction.

The first ask reads from the start of the granted ledger. Each sent ask advances that listener's
`sinceBase` to the ledger cursor (not the prose-piece count used by the legacy `--consult-since`
mode). Empty-prose turns therefore do not lose speech. Refused asks do not advance it. Retries
keep the same snapshot, and the accepted history fold retains the block. Fan-out snapshots are
all taken before any reactor answers; their cursors advance to that shared boundary, so no
same-beat answer leaks into another reactor's ask, and those words remain available next turn.

With this flag enabled, writer-authored `since` is neither joined nor required; its legacy record
field remains parseable. With the flag off, the old `--consult-since` behavior is unchanged.
No new model call is needed. Speech is what was said, not proof that its content is true.

### Presence

Presence is where someone is while one scene is being written — `SceneDef.presence`, an object of
`{"NAME": "mode :: via"}` entries. It is scene-scoped like reach and never persisted at character
level (invariant I4): it never merges into a character, and no character-level surface (preflight
cards, the story editor, the handoff) ever shows it — `/cast` carries it per scene, labelled with
its scene, the way it carries reach. Keys match case-insensitively like roster and reach, and an
unrecognised mode warns and is treated as here. Absence means "here", so every scene written
before presence existed is unchanged.

Two modes ship. `remote` needs its `via` — the connection that still reaches them, e.g. `remote ::
the phone line` — and renders onto the WHERE YOU ARE line above (`characterSystem`,
`prompts/consult.ts`): *you are not physically there, connected only by …*. `partial` carries an
optional `via`, is parsed and rendered the same way (*your presence here is only partial …*), but
deliberately gates nothing.

Besides the opt-in heard channel above, presence affects the WHERE YOU ARE line and world-beat event and memory
implantation: a `"scene"`-scoped beat's event and memories are skipped for a `remote` character
(`engine/scene-loop.ts`); a `"world"`-scoped beat implants regardless of presence. `partial`
having no consumer is deliberate: it must not become a silent "can perceive whatever is
narratively convenient".

### Constraint

`SceneDef.constraint` is reach's negative twin and presence's sibling: scene-scoped, I4-style,
`{"NAME": ["name :: meaning"]}`, absent from every character-level view. It exists for the kind of
restriction `CharacterDef.restrictions` cannot honestly model — bound to a chair still permits a
shrug, so it is never total the way a restriction is, and it belongs to the scene that imposes it,
not the character. Unlike a restriction its name is not resolved against any catalog: the vocabulary
a physical or situational hold needs cannot be closed the way a sense can, so it is free prose end to
end and the meaning is the whole of it.

It renders as its own block, **CONSTRAINED HERE**, beside HARD LIMITS — absolute for this scene, but
explicitly not a standing HARD LIMIT, so the character does not confuse a temporary hold with an
intrinsic one. Telling the character is the primary defence; the backstop is mechanical
(`engine/constraint-lint.ts`, `Judge.MD`'s `SceneDef.constraint` section): the answer's `action`
is read against the constraint before the judge ever sees it, and a high-confidence verb hit is
kept as a beat, not retried — re-asking an unchanged situation buys the same answer twice. The
character is told the act did not land, the writer is handed the attempt and its failure to
write, and the granted ledger marks the deed attempted so the lint permits narrating it without
letting it pass as done. Ambiguous prose still permits — a miss is acceptable, a false refusal
is not — and whatever the matcher cannot assess stays the judge's call, the same way it checks
a restriction's meaning.

### The room as they know it

Every consult carries `[THE ROOM AS YOU KNOW IT]` beside the situation: the live stage
filtered to what this character can perceive (`observe()`, `engine/stage.ts`), so the room
stops being reconstructed from prose. It is additional context, never a replacement — the
writer still says what is happening; the stage says what is there. What is filtered out is
what perception already governs: a `remote` character is not in the room and receives no
positions, and a character who cannot see receives only where they themselves are. Reach
never narrows the list — a grant extends perception, and anything a restriction removes is
already stripped before the projection is built. The projection is derived from the stage
alone, never from anyone's prose: no premise, no draft, no other character's replies reach
it through this channel.

### The target

Beside `action`, the answer may carry one optional sibling: `target`, the name of the one thing
in the room the act is aimed at, exactly as the room names it — a name, never an index, and
normally empty: a small model taught to fill it will fill it with furniture. The repair prompts
deliberately never ask for one — a repair that asked for a target would teach the model to invent
one — and a target on its own is not an answer: naming a thing is not doing something, so a
reply carrying nothing else stalls exactly as a thought-alone reply does.

Before anything folds in, the name resolves against the live stage (`resolveTarget`,
`engine/stage.ts`): a match — however the character spelled it — lands as the stage's own
spelling, so one thing reads as one name across turns, and an unmatched name permits unchanged:
naming is not placing, so nothing is added to the room and nothing warns.

Exactly one thing is refused: a character whose presence is `remote` naming a staged entity. A
channel carries words, never hands. The refusal is a beat, not an error — the answer is kept, no
retry is spent, the character is told the reach did not land (`[IT DID NOT LAND]`, the same tag
the constraint hold uses), and the writer is handed the reach and its failure to write. A
character naming an unstaged thing — remote or not — permits: the engine refuses only what
someone authored as impossible.

### Full control is circumstance, not obedience — the interrogation pattern

One character having full control over another (an interrogation, a captivity, a custody interview)
is authored as **circumstance the controller owns plus a choice the controlled still owns**. The
engine has no dominance or coercion field, and nothing about this pattern needs one:

- **Physical control is `constraint`, on the scene, on the controlled.** Name what the hold takes
  away, in `name :: meaning` prose, and keep it partial: bound hands still permit a shrug, a gag
  still permits a stare. Example:

  ```json
  "constraint": { "PRISONER": ["bound :: tied to the chair, cannot reach, handle, or leave",
                               "watched :: two guards in the room, every movement seen"] }
  ```

  Do not model this as `restrictions` (total, source-independent, travels between scenes), as
  `reach` on the interrogator (a grant is access, never power over someone else), or as `presence`
  (a prisoner in the room is `here`; `remote`/`partial` is for where someone stands, not who
  commands them).

- **Narrative control stays with the prisoner.** `goal`, `belief`, and especially `impulse`
  (`WHEN PRESSURED, YOU`) decide whether pressure produces confession, silence, lying, stalling,
  or bargaining — refusal and stillness are complete answers (`WHAT YOU WANT IS THE POINT`). Author
  at least one `voice` sample showing this character refusing, so defiance is an established register
  rather than a first-time invention under pressure. A goal satisfied only through the other's
  compliance ("make him confess") has no agency; give the interrogator a goal they can act toward
  themselves ("get a usable name before the shift changes") and let the prisoner's goal obstruct it.

- **The writer carries pressure as perceivable situation, one blind consult at a time.** The
  interrogator is consulted for what they say and do; the prisoner is consulted for what they can
  perceive of it — where they are, what just happened, what hangs on the choice now — without naming
  the fork, laying out options, or leaking one answer into the other's situation (the second one
  asked blind; [`Writer.MD`](Writer.MD)'s principle of operation). Escalation across turns is new
  perceivable facts (the door locked, the offer put on the table), never a directive about what the
  prisoner should do.

- **What the gates do with it.** The judge accepts defiance as usable; only an answer reaching
  through the authored `constraint` (untying, leaving, handling what bound hands cannot) or a
  `CANNOT` is retryable on those grounds. The narration lint refuses prose that writes the prisoner's
  choice before asking (THE ONE RULE) or phrases the situation around what a `CANNOT` removes. If the
  next chapter still holds them the same way, re-author the same `constraint` there; if the hold is
  gone for good, author nothing — a capability lost for good is `restrictions`, per
  [`Architect.MD`](Architect.MD)'s operating principle.

### What it is never shown

- The premise, the story-level `facts`, the writer's prose, or any other character's full private
  answer. The opt-in heard channel carries only eligible granted speech, not private thought or notes.
- On an **open** beat — the writer's own ask — the question itself. The situation is the whole of
  what it is sent; `THE_MOMENT_IS_YOURS` stands where the question would (`prompts/consult.ts`).
  The author still writes a question — it gates the consult and travels with the answer on the
  record — the character just never reads it. The wager is that a persona with a goal does not need
  to be pointed at the fork in its own situation, and that being pointed was costing more than it
  bought: a question names one fork out of the several a moment holds, and a character answering
  the named one is answering the author's reading of the scene rather than its own.
- `wants` appears only when a fork has been named in words — the judge's escalation — and arrives
  with its gloss, from the same `WANTS_MENU` the writer and judge read, so the sides never learn
  different meanings for the same word. When the named shape is `reaction` and the scene is not
  written from inside that character, the gloss is `REACTION_OUTWARD` instead of the menu's: what
  it lands on you as, surfacing where the room could catch it — a word, a movement, a change in how
  you hold yourself. It is never told why its interiority does not travel: a character told its
  thoughts go unread stops answering as itself.

## The two reply shapes

Every reply is one JSON object, one of two shapes:

- `{"need": "..."}` — a fact of its situation it was not given. One question, the smallest that
  unblocks, about a fact it would need to see, hear, or already know. Asking is the honest first
  move when the situation as given genuinely leaves it guessing — not a fallback, and not a way to
  ask what to do: what it should do is the answer being asked for.
- `{"thought", "speech", "action", "note"}` — the answer. `thought` is what actually goes through
  its head, two sentences at most and under 20 words, the immediate thing rather than a survey of
  options; `speech` is the words itself, no quotation marks; `action` is one or two plain sentences
  of what it physically does; `note` is normally empty and exists for out-of-character traffic — an
  assumption it had to make, or something it would need and does not have.

Two rules in the format do the heavy lifting. **WHAT YOU WANT IS THE POINT** makes the goal the
measure of every answer: refusal, stalling, lying, bargaining and setting conditions are all
complete answers, because a character pursuing its goal does not keep things pleasant. **STAY
INSIDE YOUR SKILLS** makes the menu a fence: what would take a skill not on the list cannot be
done, and the character does something it can instead, saying why in `note`.

## The consult conversation

`consult()` (`engine/consult.ts`) runs one consult against the character agent. It is a loop, and
the character can steer it:

- The outgoing message is `askBlock`: `[THE AUTHOR ASKS]` with the situation, the wants gloss when
  one exists, `THE_MOMENT_IS_YOURS`, and the ask-instead-of-answer reminder. From the third attempt
  a firmer line is appended (below).
- A `need` is answered by the author side — the clarifier — and the answer arrives as
  `[THE AUTHOR ANSWERS]`, so the second thing the character says knows the first. The asks and
  answers accumulate inside the consult, and ride along on the fold when the accepted answer
  finally enters the character's persistent history (`clarificationTrail`) — the conversation
  itself happens outside history, which is what keeps a rejected attempt rewindable.
- A `need` once the author has stopped answering is met with `AUTHOR_DONE_ANSWERING`: no more
  detail is coming, take the most likely reading, say which reading you took in `note`. This is a
  decision, not a nudge — it outranks the ask-instead rule.
- Asking again after that gets `ANSWER_NOW`, once. A further ask ends the consult as a stalled
  reply: an empty answer whose `note` records the question it kept asking.
- An answer with nothing in it — no thought, no speech, no action — or one short of the shape asked
  for, gets one repair (`EMPTY_REPLY` or `shapeCheck`), phrased as craft — the same one-repair
  budget the ask ladder above draws on. Then whatever came back is the reply.

The attempt-3 nudge (`RETRY_NUDGE_FIRM`) presses the answer-or-ask bar harder without ever claiming
the author is out of detail — that claim stays with `AUTHOR_DONE_ANSWERING`, where it belongs. It
is transient by design: the character's persistent history records the *un-escalated* ask
(`engine/scene-loop.ts`'s accept fold), because pressure that exists to shake loose one answer
would bend every later reply if written into memory. The escalation rides the transient message
only.

The rest of `askBlock` is transient for the same reason. What a live ask carries — `THE_MOMENT_IS_YOURS`,
the ask-for-a-fact reminder, the gloss on the wanted shape — are instructions for answering *now*,
not a record of what happened, so the fold writes `foldedAsk`: the situation, and the shape that was
wanted. Nothing else. Two things follow. The character does not re-read the same imperative once per
consult for the rest of the scene, which is the same argument the nudge already won; and a
character's history stops carrying a byte-identical paragraph per turn — about half of it by
mid-scene, measured on the doorway fixture. The turn actually being answered is unaffected: the live
ask still goes out in full.

## History, forks, and retries

The agent is persistent for the scene: every consult appends to the same instance, and what it said
before is what it remembers — thought included. An accepted consult folds in the ask (`foldedAsk`,
above) with the clarification trail on the character's side and the answer on the assistant's side,
so its memory of the conversation is exactly what happened in it. The answer is folded as the shapes
it actually gave: an empty `speech` or `action` is dropped rather than stored as `""`, the way a
fan-out's fold has always done it.

A **retry** re-asks through `agent.fork()`: a new instance carrying a copy of the persistent one's
accepted history and rolling digest — every interaction the scene has already accepted, and nothing
of the attempt being retried, because `consult()` never writes to `agent.history`; only an accepted
answer is folded in by the caller (`engine/agent.ts`). It never learns a previous answer was
rejected; it also no longer forgets a promise it made two consults ago, because the copy carries
them. An answer has to be re-asked against a changed situation to be re-asked at all
(`reviseConsult` refuses an unchanged one), because a fresh instance asked the same thing answers
it the same way.

The **point-of-view rule** runs from this seat too: a thought always enters the character's own
history — it is their memory and continuity depends on it — but the writer receives it only from
the point-of-view character. The character is never told any of this, including that its thought
may be withheld: one writing for an audience is not answering as itself. The writer-side
consequences are in [`Writer.MD`](Writer.MD).

## Reaction fan-outs

When a beat lands on several people at once, each reactor runs an isolated consult through the same
open door the writer's own ask uses: one shared situation any reactor may override (someone who
only *heard* it), no question, and no `wants` at all — what the moment lands on them as is what a
shared moment asks for without being told to. No reactor ever sees another's reply.

A reactor may volunteer an action. It stays out of the reactor's own history until promoted, so an
un-taken impulse never contradicts the page; when the writer does promote it, the character is
told `[YOU ACTED]` (`AUTHOR_TOOK_YOUR_ACTION`) and carries on from there. Page and memory never
disagree: what the character remembers is its thought, its speech, and its deed only once the
author confirmed it.

## Bounds

The situation is the only channel into a character, which is why every situation-entry path — the
writer's first ask, a fan-out's shared text, a judge's `revised` — passes the same gate
(`normalizeConsult`): a situation phrased around a sense its addressee has lost is refused, because
ground truth a character cannot have is exactly what a situation must not be. The same gate reads
presence: a `remote` addressee is refused a situation phrased around a sense their position rules
out (`cause: "presence"` rather than the CANNOT wording), and a `remote` reactor in a fan-out is
refused the shared room-perspective situation unless the writer gives them their own override.
When the ask carries a **[WHAT YOU HEARD]** block, the same gate also refuses a situation that
retells what that block already holds verbatim: a reporting construction ("she answered that",
"Rowan has just asked about", "you asked about") whose subject is another cast member — by name,
or by a subject pronoun exactly one of them declares — or the addressee. The bare fact that
someone spoke is circumstance and passes; what they said is the block's job. The check runs only
where a block exists, so an opening consult stays free to set the scene, and a fan-out's blocks
attach after the shared gate, so each reactor's own is checked at that attachment point instead. One character's
answer never becomes part of another's situation: the second one asked blind, and a fan-out's
shared text may only hold facts that predate every answer in the beat. When a consult is refused,
the character is never sent anything — the refusal is a message to the writer, and the character
does not learn it almost had a question.
