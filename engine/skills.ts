/**
 * SKILLS, RESTRICTIONS, AND REACH — how a capability gets onto a character, and how it comes off.
 *
 * These are the semantics this module implements. They hold everywhere; the code below implements
 * them, it does not define them.
 *
 * **I1 — A skill is intrinsic; reach is granted.**
 * A skill travels with the character between scenes. A reach entry exists only while the scene that
 * granted it is being written. The default is no reach; a scene must grant it. This is the whole
 * reason reach is not a skill: put `camera-access` on a character and every later scene has to
 * explicitly negate it.
 *
 * **I2 — A restriction is a source-independent prohibition.**
 * A restriction names a capability unavailable to this character no matter where it would have come
 * from — the general catalog, their own `skills`, or the scene's `reach`. Canonical-name removal is
 * how it is implemented; the mechanism implements the rule, it is not the rule. `restrictions:
 * ["cameras"]` does not make `cameras` a fundamental human capability; it says this character does
 * not have the camera access something else would have granted. A restriction never removes a
 * capability by resemblance. Corollary — the blind-AI case: `restrictions: ["sight"]` does NOT
 * remove `reach: ["cameras :: ..."]`, because `cameras` and `sight` are different capabilities, not
 * two implementations of one. The authoring rule that makes this hold: name the interface, never
 * the sense it substitutes for.
 *
 * **I3 — Intrinsic beats granted on collision.**
 * A reach entry may not reuse a canon name the general catalog or that character's own skills
 * already use. On collision the character's meaning stands and the reach entry is dropped with a
 * warning: reach vanishes at the scene boundary, so letting it win would change what a skill means
 * for one scene, then change it back.
 *
 * **I4 — Reach never leaks into a character-level representation.**
 * Every surface showing a character outside a scene resolves with reach empty and shows `skills`
 * and limits only. Only per-scene resolution in scene-loop.ts ever sees reach. (AURA reaching the
 * lobby cameras from the basement, forever, is the failure mode this exists to prevent.)
 *
 * **I5 — Reach grants access, not existence.**
 * A reach meaning describes what the character can do THROUGH the thing; that the thing is there is
 * established by the scene's `place` or the story's `facts[]`. Enforced softly on purpose: whether
 * "a modern office building" establishes security cameras is a semantic judgement, not something a
 * validator should arbitrate, so I5 lives only in the architect's verify pass and warns rather than
 * blocks. I1–I4 are mechanical and enforced here; I5 is an authoring principle.
 *
 * Resolution order: the character's origin group (all of the general catalog when no origin is
 * named) → the character's own `skills` → the scene's `reach`, with restrictions applied by canon
 * name across all three. All three catalog layers are injectable — the special-skill bible
 * (`SPECIAL_SKILL_CATALOG`), the general skills, and the origin groups (`ORIGIN_SKILL_GROUPS`)
 * each default to the in-code catalogs, and the author's persisted ones are passed in as a
 * `Catalogs` bag by the caller.
 */
/** SKILL CATALOG — the general skills every character has by default, and a story's overrides. */
import { warn } from "./warnings.ts";

/** A bible lookup: the canonical meaning for a skill name, whatever spelling it was written in.
 *  `bibleMeaningOf` is the in-code default; a later stage passes the author's persisted bible. */
export type BibleLookup = (name: string) => string | undefined;

/** The catalogs a resolution reads, each defaulting to the in-code one. Bundled because they travel
 *  together: every caller that can load one can load all three, and passing two of three is a bug
 *  that only shows up on a name the third would have resolved. */
export interface Catalogs {
  bible?: BibleLookup;
  generals?: Readonly<Record<string, string>>;
  origins?: OriginLookup;
}

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

/** Resolve a Catalogs bag once, using in-code defaults for any unset field. */
const use = (c?: Catalogs) => ({
  bible: c?.bible ?? bibleMeaningOf,
  generals: c?.generals ?? SKILL_CATALOG,
  origins: c?.origins ?? originSkillsOf,
});

/** A `BibleLookup` over an explicit name→meaning map. The bible reaches the architect as PAIRS,
 *  because one of its two consumers renders it into a prompt string; this is the other consumer's
 *  view of the same map, so the two cannot disagree about what is in it. */
