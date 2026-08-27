/** SENSE-LINT — the mechanical restricted-sense half of the narration lint.
 *
 * A CANNOT is absolute and governs narration as much as answers, but the LLM half of the lint has
 * never once enforced it: across five live runs it returned {"ok": true} on every piece, including
 * "Marsh watches them from his corner" for a character carrying `restrictions: ["sight"]` — the
 * narration prompt's own worked example. Restricted senses are mechanically tractable in a way deeds
 * are not: a CANNOT list is a closed set of names, and the verbs that violate a sense are enumerable.
 *
 * Two deliberate limits keep this conservative, because a mechanical flag has no model to soften it
 * and spends the scene's one redraft:
 *
 *  - **Subject-anchored, by name only.** A verb counts only when the character's own name governs it
 *    ("Marsh watches"). A pronoun subject ("she watches") is not resolved and is left to the LLM
 *    half. Missing a violation is the cheap failure here; inventing one is not.
 *  - **Literal verbs only.** `see` and `saw` carry most of the language's figurative sight ("see what
 *    he meant", "saw to it") and are left out entirely. What is listed is what the prompt itself
 *    names: watching, glancing, gazing, and their siblings. The `observ*` family joined `sight`
 *    deliberately — "observing" is as literal as "watching", and a live run sent a blind character
 *    six situations phrased around sight, one carrying "observing their hands at the lock". Growing
 *    the family was chosen over accepting that case as a known miss; the table is shared, so the
 *    prose lint gains it too, where it flags the same violation in the same words.
 *
 * Scope is the five perception senses. `speech` and `movement` are restrictable too but are not here:
 * dialogue is already the quote lint's, and a movement verb list cannot be written without catching
 * every metaphor that walks or steps.
 *
 * The situation sibling, `lintRestrictedSituation`, points the same tables at a consult's situation,
 * where the addressee is known and only their own limits apply. Both rules above flip there: the
 * anchor is second person (`you`, `your`) rather than the character's name, and the determiner rule
 * inverts — "under your gaze" is precisely the incriminating form, where in prose `your` before a
 * verb spelling exculpates. The conservative direction is unchanged: a miss is the cheap failure,
 * because a refusal costs the writer a step.
 */
import { canonSkill } from "./skills.ts";

export interface SenseLintHit { ok: false; why: string; character: string; sense: string; verb: string; match: string; }

/** Verbs that can only be read as perceiving through the sense they are filed under, keyed by the
 *  canonical sense name in SKILL_CATALOG. Nouns that share a spelling with their verb (`eye`,
 *  `glance` as "a glance") are handled by the determiner guard below, not by omission. */
const SENSE_VERBS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  sight: ["watch", "watches", "watched", "watching",
          "observe", "observes", "observed", "observing",
          "glance", "glances", "glanced", "glancing",
          "gaze", "gazes", "gazed", "gazing",
          "stare", "stares", "stared", "staring",
          "peer", "peers", "peered", "peering"],
  hearing: ["hear", "hears", "heard",
            "listen", "listens", "listened", "listening",
            "overhear", "overhears", "overheard", "overhearing"],
  smell: ["smell", "smells", "smelled", "smelt", "smelling",
          "sniff", "sniffs", "sniffed", "sniffing"],
  taste: ["taste", "tastes", "tasted", "tasting"],
  touch: ["touch", "touches", "touched", "touching"],
});

/** Sense NOUNS that are perception when they are the addressee's own — the second-person possessive
 *  is what a situation is written in ("under your gaze"). Deliberately narrow, because "your look"
 *  is an appearance, "your view" an opinion, "your observation" a remark and "your watch" a
 *  timepiece; a miss is the cheap failure here too. */
const SENSE_NOUNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  sight: ["gaze", "gazes", "glance", "glances", "stare", "stares", "peek", "peeks"],
  hearing: [],
  smell: [],
  taste: [],
  touch: [],
});

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A word that turns the verb spelling into a noun the character is not necessarily using: "Marsh's
 *  eyes", "the smell of smoke", "returned her glance". Checked against the text immediately before
 *  the candidate, which is what separates `Marsh watched` from `Marsh flinched at the smell`. */
