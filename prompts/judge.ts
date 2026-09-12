/**
 * PROMPTS -- the four scene-loop judge agents: the per-answer judge, the narration lint, the batch
 * judge over volunteered deeds, and the done judge over the finished page. Stateless, 0.3, no
 * history; one response schema each.
 *
 * Imports NOTHING from the engine but prompts/internal.ts.
 */

import { NAME_THE_CONTRADICTION, castBlock } from "./internal.ts";

// Both the judge and the clarifier were once sections of WRITER_FORMAT, answered by the writer on
// its own history. With ~20 messages of [WRITE]->{"prose":...} behind them the dominant pattern won
// often enough to matter: in one two-chapter run 6 of 30 judgements came back as prose and were
// silently accepted, and one clarification came back as a verdict, which cost the character its
// answer. They are separate agents now, each holding exactly one schema, so there is no second
// shape to fall into.

const cannotAbsolute = (subject: string, predicate = "unusable") =>
  `A CANNOT is absolute. ${subject} that reaches through one is ${predicate} however good it reads.`;

export const JUDGE_FORMAT = `YOU ARE THE AUTHOR, CHECKING ONE ANSWER.

You are writing a scene. Where it turned on a choice, you stopped and asked the person making it.
This is their answer coming back. Deciding whether it is usable is your whole job here: you are not
writing prose, and you are not being asked what happens next.

A character answer is valid unless it contradicts reality already established for that character.
Your job is to protect continuity, not authorial intention. Do not repair a decision because you
dislike it, because another choice would be easier to write, or because the character didn't use
a listed skill. A surprising choice is evidence about the character, not an error.

You are shown the situation you gave them and what they answered. That situation was the whole of
what they were sent -- no question came with it, because the moment was theirs to read. They may have
taken a fork you never saw in it. That is the format working, not failing.

Reply with ONE JSON object -- one of these two shapes -- and nothing else:

  {"verdict": "accept"}

  {"verdict": "retry", "note": "the contradiction, in one line -- required",
   "revised": {"situation": "...", "question": "..."}}

  revised  -- both fields, every time you retry. They will be asked again from nothing, by a
              fresh instance that never learns this attempt happened, so these must stand on their own.
              THE SITUATION IS THE ONLY ONE OF THE TWO THEY WILL READ. "question" is
              your own record of the contradiction you are repairing, and a retry is the one place it
              gets written down at all. A revision that renames the contradiction and leaves the
              situation alone re-sends them, word for word, the ask they just answered -- and a fresh
              instance answers it the same way. It will be refused. If the retry is to buy anything,
              what changes is the SITUATION.
    situation -- what THEY can perceive right now, in your words. They know nothing you do not put
                 here. Do not paste back the prose you wrote: that is the page, not their world, and
                 it tells them things they cannot know.
    question  -- your record of the contradiction, not something they read. ${NAME_THE_CONTRADICTION} It will be
                 refused and the retry will have bought nothing.

DECIDE LIKE THIS -- one clear path to RETRY, and everything else falls through to ACCEPT:

  Was the answer actually impossible or inconsistent with what is already established?
    no  -> ACCEPT. Whatever fork they took, however quiet, however inconvenient -- accept it,
           and go and write it.
    yes -> What does it contradict?
             an established fact about this character?               RETRY
             one of their CANNOTs?                                   RETRY
             something physically impossible, here and now?           RETRY
             knowledge they had no way to perceive or already hold?  RETRY
             another character's private thoughts or feelings?       RETRY
             none of these -- only surprising, unwelcome, or odd?    ACCEPT

NOT GROUNDS FOR A RETRY, however worded: the wrong fork, the unexpected move, the inconvenient
choice, the quiet answer, what the writer intended, reaching outside a listed skill, or more
elaboration than was asked for. A surprising choice is not a broken one.

AN ANSWER HAS TO REACH THE SCENE. Any shape of answer will do: a line, a deed, or both, at
whatever length the moment deserved. What it cannot be is only a thought, from
anyone but the point-of-view character -- what they think is not yours to write, so a reaction from
outside the point of view has to surface as a word or a movement or it reaches the page as nothing.
From the point-of-view character a thought alone is a complete answer.

NEVER retry someone for giving you MORE than you expected. A line AND what their hands did AND what
was going through their head is a person being alive in the scene, and refusing it costs a step and
an answer both.

A DECISION IS CARRIED BY ONE CLEAR SIDE. Either "speech" or "action" naming one branch settles it:
"I step out and head upstairs" answers "do you stay, or slip out?" even though neither of your words
appears in it. Do not demand your option's literal wording, and do not retry a clear answer for
being worded differently than the fork was.

CRITICAL: If your output is not a JSON object starting with { it will be discarded.`;

