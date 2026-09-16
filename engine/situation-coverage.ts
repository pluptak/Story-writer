/** SITUATION-COVERAGE — the measurement behind the re-consult entry in docs/PLANS.md: does a
 *  re-consult's situation already carry what happened since the character was last asked?
 *
 *  A character consulted at step 2 and again at step 24 has no durable record of the intervening
 *  page except whatever the writer happens to put in the new `situation` (docs/PLANS.md, Open
 *  design questions). Before building any new memory path, this module measures the existing
 *  channel: for every lone re-consult that follows real page progress, did its situation reference
 *  the intervening consequences?
 *
 *  Leaf tier, like `quote-lint.ts`: pure text scoring over a minimal event sequence, no engine
 *  dependencies (only `config-util.ts` for name matching). It is measurement, never a gate — the
 *  thresholds below are reporting heuristics, and every miss prints verbatim to be read.
 *
 *  Two signals:
 *  - **strict**: another character's intervening granted speech re-appears in the situation
 *    (normalized token recall ≥ STRICT_RECALL). Another's line is news this character would have
 *    to have perceived to act on — and speech is the one consequence with a mechanically
 *    checkable surface, the same matching `lintQuotations` uses, applied to the situation instead
 *    of the page. The character's OWN speech is excluded: it knows what it said, so a situation
 *    that fails to echo it back misses nothing.
 *  - **loose**: content-word recall of ALL intervening material (draft prose, granted actions,
 *    fired world beats) in the situation ≥ LOOSE_RECALL. Deeds and events have no quotable surface,
 *    so this is a human-read signal with a number attached, not a verdict.
 *
 *  Staleness is counted in **prose pieces** since the character's last consult, not steps: refusals
 *  and empty turns move no page and create no expectations. Only `attempt === 1` consults are
 *  scored (a judge retry re-asks the same beat with no draft between attempts). Fan-out reactions
 *  are excluded on both sides — they follow a shared-moment rule, and whatever they put on the
 *  page already arrives via draft prose. The denominator for the pre-registered 70% rule is
 *  re-consults with ≥ 1 intervening piece whose previous consult was answered.
 */
import { nameKey } from "./config-util.ts";

/** The minimal event shapes this measurement reads. Field names match `RunEvent` (`engine/scene-loop.ts`);
 *  a caller maps the full events onto these (fan-out and judge events are simply not mapped). */
export type CoverageEvent =
  | { t: "consult"; character: string; situation: string; attempt?: number }
  | { t: "accept"; character: string; speech: string; action: string }
  | { t: "draft"; prose: string }
  | { t: "world_beat"; beat: string };

/** Normalized token recall of `needles`' content words in `haystack` — the strict speech check. */
const STRICT_RECALL = 0.5;
/** Content-word recall of all intervening material in the situation — the loose page check. */
const LOOSE_RECALL = 0.4;

const STOP = new Set((
  "a,an,the,and,or,but,of,at,by,for,with,to,from,in,on,into,over,after,before," +
  "is,are,was,were,be,been,being,do,does,did,have,has,had,not,no,nor,so,as,it,its," +
  "he,him,his,she,her,hers,they,them,their,theirs,you,your,yours,we,our,ours,i,my,me," +
  "this,that,these,those,there,here,what,when,where,which,who,whom,how,will,would," +
  "can,could,should,shall,may,might,must,just,very,still,already,even,only,also,than," +
  "then,now,out,up,down,off,own,say,said,says"
).split(","));

/** Content words: lowercased, de-punctuated, stopwords and short tokens dropped. Names survive —
 *  a situation naming RIVEN after RIVEN acted IS coverage, and dropping names would blind the
 *  measure to exactly the reference it most needs to see. */
export function contentWords(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
    .filter(w => w.length >= 3 && !STOP.has(w));
}

/** Fraction of `needles`' content words present in `haystack` (1 when there is nothing to find —
 *  an empty speech demands no reference). */
export function recall(needles: string, haystack: string): number {
  const need = contentWords(needles);
  if (!need.length) return 1;
  const have = new Set(contentWords(haystack));
  let hit = 0;
  for (const w of need) if (have.has(w)) hit++;
  return hit / need.length;
}

