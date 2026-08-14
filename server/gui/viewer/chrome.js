import { $, notify } from "./util.js";
import { APP, READV, open } from "./state.js";
import { ingest } from "./events.js";
import { setSrc } from "./hud.js";
import { navLocked, go } from "./nav.js";

// ---- chrome -------------------------------------------------------------
$("expand").onclick = () => {
  APP.expandAll = !APP.expandAll;
  $("expand").textContent = APP.expandAll ? "collapse all" : "expand all";
  if (!APP.expandAll) open.clear();
  APP.render();
};
$("theme").onclick = () => {
  const cur = document.documentElement.getAttribute("data-theme");
  const dark = cur ? cur === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  const next = dark ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  // Kept, because a run is watched across reloads and reconnects, and having to re-pick the theme
  // on each one is a choice the page keeps forgetting. Restored before paint, up in the head.
  try { localStorage.setItem("sw-theme", next); } catch {}
};
$("file").onchange = e => {
  const f = e.target.files[0]; if (!f) return;
  if (navLocked()) { notify("pause or stop the run to leave"); e.target.value = ""; return; }
  f.text().then(t => { setSrc(READV, f.name, false); READV.label = ""; ingest(t, READV); go("read"); });
};
addEventListener("dragover", e => { e.preventDefault(); if (!navLocked()) $("drop").classList.add("on"); });
addEventListener("dragleave", e => { if (e.relatedTarget === null) $("drop").classList.remove("on"); });
addEventListener("drop", e => {
  e.preventDefault(); $("drop").classList.remove("on");
  if (navLocked()) { notify("pause or stop the run to leave"); return; }
  const f = e.dataTransfer.files[0]; if (!f) return;
  f.text().then(t => { setSrc(READV, f.name, false); READV.label = ""; ingest(t, READV); go("read"); });
});