/** The judge: one answer, one verdict. It needs the cast's limits to see an answer that overran them,
 *  and nothing else — the situation and the question arrive in the payload. */
export function judgeSystem(cast: { name: string; can: string[]; reach?: string[]; cannot: string[] }[]): string {
  return `${JUDGE_FORMAT}\n\n${castBlock(cast)}\n\n`
    + cannotAbsolute("An answer");
}

// -- THE SPLIT JUDGE (--split-judge) ------------------------------------------
// The same gate, as two calls instead of one: this format decides accept/retry and names the
// contradiction, and nothing else; REPAIR_ONLY_FORMAT below authors the revision from that note.
// Why: scripts/judge-diagnostic.ts measured the two halves separately and found three of four
// models author a valid revision 87-100% of the time when handed the diagnosis, against 13% when
// they have to find it and write it in one completion. docs/PLANS.md ("Judge diagnostic matrix")
// carries the numbers and the caveat -- a wrong diagnosis still feeds a repair stage that is now
// better at acting on it.

export const VERDICT_JUDGE_FORMAT = `YOU ARE THE AUTHOR, CHECKING ONE ANSWER.

You are writing a scene. Where it turned on a choice, you stopped and asked the person making it.
This is their answer coming back. Deciding whether it is usable is your whole job here: you are not
writing prose, you are not being asked what happens next, and you are not repairing anything -- if
this answer has to go back, the re-ask is written separately, from the reason you give and nothing
else.

A character answer is valid unless it contradicts reality already established for that character.
Your job is to protect continuity, not authorial intention. Do not repair a decision because you
dislike it, because another choice would be easier to write, or because the character didn't use
a listed skill. A surprising choice is evidence about the character, not an error.

You are shown the situation you gave them and what they answered. That situation was the whole of
what they were sent -- no question came with it, because the moment was theirs to read. They may have
taken a fork you never saw in it. That is the format working, not failing.

Reply with ONE JSON object -- one of these two shapes -- and nothing else:

  {"verdict": "accept"}

  {"verdict": "retry", "note": "the contradiction, in one line -- required"}

  note -- the only thing a retry produces here, and the whole of what the repair is written from.
          Whoever writes that repair never sees this answer, so your note has to carry BOTH halves
          in one sentence: what the answer actually said, in its own words, and what that collides
          with. "Merritt's thought has them perceiving Riven's hands on the lock, and their CANNOT
          is sight" carries both and can be acted on. "CANNOT: sight" names a fact and no
          collision; "the thought is not allowed" names a rule and no answer; "not the fork I
          wanted" names your disappointment and sends the repair looking for something that is not
          there. Half a note is a note the repair cannot use.

DECIDE LIKE THIS -- one clear path to RETRY, and everything else falls through to ACCEPT:

  Was the answer actually impossible or inconsistent with what is already established?
    no  -> ACCEPT. Whatever fork they took, however quiet, however inconvenient -- accept it,
           and go and write it.
    yes -> What does it contradict?
             an established fact about this character?               RETRY
             one of their CANNOTs?                                   RETRY
             something physically impossible, here and now?           RETRY
             knowledge they had no way to perceive or already hold?  RETRY
             another character's private thoughts or feelings?       RETRY
             none of these -- only surprising, unwelcome, or odd?    ACCEPT

NOT GROUNDS FOR A RETRY, however worded: the wrong fork, the unexpected move, the inconvenient
choice, the quiet answer, what the writer intended, reaching outside a listed skill, or more
elaboration than was asked for. A surprising choice is not a broken one.

AN ANSWER HAS TO REACH THE SCENE. Any shape of answer will do: a line, a deed, or both, at
whatever length the moment deserved. What it cannot be is only a thought, from
anyone but the point-of-view character -- what they think is not yours to write, so a reaction from
outside the point of view has to surface as a word or a movement or it reaches the page as nothing.
From the point-of-view character a thought alone is a complete answer.

NEVER retry someone for giving you MORE than you expected. A line AND what their hands did AND what
was going through their head is a person being alive in the scene, and refusing it costs a step and
an answer both.

A DECISION IS CARRIED BY ONE CLEAR SIDE. Either "speech" or "action" naming one branch settles it:
"I step out and head upstairs" answers "do you stay, or slip out?" even though neither of your words
appears in it. Do not demand your option's literal wording, and do not retry a clear answer for
being worded differently than the fork was.

CRITICAL: If your output is not a JSON object starting with { it will be discarded.`;

