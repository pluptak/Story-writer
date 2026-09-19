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

// -- SHARED TOKEN MATCHING --------------------------------------------------
/** Lowercase, punctuation to spaces, whitespace collapsed. The match only has to read as such
 *  normalized — case and punctuation are not content. Shared by quote-lint and repeat-lint so
 *  the two agree on what "verbatim" means. */
export const normText = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

/** True when `inner`'s tokens appear as a contiguous run inside `outer` (either order) — a
 *  verbatim phrase, not a substring accident where "no" matches inside "know". */
export function containsTokenRun(outer: string[], inner: string[]): boolean {
  if (inner.length === 0) return true;
  if (inner.length > outer.length) return false;
  for (let s = 0; s <= outer.length - inner.length; s++) {
    let ok = true;
    for (let k = 0; k < inner.length; k++)
      if (outer[s + k] !== inner[k]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}
