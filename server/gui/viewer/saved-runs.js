import { $, fmtRun } from "./util.js";
import { APP, READV } from "./state.js";
import { ingest } from "./events.js";
import { setSrc } from "./hud.js";
import { castChips } from "./shelf.js";
import { loadAgents, agentsPanelHtml, wireAgents } from "./agents.js";

/** Fetch one retained run's log and load it into READV -- shared by a deep-linked reload (sse.js)
 *  and the story page's "read a previous run" rows (story-page.js). */
export async function loadRun(dir, id) {
  try {
    const r = await fetch(`/runs/log?dir=${encodeURIComponent(dir)}&id=${encodeURIComponent(id)}`);
    if (!r.ok) return false;
    setSrc(READV, `${dir.replace(/^stories\//, "")} · saved run`, false);
    READV.dir = dir; READV.id = id;
    READV.label = fmtRun((APP.stories?.find(s => s.dir === dir)?.runs || []).find(x => x.id === id) || {});
    ingest(await r.text(), READV);
    await loadAgents(dir, id);
    return true;
  } catch { return false; }
}

// ---- the read tab's chrome --------------------------------------------------
// Picking which run to read now happens on the story page -- its "previous runs" list -- so this
// tab no longer needs a second copy of that picker. It shows the cast of whatever is already loaded
// instead, and stays the way in to open a log from disk.
export function readChromeHtml() {
  const cast = READV.meta ? castChips(READV.meta.characters, READV.meta.story) : "";
  return `<section class="picker readchrome">
    <h2>Cast</h2>
    ${cast ? `<div class="row">${cast}</div>`
           : `<p class="sub">open a story on the shelf, then "read" a previous run — or open one from disk</p>`}
    <div class="btns" style="margin-top:14px"><button class="btn" id="open-log">open a saved log</button></div>
  </section>` + agentsPanelHtml();
}

export function wireSavedRuns(page) {
  const ol = page.querySelector("#open-log");
  if (ol) ol.addEventListener("click", () => $("file").click());
  wireAgents(page);
}

/** Fetch the shelf's cards. Feeds the shelf itself (while picking) and, while reading, only labels
 *  a run already loaded -- called on the picking edge and every time the read page is opened, since
 *  the pre-flight behind it goes stale the moment a story is edited on disk. */
export async function loadStories() {
  APP.stories = null; APP.render();
  try { APP.stories = (await (await fetch("/stories")).json()).stories || []; }
  catch { APP.stories = []; }
  // A deep-linked run is loaded before the shelf is (sse.js: the direct-reload path has to land on
  // the read page first), so its label -- which needs a run's mtime/word-count, only known from the
  // shelf -- can only be filled in once this arrives.
  if (READV.dir && READV.id && !READV.label) {
    const r = (APP.stories.find(s => s.dir === READV.dir)?.runs || []).find(x => x.id === READV.id);
    if (r) READV.label = fmtRun(r);
  }
  APP.render();
}
