/**
 * SKILLS, RESTRICTIONS, AND REACH — how a capability gets onto a character, and how it comes off.
 *
 * These are the semantics this module implements. They hold everywhere; the code below is their
 * implementation, not their definition.
 *
 * **I1 — A skill is intrinsic; reach is granted.**
 * A skill travels with the character between scenes. A reach entry exists only while the scene that
 * granted it is being written. The default is no reach; a scene must grant it. This is the whole
 * reason reach is not a skill: put `camera-access` on a character and every later scene has to
 * explicitly negate it.
 *
 * **I2 — A restriction is a source-independent prohibition.**
 * A restriction names a capability that is unavailable to this character regardless of where that
 * capability would otherwise have originated — the general catalog, their own `skills`, or the
 * scene's `reach`. Canonical-name removal is how that is implemented, and it keeps the existing
 * one-namespace-with-a-sign design intact — but the mechanism is the implementation of the rule,
 * not the rule. `restrictions: ["cameras"]` does not make `cameras` a fundamental human capability;
 * it says this character does not have the camera access something else would have granted. A
 * restriction never removes a capability by resemblance. Corollary — the blind-AI case:
 * `restrictions: ["sight"]` does NOT remove `reach: ["cameras :: ..."]`, because `cameras` and
 * `sight` are different capabilities, not two implementations of one. The authoring rule that makes
 * this hold: name the interface, never the sense it substitutes for.
 *
 * **I3 — Intrinsic beats granted on collision.**
 * A reach entry may not reuse a canon name the general catalog or that character's own skills
 * already use. On collision the character's meaning stands and the reach entry is dropped with a
 * warning: reach vanishes at the scene boundary, so letting it win would silently change what a
 * skill means for one scene and change it back afterwards.
 *
 * **I4 — Reach never leaks into a character-level representation.**
 * Every surface that shows a character outside a scene resolves with reach empty and shows `skills`
 * and limits only. Only the per-scene resolution in scene-loop.ts ever sees reach. (AURA reaching
 * the lobby cameras from the basement, forever, is the failure mode this exists to prevent.)
 *
 * **I5 — Reach grants access, not existence.**
 * A reach meaning describes what the character can do THROUGH the thing; that the thing is there is
 * established by the scene's `place` or the story's `facts[]`. Enforced softly, on purpose: whether
 * "a modern office building" establishes security cameras is a semantic judgement, not something a
 * validator should arbitrate, so I5 lives only in the architect's verify pass and warns rather than
 * blocks. I1–I4 are mechanical and enforced here; I5 is an authoring principle.
 *
 * Resolution order: general catalog → the character's own `skills` → the scene's `reach`, with
 * restrictions applied by canon name across all three.
 */
/** SKILL CATALOG — the general skills every character has by default, and a story's overrides. */
import { warn } from "./warnings.ts";

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
 *  bible, a story's own bespoke wording, or the scene's `reach`. */
export interface Skill { name: string; meaning: string; source: "general" | "bible" | "custom" | "reach"; }

// `Lock Picking` and `lockpicking` are one skill; the authored spelling is what the character sees.
/** A spelling-insensitive key for comparing skill names, so one skill can never be written two ways. */
export const canonSkill = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, "");

// The bible is looked up by canon name, so `Sleight of Hand` finds the `sleight-of-hand` entry.
const CANON_BIBLE: ReadonlyMap<string, string> =
  new Map(Object.entries(SPECIAL_SKILL_CATALOG).map(([k, v]) => [canonSkill(k), v] as const));
/** The bible's canonical meaning for a skill name, whatever spelling it was written in. */
export const bibleMeaningOf = (name: string): string | undefined => CANON_BIBLE.get(canonSkill(name));

// A story may write `name :: what it means`; the meaning is optional, the name is not.
/** Split a `name :: what it means` entry; the meaning is optional, the name is not. */
export function splitMeaning(raw: string): { text: string; meaning: string } {
  const i = raw.indexOf("::");
  if (i < 0) return { text: raw.trim(), meaning: "" };
  return { text: raw.slice(0, i).trim(), meaning: raw.slice(i + 2).trim() };
}

/** The restrictions of one character, parsed once for every reader of them: each known capability a
 *  restriction removes is keyed by canon name to its authored spelling. A restriction must name a
 *  general skill, a bible skill, one of that character's own skills, or — since restrictions negate
 *  over the whole capability set (I2) — something the scene's `reach` grants. Anything else warns
 *  here, exactly as resolveSkills has always warned, and removes nothing. */
function parseRestrictions(who: string, skillsRaw: string, restrictionsRaw: string, granted = new Set<string>()) {
  const split = (s: string) => s.split("|").map(x => x.trim()).filter(Boolean);
  const restricted = new Map<string, string>();          // canon -> authored spelling of what removed it
  const unresolved: string[] = [];
  const declared = new Set(
    split(skillsRaw).map(e => canonSkill(splitMeaning(e).text)).filter(Boolean)); // so a bespoke custom skill can be self-restricted by name
  for (const entry of split(restrictionsRaw)) {
    const { text } = splitMeaning(entry);
    if (!text) continue;
    const key = canonSkill(text);
    if (Object.prototype.hasOwnProperty.call(SKILL_CATALOG, key)
      || bibleMeaningOf(text) !== undefined || declared.has(key) || granted.has(key)) {
      restricted.set(key, text);
    } else {
      unresolved.push(text);
    }
  }

  if (unresolved.length)
    warn(`   (character ${who}: restrictions "${unresolved.join('", "')}" — not a known skill, so there is nothing to remove; general skills: ${Object.keys(SKILL_CATALOG).join(", ")})`);

  return { split, declared, restricted };
}

