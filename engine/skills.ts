/** SKILL CATALOG — the general skills every character has by default, and a story's overrides. */
/** The general skill list: every character has all of these unless a story's `restrictions` removes them. */
export const SKILL_CATALOG: Readonly<Record<string, string>> = Object.freeze({
  movement: "moving your own body through the space you are in",
  speech:   "saying things aloud",
  hearing:  "perceiving sound",
  sight:    "perceiving light, shape and colour",
  touch:    "perceiving and handling things by contact",
  taste:    "perceiving flavour",
  smell:    "perceiving scent",
  recall:   "drawing on your own memory of what you have lived through",
});

/**
 * The restriction catalog — named penalties and the skills each disables. A restriction entry that
 * names a key here expands to the whole listed set; those skills may be general OR special/bible
 * ones, so a penalty can reach further than the same-named skill ever could. Global, in-code, fixed.
 */
export const RESTRICTION_CATALOG: Readonly<Record<string, readonly string[]>> = Object.freeze({
  deprived: Object.freeze(["sight", "hearing"]),
  anosmic:  Object.freeze(["smell"]),
  insensate: Object.freeze(["touch", "taste"]),
  bound:    Object.freeze(["movement", "touch", "climbing"]),
  "hands-bound": Object.freeze(["touch", "lockpicking", "sleight-of-hand"]),
});

/**
 * The special-skill bible — genuinely reusable special skills with canonical spellings and meanings,
 * mirroring SKILL_CATALOG. The architect draws from here; a bespoke per-story skill is still
 * first-class: a `skills[]` entry not in this catalog resolves as `custom` and keeps its own
 * `:: meaning`.
 */
export const SPECIAL_SKILL_CATALOG: Readonly<Record<string, string>> = Object.freeze({
  lockpicking:      "opening a mechanical lock without its key",
  climbing:         "ascending a sheer or near-sheer surface by hand and foot",
  "sleight-of-hand": "palming, hiding or switching a small object without being seen doing it",
});

/** One skill a character has: `source` tells where it came from — the general list, the special-skill
 *  bible, or a story's own bespoke wording. */
export interface Skill { name: string; meaning: string; source: "general" | "bible" | "custom"; }

// `Lock Picking` and `lockpicking` are one skill; the authored spelling is what the character sees.
/** A spelling-insensitive key for comparing skill names, so one skill can never be written two ways. */
export const canonSkill = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, "");

// The bible is looked up by canon name, so `Sleight of Hand` finds the `sleight-of-hand` entry.
const CANON_BIBLE: ReadonlyMap<string, string> =
  new Map(Object.entries(SPECIAL_SKILL_CATALOG).map(([k, v]) => [canonSkill(k), v] as const));
/** The bible's canonical meaning for a skill name, whatever spelling it was written in. */
export const bibleMeaningOf = (name: string): string | undefined => CANON_BIBLE.get(canonSkill(name));

// Penalties likewise: `Hands Bound` finds the `hands-bound` entry.
const CANON_RESTRICTIONS: ReadonlyMap<string, readonly string[]> =
  new Map(Object.entries(RESTRICTION_CATALOG).map(([k, v]) => [canonSkill(k), v] as const));

// A story may write `name :: what it means`; the meaning is optional, the name is not.
/** Split a `name :: what it means` entry; the meaning is optional, the name is not. */
export function splitMeaning(raw: string): { text: string; meaning: string } {
  const i = raw.indexOf("::");
  if (i < 0) return { text: raw.trim(), meaning: "" };
  return { text: raw.slice(0, i).trim(), meaning: raw.slice(i + 2).trim() };
}

/** The general skills a resolved character ended up without — the effective restrictions, which is
 *  not always the authored list: a name in both `skills` and `restrictions` is handed back. */
export const restrictionsOf = (skills: Skill[]): string[] =>
  Object.keys(SKILL_CATALOG).filter(g => !skills.some(s => canonSkill(s.name) === canonSkill(g)));

/** A character's final skill list: general skills minus restrictions, plus the story's own skills and
 *  overrides. Restrictions reach special skills too: a RESTRICTION_CATALOG penalty disables every
 *  skill it lists — general or bible — and a bare restriction name self-restricts that skill.
 *
 *  Precedence: a skill named directly in BOTH `skills` and `restrictions` is handed back (they HAVE
 *  it), but a skill disabled *via a catalog penalty* is removed even when `skills` names it. */
export function resolveSkills(who: string, skillsRaw: string, restrictionsRaw: string): Skill[] {
  const split = (s: string) => s.split("|").map(x => x.trim()).filter(Boolean);
  const restricted = new Map<string, string>();          // canon -> authored spelling of what removed it
  const viaPenalty = new Set<string>();                  // canon keys disabled through a named penalty
  const unresolved: string[] = [];
  const declared = new Set(
    split(skillsRaw).map(e => canonSkill(splitMeaning(e).text)).filter(Boolean)); // so a bespoke custom skill can be self-restricted by name
  for (const entry of split(restrictionsRaw)) {
    const { text } = splitMeaning(entry);
    if (!text) continue;
    const key = canonSkill(text);
    const penalty = CANON_RESTRICTIONS.get(key);
    if (penalty) {
      for (const member of penalty) {
        const mk = canonSkill(member);
        restricted.set(mk, member);
        viaPenalty.add(mk);
      }
    } else if (Object.prototype.hasOwnProperty.call(SKILL_CATALOG, key)
      || bibleMeaningOf(text) !== undefined || declared.has(key)) {
      restricted.set(key, text);
    } else {
      unresolved.push(text);
    }
  }

  if (unresolved.length)
    console.warn(`   (character ${who}: restrictions "${unresolved.join('", "')}" — not a known skill or penalty, so there is nothing to remove; known penalties: ${Object.keys(RESTRICTION_CATALOG).join(", ")}; general skills: ${Object.keys(SKILL_CATALOG).join(", ")})`);

  const out = new Map<string, Skill>();
  for (const [name, meaning] of Object.entries(SKILL_CATALOG))
    if (!restricted.has(canonSkill(name))) out.set(canonSkill(name), { name, meaning, source: "general" });

  for (const entry of split(skillsRaw)) {
    const { text, meaning } = splitMeaning(entry);
    if (!text) { console.warn(`   (character ${who}: a skills entry has a meaning but no name before the "::" — dropped)`); continue; }
    const key = canonSkill(text);
    if (key in SKILL_CATALOG && !restricted.has(key))
      console.warn(`   (character ${who}: skills "${text}" redeclares a general skill — the story's wording wins)`);
    if (restricted.has(key) && !viaPenalty.has(key))
      console.warn(`   (character ${who}: "${text}" is in both skills and restrictions — added back, so they HAVE it)`);
    else if (viaPenalty.has(key)) {
      console.warn(`   (character ${who}: "${text}" is listed under skills but the "${restricted.get(key)}" penalty removes it)`);
      continue;
    }
    const bible = bibleMeaningOf(text) ?? "";
    out.set(key, {
      name: text,
      meaning: meaning || bible,   // a bible skill with no authored meaning takes the catalog's
      source: bible ? "bible" : "custom",
    });
  }
  return [...out.values()];
}
