/** CONSTRAINT-LINT — the mechanical half of the scene-constraint gate.
 *
 *  A scene constraint's meaning is free prose, not a catalog name, so matching is weaker than
 *  the restricted-sense lint by construction and will not be exhaustive. The rule is
 *  default-allow: fire only on a high-confidence verb match — a physical verb the meaning bars
 *  performed in the action text — and permit everything else. A miss is acceptable; a false
 *  refusal is not, because a refusal spends a retry on an answer that broke nothing authored.
 *
 *  A restriction is a negated skill — one namespace with a sign — and the matcher reads the
 *  sign, not just the namespace. Barred verbs come only from negated spans: a span opens at a
 *  negation marker and closes at the next polarity flip (`;`, `.`, but/though/however, can
 *  still, remain). Constraint meanings routinely name what the character can still do ("bound
 *  to a chair still permits a shrug"), and verbs outside a negated span are permitted, never
 *  barred. A meaning whose permissive clause was discarded this way warns once, so thin or
 *  oddly-phrased authoring stays visible; a meaning with no assessable verb at all warns the
 *  same way. Both warnings fire once per constraint per scene (see resetConstraintLintWarnings).
 *
 *  One guard keeps the one thing it does catch conservative. An action stating the inability
 *  ("I cannot reach the rope") honours the constraint the way a situation stating a gone sense
 *  honours a CANNOT, so an incapacity-tailed verb is skipped, not fired on. And `see`/`saw` are
 *  absent from the table the way they are in sense-lint.ts: most figurative sight, and an
 *  authored "cannot see" plus "I see what you mean" is a false refusal waiting to happen.
 */
import { warn } from "../warnings.ts";

export interface SceneConstraint { name: string; meaning: string }

export interface ConstraintLintHit {
  ok: false; why: string; character: string; constraint: string; match: string;
}

/** Physical verbs a constraint meaning plausibly bars, with their inflections spelled out —
 *  no stemmer to mistune, the sense-lint table precedent. Deliberately finite: anything outside
 *  it is a miss the judge backstop still sees. */
const CONSTRAINT_VERBS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  bind: ["bind", "binds", "bound", "binding"],
  reach: ["reach", "reaches", "reached", "reaching"],
  handle: ["handle", "handles", "handled", "handling"],
  touch: ["touch", "touches", "touched", "touching"],
  grab: ["grab", "grabs", "grabbed", "grabbing"],
  hold: ["hold", "holds", "held", "holding"],
  take: ["take", "takes", "took", "taken", "taking"],
  pick: ["pick", "picks", "picked", "picking"],
  lift: ["lift", "lifts", "lifted", "lifting"],
  pull: ["pull", "pulls", "pulled", "pulling"],
  push: ["push", "pushes", "pushed", "pushing"],
  open: ["open", "opens", "opened", "opening"],
  close: ["close", "closes", "closed", "closing"],
  move: ["move", "moves", "moved", "moving"],
  walk: ["walk", "walks", "walked", "walking"],
  run: ["run", "runs", "ran", "running"],
  stand: ["stand", "stands", "stood", "standing"],
  sit: ["sit", "sits", "sat", "sitting"],
  rise: ["rise", "rises", "rose", "risen", "rising"],
  kneel: ["kneel", "kneels", "knelt", "kneeling"],
  turn: ["turn", "turns", "turned", "turning"],
  cross: ["cross", "crosses", "crossed", "crossing"],
  enter: ["enter", "enters", "entered", "entering"],
  leave: ["leave", "leaves", "left", "leaving"],
  climb: ["climb", "climbs", "climbed", "climbing"],
  carry: ["carry", "carries", "carried", "carrying"],
  throw: ["throw", "throws", "threw", "thrown", "throwing"],
  drop: ["drop", "drops", "dropped", "dropping"],
  break: ["break", "breaks", "broke", "broken", "breaking"],
  hit: ["hit", "hits", "hitting"],
  strike: ["strike", "strikes", "struck", "striking"],
  seize: ["seize", "seizes", "seized", "seizing"],
  grip: ["grip", "grips", "gripped", "gripping"],
  grasp: ["grasp", "grasps", "grasped", "grasping"],
  press: ["press", "presses", "pressed", "pressing"],
  squeeze: ["squeeze", "squeezes", "squeezed", "squeezing"],
  tie: ["tie", "ties", "tied", "tying"],
  untie: ["untie", "unties", "untied", "untying"],
  lock: ["lock", "locks", "locked", "locking"],
  unlock: ["unlock", "unlocks", "unlocked", "unlocking"],
  knock: ["knock", "knocks", "knocked", "knocking"],
  kick: ["kick", "kicks", "kicked", "kicking"],
  step: ["step", "steps", "stepped", "stepping"],
  crawl: ["crawl", "crawls", "crawled", "crawling"],
  flee: ["flee", "flees", "fled", "fleeing"],
  escape: ["escape", "escapes", "escaped", "escaping"],
  speak: ["speak", "speaks", "spoke", "spoken", "speaking"],
  say: ["say", "says", "said", "saying"],
  tell: ["tell", "tells", "told", "telling"],
  talk: ["talk", "talks", "talked", "talking"],
  shout: ["shout", "shouts", "shouted", "shouting"],
  whisper: ["whisper", "whispers", "whispered", "whispering"],
  call: ["call", "calls", "called", "calling"],
  hear: ["hear", "hears", "heard", "hearing"],
  listen: ["listen", "listens", "listened", "listening"],
  eat: ["eat", "eats", "ate", "eaten", "eating"],
  drink: ["drink", "drinks", "drank", "drunk", "drinking"],
  write: ["write", "writes", "wrote", "written", "writing"],
  read: ["read", "reads", "reading"],
  light: ["light", "lights", "lit", "lighting"],
  pour: ["pour", "pours", "poured", "pouring"],
});

