/** SITUATION-LINT — the input-side mirror of quote-lint.ts.
 *
 * The heard channel (engine/heard.ts) delivers a character's granted speech verbatim under
 * [WHAT YOU HEARD], separately from the situation — but the first live run under
 * `--heard-channel` showed six of seven heard-carrying asks ALSO paraphrasing the same speech
 * in the Situation line, the writer's retelling arriving first and the line beside it. The
 * worst reported a compromise the speaker never proposed, delivered as ground truth.
 *
 * Paraphrase is not mechanically decidable, but reported speech is: this module fires on a
 * reporting construction whose subject is another cast member or `you` — a closed,
 * evidence-grown list in the shape of quote-lint's SOURCE_FRAMES, not a general paraphrase
 * detector. The bare fact that someone spoke is circumstance and stays allowed ("Mara spoke",
 * "you hear her voice"); what they said is the heard block's job.
 *
 * Three deliberate limits keep this conservative, because a refusal costs the writer a step:
 *
 *  - **Heard-gated.** Runs only when the ask carries a non-empty heard block: with nothing
 *    to double-deliver there is nothing to catch, and a scene's opening consult stays free
 *    to set the scene.
 *  - **Subject-anchored.** The reporting verb counts only when another cast member governs
 *    it: by name ("Mara answered that"), by a subject pronoun exactly one of them declares
 *    ("she answered that"), or by the addressee ("you asked about"). The pronoun route is
 *    what the first live run demanded — three of its four missed recaps pronominalise the
 *    person the previous sentence named, which is simply how the writer writes. Left alone:
 *    a pronoun no cast member declares, one two of them share, and the asked character's
 *    own, because reporting your own speech is not double-delivering someone else's and the
 *    heard block never carries it back to them. The cost of the pronoun route is a third
 *    person standing for someone off the cast ("he is pressing you to open the door"), which
 *    refuses a clean situation and costs the writer a step; the name-only rule that avoided
 *    it missed four of the run's seven asks, which is the worse trade.
 *  - **Closed frame list.** REPORT_FRAMES holds only constructions a live run actually
 *    showed recapping heard speech, each addition's reason written down. Anything finer
 *    ("or"-style paraphrase matching) misses the decidable shape and invents refusals.
 *
 * This file imports nothing from the engine past config-util.ts: pure text matching, so it
 * stays a leaf the consult gate can call with no model, no fetch and no loop. */

import { sameName } from "../config-util.ts";

export interface SituationLintHit { ok: false; why: string; character: string; match: string; }

/** The heard block as carried on the ask — re-declared locally to keep this file a leaf
 *  (it only needs the lines it gates on). */
export interface HeardLines { lines: [string, string][]; }

/** Who a reporting verb may be anchored to: a bare name, or a name with the declared pronouns
 *  already on the schema and already read by pronoun-lint.ts and quote-lint.ts, so a pronoun
 *  subject resolves instead of being skipped. */
export type SubjectRef = string | { name: string; pronouns?: { subject: string } };

/** Reporting constructions a live run showed recapping heard speech in the situation, one
 *  per offending ask of the calibration run (the-healer-s-cell 2026-09-18T06-24-52-772Z):
 *  `answered that`, `asking if`, `asked about`, `countered by`, `pressing you to`, `offered`.
 *  Grown only on live evidence, like SOURCE_FRAMES — a construction not on this list is a
 *  miss, and a miss is the cheap failure beside a refusal of a clean situation. */
const REPORT_FRAMES = [
  "answered that",
  "asking if",
  "asked about",
  "countered by",
  "pressing you to",
  "offered",
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const FRAME_ALT = REPORT_FRAMES
  .map(f => f.split(" ").map(escapeRe).join("\\s+"))
  .join("|");

/** How far after a subject a reporting verb may sit and still be governed by it. The first
 *  live run's widest real gap is 56 characters — "Rowan is standing just outside the bars,
 *  leaning in close and asking if" — which 40 missed, so this clears that with margin rather
 *  than sitting on it. Two other guards keep the reach from borrowing the next clause's
 *  subject: sentence punctuation ends it regardless, as in sense-lint, and an intervening
 *  cast name disqualifies the match outright. */
const SUBJECT_WINDOW = 80;

/**
 * The mechanical reported-speech check. Returns the first recap found, or null when the
 * situation carries circumstance without recapping speech the heard block already carries.
 *
 * `character` is the asked character (subjects naming them are excluded); `cast` is the
 * roster a reporting subject is matched against, as bare names or names with their declared
 * pronouns; `heard` is the ask's own block — empty or absent means nothing to double-deliver
 * and the check passes silently.
 */
export function lintReportedSpeech(
  situation: string,
  character: string,
  cast: readonly SubjectRef[] = [],
  heard?: HeardLines,
): SituationLintHit | null {
  const s = situation.trim();
  if (!s || !character.trim()) return null;
  if (!heard || !heard.lines.length) return null;

  const entries = cast.map(c => typeof c === "string" ? { name: c } : c)
    .filter(e => e.name.trim());
  const castNames = entries.map(e => e.name);
  const others = entries.filter(e => !sameName(e.name, character));
  const ownSubject = entries.find(e => sameName(e.name, character))
    ?.pronouns?.subject.trim().toLowerCase();

  // A subject pronoun stands for a cast member only when exactly one of them declares it and
  // it is not the asked character's own: two sharing it names nobody, and their own names
  // themselves. Undeclared pronouns resolve to nobody at all, so a story that declares none
  // gets the name-only behaviour and no invented refusals.
  const claims = new Map<string, number>();
  for (const e of others) {
    const p = e.pronouns?.subject.trim().toLowerCase();
    if (p) claims.set(p, (claims.get(p) ?? 0) + 1);
  }
  const pronounSubjects = [...claims]
    .filter(([p, n]) => n === 1 && p !== ownSubject && p !== "you")
    .map(([p]) => p);

  // The addressee themself may also be the reporting subject ("you asked about") — named
  // for the state like sense-lint's second person, not imported from anywhere above this leaf.
  const subjects = [...others.map(e => e.name), ...pronounSubjects, "you"];

  for (const subject of subjects) {
    const re = new RegExp(
      `\\b${escapeRe(subject)}\\b([^.!?;:\\n]{0,${SUBJECT_WINDOW}}?)\\b(?:${FRAME_ALT})\\b`,
      "gi",
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      // Another name between subject and verb means the verb's governor is not decidable
      // mechanically ("you watched Mara answer that" is Mara's, not yours) — skip, as
      // sense-lint's hasOtherName does for perception verbs.
      const intervenes = castNames.some(n => n.trim() && !sameName(n, subject)
        && new RegExp(`\\b${escapeRe(n.trim())}\\b`, "i").test(m![1]));
      if (intervenes) continue;
      const match = m[0].trim();
      return {
        ok: false,
        why: `reported speech: ${character}'s situation retells speech ("${match}")`
          + ` the heard block already carries verbatim`,
        character,
        match,
      };
    }
  }
  return null;
}
