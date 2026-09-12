/** WORLD REPAIR — world-side adjudication of outstanding timeline beats after the story
 *  has actually progressed (PLANS.md, the world timeline: the repair entity).
 *
 *  This is the one repair half of the ledger; firing, holding and implanting stay in
 *  `world-timeline.ts` and are untouched. Like that module this one is pure and zero-inference:
 *  no agents, no model call, no engine dependencies. Whoever calls it supplies the standing —
 *  what already happened in the world — and gets back a structured ledger mutation, never prose.
 *
 *  Hard boundaries, by construction rather than by promise:
 *
 *  - The input carries no persona, no goal, no skills, no restrictions and no private knowledge —
 *    there is no parameter that could hold them. The entity sees the beat, the established world
 *    outcome, and whether the scene's question is still live. That is the writer's blindness
 *    PLANS.md requires, and a Director wearing a hat cannot fit through this signature.
 *  - The output is an operation (`void`, `re-aim`, `revise`, `escalate`, `none`), never wording.
 *    A replacement beat, a revised route, or an escalated re-firing still has to be authored —
 *    by the handoff/architect through the existing `beat_<n>.*` / `add_beat` surface — because
 *    this module emits no `hold`/`fired`/`memories` text at all.
 *  - The entity is pointed at the question, not the planned path. `questionLive === false`
 *    short-circuits every other branch to `void`/`none`: a scene that settled its question by an
 *    unexpected route retires its beats instead of resurrecting them. No repair here can force a
 *    character back onto a scripted outcome, because no repair here names an outcome.
 *  - Escalation keys on a landing check that ran and failed (`landed === false`). `landed === null`
 *    means no check has run — a beat awaiting its check is not a beat that failed one — and never
 *    escalates. This is the defect PLANS.md records from the removed mechanical check, kept as a
 *    branch rather than a comment.
 *  - This module does not decide visibility: nothing here says who could perceive what (that is the
 *    information-authority problem, explicitly not this entity's job), and nothing here touches the
 *    architect, writer or character prompts or any information boundary.
 */
import type { TimelineDef } from "./story-schema.ts";

/** What the world looks like from the ledger's side, after the story has progressed.
 *
 *  Every field is about the WORLD EVENT and the STORY QUESTION — never about a character.
 *  `possible` and `questionLive` are supplied by the caller (the run record, the done judge's
 *  verdict, the handoff author); this module reasons over them but never derives them, and
 *  certainly never derives them from who wanted what. */
export interface BeatStanding {
  /** Did this beat already fire this chapter (the loop injected its `fired` form)? */
  fired: boolean;
  /** Did the fired beat reach the page as established fact? `null` when no landing check has run
   *  yet — awaiting a check is not failing one. Meaningless (ignored) for a beat that never fired. */
  landed: boolean | null;
  /** Is the beat's `fired` form still possible in the world as established? `false` when a
   *  character's choice made it impossible — evacuated before the alarm, sealed the door the
   *  thing was to come through. This is a world fact, not a judgement on the choice. */
  possible: boolean;
  /** Is the pressure this beat serves still live — the scene's question still unanswered? `false`
   *  when the scene settled it, however unexpectedly. This is the only future the entity steers
   *  toward, and it is a question, never an answer. */
  questionLive: boolean;
  /** Has the chapter ended (for an unfired beat: the trigger will never be reached)? */
  ended: boolean;
}

/** One beat's repair, as a structured ledger mutation.
 *
 *  Each operation maps onto the handoff's existing edit surface (`beat_<n>.chapter`,
 *  `beat_<n>.state`, `add_beat`); none carries replacement wording, because wording is
 *  authorship and this entity is not an author. */
export type BeatRepair =
  /** Leave the ledger alone: the beat is still queued, already spent, or awaiting its check. */
  | { op: "none"; cause: "queued" | "spent" | "awaiting-check" }
  /** Drop the beat but keep it in the ledger (`beat_<n>.state "void"` — never `remove_beat`):
   *  preempted before it could fire, or spent because the question settled without it. */
  | { op: "void"; cause: "preempted" | "spent" }
  /** The scene ended with the beat unfired and the pressure still live: aim it at the next
   *  chapter (`beat_<n>.chapter`), or void it there if the handoff decides otherwise. */
  | { op: "re-aim"; toChapter: number; cause: "stranded" }
  /** The beat fired but the world it assumed is gone: the same obligation through a different
   *  route. The new `hold`/`fired` wording is the handoff's to author; this operation only
   *  requests it. */
  | { op: "revise"; cause: "contradicted" }
  /** The beat fired, is still possible, demonstrably did not land, and the question is still
   *  live: re-arm the same beat, with more force, again. Rewording is the handoff's. */
  | { op: "escalate"; cause: "unlanded" };

/** Adjudicate one beat's standing into its repair. Pure: the same standing always yields the same
 *  operation, whichever characters produced it — an unexpected but valid choice can only ever
 *  retire beats (via `questionLive: false`), never summon new pressure. */
export function adjudicateBeat(beat: TimelineDef, standing: BeatStanding): BeatRepair {
  // A settled question retires everything. This branch runs first on purpose: possibility,
  // firing and landing are all moot once nothing is owed, and putting it first is what makes
  // the "better route than the premise anticipated" case structurally safe — the entity cannot
  // escalate or revive a beat for a question nobody is still asking.
  if (!standing.questionLive) {
    if (!standing.fired) return { op: "void", cause: "spent" };
    return { op: "none", cause: "spent" };
  }
  // The world moved past the beat. Unfired, it is void (a replacement pressure, if the story
  // needs one, is the handoff's authorship, not this module's output). Fired, the same
  // obligation needs a new route — requested here, worded by the handoff.
  if (!standing.possible) {
    if (!standing.fired) return { op: "void", cause: "preempted" };
    return { op: "revise", cause: "contradicted" };
  }
  // Still queued behind its trigger: the firing logic owns it, not the repair logic.
  if (!standing.fired) {
    if (!standing.ended) return { op: "none", cause: "queued" };
    return { op: "re-aim", toChapter: beat.chapter + 1, cause: "stranded" };
  }
  // Fired and still possible: landing decides, and only a check that ran decides.
  if (standing.landed === true) return { op: "none", cause: "spent" };
  if (standing.landed === null) return { op: "none", cause: "awaiting-check" };
  return { op: "escalate", cause: "unlanded" };
}

/** Adjudicate every beat aimed at `chapter`. Returns each beat with its repair, in ledger order;
 *  beats aimed elsewhere are not consulted and not returned. `standingOf` supplies the world-side
 *  standing per beat — the same world-side-only contract as `adjudicateBeat`. */
export function adjudicateChapter(
  entries: TimelineDef[],
  chapter: number,
  standingOf: (beat: TimelineDef) => BeatStanding,
): { beat: TimelineDef; repair: BeatRepair }[] {
  return entries
    .filter(b => b.chapter === chapter && b.state !== "void")
    .map(beat => ({ beat, repair: adjudicateBeat(beat, standingOf(beat)) }));
}
