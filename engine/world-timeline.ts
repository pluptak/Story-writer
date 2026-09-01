/** WORLD TIMELINE — the pure decision half of the world-event ledger: what fires this turn, what is
 *  held, and which memories implant. No engine dependencies and no model call: firing, holding and
 *  implanting are zero-inference (PLANS.md, the world timeline). The scene loop owns the mutation
 *  this decides — injecting into the writer's instruction, appending memories to character agents —
 *  and keeps this module's output as its record of what happened. */
import type { TimelineDef } from "./story-schema.ts";

export interface BeatTurn {
  /** The beat firing this turn, if its trigger is met — the loop injects its `fired` form into the
   *  writer's next instruction as something that has happened and nobody can decline. */
  fired: TimelineDef | null;
  /** The firing beat's memories as authored: [character name, memory] pairs. The loop implants each
   *  one whose character is rostered and still in the scene; a memory for an absent character is
   *  skipped (the load path already warned that it can never reach a run). */
  memories: [string, string][];
  /** The held form of the next unfired beat — what the writer may not start until told. Empty when
   *  a beat fires this turn: the two are never rendered together. */
  hold: string;
}

/** One turn's decision for the beats aimed at `chapter`. Beats queue in authored order — the order
 *  IS the firing order — and each fires once, when `words >= target * beat.at`. `firedSoFar` is the
 *  run's own record, held by identity: the entries are the StoryConfig's stable objects for the life
 *  of a scene. A `void` entry never fires and never holds. */
export function timelineTurn(entries: TimelineDef[], chapter: number, words: number, target: number,
                             firedSoFar: Set<TimelineDef>): BeatTurn {
  const live = entries.filter(b => b.chapter === chapter && b.state !== "void" && !firedSoFar.has(b));
  const next = live[0];
  if (!next) return { fired: null, memories: [], hold: "" };
  if (words >= target * next.at)
    return { fired: next, memories: Object.entries(next.memories), hold: "" };
  return { fired: null, memories: [], hold: next.hold };
}
