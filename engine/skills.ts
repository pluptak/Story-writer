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

/** One skill a character has: `source` tells whether it came from the general list or the story. */
export interface Skill { name: string; meaning: string; source: "general" | "story"; }

// `Lock Picking` and `lockpicking` are one skill; the authored spelling is what the character sees.
/** A spelling-insensitive key for comparing skill names, so one skill can never be written two ways. */
export const canonSkill = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, "");

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

/** A character's final skill list: general skills minus restrictions, plus the story's own skills and overrides. */
export function resolveSkills(who: string, skillsRaw: string, restrictionsRaw: string): Skill[] {
  const split = (s: string) => s.split("|").map(x => x.trim()).filter(Boolean);
  const restricted = new Map<string, string>();          // canon -> authored spelling
  for (const entry of split(restrictionsRaw)) {
    const { text } = splitMeaning(entry);
    if (!text) continue;
    const key = canonSkill(text);
    if (!(key in SKILL_CATALOG))
      console.warn(`   (character ${who}: restrictions "${text}" — not a general skill, so there is nothing to remove; known: ${Object.keys(SKILL_CATALOG).join(", ")})`);
    restricted.set(key, text);
  }

  const out = new Map<string, Skill>();
  for (const [name, meaning] of Object.entries(SKILL_CATALOG))
    if (!restricted.has(canonSkill(name))) out.set(canonSkill(name), { name, meaning, source: "general" });

  for (const entry of split(skillsRaw)) {
    const { text, meaning } = splitMeaning(entry);
    if (!text) { console.warn(`   (character ${who}: a skills entry has a meaning but no name before the "::" — dropped)`); continue; }
    const key = canonSkill(text);
    if (key in SKILL_CATALOG && !restricted.has(key))
      console.warn(`   (character ${who}: skills "${text}" redeclares a general skill — the story's wording wins)`);
    if (restricted.has(key))
      console.warn(`   (character ${who}: "${text}" is in both skills and restrictions — added back, so they HAVE it)`);
    out.set(key, { name: text, meaning, source: "story" });
  }
  return [...out.values()];
}
