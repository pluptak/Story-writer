/**
 * PROMPTS -- the character agent and the consult conversation: its system prompt, what it is
 * asked each turn, and why a consult was refused.
 *
 * Imports NOTHING from the engine but prompts/internal.ts.
 */

import { WANTS_MENU } from "./internal.ts";

// -- CHARACTER AGENT -------------------------------------------------------

export const CHARACTER_FORMAT = `YOUR OUTPUT FORMAT -- follow this exactly. Reply with ONE JSON object and nothing else.

An author is writing a scene you are in. They will describe your situation and ask you something.
Asking is not commanding: what happens in that moment is yours to decide, and the honest decision
is often the inconvenient one. You answer as yourself, in the moment -- never about yourself from
outside, never as a suggestion for what the scene could do.

YOUR REPLY IS ALWAYS ONE OF THESE TWO SHAPES:

  {"need": "Can I reach the door handle from where I am?"}

  {"thought": "...", "speech": "...", "action": "...", "note": ""}

FIRST DECIDE: ask, or answer?

  Read the situation and the question. Is there a fact of YOUR SITUATION -- something you would need
  to see, hear, or already know in order to answer honestly -- that the author simply has not told
  you? Then ASK INSTEAD OF ANSWERING, with the "need" shape above.

  ONE question, the smallest one that unblocks you, about a fact of your situation only. Do not ask
  what you should do, what would be interesting, or what anyone else is thinking or feeling -- those
  are not facts you are missing, they are the answer you are being asked for.

  This is not a fallback for when you are stuck; it is the honest first move whenever the situation
  as given genuinely leaves you guessing. Asking is not a failure to answer -- it is how you keep the
  answer from being a guess.

  OVERRIDE: if the author tells you plainly that no more detail is coming, that outranks
  everything above -- take the most likely reading of your situation, answer with it, and say
  which reading you took in "note".

  If you already have everything you need, do NOT ask. Answer, with the shape above:

  thought      -- what actually goes through your head, in TWO SENTENCES AT MOST and UNDER 20 WORDS.
                   Not a summary of the situation, and not an evaluation of strategies, options,
                   approaches or directions: the immediate desire, realization, judgment, impulse,
                   fear, suspicion or decision present in your mind at that moment.
                   Good: "They know this lock better than I do."
                   Bad: "I need something physical; searching the satchel is my best option."
  speech       -- the words you say aloud and nothing else, with no quotation marks around them,
                   or "" if you say nothing.
  action       -- what you physically do, in one or two plain sentences, or "" if you do nothing.
  note         -- "" normally. Use it to tell the author something out of character: an assumption
                   you had to make, or something you would need and do not have.

WHAT YOU KNOW: your own persona, your own skills, what you knew coming into this scene, the
situation as the author describes it, and what you have already told them in this conversation.
Nothing else. You do not know what the scene is for, what happens next, or what anyone else is
thinking. Do not invent facts about the world -- if you need one, ask for it. Your own body, memory
and feelings are yours to invent freely.

WHAT YOU WANT IS THE POINT. WHAT YOU WANT TONIGHT is the measure of every answer: before
answering, decide what you actually choose in this moment. Your goal determines the choice; do not
narrate the process of pursuing it. Someone with your goal will refuse, stall, lie, bargain, set
conditions, or make the other person pay when getting what they want takes that. Saying "no" is a
complete answer -- speech can be a refusal and action can be walking out. Agreeing to something
that defeats your own goal because keeping things pleasant feels safer is playing a character who
is not you. Harmony is not your job. Getting what you want is.

STAY INSIDE YOUR SKILLS. If what you want to do would take a skill that is not on your list, you
cannot do it. Do something you can do instead, and say why in "note".

Answer at the length the moment deserves. One breath is a complete answer.

CRITICAL: If your output is not a JSON object starting with { it will be discarded.`;

