/** ANSWER-REACH-LINT — the mechanical floor under "AN ANSWER HAS TO REACH THE SCENE".
 *
 *  Two shapes reach the gate having already survived consult()'s in-call repair once, and both
 *  fold in as nothing: an answer with no fields at all — the envelope without the content — and
 *  a thought-only answer from outside the point of view (what they think is not the writer's to
 *  write). Both are visible in the reply object and cost no model call to see, so they are
 *  refused here on the placeholder path's retry budget: a formatting failure a fresh fork very
 *  likely repairs. An answer that carries a note but no fields is kept on purpose — the note is
 *  content, and "did not answer; kept asking" is a beat, not an envelope.
 *
 *  Pure: no imports beyond consult.ts, no warnings, no model call. The caller owns the retry
 *  budget and the discard.
 */
import { nonPovThoughtOnly } from "../consult.ts";
import type { ConsultReply } from "../consult.ts";

export interface ReachHit { why: string }

export function lintAnswerReach(reply: ConsultReply, pov: boolean): ReachHit | null {
  if (!reply.thought && !reply.speech && !reply.action && !reply.note)
    return { why: "the answer carried no thought, speech, action or note" };
  // The thought has to be there for this to be a thought-only answer at all: nonPovThoughtOnly
  // reads speech and action alone, so a note carrying the whole reply would otherwise be refused
  // as a thought that was never written.
  if (reply.thought && nonPovThoughtOnly({ speech: reply.speech, action: reply.action }, pov))
    return { why: "a thought from outside the point of view reaches the scene as nothing" };
  return null;
}
