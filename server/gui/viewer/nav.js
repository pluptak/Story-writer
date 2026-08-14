import { notify } from "./util.js";
import { APP } from "./state.js";
import { loadStories } from "./saved-runs.js";

// ---- pages and navigation --------------------------------------------------
/** A scene is being written RIGHT NOW -- as opposed to paused, finished, or not yet started. */
export const generating = () => APP.live && APP.session.running && !APP.session.paused;

export const navBlocked = v => v === "shelf" && generating();

export const parseHash = () => {
  const path = location.hash.replace(/^#\/?/, "").split("?")[0];
  return /^(shelf|live|read)$/.test(path) ? path : null;
};
export const parseHashParams = () => {
  const qs = location.hash.replace(/^#\/?/, "").split("?")[1] || "";
  return new URLSearchParams(qs);
};
export const syncHash = () => {
  if (parseHash() === APP.view) return;
  history.replaceState(null, "", "#/" + APP.view);
};

export function go(v) {
  if (!APP.live) v = "read";
  else if (v === "shelf" && !APP.session.picking) v = "live";
  APP.view = v;
if (v === "read" || v === "shelf") loadStories();
  syncHash();
  APP.render();
  if (v === "live" && APP.wantReaderView) {
    APP.wantReaderView = false;
    const q = document.querySelector(".reader.pending");
    if (q) q.scrollIntoView({ block:"center", behavior:"smooth" });
  }
}
export function userNav(v) {
  if (navBlocked(v)) { notify("stop the run to choose another story"); return; }
  go(v);
}
addEventListener("hashchange", () => {
  const v = parseHash();
  if (v && v !== APP.view) userNav(v);
});

for (const t of document.querySelectorAll(".tab"))
  t.addEventListener("click", () => userNav(t.dataset.view));