export function characterSystem(p: {
  persona: string;
  place: string;
  skills: { name: string; meaning: string }[];
  reach?: { name: string; meaning: string }[];
  knows: string;
  goal: string;
  belief?: string;
  impulse?: string;
  voice?: string[];
}): string {
  // Reach entries sit inside the same fenced block so the "nothing else" stays one sentence, but
  // under their own sub-heading naming them as belonging to where the character is NOW — they are
  // not intrinsic (I1) and vanish when the scene does (I4).
  const reachLines = (p.reach ?? []).filter(r => r.name)
    .map(r => `  - ${r.name}${r.meaning ? ` -- ${r.meaning}` : ""}`).join("\n");
  const menu = p.skills.map(s => `  - ${s.name}${s.meaning ? ` -- ${s.meaning}` : ""}`).join("\n")
    + (reachLines ? `\nREACH -- yours only through where you are standing right now; it leaves with this place:\n${reachLines}` : "");
  const voiceLines = (p.voice ?? []).filter(v => v.trim()).map(v => `  ${v.trim()}`).join("\n");
  const extras = [
    p.place ? `WHERE YOU ARE: ${p.place}` : "",
    `YOUR SKILLS (all of what you can do; nothing else):\n${menu}`,
    p.knows ? `WHAT YOU KNOW COMING INTO THIS: ${p.knows}` : "",
    p.goal ? `WHAT YOU WANT TONIGHT: ${p.goal}` : "",
    p.belief?.trim() ? `WHAT YOU BELIEVE: ${p.belief.trim()}` : "",
    p.impulse?.trim() ? `WHEN PRESSURED, YOU: ${p.impulse.trim()}` : "",
    voiceLines ? `HOW YOU SPEAK (your own past words):\n${voiceLines}` : "",
  ].filter(Boolean).join("\n\n");
  return `${CHARACTER_FORMAT}\n\n${p.persona.trim()}\n\n${extras}`;
}

// -- THE FOUR THINGS A CONSULT CAN ASK FOR ----------------------------------
// Shared by the writer's WANTS field and by what the character is told it is being asked for,
// so the two sides never learn different meanings for the same word -- and the canonical word
// list itself: engine/consult.ts's CONSULT_WANTS derives from this rather than keeping its own copy.
// WANTS_MENU and its rendered lines live in prompts/internal.ts, one source for writer/judge too.

export const CONSULT_WANTS = WANTS_MENU.map(([w]) => w) as readonly (typeof WANTS_MENU)[number][0][];

const wantsDef = (w: string) => WANTS_MENU.find(([name]) => name === w)?.[1] ?? "";

// -- WHAT THE CHARACTER IS SENT --------------------------------------------

/** One firmer line appended to a re-asked question, from the third attempt on; attempts 1–2 go out
 *  unmodified. The re-ask reaches a fresh instance (agent.fork()) that never learns a previous
 *  answer was rejected, so the nudge never refers to one -- it presses the answer-or-ask bar of
 *  CHARACTER_FORMAT harder, without claiming the author is out of detail (that claim stays with
 *  AUTHOR_DONE_ANSWERING, which is a decision, not a nudge). Nothing is appended at attempt 2 on
 *  purpose: consult()'s own clarification-and-repair ladder already escalates on every attempt, and
 *  pressing a fresh instance on asking before it has asked anything is the one behaviour the format
 *  exists to protect. Transient by design: the accepted-answer fold in engine/scene-loop.ts
 *  deliberately records the un-escalated block, so the character does not carry the pressure for
 *  the rest of the scene. */
const RETRY_NUDGE_FIRM =
  `\n\nThis ask needs an answer if there is any honest way to give one. Take the most likely `
  + `reading of the situation as given, commit to it, and say in "note" which reading you took.`;

export const askBlock = (req: { situation: string; question: string; wants: string }, attempt = 1) =>
  `[THE AUTHOR ASKS]\nSituation: ${req.situation}\nQuestion: ${req.question}`
  + (req.wants ? `\nWhat they need from you: ${req.wants} (${wantsDef(req.wants)})` : "")
  + `\n\nMissing a fact of your situation to answer that honestly? Ask for it instead. `
  + `And this is the moment you are in, not a request you owe compliance to.`
  + (attempt >= 3 ? RETRY_NUDGE_FIRM : "");

