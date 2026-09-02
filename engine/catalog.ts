/** CATALOG — storage and validation for the character catalog. */
import { readFile, writeFile, rename } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { warn } from "./warnings.ts";
import { characterPsychologyWarnings } from "./story-spec.ts";
import { capabilityProblems } from "./skills.ts";
import { ROOT } from "./story-format.ts";
import { CharacterCatalog, LibraryCharacter, type CatalogKind } from "./catalog-schema.ts";

const KIND_TO_FILENAME: Record<CatalogKind, string> = {
  characters: "catalog-characters.json",
};

function catalogPath(kind: CatalogKind, path?: string): string {
  if (!KIND_TO_FILENAME[kind])
    throw new Error(`Unknown catalog kind: ${kind}`);
  return path ?? joinPath(ROOT, KIND_TO_FILENAME[kind]);
}

/** Every entry in one catalog. Missing file = empty catalog, silently. */
export async function loadCatalog(kind: CatalogKind, path?: string): Promise<CharacterCatalog> {
  const filePath = catalogPath(kind, path);
  let raw: any;
  try {
    raw = JSON.parse(await readFile(filePath, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { entries: [] };
    }
    warn(`${kind} catalog could not be read (${(e as Error).message}) — using empty catalog`);
    return { entries: [] };
  }

  const result = CharacterCatalog.safeParse(raw);
  if (!result.success) {
    warn(`${kind} catalog could not be parsed — using empty catalog`);
    return { entries: [] };
  }

  return result.data;
}

/** Validate one entry without saving it: schema issues first, then advisory problems. */
export function checkEntry(raw: unknown): { ok: false; issues: string[] } | { ok: true; entry: LibraryCharacter; problems: string[] } {
  const result = LibraryCharacter.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join(".") || "entry"}: ${i.message}`);
    return { ok: false, issues };
  }

  const entry = result.data;
  const problems: string[] = [];

  problems.push(...characterPsychologyWarnings(entry.name, entry.belief, entry.impulse, entry.voice));

  // The catalog is an editing surface: an unresolvable restriction is something to tell the author
  // about, not something to silently delete from their entry.
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

  return { ok: true, entry, problems };
}

/** Insert or replace one entry by id, then persist. Bumps `version` on replace. */
export async function saveEntry(kind: CatalogKind, raw: unknown, path?: string):
  Promise<{ ok: true; entry: LibraryCharacter; problems: string[] } | { ok: false; reason: string; issues?: string[] }> {
  const check = checkEntry(raw);
  if (!check.ok) {
    return { ok: false, reason: "entry validation failed", issues: check.issues };
  }

  const entry = check.entry;
  const problems = check.problems;

  const catalog = await loadCatalog(kind, path);

  const existingIndex = catalog.entries.findIndex(e => e.id === entry.id);
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
  const saved = reloaded.entries.find(e => e.id === entry.id);
  if (!saved || saved.version !== entryToSave.version) {
    return { ok: false, reason: "saved but does not load: entry not found or version mismatch" };
  }

  return { ok: true, entry: entryToSave, problems };
}

/** Remove one entry by id, then persist. Removing an id that is not there is `ok: false`. */
export async function deleteEntry(kind: CatalogKind, id: string, path?: string):
  Promise<{ ok: true } | { ok: false; reason: string }> {
  const catalog = await loadCatalog(kind, path);

  const existingIndex = catalog.entries.findIndex(e => e.id === id);
  if (existingIndex === -1) {
    return { ok: false, reason: `entry "${id}" not found` };
  }

  catalog.entries.splice(existingIndex, 1);

  const persistResult = await persist(kind, catalog, path);
  if (!persistResult.ok) {
    return persistResult;
  }

  // Verify the entry was actually deleted.
  const reloaded = await loadCatalog(kind, path);
  if (reloaded.entries.some(e => e.id === id)) {
    return { ok: false, reason: "saved but does not load: entry still present" };
  }

  return { ok: true };
}

/** Write one catalog to disk: temp file, then rename. Whether the write took is the caller's to
 *  confirm — each knows what it expects to find. */
async function persist(kind: CatalogKind, catalog: CharacterCatalog, path?: string):
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
