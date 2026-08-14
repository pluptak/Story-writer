import { notify } from "./util.js";
import { APP } from "./state.js";
import { loadStories } from "./saved-runs.js";

// ---- pages and navigation --------------------------------------------------
export const navLocked = () => APP.live && APP.session.running && !APP.session.paused;

export const parseHash = () => {
  const path = location.hash.replace(/^#\/?/, "").split("?")[0];
  return /^(shelf|live|read)$/.test(path) ? path : null;
};
export const parseHashParams = () => {
  const qs = location.hash.replace(/^#\/?/, "").split("?")[1] || "";
  return new URLSearchParams(qs);
};
/** Only replaces the hash when the PATH is out of date -- a `#/read?dir=&id=` deep link that
 *  already names the current view keeps its query string, so reloading or bookmarking it lands
 *  back on the same saved run rather than the bare saved-run browser. */
export const syncHash = () => {
  if (parseHash() === APP.view) return;
  history.replaceState(null, "", "#/" + APP.view);
};

/** Programmatic navigation -- always applied, used for the edge-triggered auto-switches and for the
 *  boot sequence. Falls back rather than landing somewhere nonsensical: no engine attached means
 *  only the read page means anything, and the shelf is never shown except while parked on a pick. */
export function go(v) {
  if (!APP.live) v = "read";
  else if (v === "shelf" && !APP.session.picking) v = "live";
  APP.view = v;
  // Both the shelf and the saved-run browser read the same `/stories`, and both go stale the
  // moment a story is edited on disk -- refetch on every arrival rather than trusting a cache from
  // whenever the tab was last open.
  if (v === "read" || v === "shelf") loadStories();
  syncHash();
  APP.render();
  if (v === "live" && APP.wantReaderView) {
    APP.wantReaderView = false;
    const q = document.querySelector(".reader.pending");
    if (q) q.scrollIntoView({ block:"center", behavior:"smooth" });
  }
}
/** A click on a tab, or the hash changing under the user's hand. Refuses to move while a scene is
 *  generating -- the same one-sentence reason the tab's own tooltip already gives. */
export function userNav(v) {
  if (navLocked()) { notify("pause or stop the run to leave"); return; }
  go(v);
}
addEventListener("hashchange", () => {
  const v = parseHash();
  if (v && v !== APP.view) userNav(v);
});

for (const t of document.querySelectorAll(".tab"))
  t.addEventListener("click", () => userNav(t.dataset.view));
