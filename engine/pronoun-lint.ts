/** PRONOUN-LINT — observe-only mechanical check: does the writer's own prose contradict a
 *  character's declared pronoun set?
 *
 *  Block B of the pronoun-drift entry (docs/PLANS.md): this module only detects and reports
 *  (`narration_pronoun_flag`); nothing gates on it yet. Same conservative bias as sense-lint.ts,
 *  its closest sibling — a miss costs nothing, a false positive would spend the scene's one
 *  redraft on valid prose, so every guard below favours silence.
 *
 *  Two guards, both required:
 *  - **Subject-anchored, by name only** (sense-lint.ts's SUBJECT_WINDOW pattern): a pronoun word
 *    counts only when a character's own name governs it within the same clause, no sentence
 *    break between them.
 *  - **Single-character sentences only.** If any OTHER cast member's name also appears anywhere
 *    in the enclosing sentence, the pronoun's antecedent is not decidable mechanically — skip.
 *    This is what keeps "Merritt and Riven stood, their breath visible" and "Riven watched
 *    Merritt lift his bag" both silent: a compound or cross-referring subject is exactly the case
 *    a name-only anchor cannot resolve, and inventing a flag there is the failure mode this whole
 *    module exists to avoid.
 *
 *  Quoted dialogue is stripped before matching — a character's own words are never narration, and
 *  a second-person address inside dialogue or a situation is a different check's job
 *  (prompts/writer.ts's person clause, not this).
 */
import { nameKey } from "./config-util.ts";

export interface PronounSet { subject: string; object: string; possessive: string; reflexive: string }

export interface PronounLintHit {
  ok: false;
  why: string;
  character: string;
  found: string;
  declared: PronounSet;
  match: string;
}

// The standard English personal-pronoun vocabulary this module recognizes as "a pronoun word" even
// when it belongs to nobody's declared set in this cast (so a two-character cast where only one
// side declared pronouns still catches "her" showing up for a declared "he"). Any custom word a
// cast member actually declares (a neopronoun) is unioned in per-check, so an authored set outside
// this list is still recognized once it is declared for at least one character.
const STANDARD_PRONOUNS = [
  "he", "she", "they",
  "him", "her", "them",
  "his", "their", "hers", "theirs",
  "himself", "herself", "themself", "themselves",
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SUBJECT_WINDOW = 40;

/** Strip quoted dialogue so a character's own second-person or off-pronoun speech is never read
 *  as narration. Straight and curly double quotes both open and close a span here -- live prose
 *  routinely comes back with curly quotes ("“...”"), and a stripper that only recognized
 *  straight ones would read that whole line as narration, exactly the false positive this module
 *  exists to avoid. */
function stripQuotes(prose: string): string {
  return prose.replace(/["“][^"”]*["”]/g, m => " ".repeat(m.length));
}

/** The sentence enclosing the match at [start, end) in `text` — bounded by the same punctuation
 *  sense-lint.ts's SUBJECT_WINDOW respects, or the string edges. Used to test for a second cast
 *  name anywhere in the same sentence, not just the name-to-pronoun window. */
function enclosingSentence(text: string, start: number, end: number): string {
  const before = text.slice(0, start);
  const boundary = Math.max(before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"),
                             before.lastIndexOf(";"), before.lastIndexOf(":"), before.lastIndexOf("\n"));
  const afterText = text.slice(end);
  const relEnd = afterText.search(/[.!?;:\n]/);
  const stop = relEnd === -1 ? text.length : end + relEnd;
  return text.slice(boundary + 1, stop);
}

/**
 * The mechanical pronoun check, observe-only. Returns the first mismatch found in `prose`, or
 * null.
 *
 * Every cast member with a declared `pronouns` set is checked. A cast member with none declared is
 * silently skipped — there is no ground truth to check drift against.
 */
export function lintPronouns(
  prose: string,
  cast: ReadonlyArray<{ name: string; pronouns?: PronounSet }>,
): PronounLintHit | null {
  if (!prose.trim()) return null;
  const clean = stripQuotes(prose);

  // The recognized pronoun vocabulary for THIS cast: the standard list plus every declared word,
  // lowercased — so a custom/neopronoun set is still recognized once anyone declares it. Sorted
  // longest-first so "themselves" is tried before "them" in the alternation.
  const vocab = new Set(STANDARD_PRONOUNS);
  for (const c of cast) {
    if (!c.pronouns) continue;
    for (const w of Object.values(c.pronouns)) vocab.add(w.toLowerCase());
  }
  const vocabAlt = [...vocab].sort((a, b) => b.length - a.length).map(escapeRe).join("|");

  for (const member of cast) {
    if (!member.name.trim() || !member.pronouns) continue;
    const own = new Set(Object.values(member.pronouns).map(w => w.toLowerCase()));

    // Find all name occurrences, then check pronouns within each window
    const nameRegex = new RegExp(`\\b${escapeRe(member.name)}\\b`, "gi");
    let nameMatch: RegExpExecArray | null;

    while ((nameMatch = nameRegex.exec(clean))) {
      const nameStart = nameMatch.index;
      const windowStart = nameStart + nameMatch[0].length;
      const windowEnd = Math.min(windowStart + SUBJECT_WINDOW, clean.length);

      // Don't cross sentence boundaries
      const sentenceEnd = clean.slice(windowStart).search(/[.!?;:\n]/);
      const actualWindowEnd = sentenceEnd === -1 ? windowEnd : Math.min(windowStart + sentenceEnd, windowEnd);

      const window = clean.slice(windowStart, actualWindowEnd);

      // Find pronouns in this window
      const pronounRegex = new RegExp(`\\b(${vocabAlt})\\b`, "gi");
      let pronounMatch: RegExpExecArray | null;
      while ((pronounMatch = pronounRegex.exec(window))) {
        const found = pronounMatch[1].toLowerCase();
        if (own.has(found)) continue;   // matches the character's own declared set — not a drift

        const pronounEnd = windowStart + pronounMatch.index + pronounMatch[0].length;
        const matchStart = nameStart;
        const matchEnd = pronounEnd;

        // Check for ambiguity: if any OTHER cast member's name appears in the sentence,
        // the antecedent is not decidable mechanically (e.g., "Merritt watched Riven lift his bag"
        // where "his" could refer to either). Check the entire enclosing sentence.
        const sentence = enclosingSentence(clean, matchStart, matchEnd);
        const others = cast.filter(c => nameKey(c.name) !== nameKey(member.name) && c.name.trim());
        const ambiguous = others.some(c => new RegExp(`\\b${escapeRe(c.name)}\\b`, "i").test(sentence));
        if (ambiguous) continue;
        const declaredElsewhere = others.filter(c => c.pronouns
          && Object.values(c.pronouns).some(w => w.toLowerCase() === found));
        const reflexive = /(?:self|selves)$/.test(found)
          || cast.some(c => c.pronouns?.reflexive.toLowerCase() === found);
        if (!reflexive && declaredElsewhere.length === 1) continue;

        return {
          ok: false,
          why: `${member.name} is "${found}" here, but is declared ${member.pronouns.subject}/`
            + `${member.pronouns.object}/${member.pronouns.possessive}/${member.pronouns.reflexive}`,
          character: member.name,
          found,
          declared: member.pronouns,
          match: clean.slice(matchStart, matchEnd),
        };
      }
    }
  }
  return null;
}