const DETERMINER = /(?:\b(?:the|a|an|his|her|their|its|our|your|my|of|no|any)\s+|['’]s\s+|s['’]\s+)$/i;

/** How far after a name a verb may sit and still be governed by it — enough for "Marsh, still in his
 *  corner, watches" and short enough that the next clause's subject does not get borrowed. Sentence
 *  punctuation ends the reach regardless. */
const SUBJECT_WINDOW = 40;

/**
 * The mechanical restricted-sense check. Returns the first violation found, or null when the prose
 * narrates nobody perceiving through a sense they have lost.
 *
 * Every cast member is checked, not only the point-of-view character: a CANNOT is absolute, and the
 * live miss this exists for was a non-POV character shown watching.
 */
export function lintRestrictedSenses(
  prose: string,
  cast: ReadonlyArray<{ name: string; cannot: readonly string[] }>,
): SenseLintHit | null {
  if (!prose.trim()) return null;

  for (const member of cast) {
    if (!member.name.trim() || !member.cannot?.length) continue;
    for (const limit of member.cannot) {
      const sense = canonSkill(limit);
      const verbs = SENSE_VERBS[sense];
      if (!verbs) continue;   // a restriction with no verb table — a special skill, the LLM half's

      // `NAME <up to SUBJECT_WINDOW chars, no sentence break> VERB`, non-greedy so the nearest verb
      // wins and the window is measured from the name, not from the match.
      const re = new RegExp(
        `\\b${escapeRe(member.name)}\\b([^.!?;:\\n]{0,${SUBJECT_WINDOW}}?)\\b(${verbs.join("|")})\\b`,
        "gi",
      );
      let m: RegExpExecArray | null;
      while ((m = re.exec(prose))) {
        if (DETERMINER.test(m[1])) continue;
        const verb = m[2];
        return {
          ok: false,
          why: `restricted sense: ${member.name} is shown "${verb}" but CANNOT ${limit}`,
          character: member.name,
          sense: limit,
          verb,
          match: m[0],
        };
      }
    }
  }
  return null;
}

/**
 * The situation sibling: the same verb table, pointed at a consult's situation before it is sent.
 * The addressee is known (`character`), so only their own limits are matched and only in the second
 * person a situation is written in — `you <verb>` within the same reach a name gets in prose, and
 * `your <sense-noun>` for the possessive forms the prose determiner guard would exculpate. Returns
 * the first violation, or null.
 *
 * Third-person clauses about OTHER characters are deliberately out of scope: a situation may describe
 * anyone doing anything, and their perceiving is checked in their own consult or on the page, not
 * here.
 */
export function lintRestrictedSituation(
  situation: string,
  character: string,
  cannot: readonly string[],
): SenseLintHit | null {
  const s = situation.trim();
  if (!s || !character.trim()) return null;

  for (const limit of cannot) {
    const sense = canonSkill(limit);

    const verbs = SENSE_VERBS[sense];
    if (verbs) {
      const re = new RegExp(
        `\\byou\\b[^.!?;:\\n]{0,${SUBJECT_WINDOW}}?\\b(${verbs.join("|")})\\b`,
        "gi",
      );
      let m: RegExpExecArray | null;
      while ((m = re.exec(s))) {
        return {
          ok: false,
          why: `restricted sense: ${character}'s situation says "${m[0].trim()}" but CANNOT ${limit}`,
          character,
          sense: limit,
          verb: m[1],
          match: m[0].trim(),
        };
      }
    }

    const nouns = SENSE_NOUNS[sense];
    if (nouns?.length) {
      const re = new RegExp(`\\byour\\s+(${nouns.join("|")})\\b`, "gi");
      let m: RegExpExecArray | null;
      while ((m = re.exec(s))) {
        return {
          ok: false,
          why: `restricted sense: ${character}'s situation says "${m[0]}" but CANNOT ${limit}`,
          character,
          sense: limit,
          verb: m[1],
          match: m[0],
        };
      }
    }
  }
  return null;
}