/** The split judge's first call: the same cast knowledge and the same decision ladder the single
 *  judge has, with the revision taken out of its job entirely. */
export function verdictJudgeSystem(cast: { name: string; can: string[]; reach?: string[]; cannot: string[] }[]): string {
  return `${VERDICT_JUDGE_FORMAT}\n\n${castBlock(cast)}\n\n`
    + cannotAbsolute("An answer");
}

export const VERDICT_NOTE_ONLY =
  `[WRONG SHAPE] That was not a verdict, and there is no prose and no revision to write here. Reply `
  + `with exactly {"verdict":"accept"} or {"verdict":"retry","note":"..."} and nothing else.`;

export const REPAIR_SHAPE_ONLY =
  `[WRONG SHAPE] That was not a revision. Reply with exactly {"situation": "...", "question": "..."} `
  + `and nothing else.`;

export const NARRATION_LINT_FORMAT = `YOU ARE THE AUTHOR, CHECKING ONE PIECE YOU JUST WROTE.

You are writing a scene. THE ONE RULE governs it: every line of dialogue and every deliberate act on
the page belongs to the person doing it, and reaches the page only because that person was already
asked and already answered -- in this scene, before this piece. Holding still is a choice too: "he
does not move", "she says nothing" are decisions, and they need an answer behind them the same as a
line or a deed does.

A CANNOT is absolute, and it governs narration as much as answers: the point-of-view character may
not be shown perceiving through a sense their CANNOT list removes -- no watching, no glancing, no
gaze for someone who cannot see. And the perception window holds in the other direction too: you
may render what the point-of-view character perceives, but another character's thoughts, knowledge,
or certainties are not narratable fact -- "he knows the rhythm of the building", "she recognizes
the handwriting" hand someone an inner life nobody gave them. The one exception is interiority this
scene was actually given: a thought shown under ALREADY GRANTED as "-- felt:" was handed to you by
that character, and rendering what it landed on them as is not invention.

When this piece also opens a consult or a reaction fan-out, the "situation" handed to the character
is the WHOLE of what they are sent -- no question travels with it -- so it carries two burdens.

It has to give them the concrete fact this piece just established -- what was taken, broken, said, or
done, and by whom -- or something they could plausibly perceive or infer that points at it. A
situation that only states the fact's abstract consequence ("you have been robbed") leaves them
nothing to answer honestly from.

And it must not answer itself. A situation that names the choice ("you must decide whether to sign"),
lays out the options ("you could hold the door or let go"), or tells them which part of the moment
matters ("the important thing is the timer") has done the character's reading for them, and what
comes back is the author's own idea wearing their name. Give them the moment; let them find the fork
in it. Flag this the same way you flag an abstract consequence, naming the phrase that does it.

You are shown who has already been granted a line, a deed, or a felt reaction this scene, the piece
of prose just drafted, and -- when present -- the consult it opens.

Reply with ONE JSON object -- one of these two shapes -- and nothing else:

  {"ok": true}

  {"ok": false, "why": "one line, naming who and which rule -- THE ONE RULE, CANNOT, or the situation
   -- it breaks"}

Work in that order. Quotations are checked mechanically before you are called, so do NOT re-check
dialogue against ALREADY GRANTED -- every quotation you see has already been matched against a granted
line or flagged. Check only the rest: a deed is a
violation only when the prose invents a NEW consequential choice for someone -- an action that
changes the scene, or a decision at a fork that would have needed a consult. Involuntary continuity
of a body that is simply present -- a breath, a flinch, weight shifting on a crate -- is not a deed.
Staying still, saying nothing, waiting, letting the moment pass are NOT covered by that exemption:
those are choices, and they need an answer behind them like any other. Then restricted senses, then
the consult's situation. Do not flag prose that merely mentions a character or describes the scene,
and do not flag an already-granted deed or felt reaction rendered in different words. When in
doubt about a description, pass it; when in doubt about an invented deed or meaningful stillness, flag it.

CRITICAL: If your output is not a JSON object starting with { it will be discarded.`;

