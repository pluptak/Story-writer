/** SENSE-LINT — the mechanical restricted-sense half of the narration lint.
 *
 * A CANNOT is absolute and governs narration as much as answers, but the LLM half of the lint has
 * never enforced it: across five live runs it returned {"ok": true} on every piece, including
 * "Marsh watches them from his corner" for a character with `restrictions: ["sight"]` — the
 * narration prompt's own worked example. Restricted senses are mechanically tractable in a way
 * deeds are not: a CANNOT list is a closed set of names, and the verbs that break a sense are
 * enumerable.
 *
 * Two deliberate limits keep this conservative, because a mechanical flag has no model to soften it
 * and spends the scene's one redraft:
 *
 *  - **Subject-anchored, by name only.** A verb counts only when the character's own name governs
 *    it ("Marsh watches"); a pronoun subject ("she watches") is left to the LLM half. Missing a
 *    violation is the cheap failure; inventing one is not.
 *  - **Literal verbs only.** `see` and `saw` carry most figurative sight ("see what he meant") and
 *    are left out entirely — a measured trade-off, settled after the doorway runs of 2026-08-27
 *    put both sides on the page (the figurative "waiting to see if he moves away" passed, the
 *    literal "wide enough for Merritt to see them" leaked). What is listed is what the prompt
 *    itself names: watching, glancing, gazing, and their siblings. The `observ*` family joined
 *    `sight` deliberately — a live run sent a blind character six situations phrased around sight,
 *    one carrying "observing their hands at the lock"; growing the family beat accepting that as a
 *    known miss, and the table is shared, so the prose lint flags the same words. The `look` family
 *    joined the same way, gated: "look up", "look down", "looks at" are as literal as "watches",
 *    but bare `look` is as often copular as perceiving ("looks tired", "looks like", "looks to"),
 *    so it counts only with a directional particle (GATED_LOOK; the "look up to" idiom is refused
 *    by the same gate). Two noun-uses survive the gate and are exculpated: the determiner guard
 *    catches "his look at the door", and NOUN_TAIL catches "gave her a long look at".
 *  - **The possessive noun is read, not just skipped.** The determiner guard exculpates every
 *    possessive before a verb spelling — right for "returned her glance", wrong for "Merritt's
 *    gaze travels down the line of keys", where the noun is the subject of an action and the
 *    sentence is the act. So the prose check adds a pass keyed to the name-possessive form
 *    (NOUN_PREDICATES below): noun first, action predicate after, nothing between but an -ly
 *    adverb or "then". Name-possessive only — a bare pronoun possessive ("his gaze remains fixed")
 *    is as unresolved as a pronoun subject and stays with the LLM half — and prose only: in a
 *    situation the second-person possessive is already the incriminating form, and this pass must
 *    not change what that check does with `your`.
 *
 * Scope is the five perception senses. `speech` and `movement` are restrictable too but are not
 * here: dialogue is already the quote lint's, and a movement verb list would catch every metaphor
 * that walks or steps.
 *
 * The situation sibling, `lintRestrictedSituation`, points the same tables at a consult's
 * situation, where the addressee is known and only their own limits apply. Both rules flip there:
 * the anchor is second person (`you`, `your`) rather than the character's name, and the determiner
 * rule inverts — "under your gaze" is precisely the incriminating form, where in prose `your`
 * before a verb spelling exculpates. The conservative direction is unchanged: a miss is the cheap
 * failure, because a refusal costs the writer a step.
 *
 * One rule does not carry across, and INCAPACITY_TAIL is where: a situation saying the sense is
 * gone ("you cannot look at them, but you can hear their voice clearly") is the writer rendering
 * the character through what they DO have — what it was asked for. On the page that same sentence
 * is still a flag: narrating the sense at all is the defect there. Ordinary negation is untouched
 * on both sides.
 */
import { canonSkill } from "./skills.ts";

export interface SenseLintHit { ok: false; why: string; character: string; sense: string; verb: string; match: string; }

/** Verbs that can only mean perceiving through the sense they are filed under, keyed by the
 *  canonical sense name in SKILL_CATALOG. Nouns sharing a spelling with their verb (`eye`, `glance`
 *  as "a glance") are handled by the determiner guard below, not by omission. */
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

/** Sense NOUNS that are perception when possessed — read two ways: in a situation, where the
 *  second-person possessive is how a situation is written ("under your gaze"), and in prose, where
 *  the name-possessive with an action predicate is the act ("Merritt's gaze travels").
 *  Deliberately narrow: "your look" is an appearance, "your view" an opinion, "your watch" a
 *  timepiece; a miss is the cheap failure here too. */
