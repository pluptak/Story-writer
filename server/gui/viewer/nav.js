import { APP, READV, READER } from "./state.js";
import { loadStories } from "./saved-runs.js";

// ---- pages and navigation --------------------------------------------------
/** A scene is being written RIGHT NOW -- as opposed to paused, finished, or not yet started. */
export const generating = () => APP.live && APP.session.running && !APP.session.paused;

export const parseHash = () => {
  const path = location.hash.replace(/^#\/?/, "").split("?")[0];
  return /^(shelf|story|live|read|readstory|compare|handoff|edit|scaffold|catalog)$/.test(path) ? path : null;
};
export const parseHashParams = () => {
  const qs = location.hash.replace(/^#\/?/, "").split("?")[1] || "";
  return new URLSearchParams(qs);
};

/** The hash a page WANTS, params and all -- not just its path. A story page and a saved run are
 *  each about one particular thing, and a reload that keeps the page but loses which one is a
 *  bookmark that does not work. Sub-page targets ride along: `&block=` names the consult to open
 *  (live/read), `&modal=` the character card to reopen -- so the URL a bug report pastes IS the
 *  pinpoint. */
const joiner = h => h + (h.includes("?") ? "&" : "?");
const hashFor = () => {
  if (APP.view === "story" && APP.storyDir) return withExtras(`#/story?dir=${encodeURIComponent(APP.storyDir)}`);
  if (APP.view === "handoff" && APP.handoffDir) return `#/handoff?dir=${encodeURIComponent(APP.handoffDir)}`;
  if (APP.view === "scaffold") return "#/scaffold";
  if (APP.view === "catalog") {
    // Include kind in the URL so a reload lands back on the same catalog kind
    const kind = APP.catalog.kind || "characters";
    return kind !== "characters" ? `#/catalog?kind=${encodeURIComponent(kind)}` : "#/catalog";
  }
  if (APP.view === "edit" && APP.editNew) return "#/edit?new=1";
  if (APP.view === "edit" && APP.editDir) return `#/edit?dir=${encodeURIComponent(APP.editDir)}`;
  if (APP.view === "readstory" && READER.dir) return `#/readstory?dir=${encodeURIComponent(READER.dir)}`;
  if (APP.view === "read" && READV.dir && READV.id) {
    let h = `#/read?dir=${encodeURIComponent(READV.dir)}&id=${encodeURIComponent(READV.id)}`;
    if (APP.focusSeq != null) h += `&block=${APP.focusSeq}`;
    return withExtras(h);
  }
  if (APP.view === "compare" && APP.compareDir)
    return `#/compare?dir=${encodeURIComponent(APP.compareDir)}&a=${encodeURIComponent(APP.compareA)}&b=${encodeURIComponent(APP.compareB)}`;
  if ((APP.view === "live" || APP.view === "read") && APP.focusSeq != null)
    return `#/${APP.view}?block=${APP.focusSeq}`;
  return withExtras("#/" + APP.view);
};
/** modal= applies on any route (the card opens over live, read, shelf and story alike). */
const withExtras = h => APP.modalWant ? joiner(h) + "modal=" + encodeURIComponent(APP.modalWant) : h;
// replaceState, never `location.hash =`, so the page's own transitions do not fire a synthetic
// hashchange for the listener below to chase.
export const syncHash = () => {
  const want = hashFor();
  if (location.hash !== want) history.replaceState(null, "", want);
};

// ---- sub-page deep links ----------------------------------------------------
/** Tag the consult the URL should name. `noteFocus` is a jump (timeline marker, deep link): it
 *  re-arms the one-shot scroll in pages.js's settle. `tagFocus` is a quiet URL sync (the user
 *  toggled a consult open themselves) -- no rescroll. */
export const noteFocus = seq => { APP.focusSeq = seq; APP.focusScrolled = false; };
export const tagFocus = seq => { APP.focusSeq = seq; };
export const clearFocus = () => {
  if (APP.focusSeq == null) return;
  APP.focusSeq = null;
  APP.focusScrolled = false;
  syncHash();
};

/** Go to a page. The shelf is always a legal destination while an engine is attached -- it is the
 *  hub, not a parking spot -- so the only rewrite left is for a viewer with no engine behind it at
 *  all, which has nothing but a saved run to show. */
export function go(v) {
  if (!APP.live && v !== "read" && v !== "readstory" && v !== "compare") v = "read";
  // Leaving live/read drops the block anchor -- it names a seq in the scene that page was showing,
  // and carrying it over would scroll to whatever happens to reuse the number.
  if (v !== "live" && v !== "read" && APP.focusSeq != null) { APP.focusSeq = null; APP.focusScrolled = false; }
  // Dirty guard: confirm before leaving the editor with unsaved changes. On cancel, put the URL
  // back: a hashchange (browser back, a bookmark) has already moved location.hash, so without this
  // the address bar shows the page we refused while the editor stays on screen.
  if (v !== "edit" && APP.editDirty && !confirm("Discard unsaved changes?")) { syncHash(); return; }
  // Actually leaving the editor clears its state -- "discard" has to mean discard. Without this
  // the guard re-prompts on every later navigation, beforeunload keeps warning on tab close, and
  // the surviving draft can be saved into whichever story opens next.
  if (APP.view === "edit" && v !== "edit") {
    if (APP.editCheckTimer) clearTimeout(APP.editCheckTimer);
    APP.editDir = ""; APP.editNew = false; APP.editFor = ""; APP.editStory = null; APP.editDraft = null;
    APP.editDirty = false; APP.editError = ""; APP.editIssues = []; APP.editRaw = null;
  }
  // Leaving the catalog clears its armed delete timer -- an armed destructive action must not
  // survive navigation.
  if (APP.view === "catalog" && v !== "catalog") {
    if (APP.catalog.deleteTimer) clearTimeout(APP.catalog.deleteTimer);
    APP.catalog.deleteTimer = 0;
    APP.catalog.armedDelete = false;
  }
  APP.view = v;
  // The URL is synced BEFORE the fetch, because loadStories() renders synchronously on its first
  // line -- and a page that reads the URL on arrival (the catalog's kind) would otherwise be handed
  // the address of the page we just left, and reset itself to what that one said.
  syncHash();
  if (v === "readstory" || v === "read" || (v === "compare" && !APP.stories) || v === "shelf" || v === "story" || v === "handoff" || v === "edit" || v === "catalog") loadStories();
  APP.render();
  if (v === "live" && APP.wantReaderView) {
    APP.wantReaderView = false;
    const q = document.querySelector(".reader.pending");
    if (q) q.scrollIntoView({ block:"center", behavior:"smooth" });
  }
}

addEventListener("hashchange", () => {
  const v = parseHash();
  if (v && v !== APP.view) go(v);
});

for (const t of document.querySelectorAll("#sidenav .navitem"))
  t.addEventListener("click", () => {
    const v = t.dataset.view, kind = t.dataset.kind;
    // The Libraries group seeds the kind before navigating: hashFor() reads APP.catalog.kind to
    // build the URL, and applyCatalogUrlKind's not-loaded branch is what actually fetches it.
    if (v === "catalog" && kind) { APP.catalog.kind = kind; APP.catalog.loaded = false; }
    // "Architect" is whichever session is open — the handoff re-authors a cast, the scaffold builds
    // a new story, and only one of them is ever live.
    if (t.id === "nav-architect" && APP.handoff.active) {
      APP.handoffDir = APP.handoff.dir;
      go("handoff");
      return;
    }
    go(v);
  });
