/** CATALOG — storage and validation for character, tag, style, and skill catalogs. */
import { readFile, writeFile, rename } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { z } from "zod";
import { warn } from "./warnings.ts";
import { characterPsychologyWarnings } from "./story-spec.ts";
import { capabilityProblems, SKILL_CATALOG, SPECIAL_SKILL_CATALOG, canonSkill, bibleMeaningOf, bibleFrom, type BibleLookup } from "./skills.ts";
import { ROOT } from "./story-format.ts";
import {
  CharacterCatalog,
  TAG_SEED, TagCatalog, TagEntry, type CatalogKind, type TagFacet,
  LibraryCharacter,
  LibraryStyle,
  StyleCatalog,
  LibrarySkill,
  SkillCatalog,
} from "./catalog-schema.ts";

// -- REGISTRY ---------------------------------------------------------------

/** Per-kind configuration: schema, filename, problems checker, and optional seed. */
type CatalogRegistry = {
  filename: string;
  catalog: z.ZodType<any>;
  entry: z.ZodType<any>;
  problems: (entry: any, bible?: BibleLookup) => string[];
  seed?: () => any[];
};

/** Character-specific problems: psychology, capabilities, and portable-persona checks. */
function characterProblems(entry: LibraryCharacter, bible: BibleLookup = bibleMeaningOf): string[] {
  const problems: string[] = [];

  problems.push(...characterPsychologyWarnings(entry.name, entry.belief, entry.impulse, entry.voice));

  const capProblems = capabilityProblems(entry.name, entry.skills, entry.restrictions, bible);
  problems.push(...capProblems.problems);

  if (!entry.portablePersona.trim()) {
    problems.push(`${entry.name} has no portable persona — the half of a character that travels between stories`);
  } else {
    const storySpecificMatch = entry.portablePersona.match(/\b(in this story|this chapter|right now|currently|at the start of|has just|recently arrived)\b/i);
    if (storySpecificMatch) {
      problems.push(
        `${entry.name}'s portable persona names something story-specific ("${storySpecificMatch[1]}") — the portable half must read as valid on its own`
      );
    }
  }

  return problems;
}

/** Tag-specific problems: advisory only. */
function tagProblems(entry: TagEntry): string[] {
  const problems: string[] = [];

  // Check if label is already trimmed-lowercase
  const trimmed = entry.label.trim().toLowerCase();
  if (entry.label !== trimmed) {
    problems.push(`${entry.label} is not lowercase — tags are matched by label, so "Bleak" and "bleak" would be two tags`);
  }

  return problems;
}

/** Style-specific problems: advisory only. The voice field is checked for story-mandated
 *  perception clauses that must not travel in a reusable preset. */