/** One intervening item and whether the situation referenced it. */
export interface CoverageItem {
  kind: "speech" | "action" | "prose" | "beat";
  character: string;
  text: string;
  covered: boolean;
  score: number;
}

/** One scored re-consult: the situation, how stale the character was, and the item breakdown. */
export interface CoverageVerdict {
  character: string;
  situation: string;
  piecesSince: number;
  answeredSince: boolean;
  covered: boolean;
  looseScore: number;
  items: CoverageItem[];
}

/**
 * Score every lone re-consult in the sequence. First consults per character are not verdicts
 * (nothing intervened); consults with no intervening prose are reported with an empty item list
 * and `covered: true` — a fresh beat needs no backward reference, and counting it as a miss
 * would punish the writer for exactly the contact the loop wants.
 */
export function scoreCoverage(events: CoverageEvent[]): CoverageVerdict[] {
  const verdicts: CoverageVerdict[] = [];
  // Per character: event index of the last consult, and whether it was answered since. A consult
  // that was never answered creates no expectations, so its successor is reported but excluded
  // from the decision denominator (answeredSince: false).
  const contact = new Map<string, { at: number; answered: boolean }>();

  events.forEach((e, i) => {
    if (e.t === "consult" && (e.attempt ?? 1) === 1) {
      const key = nameKey(e.character);
      const prev = contact.get(key);
      if (prev) {
        verdicts.push(scoreOne(e.character, e.situation, events.slice(prev.at + 1, i), prev.answered));
      }
      contact.set(key, { at: i, answered: false });
    } else if (e.t === "accept") {
      const c = contact.get(nameKey(e.character));
      if (c) c.answered = true;
      // An accept with no consult on record is not contact: the next consult for them is scored
      // as a first consult (no verdict), never as a re-consult of an unknown beat.
    }
  });
  return verdicts;
}

function scoreOne(character: string, situation: string, between: CoverageEvent[],
                  answeredSince: boolean): CoverageVerdict {
  const piecesSince = between.filter(e => e.t === "draft" && e.prose.trim()).length;
  const items: CoverageItem[] = [];

  if (piecesSince === 0) {
    return { character, situation, piecesSince, answeredSince, covered: true, looseScore: 1, items };
  }

  // Strict per granted speech — other characters' lines only. One's own line is no news to
  // oneself; another's line reaching the page unmentioned is the candidate the human read checks.
  for (const e of between) {
    if (e.t !== "accept" || !e.speech.trim()) continue;
    if (nameKey(e.character) === nameKey(character)) continue;
    const s = recall(e.speech, situation);
    items.push({ kind: "speech", character: e.character, text: e.speech, covered: s >= STRICT_RECALL, score: s });
  }
  // Loose per item, for the human read: actions, fired beats, and each prose piece.
  for (const e of between) {
    if (e.t === "accept" && e.action.trim()) {
      const s = recall(e.action, situation);
      items.push({ kind: "action", character: e.character, text: e.action, covered: s >= LOOSE_RECALL, score: s });
    } else if (e.t === "world_beat" && e.beat.trim()) {
      const s = recall(e.beat, situation);
      items.push({ kind: "beat", character: "", text: e.beat, covered: s >= LOOSE_RECALL, score: s });
    } else if (e.t === "draft" && e.prose.trim()) {
      const s = recall(e.prose, situation);
      items.push({ kind: "prose", character: "", text: e.prose.slice(0, 160), covered: s >= LOOSE_RECALL, score: s });
    }
  }

  const pooled = between
    .map(e => {
      if (e.t === "accept") return `${e.speech} ${e.action}`;
      if (e.t === "draft") return e.prose;
      if (e.t === "world_beat") return e.beat;
      return "";
    })
    .join(" ");
  const looseScore = recall(pooled, situation);
  const strictOk = items.filter(x => x.kind === "speech").every(x => x.covered);
  return { character, situation, piecesSince, answeredSince, covered: strictOk && looseScore >= LOOSE_RECALL, looseScore, items };
}
