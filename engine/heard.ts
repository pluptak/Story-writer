import { sameName } from "./config-util.ts";

/** HEARD — what a character actually heard since they were last asked, as one verbatim block.
 *
 *  Across 64 recorded runs, 503 situations followed another character's granted speech and only
 *  24 (5%) carried any 6-word verbatim run of it. Every consult chain was a telephone game: the
 *  writer paraphrased what someone said, the next character answered the paraphrase. This module
 *  is the input-side fix: the engine composes the block here and renders it into the ask, so the
 *  words that reached a character are the words that were said, not the writer's retelling.
 *
 *  No runtime engine imports — name matching goes through config-util.ts, a dependency-free leaf.
 *  This stays a leaf the engine can wire into anything, unit-testable with no model, no fetch and
 *  no loop. The composition is pure: the caller (Block 3b's scene-loop wiring) slices the granted
 *  ledger at the listener's last-asked position (stored in `sinceBase`), resolves presence into
 *  `present`, and computes `cannotHear` from the listener's own CANNOT list with the same
 *  canonical sense matching the sense lint uses (`canonSkill(limit) === "hearing"`) — reuse rather
 *  than restate.
 */
/** One line/deed the writer has actually been granted this scene. Speech is what reached listeners. */
export interface GrantedLine { character: string; speech?: string; }
/** One listener's standing for one ask: who they are, whether they can hear, and where their
 *  knowledge stops. The caller slices the ledger window before calling, so the pure function
 *  itself never reads any index. */
export interface HeardListener {
  /** The asked character's authored name, for exclusion and reporting. */
  name: string;
  /** Every name currently perceivable to them, as the scene's own roster spellings. */
  present: readonly string[];
  /** Presence and CANNOT combined by the caller: true when this listener cannot hear speech. */
  cannotHear: boolean;
}

/** The verbatim block for one listener, ready for the ask's [WHAT YOU HEARD] render. */
export interface HeardBlock {
  /** `[NAME, "line"]` pairs in scene order — the caller renders them; this module decides only
   *  what is in. Empty when nothing qualifies. */
  lines: [string, string][];
}

/** True when `listener` may perceive speech from `speaker` this scene: the speaker is among the
 *  names present, the listener is not deaf (`cannotHear`, computed by the caller the way the
 *  sense lint matches restricted senses — reuse rather than restate), and the speaker is not the
 *  listener themself. */
const perceives = (l: HeardListener, speaker: string): boolean =>
  !sameName(l.name, speaker) && l.present.some(who => sameName(who, speaker));

/** The verbatim block of what `listener` heard since they were last asked: every granted line of
 *  speech from a present, perceivable speaker other than themself, in ledger order, from the
 *  piece position they last listened at. Pure: same inputs, same block, no model call.
 *
 *  Presence modes and hearing restrictions are resolved by the caller into `present` and
 *  `cannotHear` — a remote speaker's words reach a listener only when the caller put the speaker
 *  in `present`, which is where `via` (a phone line, a radio) and `partial` semantics belong.
 *  Returns an empty block when nothing qualifies; the caller renders nothing for it. */
export function heardBlock(listener: HeardListener, ledger: readonly GrantedLine[]): HeardBlock {
  const lines: [string, string][] = [];
  if (listener.cannotHear) return { lines };
  for (const g of ledger) {
    const speech = g.speech ?? "";
    if (!speech) continue;
    if (!perceives(listener, g.character)) continue;
    lines.push([g.character, speech]);
  }
  return { lines };
}