export const bibleFrom = (entries: Readonly<Record<string, string>>): BibleLookup => {
  const m = new Map(Object.entries(entries).map(([k, v]) => [canonSkill(k), v] as const));
  return name => m.get(canonSkill(name));
};

/** One origin as the in-code catalog holds it: what kind of being it is, and which general skills
 *  it starts with. The `meaning` is what the author reads and what seeds the persisted catalog; only
 *  `skills` reaches resolution. */
export interface OriginGroup { meaning: string; skills: readonly string[] }

/** A character's origin: which general skills a kind of being starts with. No origin means all of
 *  SKILL_CATALOG — the human default, and what every story written before origins existed gets. */
export const ORIGIN_SKILL_GROUPS: Readonly<Record<string, OriginGroup>> = Object.freeze({
  human: { meaning: "a person: a body in the room, and every ordinary sense",
           skills: Object.freeze(Object.keys(SKILL_CATALOG)) },
  ai:    { meaning: "a program: it speaks through whatever it is wired to and remembers, and has no body at all",
           skills: Object.freeze(["speech", "recall"]) },
});

/** An origin lookup: the general skills an origin name grants, or undefined if it names none. */
export type OriginLookup = (name: string) => readonly string[] | undefined;

const CANON_ORIGINS: ReadonlyMap<string, readonly string[]> =
  new Map(Object.entries(ORIGIN_SKILL_GROUPS).map(([k, v]) => [canonSkill(k), v.skills] as const));
/** The in-code group for an origin name, whatever spelling it was written in. */
export const originSkillsOf: OriginLookup = name => CANON_ORIGINS.get(canonSkill(name));

/** An `OriginLookup` over an explicit name→group map, the origin half of `bibleFrom`. */
export const originsFrom = (entries: Readonly<Record<string, readonly string[]>>): OriginLookup => {
  const m = new Map(Object.entries(entries).map(([k, v]) => [canonSkill(k), v] as const));
  return name => m.get(canonSkill(name));
};

/** One character's origin: the authored name, and the canon keys into SKILL_CATALOG it grants. */
export interface Origin { name: string; skills: readonly string[] }

/** Resolve a character's origin name into an Origin, or undefined for an empty name — which means
 *  all general skills, the pre-origins default. An unknown name warns and falls back to the same.
 *  The lookup is injectable and cannot be enumerated, so the warning names no alternatives. */
export function resolveOrigin(who: string, name: string, catalogs?: Catalogs): Origin | undefined {
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  const { origins, generals } = use(catalogs);
  const group = origins(trimmed);
  if (!group) {
    warn(`   (character ${who}: origin "${trimmed}" is not a known origin — falling back to all general skills)`);
    return undefined;
  }
  const known = (s: string) => Object.prototype.hasOwnProperty.call(generals, canonSkill(s));
  const dropped = group.filter(s => !known(s));
  if (dropped.length)
    warn(`   (character ${who}: origin "${trimmed}" names "${dropped.join('", "')}" — not a general skill, dropped)`);
  return { name: trimmed, skills: group.filter(known).map(canonSkill) };
}

// A story may write `name :: what it means`; the meaning is optional, the name is not.
/** Split a `name :: what it means` entry; the meaning is optional, the name is not. */
export function splitMeaning(raw: string): { text: string; meaning: string } {
  const i = raw.indexOf("::");
  if (i < 0) return { text: raw.trim(), meaning: "" };
  return { text: raw.slice(0, i).trim(), meaning: raw.slice(i + 2).trim() };
}

/** The general skills this character starts with: their origin's group, or all of them. */
const generalKeys = (origin?: Origin, catalogs?: Catalogs) => {
  const { generals } = use(catalogs);
  return origin ? origin.skills : Object.keys(generals).map(canonSkill);
};

/** The restrictions of one character, parsed once for every reader of them: each known capability a
 *  restriction removes is keyed by canon name to its authored spelling. A restriction must name a
 *  general skill their origin grants, a bible skill, one of that character's own skills, or — since
 *  restrictions negate over the whole capability set (I2) — something the scene's `reach` grants.
 *  Anything else warns here, exactly as resolveSkills has always warned, and removes nothing. */
