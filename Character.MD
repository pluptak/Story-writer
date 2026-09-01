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

Agents are built fresh for each chapter in `runChapter` (`engine/scene-loop.ts:931`), keyed by
lowercased name in the agents map. No history crosses chapters — the story file is the only
continuity mechanism, which is the handoff's job to maintain
([`Architect.MD`](Architect.MD)'s operating principle).

### What it holds

The system prompt is `CHARACTER_FORMAT` followed by the persona and the definition's fields, each
rendered as a labelled block (`prompts/consult.ts`):

- `persona` — the character itself, verbatim.
- **WHERE YOU ARE** — the scene's `place`.
- **YOUR SKILLS (all of what you can do; nothing else)** — the resolved skill menu: general skills,
  the character's own, and — in a `REACH` sub-heading when the scene grants any — what it has
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
and what it has already said in this conversation — nothing else. It is told not to invent facts
about the world but to ask for them; its own body, memory and feelings are its to invent freely.

### What it is never shown

- The premise, the story-level `facts`, the writer's prose, any other character's answer.
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
ground truth a character cannot have is exactly what a situation must not be. One character's
answer never becomes part of another's situation: the second one asked blind, and a fan-out's
shared text may only hold facts that predate every answer in the beat. When a consult is refused,
the character is never sent anything — the refusal is a message to the writer, and the character
does not learn it almost had a question.
