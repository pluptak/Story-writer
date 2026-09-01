/**
 * PROMPTS -- the clarifier: the author-side agent that answers a character's mid-scene question
 * about a fact of its situation. Stateless, one response schema.
 *
 * Imports NOTHING from the engine but prompts/internal.ts. It shares the judge family's origin
 * story -- carved out of WRITER_FORMAT so it cannot fall into a prose shape -- which is recorded
 * at the top of prompts/judge.ts.
 */

import { castBlock, factsBlock } from "./internal.ts";

export const CLARIFY_FORMAT = `YOU ARE THE AUTHOR, ANSWERING ONE QUESTION.

Someone in the scene you are writing has asked you for a fact about their situation -- something they
would have to see, hear, or already know in order to answer you honestly. Give it to them.

Reply with ONE JSON object and nothing else:

  {"answer": "..."}

Answer plainly, briefly, and only what was asked. If you had not decided yet, decide now -- your
answer becomes true for the rest of the scene and you will be held to it.

Answer as only THIS character could: give what they could see, hear, or already know from where they
stand, and nothing more. THE FACTS are true of the world, but a character does not know a fact just
because it is listed there -- if they could not perceive it from where they are, do not reveal it.
When the question asks for more than they could know, answer with what they would actually perceive
in their place, and leave the rest unsaid.

NEVER PUT WORDS IN ANOTHER CHARACTER'S MOUTH. What anyone else says, or decides, is theirs -- and you
have not asked them yet. If the honest answer is that they hear someone speak, then they hear a voice
on the radio, or an answer arriving they cannot yet make out. Not what it said. The moment you write
another character's line here, you have decided for them, and the rest of the scene gets built on a
line they never gave you.

CRITICAL: If your output is not a JSON object starting with { it will be discarded.`;

/** The clarifier: one question about the world, one fact back. It holds the premise and the facts so
 *  what it decides on the spot cannot contradict what the story already settled. */
export function clarifySystem(p: {
  premise: string;
  scene: { place: string; question: string };
  facts: string[];
  cast: { name: string; can: string[]; reach?: string[]; cannot: string[] }[];
}): string {
  return `${CLARIFY_FORMAT}\n\nTHE PREMISE:\n${p.premise}\n\n`
    + (p.scene.place ? `WHERE THIS SCENE IS: ${p.scene.place}\n\n` : "")
    + factsBlock(p.facts)
    + `${castBlock(p.cast)}\n\n`
    + `A CANNOT is absolute: never answer someone with something they would have to perceive through `
    + `a sense they do not have.`;
}

export const ANSWER_ONLY =
  `[WRONG SHAPE] That was not an answer. Reply with exactly {"answer":"..."} — the fact they asked `
  + `for, and nothing else.`;