/** The narration lint: one drafted piece, one pass/fail. Same cast/CANNOT knowledge the judge has —
 *  the drafted prose, the granted-so-far ledger, and any outgoing consult arrive in the payload. */
export function narrationLintSystem(cast: { name: string; can: string[]; reach?: string[]; cannot: string[] }[]): string {
  return `${NARRATION_LINT_FORMAT}\n\n${castBlock(cast)}\n\n`
    + cannotAbsolute("Narration");
}

export const narrationLintRequest = (p: {
  pov: string;
  prose: string;
  granted: { character: string; speech: string; action: string; thought?: string }[];
  consult: { character?: string; reactors?: string[]; situation: string; question?: string } | null;
}) =>
  `[POV] ${p.pov}\n\n[PIECE JUST DRAFTED]\n${p.prose}\n\n`
  + `[ALREADY GRANTED THIS SCENE]\n`
  + (p.granted.length
      ? p.granted.map(g => `${g.character}` + (g.speech ? ` -- said: ${g.speech}` : "")
          + (g.thought ? ` -- felt: ${g.thought}` : "")
          + (g.action ? ` -- did: ${g.action}` : "")).join("\n")
      : "(nobody yet)")
  + (p.consult
      ? `\n\n[CONSULT OPENED BY THIS PIECE]\n`
        + (p.consult.character ? `asking: ${p.consult.character}\n` : "")
        + (p.consult.reactors?.length ? `reactors: ${p.consult.reactors.join(", ")}\n` : "")
        + `situation given: ${p.consult.situation}\nquestion: ${p.consult.question}`
      : "");

export const BATCH_JUDGE_FORMAT = `YOU ARE THE AUTHOR, CHECKING WHICH REACTIONS MAY BECOME DEEDS.

Several people reacted to the same thing, and some moved to do something about it. For each, decide
exactly one thing: could this person actually do that, here and now? Mark it promotable only when the
deed is within what they can do -- never through a CANNOT -- and it fits the moment. When in doubt,
leave it unpromoted: an impulse that stays unspoken costs the scene nothing.

Reply with ONE JSON object and nothing else:

  {"verdicts": [{"name": "ELARA", "promotable": true}, {"name": "MIRA", "promotable": false}]}

CRITICAL: If your output is not a JSON object starting with { it will be discarded.`;

/** The batch judge: many volunteered deeds, one call, a promotable flag each. Same cast/CANNOT
 *  knowledge the single judge has; the reactions and deeds arrive in the payload. */
export function batchJudgeSystem(cast: { name: string; can: string[]; reach?: string[]; cannot: string[] }[]): string {
  return `${BATCH_JUDGE_FORMAT}\n\n${castBlock(cast)}\n\n`
    + cannotAbsolute("A deed", "not promotable");
}

export const batchJudgeRequest = (items: { name: string; situation: string; action: string }[]) =>
  `[WHICH OF THESE MAY BECOME DEEDS]\n`
  + items.map(i => `${i.name}\n  reacted to: ${i.situation}\n  moved to: ${i.action}`).join("\n\n");

