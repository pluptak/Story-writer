import { $ } from "./util.js";
import { APP, READV, open } from "./state.js";
import { ingest } from "./events.js";
import { setSrc } from "./hud.js";
import { go } from "./nav.js";

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
  try { localStorage.setItem("sw-theme", next); } catch {}
};
// Opening or dropping a saved log lands on the read page, which is read-only -- so it is allowed
// even mid-run, the same as clicking the read tab. The live scene keeps streaming into LIVEV and is
// one click on the run tab away.
$("file").onchange = e => {
  const f = e.target.files[0]; if (!f) return;
  f.text().then(t => { setSrc(READV, f.name, false); READV.label = ""; READV.dir = ""; READV.id = ""; ingest(t, READV); go("read"); });
};
addEventListener("dragover", e => { e.preventDefault(); $("drop").classList.add("on"); });
addEventListener("dragleave", e => { if (e.relatedTarget === null) $("drop").classList.remove("on"); });
addEventListener("drop", e => {
  e.preventDefault(); $("drop").classList.remove("on");
  const f = e.dataTransfer.files[0]; if (!f) return;
  f.text().then(t => { setSrc(READV, f.name, false); READV.label = ""; READV.dir = ""; READV.id = ""; ingest(t, READV); go("read"); });
});
