import { $, basename, esc, fmtRun, fmtWhen, runOutcome, tid } from "./util.js";
import { APP, READV, storyName } from "./state.js";
import { ingest } from "./events.js";
import { setSrc } from "./hud.js";
import { castChips } from "./shelf.js";
import { loadAgentState, agentsPanelHtml, wireAgents } from "./agents.js";
import { button, pageTitle } from "./ui.js";

/** Fetch one retained run's log and load it into READV -- shared by a deep-linked reload (sse.js)
 *  and the story page's history rows (story-page.js). Returns false on failure, null
 *  when superseded: a slower earlier fetch must never overwrite a newer click's run (reader.js's
 *  loadReader guards the same hazard by re-checking READER.dir). */
export async function loadSavedRun(dir, id, store = READV, repaint = true, agentState = APP) {
  const req = ++store.loadReq;
  try {
    const r = await fetch(`/runs/log?dir=${encodeURIComponent(dir)}&id=${encodeURIComponent(id)}`);
    if (!r.ok || req !== store.loadReq) return req === store.loadReq ? false : null;
    const text = await r.text();
    if (req !== store.loadReq) return null;
    setSrc(store, `${dir.replace(/^data\/stories\//, "")} · history`, false);
    store.dir = dir; store.id = id;
    store.label = fmtRun((APP.stories?.find(s => s.dir === dir)?.runs || []).find(x => x.id === id) || {});
    ingest(text, store, repaint);
    await loadAgentState(dir, id, agentState);
    return true;
  } catch { return req === store.loadReq ? false : null; }
}

export function loadRun(dir, id) { return loadSavedRun(dir, id); }

// ---- the read tab's chrome --------------------------------------------------
// A loaded run reads as a history entry, not a log file: what story, what chapter, when, how it
// ended and how far it got -- with comparing as the primary action beside reading (the prose
// below). The raw record stays one disclosure down (run id, disk path, the "open a saved log"
// way in) and per-agent: model calls render as a panel, transcripts open on demand. Picking
// which run to read happens on the story page -- its History list -- so this tab shows the cast
// of whatever is loaded instead, and stays the way in to open a log from disk.
function describeLoadedRun(store) {
  const card = (APP.stories || []).find(s => s.dir === store.dir);
  const fromCard = (card?.runs || []).find(x => x.id === store.id);
  const evs = store.events || [];
  const start = evs.find(e => e.t === "scene_start");
  const end = [...evs].reverse().find(e => e.t === "scene_end");
  const draftWords = evs.filter(e => e.t === "draft").reduce((n, e) => Math.max(n, e.words || 0), 0);
  const shape = end || fromCard || (draftWords ? { words: draftWords } : {});
  return {
    name: card?.name || storyName(store.dir) || basename(store.dir) || "a story",
    chapter: fromCard?.chapter ?? start?.chapter ?? end?.chapter ?? null,
    when: fromCard?.mtimeMs != null ? fmtWhen(fromCard.mtimeMs) : "",
    outcome: runOutcome(shape),
    words: end?.words ?? fromCard?.words ?? (draftWords || null),
    steps: end?.steps ?? fromCard?.steps ?? null,
  };
}

function historyHeaderHtml(store) {
  if (!store.dir || !store.id) return "";
  const d = describeLoadedRun(store);
  const where = d.chapter != null ? `chapter ${d.chapter}` : "a run";
  const far = [d.words != null ? `${d.words} words` : "",
               d.steps != null ? `${d.steps} steps` : ""].filter(Boolean).join(" · ");
  return `<section ${tid("read.history")} class="picker run-history">
    ${pageTitle({ eyebrow: "History", title: `${d.name} — ${where}`, dataTid: "read.history-title" })}
    <p class="run-history-line"><span class="tag outcome-${d.outcome.key}" data-tid="read.outcome">${esc(d.outcome.label)}</span>
      <span class="hint">${esc([d.when, far].filter(Boolean).join(" · "))}</span></p>
    <div class="btns">${button({ label: "compare this run", id: "read-compare", tidName: "read.compare-btn", variant: "primary" })}</div>
    <details class="engine-details runlog" data-tid="read.run-log"><summary>Run log</summary>
      <div class="tech">run ${esc(store.id)}${store.dir ? ` · ${esc(store.dir)}` : ""}</div>
      <p class="hint">The raw record: per-agent model calls below, full prompt/response transcripts one
        click down, and the log on disk at out/${esc(store.id)}/writing-log.jsonl. Or open a different log:</p>
      <div class="btns mt-sm">${button({ label: "open a saved log", id: "open-log", tidName: "read.open-log-btn" })}</div>
    </details>
  </section>`;
}

export function readChromeHtml(store = READV, includeAgents = store === READV, agentState = APP, includeOpen = store === READV) {
  // The read tab's own Cast section carries the same chat shortcuts as the live header: enabled
  // while the character has a consultation in the run on screen. Compare panes (includeOpen
  // false, another store) stay plain pills -- their inspector belongs to no run on screen.
  const chat = includeOpen && store === READV && store.meta
    ? new Set((store.events || []).filter(e => e.t === "consult").map(e => String(e.character || "").toLowerCase()))
    : null;
  const cast = store.meta ? castChips(store.meta.characters, store.meta.story, store.meta.chapter ?? null, chat) : "";
  const loaded = !!(store.dir && store.id);
  return (includeOpen ? historyHeaderHtml(store) : "")
  + `<section ${tid("read.chrome")} class="picker readchrome">
    <h2>Cast</h2>
    ${cast ? `<div class="row">${cast}</div>`
           : loaded ? `<p class="sub">this run's cast arrives with its log</p>`
           : `<p class="sub">open a story on the shelf, then "read" a run from its history — or open one from disk</p>`}
    ${includeOpen && !loaded ? `<div class="btns mt-sm">${button({ label: "open a saved log", id: "open-log", tidName: "read.open-log-btn" })}</div>` : ""}
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
  // A deep-linked run loads before the shelf (sse.js: the direct-reload path has to land on the
  // read page first), so its label -- which needs a run's mtime/word-count, only known from the
  // shelf -- can only be filled in once this arrives.
  if (READV.dir && READV.id && !READV.label) {
    const r = (APP.stories.find(s => s.dir === READV.dir)?.runs || []).find(x => x.id === READV.id);
    if (r) READV.label = fmtRun(r);
  }
  APP.render();
}