const SENSE_NOUNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  sight: ["gaze", "gazes", "glance", "glances", "stare", "stares", "peek", "peeks"],
  hearing: [],
  smell: [],
  taste: [],
  touch: [],
});

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The `look` family, gated: only with a directional particle following is "look" the act. Bare
 *  "looks" is as often copular as perceiving ("looks tired", "looks like", "looks to"), so the
 *  ungated form is deliberately absent — the miss is the cheap failure. "Up" carries its own guard:
 *  "looked up to Riven" is the admire idiom, not a gaze, while "looked up at" and "looked up to the
 *  ceiling" are literal. Refusing both costs a miss; inventing the first costs a flag. */
const LOOK_PARTICLES = "down|at|towards?|around|over|back|away|into|through|across|past|out";
const GATED_LOOK =
  `look(?:s|ed|ing)?\\s+(?:${LOOK_PARTICLES})\\b` +
  `|look(?:s|ed|ing)?\\s+up\\b(?!\\s+to\\b)`;

/** The verb alternation for a canonical sense — the sense's own table, plus the gated `look` family
 *  on sight. Shared by the prose and situation checks so both flag the same words the same way. */
const verbSource = (sense: string): string | null => {
  const verbs = SENSE_VERBS[sense];
  if (!verbs) return null;
  return sense === "sight" ? `${verbs.join("|")}|${GATED_LOOK}` : verbs.join("|");
};

/** A word that turns the verb spelling into a noun the character is not necessarily using: "Marsh's
 *  eyes", "the smell of smoke", "returned her glance". Checked against the text just before the
 *  candidate — what separates `Marsh watched` from `Marsh flinched at the smell`. */
const DETERMINER = /(?:\b(?:the|a|an|his|her|their|its|our|your|my|of|no|any)\s+|['’]s\s+|s['’]\s+)$/i;

/** The noun use the particle gate lets through: "gave her a long look at the satchel" — an article
 *  or possessive, with at most two adjective-ish words after it, immediately before "look", makes
 *  it a thing rather than an act. Checked like DETERMINER, against the window tail.
 *
 *  `no` carries one exclusion. Unqualified it is the determiner this pass is for ("gave her no
 *  look at the door"), but "can no longer look" is not a noun use at all — the adjective slot
 *  swallowed "longer" and exculpated a sentence the page's own ruling flags, leaving "cannot look
 *  at the door" and "can no longer look at the door" reading differently for no reason anyone
 *  chose. On the page narrating the sense at all is the defect, incapacity included, so both flag
 *  now. Situations are unaffected: INCAPACITY_TAIL reads that phrase there, where saying the sense
 *  is gone is the writer honouring the CANNOT. */