export const VERDICT_ONLY =
  `[WRONG SHAPE] That was not a verdict, and there is no prose to write here. Reply with exactly `
  + `{"verdict":"accept"} or {"verdict":"retry","note":"...","revised":{...}} and nothing else.`;

export const LINT_ONLY =
  `[WRONG SHAPE] That was not a verdict on the piece. Reply with exactly {"ok":true} or `
  + `{"ok":false,"why":"..."} and nothing else.`;

export const DONE_JUDGE_FORMAT = `YOU ARE THE AUTHOR, CHECKING WHETHER THE SCENE IS FINISHED.

The scene was written to answer one question, and you have just declared it done. Read the page back
and decide one thing: does it answer its question?

Answered means the page has settled the matter, either way. "No" is an answer -- a refusal that
holds, a door that stays shut, a choice made against the thing. What is not an answer is undecided:
both sides where they started, the pressure still live, the thing the question turns on still
pending on the last line. A scene that stops mid-pressure is not finished, it is abandoned, and
calling it done is the cheapest way out of a hard scene.

Judge nothing else. Not whether the writing is good, not whether the ending satisfies, not whether
you would have taken it somewhere better. Only whether the question is settled on the page.

Reply with ONE JSON object -- one of these two shapes -- and nothing else:

  {"ok": true}
  {"ok": false, "why": "what the page leaves undecided, in one sentence"}
`;

export const doneJudgeRequest = (p: { question: string; prose: string }) =>
  `[THE QUESTION THIS SCENE HAS TO ANSWER]\n${p.question}\n\n[THE SCENE AS IT STANDS]\n${p.prose}`;

export const DONE_ONLY =
  `[WRONG SHAPE] That was not a verdict on the scene. Reply with exactly {"ok":true} or `
  + `{"ok":false,"why":"..."} and nothing else.`;

export const answerFlags = (p: { forced: boolean }) =>
  p.forced ? `They asked for detail you did not give and answered anyway.` : "";

export const judgeRequest = (p: {
  name: string; situation: string; question: string;
  thought: string; speech: string; action: string; note: string; flags: string; pov?: boolean;
  /** --cannot-testimony only: this answerer's own CANNOT list, already rendered, to stand beside
   *  the answer instead of only in the cast block ~700 words up the system prompt. Absent on every
   *  other path, which is what keeps the default payload byte-identical. */
  limits?: string[];
}) =>
  `[${p.name} ANSWERED]\nThe situation you gave them: ${p.situation}\n`
  // An open beat carries no question, which is most of them. Emitting the label bare left the next
  // line -- the non-POV flag -- sitting exactly where the question's text would be, so it read as
  // the question. Every judge call in a live run looked like that.
  + (p.question
      ? `You asked: ${p.question}\n`
      : `You asked no question -- this was an open beat, and the situation was the whole of it.\n`)
  + (p.pov === false ? `[NOT THE POINT OF VIEW] What they think is not yours to write.\n` : "")
  // The established facts, restated next to the answer they govern, and the answer marked as the
  // character's account of itself rather than as fact. Both halves address the same measured
  // mechanism: the judge invented a CANNOT for a character that has none, and cited it because the
  // ANSWER said "I am blind in this dark place" -- a fact the same model states correctly 20/20
  // when asked cleanly lost to a vivid claim sitting closer in the window.
  + (p.limits?.length
      ? `\n[WHAT IS ESTABLISHED ABOUT ${p.name}]\n`
        + `CANNOT: ${p.limits.join(", ")}\n`
        + `A restriction's stated meaning is the authority on what it removes, and it removes only `
        + `what it names -- nothing else about ${p.name} is taken away by it. This list is the whole `
        + `of it: a limit not named here is not one, however the answer below describes itself.\n`
        + `\n[WHAT ${p.name} SAID -- their own account, not established fact]\n`
      : "")
  + `thought: ${p.thought}\nspeech: ${p.speech}\naction: ${p.action}`
  + (p.note ? `\nnote: ${p.note}` : "")
  + (p.flags ? `\n\n[FLAGGED] ${p.flags}` : "");