const SPELL_TO_BASE = new Map<string, string>();
for (const [base, spellings] of Object.entries(CONSTRAINT_VERBS))
  for (const spelling of spellings) SPELL_TO_BASE.set(spelling, base);

/** Verb bases the text performs, in order. Anything outside the table is not a verb here. */
function performedVerbs(text: string): { base: string; spelling: string; index: number }[] {
  const out: { base: string; spelling: string; index: number }[] = [];
  const re = /\b([a-z]+)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const base = SPELL_TO_BASE.get(m[1].toLowerCase());
    if (base) out.push({ base, spelling: m[1], index: m.index });
  }
  return out;
}

/** Stating the inability is honouring the constraint, not breaking it. */
const INCAPACITY_BEFORE = /\b(can ?not|cannot|can['’]t|could ?not|couldn['’]t|unable\s+to|never|won['’]t|will\s+not)\s*$/i;

/** A negated span opens here — the author taking something away. */
const NEGATION_OPEN = /\b(can ?not|cannot|can['’]t|could ?not|couldn['’]t|no\s+longer|unable\s+to|never)\b/gi;

/** ... and closes at the next polarity flip — everything past it is permitted, not barred. */
const POLARITY_FLIP = /[;.]|\b(but|though|however)\b|\bcan\s+still\b|\bremains?\b/gi;

function spanEnds(text: string): number[] {
  const out: number[] = [];
  POLARITY_FLIP.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = POLARITY_FLIP.exec(text))) out.push(m.index);
  return out;
}

/** The verb bases the meaning bars, plus whether a permissive clause was discarded to get
 *  them — text past a flip the matcher does not assess. */
function barredVerbs(meaning: string): { barred: Set<string>; permissive: boolean } {
  const barred = new Set<string>();
  const ends = spanEnds(meaning);
  NEGATION_OPEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NEGATION_OPEN.exec(meaning))) {
    const end = ends.find(e => e > m!.index) ?? meaning.length;
    for (const v of performedVerbs(meaning.slice(m.index, end))) barred.add(v.base);
  }
  const permissive = ends.some(e => meaning.slice(e + 1).trim().length > 0);
  return { barred, permissive };
}

/** Warning state, keyed by answerer and constraint: the condition is authored once per scene
 *  but answers arrive many times a scene, so without this one vague constraint warns every
 *  turn. A leaf cannot see scene boundaries — the scene owner (Chunk 3 wiring, at scene start)
 *  calls resetConstraintLintWarnings, which is what makes this per-scene rather than
 *  per-process. Keyed by character as well as name because two characters can carry
 *  same-named constraints with different meanings. */
const warnedKeys = new Set<string>();

export function resetConstraintLintWarnings(): void {
  warnedKeys.clear();
}

function warnOnce(character: string, name: string, msg: string): void {
  const key = `${character}::${name}`;
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  warn(msg);
}

/**
 * Whether the character's action violates one of their active scene constraints: the first
 * high-confidence verb hit, or null. A spoken-only answer (empty action) permits silently —
 * there is nothing to assess. A meaning with no barred verb, or one whose permissive clause
 * was discarded, permits with a warning, never a refusal.
 */
export function lintConstraintAction(
  action: string,
  character: string,
  constraints: readonly SceneConstraint[],
): ConstraintLintHit | null {
  const text = action.trim();
  if (!text || !character.trim()) return null;
  const done = performedVerbs(text);

  for (const c of constraints) {
    if (!c.name) continue;
    const { barred, permissive } = barredVerbs(c.meaning);
    if (!barred.size) {
      if (text) warnOnce(character, c.name,
        `   (character ${character}: constraint "${c.name}" carries no assessable verb — permitting "${text.slice(0, 80)}")`);
      continue;
    }
    if (permissive) warnOnce(character, c.name,
      `   (character ${character}: constraint "${c.name}" also permits what its flip clause names — assessing only the barred part)`);
    for (const v of done) {
      if (!barred.has(v.base)) continue;
      if (INCAPACITY_BEFORE.test(text.slice(0, v.index))) continue;
      return {
        ok: false,
        why: `constraint: ${character}'s action "${v.spelling}" breaks "${c.name} :: ${c.meaning}"`,
        character,
        constraint: c.name,
        match: v.spelling,
      };
    }
  }
  return null;
}

