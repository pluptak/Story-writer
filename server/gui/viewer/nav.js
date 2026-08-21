import { APP, READV, READER } from "./state.js";
import { loadStories } from "./saved-runs.js";

// ---- pages and navigation --------------------------------------------------
/** A scene is being written RIGHT NOW -- as opposed to paused, finished, or not yet started. */
export const generating = () => APP.live && APP.session.running && !APP.session.paused;

export const parseHash = () => {
  const path = location.hash.replace(/^#\/?/, "").split("?")[0];
  return /^(shelf|story|live|read|readstory|compare|handoff|edit)$/.test(path) ? path : null;
};
export const parseHashParams = () => {
  const qs = location.hash.replace(/^#\/?/, "").split("?")[1] || "";
  return new URLSearchParams(qs);
};

/** The hash a page WANTS, params and all -- not just its path. A story page and a saved run are
 *  each about one particular thing, and a reload that keeps the page but loses which one is a
 *  bookmark that does not work. */
const hashFor = () => {
  if (APP.view === "story" && APP.storyDir) return `#/story?dir=${encodeURIComponent(APP.storyDir)}`;
  if (APP.view === "handoff" && APP.handoffDir) return `#/handoff?dir=${encodeURIComponent(APP.handoffDir)}`;
  if (APP.view === "edit" && APP.editDir) return `#/edit?dir=${encodeURIComponent(APP.editDir)}`;
  if (APP.view === "readstory" && READER.dir) return `#/readstory?dir=${encodeURIComponent(READER.dir)}`;
  if (APP.view === "read" && READV.dir && READV.id)
    return `#/read?dir=${encodeURIComponent(READV.dir)}&id=${encodeURIComponent(READV.id)}`;
  if (APP.view === "compare" && APP.compareDir)
    return `#/compare?dir=${encodeURIComponent(APP.compareDir)}&a=${encodeURIComponent(APP.compareA)}&b=${encodeURIComponent(APP.compareB)}`;
  return "#/" + APP.view;
};
// replaceState, never `location.hash =`, so the page's own transitions do not fire a synthetic
// hashchange for the listener below to chase.
export const syncHash = () => {
  const want = hashFor();
  if (location.hash !== want) history.replaceState(null, "", want);
};

/** Go to a page. The shelf is always a legal destination while an engine is attached -- it is the
 *  hub, not somewhere the session parks you -- so the only rewrite left is the one for a viewer
 *  with no engine behind it at all, which has nothing but a saved run to show. */
export function go(v) {
  if (!APP.live && v !== "read" && v !== "readstory" && v !== "compare") v = "read";
  // Dirty guard: confirm before leaving the editor with unsaved changes
  if (v !== "edit" && APP.editDirty && !confirm("Discard unsaved changes?")) return;
  // Actually leaving the editor clears its state -- "discard" has to mean discard. Without this
  // the guard re-prompts on every later navigation, beforeunload keeps warning on tab close, and
  // the surviving draft can be saved into whichever story is opened next.
  if (APP.view === "edit" && v !== "edit") {
    if (APP.editCheckTimer) clearTimeout(APP.editCheckTimer);
    APP.editDir = ""; APP.editFor = ""; APP.editStory = null; APP.editDraft = null;
    APP.editDirty = false; APP.editError = ""; APP.editIssues = []; APP.editRaw = null;
  }
  APP.view = v;
  if (v === "readstory" || v === "read" || (v === "compare" && !APP.stories) || v === "shelf" || v === "story" || v === "handoff" || v === "edit") loadStories();
  syncHash();
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

for (const t of document.querySelectorAll(".tab"))
  t.addEventListener("click", () => go(t.dataset.view));
