import { $, post } from "./util.js";
import { APP, LIVEV } from "./state.js";
import { build } from "./events.js";
import { setSrc, renderRail, paintSrcbar } from "./hud.js";
import { clearReaderDrafts } from "./blocks.js";
import { go, parseHash, parseHashParams, syncHash } from "./nav.js";
import { renderSession, disarm, loadModels, loadEditorConfig } from "./session.js";
import { loadStories, loadRun } from "./saved-runs.js";
import { loadReader } from "./reader.js";
import { loadDeepLinkedComparison, loadComparisonRuns } from "./compare.js";
import { disarmAccept, disarmApprove } from "./interview.js";

export function loadDeepLinkedRun() {
  const params = parseHashParams();
  const dir = params.get("dir"), id = params.get("id");
  if (!dir || !id) return Promise.resolve(false);
  return loadRun(dir, id);
}

export function loadDeepLinkedReader() {
  const params = parseHashParams();
  const dir = params.get("dir");
  if (!dir) return;
  loadReader(dir);
}

export const sessionFrom = j => ({ running: !!j.running, stopping: !!j.stopping, where: j.where || "", picking: !!j.picking,
  loading: !!j.loading, armed: !!j.armed, paused: !!j.paused, pausing: !!j.pausing, model: j.model || null, interactive: j.interactive !== false });

export async function tryHttp() {
  try {
    const r = await fetch("/run"); if (!r.ok) throw 0;
    const j = await r.json();
    if (j.run) { LIVEV.meta = j.run; }
    APP.session = sessionFrom(j);
    APP.live = true;
    loadModels();
    loadEditorConfig();
    if (j.awaitingContinue) showPrompt(j.awaitingContinue);
    // An interview may already be open -- a reload mid-interview must land back in it. Independent
    // endpoints, fetched concurrently; either may fail without affecting the other.
    const [scaf, hand] = await Promise.allSettled([
      fetch("/scaffold").then(r => r.json()),
      fetch("/next-chapter").then(r => r.json()),
    ]);
    if (scaf.status === "fulfilled") APP.scaffold = scaf.value;
    if (hand.status === "fulfilled") APP.handoff = hand.value;
    if (APP.handoff.active) APP.handoffDir = APP.handoff.dir;
    // Respect an explicit hash (a reload, a bookmark, a deep link) -- the shelf is a real
    // destination now, not just a place the session parks you, so nothing has to be rewritten.
    // With nothing asked for, land on the scene if one is running, the hub otherwise.
    const wanted = parseHash();
    APP.view = wanted || (APP.session.running ? "live" : "shelf");
    if (APP.view === "story") APP.storyDir = parseHashParams().get("dir") || "";
    // The URL wins for the handoff page: a reload/bookmark of #/handoff?dir=X is asking for X, even
    // if the server still holds a session open on a different story (handoffForPage then draws the
    // start screen for X rather than the other story's proposal).
    if (APP.view === "handoff") APP.handoffDir = parseHashParams().get("dir") || APP.handoff.dir || "";
  if (APP.view === "edit") {
    const params = parseHashParams();
    APP.editNew = params.get("new") === "1";
    APP.editDir = params.get("dir") || "";
  }
    if (APP.view === "readstory") loadDeepLinkedReader();     // sets READER.dir and starts the fetch
    if (APP.view === "read") await loadDeepLinkedRun();       // before loadStories()/render() below
    if (APP.view === "compare") loadDeepLinkedComparison();
    if (APP.view === "readstory" || APP.view === "read" || APP.view === "compare" || APP.view === "shelf" || APP.view === "story" || APP.view === "handoff" || APP.view === "edit") {
      await loadStories();
      if (APP.view === "compare") { loadDeepLinkedComparison(); loadComparisonRuns(); }
    }
    syncHash();
    APP.render();
    startSSE();
    return true;
  } catch { return false; }
}