function parseRestrictions(who: string, skillsRaw: string, restrictionsRaw: string, granted = new Set<string>(), catalogs?: Catalogs, origin?: Origin) {
  const { bible, generals } = use(catalogs);
  const split = (s: string) => s.split("|").map(x => x.trim()).filter(Boolean);
  const restricted = new Map<string, string>();          // canon -> authored spelling of what removed it
  const unresolved: string[] = [];
  const declared = new Set(
    split(skillsRaw).map(e => canonSkill(splitMeaning(e).text)).filter(Boolean)); // so a bespoke custom skill can be self-restricted by name
  const general = new Set(generalKeys(origin, catalogs));
  for (const entry of split(restrictionsRaw)) {
    const { text } = splitMeaning(entry);
    if (!text) continue;
    const key = canonSkill(text);
    if (general.has(key) || bible(text) !== undefined || declared.has(key) || granted.has(key)) {
      restricted.set(key, text);
    } else {
      unresolved.push(text);
    }
  }

  if (unresolved.length)
    warn(`   (character ${who}: restrictions "${unresolved.join('", "')}" — not a known skill, so there is nothing to remove; general skills: ${[...general].join(", ")})`);

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

/** The three capability layers resolved against each other: the origin's general skills → the
 *  character's own `skills` → the scene's `reach`, restrictions applied by canon name across all three. */
function resolveLayers(who: string, skillsRaw: string, restrictionsRaw: string, reachRaw: string, catalogs?: Catalogs, origin?: Origin): Map<string, Skill> {
  const { bible, generals } = use(catalogs);
  const reach = parseReach(who, reachRaw);
  const { split, restricted } = parseRestrictions(who, skillsRaw, restrictionsRaw,
    new Set(reach.list.map(r => r.key)), catalogs, origin);

  const out = new Map<string, Skill>();
  // Iterated over the catalog rather than the origin's group, so an origin never reorders the
  // general skills a character is told they have.
  const granted = new Set(generalKeys(origin, catalogs));
  for (const [name, meaning] of Object.entries(generals))
    if (granted.has(canonSkill(name)) && !restricted.has(canonSkill(name)))
      out.set(canonSkill(name), { name, meaning, source: "general" });

  for (const entry of split(skillsRaw)) {
    const { text, meaning } = splitMeaning(entry);
    if (!text) { warn(`   (character ${who}: a skills entry has a meaning but no name before the "::" — dropped)`); continue; }
    const key = canonSkill(text);
    // A general skill the origin withholds is not a redeclaration — the character is being given it.
    if (granted.has(key) && !restricted.has(key))
      warn(`   (character ${who}: skills "${text}" redeclares ${origin ? "a skill their origin grants" : "a general skill"} — the story's wording wins)`);
    if (restricted.has(key))
      warn(`   (character ${who}: "${text}" is in both skills and restrictions — added back, so they HAVE it)`);
    const fromBible = bible(text) ?? "";
    out.set(key, {
      name: text,
      meaning: meaning || fromBible,   // a bible skill with no authored meaning takes the catalog's
      source: fromBible ? "bible" : "custom",
    });
  }

  for (const s of reachLayer(who, k => out.has(k), restricted, reach.list)) out.set(canonSkill(s.name), s);
  return out;
}

// The reach layer, applied against whatever already stands: both entry points share it, so I2 and I3
// have one implementation rather than one per caller.
/** The scene's grant, minus what an intrinsic skill already covers (I3) and what a restriction
 *  removes (I2). `held` answers whether a canon name is already taken by the intrinsic layers. */
function reachLayer(who: string, held: (key: string) => boolean, restricted: ReadonlyMap<string, string>,
                    list: { key: string; name: string; meaning: string }[]): Skill[] {
  const out: Skill[] = [];
  for (const r of list) {
    if (held(r.key)) {
      warn(`   (character ${who}: reach "${r.name}" reuses a skill they already have — their own meaning stands and the reach entry is dropped)`);
      continue;   // I3: intrinsic beats granted on collision
    }
    if (restricted.has(r.key)) continue;   // I2: a restriction reaches across layers by canon name
    out.push({ name: r.name, meaning: r.meaning, source: "reach" });
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
export function resolveSkills(who: string, skillsRaw: string, restrictionsRaw: string, reachRaw = "", origin?: Origin, catalogs?: Catalogs): Skill[] {
  return [...resolveLayers(who, skillsRaw, restrictionsRaw, reachRaw, catalogs, origin).values()];
}

/** Just the reach layer for one character in one scene — what the scene grants them through where
 *  they are standing, minus what restrictions remove (I2) and what an intrinsic skill already covers
 *  (I3). This is the only form in which scene-loop.ts ever sees reach (I4).
 *
 *  `skills` is the character's ALREADY-RESOLVED list, because that is what the caller holds by the
 *  time a scene is being written: general catalog and own skills settled, restrictions subtracted.
 *  Taking it resolved rather than re-flattening it to `name :: meaning` and running the intrinsic
 *  layers a second time is what keeps a general the character simply has from reading as a story
 *  redeclaring one. */
export function resolveReach(who: string, skills: readonly Skill[], restrictionsRaw: string, reachRaw: string, catalogs?: Catalogs): Skill[] {
  const reach = parseReach(who, reachRaw);
  const { restricted } = parseRestrictions(who, skills.map(s => s.name).join(" | "), restrictionsRaw,
    new Set(reach.list.map(r => r.key)), catalogs);
  const held = new Set(skills.map(s => canonSkill(s.name)));
  return reachLayer(who, k => held.has(k), restricted, reach.list);
}

/** Validate capabilities (skills and restrictions) at authoring time, returning advisory problems
 *  and the filtered restriction list (those that resolve to known skills). The `catalogs` parameter
 *  allows later stages to inject user-editable catalogs on top of the in-code ones; the in-code
 *  defaults apply when unset. */
export function capabilityProblems(
  who: string,
  skills: string[],
  restrictionsRaw: string[],
  origin?: Origin,
  catalogs?: Catalogs,
): { restrictions: string[]; problems: string[] } {
  const { bible, generals } = use(catalogs);
  const problems: string[] = [];

  for (const entry of skills) {
    const { text, meaning } = splitMeaning(entry);
    if (bible(text) === undefined && !meaning)
      problems.push(`${who} has skill "${text}" — not a bible skill, and it carries no ":: meaning", so nobody can tell what it lets them do`);
  }

  const general = new Set(generalKeys(origin, catalogs));
  const restrictions = restrictionsRaw.filter(l => {
    const r = splitMeaning(l).text;
    const rk = canonSkill(r);
    const ok = general.has(rk)
      || bible(r) !== undefined
      || skills.some(s => canonSkill(splitMeaning(s).text) === rk);
    if (!ok) problems.push(`${who} "restrictions: ${l}" — not a known skill, so it would remove nothing`);
    return ok;
  });

  return { restrictions, problems };
}

/**
 * What the authored restrictions took away, as explicit negative facts: the authored spelling of
 * every known capability removed — general AND special/bible AND reach — followed by the general
 * skills the character's origin never granted. This is the writer-side CANNOT list, because
 * absence-from-`can` hides a withheld capability exactly the way it hides a restricted one.
 * A skill named directly in both lists is one they HAVE and is not a cannot.
 */
export function removedCapabilities(who: string, skillsRaw: string, restrictionsRaw: string, reachRaw = "", origin?: Origin, catalogs?: Catalogs): string[] {
  const { generals } = use(catalogs);
  const reach = parseReach(who, reachRaw);
  const { declared, restricted } = parseRestrictions(who, skillsRaw, restrictionsRaw,
    new Set(reach.list.map(r => r.key)), catalogs, origin);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [key, spelling] of restricted) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (declared.has(key)) continue;   // named in both lists — they HAVE it
    out.push(spelling);
  }
  if (origin) {
    const granted = new Set(origin.skills);
    for (const name of Object.keys(generals)) {
      const key = canonSkill(name);
      if (granted.has(key) || seen.has(key) || declared.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
  }
  return out;
}
