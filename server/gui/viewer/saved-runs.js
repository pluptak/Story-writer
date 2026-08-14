import { $, esc, fmtRun } from "./util.js";
import { APP, READV } from "./state.js";
import { ingest } from "./events.js";
import { setSrc } from "./hud.js";

// ---- the saved-run browser -------------------------------------------------
export function savedRunsHtml() {
  if (!APP.stories) return `<section class="picker"><h2>Saved runs</h2><p class="sub">reading the shelf…</p></section>`;
  const rows = APP.stories.map(s => {
    const runs = (s.runs || []).length
      ? `<div class="runs">${s.runs.map(r => `<button class="btn runbtn" data-dir="${esc(s.dir)}"
           data-run="${esc(r.id)}">read · ${esc(fmtRun(r))}</button>`).join("")}</div>`
      : `<span class="hint">no retained runs</span>`;
    return `<div class="cardwrap"><div class="storyrow">${esc(s.name)}</div>${runs}</div>`;
  }).join("");
  return `<section class="picker">
    <h2>Saved runs</h2>
    <p class="sub">a story's retained runs, newest first — or open one from disk</p>
    <div class="cards">${rows}</div>
    <div class="btns" style="margin-top:14px"><button class="btn" id="open-log">open a saved log</button></div>
  </section>`;
}

export function wireSavedRuns(page) {
  const ol = page.querySelector("#open-log");
  if (ol) ol.addEventListener("click", () => $("file").click());
  for (const b of page.querySelectorAll(".runbtn"))
    b.addEventListener("click", async () => {
      const dir = b.dataset.dir, id = b.dataset.run;
      try {
        const r = await fetch(`/runs/log?dir=${encodeURIComponent(dir)}&id=${encodeURIComponent(id)}`);
        if (!r.ok) return;
        setSrc(READV, `${dir.replace(/^stories\//, "")} · saved run`, false);
        READV.label = fmtRun((APP.stories.find(s => s.dir === dir)?.runs || []).find(x => x.id === id) || {});
        ingest(await r.text(), READV);
      } catch {}
    });
}

/** Fetch the shelf's cards. Feeds both the shelf (while picking) and the saved-run browser (while
 *  reading) -- called on the picking edge and every time the read page is opened, since the
 *  pre-flight behind it goes stale the moment a story is edited on disk. */
export async function loadStories() {
  APP.stories = null; APP.render();
  try { APP.stories = (await (await fetch("/stories")).json()).stories || []; }
  catch { APP.stories = []; }
  APP.render();
}
