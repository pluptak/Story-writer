/**
 * PROMPTS -- the three judge agents: the per-answer judge, the narration lint, and the batch
 * judge over volunteered deeds. Stateless, 0.3, no history; one response schema each.
 *
 * Imports NOTHING from the engine but prompts/internal.ts.
 */

import { NAME_THE_FORK, castBlock, wantsMenuLines } from "./internal.ts";

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

You are shown the situation you gave them and what they answered. That situation was the whole of
what they were sent -- no question came with it, because the moment was theirs to read. They may have
taken a fork you never saw in it. That is the format working, not failing.

Reply with ONE JSON object -- one of these two shapes -- and nothing else:

  {"verdict": "accept"}

  {"verdict": "retry", "note": "why it is unusable, in one line -- required",
   "revised": {"situation": "...", "question": "...", "wants": "..."}}

  revised  -- all three fields, every time you retry. They will be asked again from nothing, by a
              fresh instance that never learns this attempt happened, so these must stand on their own.
              THE SITUATION IS THE ONLY ONE OF THE THREE THEY WILL READ. "question" and "wants" are
              your own record of what you decided the fork was, and a retry is the one place they
              get written down at all. A revision that sharpens the question and leaves the situation
              alone re-sends them, word for word, the ask they just answered -- and a fresh instance
              answers it the same way. It will be refused. If the retry is to buy anything, what
              changes is the SITUATION.
    situation -- what THEY can perceive right now, in your words. They know nothing you do not put
                 here. Do not paste back the prose you wrote: that is the page, not their world, and
                 it tells them things they cannot know.
    question  -- your record of the fork, not something they read. ${NAME_THE_FORK} It will be
                 refused and the retry will have bought nothing.
    wants     -- EXACTLY ONE of these four words:
${wantsMenuLines}

RETRY ONLY WHEN THE ANSWER IS UNUSABLE: it engages nothing that is happening to them, or they plainly
lacked something they needed in order to answer (then fix the SITUATION), or they did something they
are not able to do. "It is not the fork I had in mind" is NOT unusable. Neither is "it is quieter
than I wanted". Those are the scene telling you something true.

AN ANSWER HAS TO REACH THE SCENE. You asked for no particular shape, so any of them will do: a line,
a deed, or both, at whatever length the moment deserved. What it cannot be is only a thought, from
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

DO NOT RETRY because the answer is inconvenient, quieter than you hoped, or takes the scene somewhere
you had not planned. That is the scene telling you something true. Accept it, and go and write it.

CRITICAL: If your output is not a JSON object starting with { it will be discarded.`;

/** The judge: one answer, one verdict. It needs the cast's limits to see an answer that overran them,
 *  and nothing else — the situation and the question arrive in the payload. */
export function judgeSystem(cast: { name: string; can: string[]; reach?: string[]; cannot: string[] }[]): string {
  return `${JUDGE_FORMAT}\n\n${castBlock(cast)}\n\n`
    + cannotAbsolute("An answer");
}

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

export const answerFlags = (p: { forced: boolean }) =>
  p.forced ? `They asked for detail you did not give and answered anyway.` : "";

export const judgeRequest = (p: {
  name: string; situation: string; question: string; wants: string;
  thought: string; speech: string; action: string; note: string; flags: string; pov?: boolean;
}) =>
  `[${p.name} ANSWERED]\nThe situation you gave them: ${p.situation}\nYou asked: ${p.question}\n`
  + `What you needed from them: ${p.wants}\n`
  + (p.pov === false ? `They are not the point of view: what they think is not yours to write.\n` : "")
  + `thought: ${p.thought}\nspeech: ${p.speech}\naction: ${p.action}`
  + (p.note ? `\nnote: ${p.note}` : "")
  + (p.flags ? `\n\n[FLAGGED] ${p.flags}` : "");