export function startSSE() {
  const es = new EventSource("/events");
  setSrc(LIVEV, "live", true);
  APP.live = true;                       // a session to control: renderSession decides which controls
  renderSession();
  let pending = null;
  es.onmessage = m => {
    let f; try { f = JSON.parse(m.data); } catch { return; }
    if (f.t === "composing") { APP.composing = f; if (APP.view === "live") renderRail(LIVEV, build(LIVEV)); return; }
    if (f.t === "idle") { APP.composing = null; if (APP.view === "live") renderRail(LIVEV, build(LIVEV)); return; }
    if (f.t === "agent_stats") {
      const prior = LIVEV.agentStats[f.who] || { who:f.who, model:f.model, calls:0, durationMs:0,
        promptTokens:0, completionTokens:0, tokenCalls:0 };
      prior.model = f.model;
      prior.calls++;
      prior.durationMs += Math.max(0, Number(f.durationMs) || 0);
      if (Number.isFinite(f.promptTokens) && Number.isFinite(f.completionTokens)) {
        prior.promptTokens += f.promptTokens;
        prior.completionTokens += f.completionTokens;
        prior.tokenCalls++;
      }
      LIVEV.agentStats[f.who] = prior;
      if (APP.view === "live") renderRail(LIVEV, build(LIVEV));
      return;
    }
    if (f.t === "continue_prompt") { showPrompt(f); return; }
    if (f.t === "provider_state") {
      // The engine sends one whenever its request line or last failure changes. The chip is
      // chrome, not page content — repaint the srcbar, never the page under the reader.
      APP.provider = f;
      paintSrcbar();
      return;
    }
    if (f.t === "run_state") {
      const wasPicking = APP.session.picking, wasRunning = APP.session.running;
      APP.session = sessionFrom(f);
      // The budget question can be answered elsewhere -- the console, a second tab, or a stop that
      // clears it. Every frame carries whether it is still outstanding, so a prompt nobody is
      // waiting on comes down instead of sitting there with buttons that only 400.
      if (!f.awaitingContinue) $("prompt").classList.remove("on");
      if (!APP.session.running) { disarm(); APP.awaitingReader = false; }
      // Edges only -- a page you navigated to on purpose must not get yanked out from under you by
      // a frame that arrives several times a run for unrelated reasons. run_state always re-renders,
      // so the same frame must not repeat a side effect that only makes sense the first time each
      // condition becomes true.
      if (!wasPicking && APP.session.picking) {
        // A new pick window opened -- the previous one, if any, is done. Reset without navigating:
        // the engine parks in awaitPick() the instant a run ends, one tick after running goes false
        // below, and following it to the shelf would yank a just-finished scene off screen before
        // its own "run ended" edge (below) can say so.
        APP.picked = ""; APP.storyModel = ""; APP.storyError = "";
      }
      let moved = false;
      if (!wasRunning && APP.session.running) {
        // A run starting is not the user navigating. Following it to the live page is right from
        // the shelf or a finished scene, but from the editor it fires the dirty-guard confirm with
        // nothing of yours behind it -- there, stay put and let the tab dot say a run is on.
        if (APP.view !== "edit") { go("live"); moved = true; }
      }
      else if (wasRunning && !APP.session.running && APP.view === "live") {
        // The run just ended while it was on screen -- offer the choice explicitly instead of
        // silently dropping the "run controls vanish" behaviour that used to be the only sign.
        const end = LIVEV.events.findLast(e => e.t === "scene_end");
        if (end) APP.runEnded = { done: end.done, stopped: end.stopped, words: end.words, steps: end.steps };
      }
      if (!moved) APP.render();
      return;
    }
    if (f.t === "scaffold") {
      // A round is a minute of model call; a reload or a second tab has to catch up, and the POST
      // response only ever reaches whoever sent it.
      APP.scaffold = f.state || { active:false };
      if (APP.scaffold.active) APP.ideaOpen = false;
      if (APP.scaffold.last?.kind !== "blocked") disarmApprove();
      if (!APP.scaffold.problems || !APP.scaffold.problems.length) disarmAccept(); else APP.render();
      return;
    }
    // The engine failed to load or run the story. Clear the pending pick and show the error on the
    // story page. runError survives picking-edge resets (which clear storyError), so it stays visible.
    if (f.t === "run_error") {
      APP.runError = f.message;
      APP.picked = "";
      APP.render();
      return;
    }
    if (f.t === "handoff") {
      // Same reason as the scaffold frame above: a round is a minute of model call, and the POST
      // response only ever reaches whoever sent it.
      APP.handoff = f.state || { active:false };
      // Don't let a frame retarget the handoff page: the URL pins which story it shows, and the
      // server may be driving a session for a different story. Seed handoffDir only for other
      // views, and only when nothing has pinned it yet. handoffForPage() keeps a mismatched
      // session from rendering here regardless.
      if (APP.handoff.active && APP.view !== "handoff") APP.handoffDir = APP.handoffDir || APP.handoff.dir;
      APP.render();
      return;
    }
    if (f.t === "run_reset") {
      // A new story in the same session. Replay only helps clients that connect after it; one
      // already attached must be told, or the next scene renders glued onto the last one.
      LIVEV.events = []; LIVEV.seen = new Set(); LIVEV.meta = null; LIVEV.agentStats = {}; APP.composing = null;
      APP.awaitingReader = false; APP.runEnded = null; APP.runError = "";
      clearReaderDrafts();
      fetch("/run").then(r => r.json()).then(j => { if (j.run) { LIVEV.meta = j.run; if (APP.view === "live") APP.render(); } }).catch(() => {});
      // Same rule as the run-start edge above: never yank you out of the editor -- least of all
      // through its dirty-guard confirm, which would pop with no navigation of yours behind it.
      if (APP.view !== "edit") go("live");
      return;
    }
    // A replayed event is one we already have. `seq` is stamped once by publish(), so it is the
    // identity of the event in both the log and the stream.
    if (f.seq !== undefined) { if (LIVEV.seen.has(f.seq)) return; LIVEV.seen.add(f.seq); }
    LIVEV.events.push(f);
    if (f.t === "reader_ask") { APP.wantReaderView = true; APP.awaitingReader = true; }
    if (f.t === "reader_answer") APP.awaitingReader = false;
    // Re-render whole, debounced: a scene is a few dozen events, and rebuilding is far cheaper
    // than keeping incremental DOM state correct across retries and late-arriving verdicts. Only
    // when the run page is actually showing -- otherwise events just accumulate in LIVEV and render
    // in full the next time it is.
    if (!pending) pending = setTimeout(() => {
      pending = null;
      if (APP.view !== "live") return;
      const nearBottom = window.scrollY + innerHeight > document.body.scrollHeight - 220;
      APP.render();
      if (nearBottom) window.scrollTo(0, document.body.scrollHeight);
      // The run is now blocked on you. Reading further up the scene is the normal thing to be doing
      // when it arrives, and a question nobody scrolls to is a run that looks hung.
      if (APP.wantReaderView) {
        APP.wantReaderView = false;
        const q = document.querySelector(".reader.pending");
        if (q) q.scrollIntoView({ block:"center", behavior:"smooth" });
      }
    });
  };
  // `open` fires on the first connect AND on every auto-reconnect, so it puts the dot back to
  // "live" after an onerror -- without it the srcbar stays "reconnecting…" for the rest of the
  // session even though events have resumed.
  es.onopen = () => setSrc(LIVEV, "live", true);
  es.onerror = () => setSrc(LIVEV, "live (reconnecting…)", false);
}

// ---- the out-of-budget prompt (live only) -------------------------------
function showPrompt(p) {
  $("promptText").textContent = `${p.steps} steps used and the scene is not finished.`;
  $("promptN").value = p.suggested || 8;
  $("prompt").classList.add("on");
  // The decision is one keypress now that Enter submits -- cursor in the field, text selected, so
  // changing the number or hitting Enter needs no reach for the mouse.
  const n = $("promptN"); n.focus(); n.select();
}
const answerPrompt = async n => {
  $("prompt").classList.remove("on");
  await post("/continue", { steps:n });
};
$("promptGo").onclick = () => answerPrompt(Math.max(0, parseInt($("promptN").value, 10) || 0));
$("promptStop").onclick = () => answerPrompt(0);
// Enter in the step field is the same as clicking "give steps" -- a one-key decision needs no mouse.
$("promptN").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); $("promptGo").click(); } });