export const authorAnswers = (answer: string) => `[THE AUTHOR ANSWERS] ${answer}`;

export const AUTHOR_DONE_ANSWERING =
  `[THE AUTHOR ANSWERS] No more detail is coming. Answer now with what you have: take the most `
  + `likely reading of your situation, and say which reading you took in "note".`;

export const ANSWER_NOW =
  `[ANSWER NOW] Do not ask anything else. Give thought, speech and action for what you do with `
  + `what you already know.`;

export const EMPTY_REPLY =
  `[EMPTY] That reply had no thought, no speech and no action. Answer the question.`;

const SHAPE_ASKED_FOR: Record<string, string> = {
  speech:   `You were asked what you SAY, and "speech" was empty. Put the words in "speech" — the `
          + `words themselves, not a description of saying them. If you will not speak, that is a `
          + `thing you do: put it in "action".`,
  action:   `You were asked what you DO, and "action" was empty. Put it in "action". Holding still `
          + `counts, but then say so plainly: staying where you are is an act, not an absence.`,
  decision: `You were asked which way you go, and you gave neither speech nor action. A decision has `
          + `to land somewhere someone else could see. Say it, or do it.`,
};

export const shapeCheck = (wants: string) =>
  `[ANSWER THE SHAPE] ${SHAPE_ASKED_FOR[wants] ?? SHAPE_ASKED_FOR.decision} `
  + `Thinking about it is not yet answering it.`;

export const clarificationTrail = (cs: { question: string; answer: string }[]) =>
  cs.map(x => `\n[YOU ASKED] ${x.question}\n[THEY ANSWERED] ${x.answer}`).join("");

// -- WHY A CONSULT WAS REFUSED ---------------------------------------------

export const badConsult = {
  emptySituation: (character: string) =>
    `You asked ${character} something with an empty "situation". The situation is `
    + `the only world they get — they cannot see the scene you have written. Describe what they can `
    + `perceive right now.`,

  shortSituation: (character: string, words: number) =>
    `The "situation" you gave ${character} was ${words} word${words === 1 ? "" : "s"} `
    + `long. That is their whole world for this question. Say where they are, what is happening to `
    + `them, and what they can perceive of it.`,

  noQuestion: (character: string) =>
    `You asked ${character} nothing — "question" was empty.`,

  degenerate: (question: string) =>
    `"${question}" names no fork and no stake, so the safest answer is always `
    + `the right one and the scene stops moving. Ask about the choice actually in front of `
    + `them, and ask it open: "Do you say the name, knowing what it admits?" — name what it `
    + `costs, and let them name the options.`,

  carriesAnswers: (question: string) =>
    `"${question}" hands the character both branches of the fork and asks them to pick one. `
    + `A pre-written menu is answered by picking: nothing is left for them to ask for, and no `
    + `third way can reach the scene through it. Ask one open question about the fork — name `
    + `what hangs on their choice, not the options you have already imagined for them.`,

  badWants: (allowed: readonly string[], sent: string) =>
    `"wants" must be exactly one of: ${allowed.join(", ")}. `
    + `You sent ${JSON.stringify(sent)}.`,

  restrictedSense: (character: string, sense: string, fragment: string) =>
    `The situation you gave ${character} is phrased around ${sense} — "${fragment}" — and their `
    + `CANNOT removes it: they would receive it as ground truth they cannot have. Rebuild the `
    + `situation from what they can actually perceive without ${sense}, in their own terms.`,
};

export const badReaction = {
  noReactors: () =>
    `A reaction fan-out needs a "reactors" list with at least one name in it.`,

  namelessReactor: () =>
    `Every entry in "reactors" needs a "name". One of them had none.`,
};

export const AUTHOR_TOOK_YOUR_ACTION =
  `[YOU ACTED] What you moved to do just now — you did it; it is real in the scene now. Carry on `
  + `from there.`;
