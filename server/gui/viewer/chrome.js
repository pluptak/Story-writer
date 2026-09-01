import { $ } from "./util.js";
import { APP, READV, open } from "./state.js";
import { ingest } from "./events.js";
import { setSrc } from "./hud.js";
import { go } from "./nav.js";

// ---- chrome -------------------------------------------------------------
$("expand").onclick = () => {
  APP.expandAll = !APP.expandAll;
  $("expand").textContent = APP.expandAll ? "collapse all" : "expand all";
  $("expand").setAttribute("aria-pressed", APP.expandAll ? "true" : "false");
  if (!APP.expandAll) open.clear();
  APP.render();
};
// The theme button names what a click DOES and reflects the mode it would leave -- so it doubles
// as a read-out of the current theme, which "theme" alone never was.
function paintTheme() {
  const cur = document.documentElement.getAttribute("data-theme");
  const dark = cur ? cur === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  const t = $("theme");
  t.textContent = dark ? "☀ light" : "☾ dark";
  t.title = dark ? "switch to the light theme" : "switch to the dark theme";
  t.setAttribute("aria-pressed", dark ? "true" : "false");
}
$("theme").onclick = () => {
  const cur = document.documentElement.getAttribute("data-theme");
  const dark = cur ? cur === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  const next = dark ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("sw-theme", next); } catch {}
  paintTheme();
};
paintTheme();
// Follow the OS theme too, but only while the viewer is on the system default (no explicit choice).
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (!document.documentElement.getAttribute("data-theme")) paintTheme();
});
// Opening or dropping a saved log lands on the read page, which is read-only -- so it is allowed
// even mid-run, like clicking the read tab. The live scene keeps streaming into LIVEV and is one
// click on the run tab away.
const openLog = f =>
  f.text().then(t => { setSrc(READV, f.name, false); READV.label = ""; READV.dir = ""; READV.id = ""; ingest(t, READV); go("read"); });
$("file").onchange = e => {
  const f = e.target.files[0];
  e.target.value = "";              // picking the same file again after a cancel must still fire
  if (!f) return;
  openLog(f);
};
const dragHasFiles = e => [...(e.dataTransfer?.types || [])].includes("Files");
addEventListener("dragover", e => {
  // Only files light the overlay -- dragging selected text across the window used to say
  // "drop a writing-log.jsonl" too.
  if (!dragHasFiles(e)) return;
  e.preventDefault(); $("drop").classList.add("on");
});
addEventListener("dragleave", e => { if (e.relatedTarget === null) $("drop").classList.remove("on"); });
addEventListener("drop", e => {
  e.preventDefault(); $("drop").classList.remove("on");
  const f = e.dataTransfer.files[0]; if (!f) return;
  openLog(f);
});

// Escape closes the topmost modal only -- character card stacks above run-ended, which sits above
// the interview. Each close is that modal's own "dismiss, never submit" path.
addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  const backdrops = [...document.querySelectorAll(".modal-backdrop")];
  const top = backdrops[backdrops.length - 1];
  if (!top) return;
  if (top.id === "iv-backdrop") { e.preventDefault(); go("shelf"); return; }
  if (top.id === "charcard-backdrop") { APP.charCard = null; APP.modalWant = ""; }
  else if (top.id === "runended-backdrop") APP.runEnded = null;
  else return;
  e.preventDefault();
  APP.render();
});

// ---- breadcrumb navigation ----------------------------------------------
// The crumbs paintSrcbar() (hud.js) draws into #src carry where they lead. Wired here, not in
// hud.js, because hud.js must not import nav.js: saved-runs.js already imports hud.js, so
// hud.js -> nav.js -> saved-runs.js -> hud.js would close a module cycle.
function navigateCrumb(c) {
  const view = c.dataset.view, dir = c.dataset.dir;
  if (view === "story" && dir) { APP.storyDir = dir; APP.chapter = null; go("story"); }
  else go(view);
}
$("src").addEventListener("click", e => {
  const c = e.target.closest(".crumb[data-view]");
  if (c) navigateCrumb(c);
});
$("src").addEventListener("keydown", e => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const c = e.target.closest(".crumb[data-view]");
  if (!c) return;
  e.preventDefault();
  navigateCrumb(c);
});
