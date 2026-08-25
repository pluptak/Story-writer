import { $, fmtRun, tid } from "./util.js";
import { APP, READV } from "./state.js";
import { ingest } from "./events.js";
import { setSrc } from "./hud.js";
import { castChips } from "./shelf.js";
import { loadAgentState, agentsPanelHtml, wireAgents } from "./agents.js";

/** Fetch one retained run's log and load it into READV -- shared by a deep-linked reload (sse.js)
 *  and the story page's "read a previous run" rows (story-page.js). Returns false on failure,
 *  null when superseded: a slower earlier fetch must never overwrite a newer click's run
 *  (reader.js's loadReader guards the same hazard by re-checking READER.dir). */
export async function loadSavedRun(dir, id, store = READV, repaint = true, agentState = APP) {
  const req = ++store.loadReq;
  try {
    const r = await fetch(`/runs/log?dir=${encodeURIComponent(dir)}&id=${encodeURIComponent(id)}`);
    if (!r.ok || req !== store.loadReq) return req === store.loadReq ? false : null;
    const text = await r.text();
    if (req !== store.loadReq) return null;
    setSrc(store, `${dir.replace(/^stories\//, "")} · saved run`, false);
    store.dir = dir; store.id = id;
    store.label = fmtRun((APP.stories?.find(s => s.dir === dir)?.runs || []).find(x => x.id === id) || {});
    ingest(text, store, repaint);
    await loadAgentState(dir, id, agentState);
    return true;
  } catch { return req === store.loadReq ? false : null; }
}

export function loadRun(dir, id) { return loadSavedRun(dir, id); }

// ---- the read tab's chrome --------------------------------------------------
// Picking which run to read now happens on the story page -- its "previous runs" list -- so this
// tab no longer needs a second copy of that picker. It shows the cast of whatever is already loaded
// instead, and stays the way in to open a log from disk.
export function readChromeHtml(store = READV, includeAgents = store === READV, agentState = APP, includeOpen = store === READV) {
  const cast = store.meta ? castChips(store.meta.characters, store.meta.story) : "";
  return `<section ${tid("read.chrome")} class="picker readchrome">
    <h2>Cast</h2>
    ${cast ? `<div class="row">${cast}</div>`
           : `<p class="sub">open a story on the shelf, then "read" a previous run — or open one from disk</p>`}
    ${includeOpen ? `<div class="btns" style="margin-top:14px"><button ${tid("read.open-log-btn")} class="btn" id="open-log">open a saved log</button></div>` : ""}
  </section>` + (includeAgents ? agentsPanelHtml(store, agentState) : "");
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
