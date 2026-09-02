/** CATALOG — storage and validation for character and tag catalogs. */
import { readFile, writeFile, rename } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { z } from "zod";
import { warn } from "./warnings.ts";
import { characterPsychologyWarnings } from "./story-spec.ts";
import { capabilityProblems } from "./skills.ts";
import { ROOT } from "./story-format.ts";
import {
  CharacterCatalog,
  TAG_SEED, TagCatalog, TagEntry, type CatalogKind, type TagFacet,
  LibraryCharacter,
} from "./catalog-schema.ts";

// -- REGISTRY ---------------------------------------------------------------

/** Per-kind configuration: schema, filename, problems checker, and optional seed. */
type CatalogRegistry = {
  filename: string;
  catalog: z.ZodType<any>;
  entry: z.ZodType<any>;
  problems: (entry: any) => string[];
  seed?: () => any[];
};

/** Character-specific problems: psychology, capabilities, and portable-persona checks. */
function characterProblems(entry: LibraryCharacter): string[] {
  const problems: string[] = [];

  problems.push(...characterPsychologyWarnings(entry.name, entry.belief, entry.impulse, entry.voice));

  const capProblems = capabilityProblems(entry.name, entry.skills, entry.restrictions);
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
};

function catalogPath(kind: CatalogKind, path?: string): string {
  const reg = REGISTRY[kind];
  if (!reg) throw new Error(`Unknown catalog kind: ${kind}`);
  return path ?? joinPath(ROOT, reg.filename);
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
 *  Synchronous and catalog-free — uses only the registry's entry schema and problems checker. */
export function checkEntry(kind: CatalogKind, raw: unknown): { ok: false; issues: string[] } | { ok: true; entry: any; problems: string[] } {
  const reg = REGISTRY[kind];
  if (!reg) throw new Error(`Unknown catalog kind: ${kind}`);

  const result = reg.entry.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join(".") || "entry"}: ${i.message}`);
    return { ok: false, issues };
  }

  const entry = result.data;
  const problems = reg.problems(entry);

  return { ok: true, entry, problems };
}

/** Insert or replace one entry by id, then persist. Bumps `version` on replace.
 *  For tags, checks for duplicate facet+label pairs and reports them as advisory problems
 *  (they don't block the save, since the catalog is an editing surface). */
export async function saveEntry(kind: CatalogKind, raw: unknown, path?: string):
  Promise<{ ok: true; entry: any; problems: string[] } | { ok: false; reason: string; issues?: string[] }> {
  const check = checkEntry(kind, raw);
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
