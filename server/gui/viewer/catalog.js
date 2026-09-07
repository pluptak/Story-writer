import { APP } from "./state.js";
import { syncHash } from "./nav.js";

/** What the other catalogs reference, for the list's "used by" lines and the tag page's derived
 *  STORY/STYLE grouping and styles-associated line. Derived server-side over all kinds at once; a
 *  failure leaves the last known usage rather than erroring the page — counts are decoration, the
 *  entries are the data. */
export async function refreshUsage() {
  try {
    const r = await fetch("/catalog/usage");
    const j = await r.json();
    if (j.ok) APP.catalog.usage = j.usage;
  } catch { /* keep what was there */ }
}

// "Loaded" is tracked apart from "non-empty" because an EMPTY catalog is a real answer, and the
// loaders that keyed on `.length` re-fetched forever when they got one: every load ends in a
// render, every render re-runs the wiring that starts the load. A catalog nobody has authored yet
// -- characters and styles both, on a new install -- span the page instead of settling.

/** One lazy "load once on first need" fetcher, filling an APP.catalog slot from /catalog?kind=….
 *  A load that failed marks itself loaded anyway -- it shows its error and waits to be
 *  invalidated, rather than being retried by the very render it just caused. `.invalidate()`
 *  drops the cache after a write to that kind, so pickers fed from it reflect the edit. */
function makeLazyLoader({ path, slot, label }) {
  let loading = false, loaded = false;
  const load = async () => {
    if (loaded || loading) return;   // already here, or already on its way

    loading = true;
    try {
      const r = await fetch(path);
      const j = await r.json();
      if (j.ok) APP.catalog[slot] = j.entries || [];
      APP.render();
      syncHash();
    } catch {
      // Left as [] (its initial value): callers already treat an empty slot as "nothing to offer".
      APP.render();
      syncHash();
    } finally {
      loading = false; loaded = true;
    }
  };
  load.invalidate = () => { APP.catalog[slot] = []; loading = false; loaded = false; };
  return load;
}

/** Load the tag vocabulary once, on first need */
export const loadVocab = makeLazyLoader({ path: "/catalog?kind=tags", slot: "vocab", label: "tag vocabulary" });

/** Load the style presets once, on first need */
export const loadStyles = makeLazyLoader({ path: "/catalog?kind=styles", slot: "styles", label: "style presets" });

/** Load the character library once, on first need */
export const loadLibrary = makeLazyLoader({ path: "/catalog?kind=characters", slot: "library", label: "character library" });