const NOUN_TAIL =
  /(?:\b(?:a|an|the|his|her|their|its|no(?!\s+longer\b)|one|another|this|that)\s+(?:[\w'’-]+,\s*){0,2}[\w'’-]+\s+)$/i;

/** A capacity modal before "look" narrates a possibility, not an act: "held it where Riven could
 *  look at them" is the other character perceiving, "Marsh could look at the door" a capacity the
 *  CANNOT removes. Same window-tail check, same look-scoped conservatism. */
const MODAL_TAIL = /\b(?:could|can|may|might|would|should)\s+$/i;

/** An explicit statement that the sense is gone — "you cannot look at them", "you can no longer
 *  hear the alarm". Situation-side only, and the reason it is not general negation: on the page,
 *  narrating the sense at all is the defect, so "does not look up" stays a flag there. In a
 *  situation the writer is telling the character what they can and cannot perceive, exactly what
 *  `writerSystem` asks for — "Render them through what they DO have". Refusing that inverts the
 *  incentive, and did so unevenly: "You cannot see them, but you can hear their voice clearly"
 *  passed while the same sentence with "look at" was refused, one synonym apart. Ordinary negation
 *  is left alone on both sides; only incapacity is read as honouring the CANNOT rather than
 *  breaking it. */
const INCAPACITY_TAIL =
  /\b(?:cannot|can['’]?t|could\s+not|couldn['’]?t|unable\s+to|no\s+longer(?:\s+\w+)?)\s+$/i;

/** What a sense NOUN does when it is the subject of its clause: "Merritt's gaze travels down the
 *  line of keys" is the act narrated through the noun, while "returned her glance" — verb before
 *  noun, noun as object — is not. A closed list, seeded from the doorway evidence and grown like
 *  the verb table: on live evidence, with the rationale written down. The window between noun and
 *  predicate admits only one -ly adverb or "then", so "Riven met Merritt's gaze and held it" —
 *  gaze as object, Riven acting — cannot match: conjunctions are refused by shape, not enumerated.
 *  Sight only; SENSE_NOUNS has entries for no other sense. */
const NOUN_PREDICATES =
  "travels?|travell?ed|travell?ing" +
  "|settles?|settled|settling" +
  "|remains?|remained|remaining" +
  "|sweeps?|swept|sweeping" +
  "|drops?|dropped|dropping" +
  "|lingers?|lingered|lingering" +
  "|drifts?|drifted|drifting" +
  "|rests?|rested|resting" +
  "|fixes|fixed|fixing" +
  "|holds?|held|holding" +
  "|darts?|darted|darting" +
  "|shifts?|shifted|shifting" +
  "|lifts?|lifted|lifting" +
  "|falls?|fell|falling" +
  "|rises?|rising" +
  "|wanders?|wandered|wandering" +
  "|stays?|stayed|staying" +
  "|moves?|moved|moving";

/** True when a matched `look` is a noun or a capacity use rather than the act. Applies only to
 *  `look` matches: watch, stare and the rest keep the shipped guard's behaviour exactly. */
const lookIsNotTheAct = (window: string): boolean =>
  NOUN_TAIL.test(window) || MODAL_TAIL.test(window);

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
      const verbs = verbSource(sense);
      if (!verbs) continue;   // a restriction with no verb table — a special skill, the LLM half's

      // `NAME <up to SUBJECT_WINDOW chars, no sentence break> VERB`, non-greedy so the nearest verb
      // wins and the window is measured from the name, not from the match.
      const re = new RegExp(
        `\\b${escapeRe(member.name)}\\b([^.!?;:\\n]{0,${SUBJECT_WINDOW}}?)\\b(${verbs})\\b`,
        "gi",
      );
      let m: RegExpExecArray | null;
      while ((m = re.exec(prose))) {
        if (DETERMINER.test(m[1])) continue;
        if (/^look/.test(m[2]) && lookIsNotTheAct(m[1])) continue;
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

      // The possessive-noun pass: `NAME's <sense-noun> <predicate>` is the act narrated through the
      // noun — the prose mirror of the situation lint's "your gaze". Name-possessive and prose
      // only: a pronoun possessive stays with the LLM half like a pronoun subject, and in a
      // situation the second-person possessive is already incriminating, so this pass must not
      // change what that check does with `your`.
      const nouns = SENSE_NOUNS[sense];
      if (nouns?.length) {
        const reNoun = new RegExp(
          `\\b${escapeRe(member.name)}['’]s\\s+(${nouns.join("|")})\\b` +
          `(?:\\s+(?:\\w+ly|then)\\b)?\\s+(${NOUN_PREDICATES})\\b`,
          "gi",
        );
        const mn = reNoun.exec(prose);
        if (mn) {
          return {
            ok: false,
            why: `restricted sense: ${member.name} is shown "${mn[1]} ${mn[2]}" but CANNOT ${limit}`,
            character: member.name,
            sense: limit,
            verb: mn[2],
            match: mn[0],
          };
        }
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

    const verbs = verbSource(sense);
    if (verbs) {
      const re = new RegExp(
        `\\byou\\b([^.!?;:\\n]{0,${SUBJECT_WINDOW}}?)\\b(${verbs})\\b`,
        "gi",
      );
      let m: RegExpExecArray | null;
      while ((m = re.exec(s))) {
        // No determiner guard here — a possessive is the incriminating form in second person — but
        // the gated `look` family keeps its noun/capacity guard: "you give Riven a long look at" is
        // as innocent in a situation as on the page.
        if (/^look/.test(m[2]) && lookIsNotTheAct(m[1])) continue;
        // A situation that states the sense is gone is honouring the CANNOT, not breaking it, and
        // applies to every sense rather than only `look`: "you cannot hear the alarm, but you feel
        // the floor" is the writer doing its job.
        if (INCAPACITY_TAIL.test(m[1])) continue;
        return {
          ok: false,
          why: `restricted sense: ${character}'s situation says "${m[0].trim()}" but CANNOT ${limit}`,
          character,
          sense: limit,
          verb: m[2],
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