function styleProblems(entry: LibraryStyle): string[] {
  const problems: string[] = [];

  if (!entry.voice.trim()) {
    problems.push(
      `${entry.name} has no voice — the half of a house style that travels between stories`
    );
  } else {
    // Check for story-specific perception clauses. Case-insensitive match on phrases
    // that name perception rules derived per-story from POV and cast restrictions.
    const perceptionMatch = entry.voice.match(/\b(cannot see|can't see|is blind|no omniscience|only visible|nothing that is only)\b/i);
    if (perceptionMatch) {
      problems.push(
        `${entry.name}'s voice names a story-specific perception rule ("${perceptionMatch[1]}") — ` +
        `those are derived per story from the POV and the cast's restrictions, so a preset carrying one ` +
        `would take it away when the voice is swapped`
      );
    }
  }

  if (!entry.description.trim()) {
    problems.push(
      `${entry.name} has no description — presets are chosen from a list, and a name alone does not say what this one sounds like`
    );
  }

  return problems;
}

/** Skill-specific problems: advisory only. */
function skillProblems(entry: LibrarySkill): string[] {
  const problems: string[] = [];

  if (!entry.meaning.trim()) {
    problems.push(
      `${entry.name} has no meaning — a bible entry exists to say what the skill lets a character do`
    );
  }

  if (Object.keys(SKILL_CATALOG).some(g => canonSkill(g) === canonSkill(entry.name))) {
    problems.push(
      `${entry.name} is a general skill every character already has — a bible entry by that name adds nothing`
    );
  }

  if (entry.name.includes("::")) {
    problems.push(
      `${entry.name} contains "::" — that is the separator between a skill's name and its meaning in a story, so a name carrying one can never be matched`
    );
  }

  return problems;
}

/** Registry of all catalog kinds. */
const REGISTRY: Record<CatalogKind, CatalogRegistry> = {
  characters: {
    filename: "catalog-characters.json",
    catalog: CharacterCatalog,
    entry: LibraryCharacter,
    problems: characterProblems,
  },
  tags: {
    filename: "catalog-tags.json",
    catalog: TagCatalog,
    entry: TagEntry,
    problems: tagProblems,
    seed: () => TAG_SEED.map(item => ({
      ...item,
      id: `${item.facet}-${item.label}`,
      version: 1,
    })),
  },
  styles: {
    filename: "catalog-styles.json",
    catalog: StyleCatalog,
    entry: LibraryStyle,
    problems: styleProblems,
    // No seed for styles; they are authored by the user and not provided by the engine.
  },
  skills: {
    filename: "catalog-skills.json",
    catalog: SkillCatalog,
    entry: LibrarySkill,
    problems: skillProblems,
    // The in-code special-skill catalog is the seed; the file wins entirely once it exists.
    seed: () => Object.entries(SPECIAL_SKILL_CATALOG).map(([name, meaning]) => ({ id: name, version: 1, name, meaning, tags: [] })),
  },
};

function catalogPath(kind: CatalogKind, path?: string): string {
  const reg = REGISTRY[kind];
  if (!reg) throw new Error(`Unknown catalog kind: ${kind}`);
  return path ?? joinPath(ROOT, reg.filename);
}

/** The persisted bible as name → meaning pairs. Entries with a blank meaning are dropped: a bible
 *  entry exists to say what a skill lets a character do, and one that says nothing is not a bible
 *  entry. This is the shape the architect's system prompt needs. */
export async function skillBibleEntries(path?: string): Promise<Record<string, string>> {
  const catalog = await loadCatalog("skills", path);
  const entries: Record<string, string> = {};
  for (const entry of catalog.entries) {
    const trimmed = entry.meaning.trim();
    if (trimmed) {
      entries[entry.name] = trimmed;
    }
  }
  return entries;
}

/** The bible as the author has it: every entry in the persisted skills catalog, keyed by canonical
 *  name. `loadCatalog` already resolves file-or-seed, so an absent file gives the in-code seed and a
 *  present one wins entirely — an entry the author deleted stays deleted. A blank meaning is skipped
 *  rather than returned, because a lookup that succeeds with no meaning is exactly the failure the
 *  required `meaning` field exists to prevent. */
export async function skillBible(path?: string): Promise<BibleLookup> {
  return bibleFrom(await skillBibleEntries(path));
}

/** Every entry in one catalog. Missing file returns the seed (if one exists) or an empty catalog, silently.
 *  When the file EXISTS, it wins entirely — the seed is not merged in. We don't merge because that
 *  would resurrect a seed tag the author deliberately deleted, which is worse than a new engine
 *  version's additions not appearing. The author's deletions are intentional and must be preserved.
 *  The seed materializes on first save: when the author edits a tag in a fresh catalog, the save
 *  persists the entire seed (24 tags) with the user's edit, making all tags editable, deletable,
 *  and renameable going forward. */
export async function loadCatalog(kind: CatalogKind, path?: string): Promise<any> {
  const reg = REGISTRY[kind];
  if (!reg) throw new Error(`Unknown catalog kind: ${kind}`);

  const filePath = catalogPath(kind, path);
  let raw: any;
  try {
    raw = JSON.parse(await readFile(filePath, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      // File is absent; return seed if one exists, otherwise empty catalog.
      if (reg.seed) {
        return { entries: reg.seed() };
      }
      return { entries: [] };
    }
    warn(`${kind} catalog could not be read (${(e as Error).message}) — using empty catalog`);
    return { entries: [] };
  }

  const result = reg.catalog.safeParse(raw);
  if (!result.success) {
    warn(`${kind} catalog could not be parsed — using empty catalog`);
    return { entries: [] };
  }

  return result.data;
}

/** Validate one entry without saving it: schema issues first, then advisory problems.
 *  Synchronous and catalog-free — the bible arrives as a parameter for exactly that reason:
 *  the caller that can load one passes it, and the default is the in-code one. */
export function checkEntry(kind: CatalogKind, raw: unknown, bible: BibleLookup = bibleMeaningOf): { ok: false; issues: string[] } | { ok: true; entry: any; problems: string[] } {
  const reg = REGISTRY[kind];
  if (!reg) throw new Error(`Unknown catalog kind: ${kind}`);

  const result = reg.entry.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join(".") || "entry"}: ${i.message}`);
    return { ok: false, issues };
  }

  const entry = result.data;
  const problems = reg.problems(entry, bible);

  return { ok: true, entry, problems };
}

/** Insert or replace one entry by id, then persist. Bumps `version` on replace.
 *  Kinds with an identity of their own beyond the id report a collision as an advisory problem —
 *  a duplicate facet+label for tags, a duplicate canonical name for skills. Neither blocks the save,
 *  since the catalog is an editing surface. */
export async function saveEntry(kind: CatalogKind, raw: unknown, path?: string, bible: BibleLookup = bibleMeaningOf):
  Promise<{ ok: true; entry: any; problems: string[] } | { ok: false; reason: string; issues?: string[] }> {
  const check = checkEntry(kind, raw, bible);
  if (!check.ok) {
    return { ok: false, reason: "entry validation failed", issues: check.issues };
  }

  const entry = check.entry;
  let problems = [...check.problems];

  const catalog = await loadCatalog(kind, path);

  // For tags, check for duplicate facet+label under a different id.
  if (kind === "tags") {
    const existing = (catalog.entries as TagEntry[]).find(
      e => e.facet === entry.facet && e.label === entry.label && e.id !== entry.id
    );
    if (existing) {
      // Duplicate detected, but still save — the catalog is an editing surface.
      problems.push(`tag with facet "${entry.facet}" and label "${entry.label}" already exists with id "${existing.id}"`);
    }
  }

  // For skills, check for canonical duplicate under a different id.
  if (kind === "skills") {
    const existing = (catalog.entries as LibrarySkill[]).find(
      e => canonSkill(e.name) === canonSkill(entry.name) && e.id !== entry.id
    );
    if (existing) {
      // Duplicate detected, but still save — the catalog is an editing surface.
      problems.push(`a skill named "${existing.name}" is already in the bible (id "${existing.id}") — one skill must have one canonical spelling`);
    }
  }

  const existingIndex = catalog.entries.findIndex((e: any) => e.id === entry.id);
  const entryToSave = { ...entry };
  if (existingIndex >= 0) {
    entryToSave.version = catalog.entries[existingIndex].version + 1;
    catalog.entries[existingIndex] = entryToSave;
  } else {
    entryToSave.version = 1;
    catalog.entries.push(entryToSave);
  }

  const persistResult = await persist(kind, catalog, path);
  if (!persistResult.ok) {
    return persistResult;
  }

  // Verify the entry was actually saved at the expected version.
  const reloaded = await loadCatalog(kind, path);
  const saved = reloaded.entries.find((e: any) => e.id === entry.id);
  if (!saved || saved.version !== entryToSave.version) {
    return { ok: false, reason: "saved but does not load: entry not found or version mismatch" };
  }

  return { ok: true, entry: entryToSave, problems };
}

/** Remove one entry by id, then persist. Removing an id that is not there is `ok: false` with `missing: true`. */
export async function deleteEntry(kind: CatalogKind, id: string, path?: string):
  Promise<{ ok: true } | { ok: false; reason: string; missing?: true }> {
  const catalog = await loadCatalog(kind, path);

  const existingIndex = catalog.entries.findIndex((e: any) => e.id === id);
  if (existingIndex === -1) {
    return { ok: false, reason: `entry "${id}" not found`, missing: true };
  }

  catalog.entries.splice(existingIndex, 1);

  const persistResult = await persist(kind, catalog, path);
  if (!persistResult.ok) {
    return persistResult;
  }

  // Verify the entry was actually deleted.
  const reloaded = await loadCatalog(kind, path);
  if (reloaded.entries.some((e: any) => e.id === id)) {
    return { ok: false, reason: "saved but does not load: entry still present" };
  }

  return { ok: true };
}

/** Write one catalog to disk: temp file, then rename. Whether the write took is the caller's to
 *  confirm — each knows what it expects to find. */
async function persist(kind: CatalogKind, catalog: any, path?: string):
  Promise<{ ok: true } | { ok: false; reason: string }> {
  const filePath = catalogPath(kind, path);
  const tmpPath = filePath + ".tmp";
  const content = JSON.stringify(catalog, null, 2) + "\n";
  try {
    await writeFile(tmpPath, content, "utf8");
    await rename(tmpPath, filePath);
  } catch (e) {
    return { ok: false, reason: `write failed: ${(e as Error).message}` };
  }
  return { ok: true };
}
