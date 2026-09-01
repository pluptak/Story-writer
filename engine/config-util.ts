/** Shared filename slugifier, and the character-name matching everything else agrees on. */

/** A safe folder-name slug from any string, or "" when nothing usable survives. */
export function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

// -- CHARACTER NAME MATCHING ------------------------------------------------
/** Roster, pov, reach grants, consult addressees and every agent map key match character names
 *  case-insensitively — a mis-cased name must find its character, not silently match nobody — so
 *  every identity comparison goes through these two rather than re-spelling the rule. */
export const nameKey = (name: string) => name.trim().toLowerCase();
export const sameName = (a: string, b: string) => nameKey(a) === nameKey(b);