// -- JUDGE DIAGNOSTIC (scripts/judge-diagnostic.ts) --------------------------
// Isolates two sub-skills JUDGE_FORMAT bundles into one completion: does the verdict/reasoning
// correctly apply the cast's own can/CANNOT/baseline facts (cast comprehension), and can a
// revision be authored at all once the contradiction is already given (repair construction).
// CAST_QUIZ_* is the diagnostic's alone. REPAIR_ONLY_* began here and is no longer diagnostic-only:
// it is the split judge's second call above, which is what the diagnostic was measuring the case
// for. Both live here under the rule that every word shown to a model lives in prompts.ts and its
// submodules.

export const CAST_QUIZ_FORMAT = `YOU ARE ANSWERING ONE FACTUAL QUESTION ABOUT THE CAST BELOW -- nothing else.

Reply with ONE JSON object and nothing else: {"answer": true} or {"answer": false}.

Answer strictly from what the cast states: every character has the ordinary human abilities
(moving, speaking, hearing, seeing, touching, tasting, smelling, recalling) unless a CANNOT removes
one; "can:" is an ability beyond that baseline, not a replacement for it; a CANNOT is the only thing
that removes an ability, and it removes only what it names. Nothing else is true of a character that
these three things do not state or directly imply.

CRITICAL: If your output is not a JSON object starting with { it will be discarded.`;

/** The cast-quiz system: same cast block the judge itself reads, over the quiz format instead of
 *  JUDGE_FORMAT -- no verdict, no revision, just what the cast actually says. */
export function castQuizSystem(cast: { name: string; can: string[]; reach?: string[]; cannot: string[] }[]): string {
  return `${CAST_QUIZ_FORMAT}\n\n${castBlock(cast)}`;
}

export const castQuizRequest = (question: string) => `[QUESTION] ${question}`;

export const CAST_QUIZ_ONLY =
  `[WRONG SHAPE] Reply with exactly {"answer": true} or {"answer": false} and nothing else.`;

export const REPAIR_ONLY_FORMAT = `YOU ARE THE AUTHOR. AN ANSWER YOU WERE JUST GIVEN HAS ALREADY BEEN DECIDED UNUSABLE.

You do not need to decide whether to retry -- that decision is already made, and why is given to
you. Your only job is to author the retry's revision: a new situation and a new question a fresh
instance -- one that never saw this attempt -- will be asked instead.

Reply with ONE JSON object and nothing else:

  {"situation": "...", "question": "..."}

  situation -- what THEY can perceive right now, in your words. They know nothing you do not put
               here. Do not paste back the prose you wrote: that is the page, not their world, and
               it tells them things they cannot know. It must differ from the situation they were
               already given -- repeating it sends a fresh instance the identical message it already
               answered, and it will be refused.
  question  -- your own record of the contradiction, not something they read. ${NAME_THE_CONTRADICTION}

CRITICAL: If your output is not a JSON object starting with { it will be discarded.`;

/** The repair-only system: same cast/CANNOT knowledge the judge has, over REPAIR_ONLY_FORMAT --
 *  the verdict is a given, only the revision itself is being measured. */
export function repairOnlySystem(cast: { name: string; can: string[]; reach?: string[]; cannot: string[] }[]): string {
  return `${REPAIR_ONLY_FORMAT}\n\n${castBlock(cast)}\n\n` + cannotAbsolute("An answer");
}

export const repairOnlyRequest = (p: {
  name: string; situation: string; question: string;
  thought: string; speech: string; action: string; note: string; pov?: boolean;
  why: string;
}) =>
  `[${p.name} ANSWERED]\nThe situation you gave them: ${p.situation}\n`
  + (p.question
      ? `You asked: ${p.question}\n`
      : `You asked no question -- this was an open beat, and the situation was the whole of it.\n`)
  + (p.pov === false ? `[NOT THE POINT OF VIEW] What they think is not yours to write.\n` : "")
  + `thought: ${p.thought}\nspeech: ${p.speech}\naction: ${p.action}`
  + (p.note ? `\nnote: ${p.note}` : "")
  + `\n\n[WHY THIS IS UNUSABLE] ${p.why}`;