// A scene's reach entries, parsed once per reader: canon key, authored name, and the meaning that
// says what the character can do THROUGH the thing (I5 leaves whether the thing exists to the scene).
// Reach entries are always bespoke, so a missing `:: meaning` warns; duplicates collapse.
function parseReach(who: string, reachRaw: string): { list: { key: string; name: string; meaning: string }[] } {
  const list: { key: string; name: string; meaning: string }[] = [];
  const seen = new Set<string>();
  for (const entry of reachRaw.split("|").map(x => x.trim()).filter(Boolean)) {
    const { text, meaning } = splitMeaning(entry);
    if (!text) continue;
    if (!meaning)
      warn(`   (character ${who}: reach "${text}" carries no ":: meaning" — nobody can tell what it lets them do through)`);
    const key = canonSkill(text);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ key, name: text, meaning });
  }
  return { list };
}

/** The three capability layers resolved against each other: general catalog → the character's own
 *  `skills` → the scene's `reach`, with restrictions applied by canon name across all three. */
function resolveLayers(who: string, skillsRaw: string, restrictionsRaw: string, reachRaw: string): Map<string, Skill> {
  const reach = parseReach(who, reachRaw);
  const { split, restricted } = parseRestrictions(who, skillsRaw, restrictionsRaw,
    new Set(reach.list.map(r => r.key)));

  const out = new Map<string, Skill>();
  for (const [name, meaning] of Object.entries(SKILL_CATALOG))
    if (!restricted.has(canonSkill(name))) out.set(canonSkill(name), { name, meaning, source: "general" });

  for (const entry of split(skillsRaw)) {
    const { text, meaning } = splitMeaning(entry);
    if (!text) { warn(`   (character ${who}: a skills entry has a meaning but no name before the "::" — dropped)`); continue; }
    const key = canonSkill(text);
    if (key in SKILL_CATALOG && !restricted.has(key))
      warn(`   (character ${who}: skills "${text}" redeclares a general skill — the story's wording wins)`);
    if (restricted.has(key))
      warn(`   (character ${who}: "${text}" is in both skills and restrictions — added back, so they HAVE it)`);
    const bible = bibleMeaningOf(text) ?? "";
    out.set(key, {
      name: text,
      meaning: meaning || bible,   // a bible skill with no authored meaning takes the catalog's
      source: bible ? "bible" : "custom",
    });
  }

  for (const r of reach.list) {
    if (out.has(r.key)) {
      warn(`   (character ${who}: reach "${r.name}" reuses a skill they already have — their own meaning stands and the reach entry is dropped)`);
      continue;   // I3: intrinsic beats granted on collision
    }
    if (restricted.has(r.key)) continue;   // I2: a restriction reaches across layers by canon name
    out.set(r.key, { name: r.name, meaning: r.meaning, source: "reach" });
  }
  return out;
}

/** A character's final skill list: general skills minus restrictions, plus the story's own skills and
 *  overrides. Restrictions reach special skills too — they negate over the whole capability set by
 *  canon name — and a bare restriction name self-restricts that skill.
 *
 *  Precedence: a skill named directly in BOTH `skills` and `restrictions` is handed back (they HAVE
 *  it). `reachRaw` is the scene's grant for this character; pass nothing for any character-level
 *  view, so reach never leaks outside the scene that granted it (I4). */
export function resolveSkills(who: string, skillsRaw: string, restrictionsRaw: string, reachRaw = ""): Skill[] {
  return [...resolveLayers(who, skillsRaw, restrictionsRaw, reachRaw).values()];
}

/** Just the reach layer for one character in one scene — what the scene grants them through where
 *  they are standing, minus what restrictions remove (I2) and what an intrinsic skill already covers
 *  (I3). This is the only form in which scene-loop.ts ever sees reach (I4). */
export function resolveReach(who: string, skillsRaw: string, restrictionsRaw: string, reachRaw: string): Skill[] {
  return [...resolveLayers(who, skillsRaw, restrictionsRaw, reachRaw).values()].filter(s => s.source === "reach");
}

/**
 * What the authored restrictions took away, as explicit negative facts: the authored spelling of
 * every known capability removed — general AND special/bible AND reach. This is the writer-side
 * CANNOT list, because absence-from-`can` hides exactly the special skills a restriction removed.
 * A skill named directly in both lists is one they HAVE and is not a cannot.
 */
export function removedCapabilities(who: string, skillsRaw: string, restrictionsRaw: string, reachRaw = ""): string[] {
  const reach = parseReach(who, reachRaw);
  const { split, declared, restricted } = parseRestrictions(who, skillsRaw, restrictionsRaw,
    new Set(reach.list.map(r => r.key)));
  const held = new Set<string>();   // canon keys an intrinsic skill already covers (I3 drops those entries)
  for (const [name] of Object.entries(SKILL_CATALOG)) held.add(canonSkill(name));
  for (const entry of split(skillsRaw)) {
    const t = splitMeaning(entry).text;
    if (t) held.add(canonSkill(t));
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [key, spelling] of restricted) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (declared.has(key)) continue;   // named in both lists — they HAVE it
    out.push(spelling);
  }
  return out;
}
