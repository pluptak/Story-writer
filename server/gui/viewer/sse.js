import { $, post } from "./util.js";
import { APP, LIVEV, READV } from "./state.js";
import { build, ingest } from "./events.js";
import { setSrc, renderRail } from "./hud.js";
import { go, parseHash, parseHashParams, syncHash } from "./nav.js";
import { renderSession, disarm, loadModels } from "./session.js";
import { loadStories } from "./saved-runs.js";
import { disarmAccept } from "./interview.js";

export async function loadDeepLinkedRun() {
  const params = parseHashParams();
  const dir = params.get("dir"), id = params.get("id");
  if (!dir || !id) return false;
  try {
    const r = await fetch(`/runs/log?dir=${encodeURIComponent(dir)}&id=${encodeURIComponent(id)}`);
    if (!r.ok) return false;
    setSrc(READV, `${dir.replace(/^stories\//, "")} · saved run`, false);
    ingest(await r.text(), READV);
    return true;
  } catch { return false; }
}

export const sessionFrom = j => ({ running: !!j.running, stopping: !!j.stopping, where: j.where || "", picking: !!j.picking,
  armed: !!j.armed, paused: !!j.paused, pausing: !!j.pausing, model: j.model || null, interactive: j.interactive !== false });

export async function tryHttp() {
  try {
    const r = await fetch("/run"); if (!r.ok) throw 0;
    const j = await r.json();
    if (j.run) { LIVEV.meta = j.run; }
    APP.session = sessionFrom(j);
    APP.live = true;
    loadModels();
    if (j.awaitingContinue) showPrompt(j.awaitingContinue);
    // An interview may already be open — a reload in the middle of one must land back in it.
    try { APP.scaffold = await (await fetch("/scaffold")).json(); } catch {}
    // Respect an explicit hash (a reload, a bookmark) unless it names the shelf and nothing is
    // actually waiting on a pick -- otherwise land wherever the session itself is.
    const wanted = parseHash();
    APP.view = (wanted && (wanted !== "shelf" || APP.session.picking)) ? wanted : (APP.session.picking ? "shelf" : "live");
    if (APP.view === "read") await loadDeepLinkedRun();       // before loadStories()/render() below
    if (APP.view === "read" || APP.view === "shelf") loadStories();
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
    if (f.t === "continue_prompt") { showPrompt(f); return; }
    if (f.t === "run_state") {
      const wasPicking = APP.session.picking, wasRunning = APP.session.running;
      APP.session = sessionFrom(f);
      // The budget question can be answered somewhere else — the console, a second tab, or a stop
      // that clears it. Every frame carries whether it is still outstanding, so a prompt nobody is
      // waiting on comes down instead of sitting there with buttons that only 400.
      if (!f.awaitingContinue) $("prompt").classList.remove("on");
      if (!APP.session.running) disarm();
      // Edges only -- a page you navigated to on purpose must not get yanked out from under you
      // by a frame that arrives several times a run for reasons that have nothing to do with it
      // (VIEWER-UI.md: run_state always re-renders, not only on a picking edge -- the SAME frame
      // still means "leave this page" only the first time each condition becomes true). `go()`
      // already renders, so the plain `render()` below only runs when neither edge fired.
      let moved = false;
      if (!wasPicking && APP.session.picking) { APP.picked = ""; APP.confirmDir = ""; APP.confirmError = ""; go("shelf"); moved = true; }
      if (!wasRunning && APP.session.running) { go("live"); moved = true; }
      if (!moved) APP.render();
      return;
    }
    if (f.t === "scaffold") {
      // A round is a minute of model call; a reload or a second tab has to be able to catch up,
      // and the POST response only ever reaches whoever sent it.
      APP.scaffold = f.state || { active:false };
      if (APP.scaffold.active) APP.ideaOpen = false;
      if (!APP.scaffold.problems || !APP.scaffold.problems.length) disarmAccept(); else APP.render();
      return;
    }
    if (f.t === "run_reset") {
      // A new story in the same session. Replay only helps clients that connect after it; one
      // already attached has to be told, or the next scene renders glued onto the last one.
      LIVEV.events = []; LIVEV.seen = new Set(); LIVEV.meta = null; LIVEV.open = new Set(); APP.composing = null;
      fetch("/run").then(r => r.json()).then(j => { if (j.run) { LIVEV.meta = j.run; if (APP.view === "live") APP.render(); } }).catch(() => {});
      go("live");
      return;
    }
    // A replayed event is one we already have. `seq` is stamped once by publish(), so it is the
    // identity of the event in both the log and the stream.
    if (f.seq !== undefined) { if (LIVEV.seen.has(f.seq)) return; LIVEV.seen.add(f.seq); }
    LIVEV.events.push(f);
    if (f.t === "reader_ask") APP.wantReaderView = true;
    // Re-render whole, debounced: a scene is a few dozen events, and rebuilding is far cheaper
    // than keeping incremental DOM state correct across retries and late-arriving verdicts. Only
    // when the run page is actually showing -- otherwise the events just accumulate in LIVEV and
    // render in full the next time it is.
    //
    // A TIMER, not requestAnimationFrame. rAF does not fire in a hidden or non-compositing tab, so
    // a run watched in a background tab stopped updating entirely — and because the handle latched
    // in `pending`, nothing rescheduled either. A scene is a few dozen events; frame alignment was
    // never worth that.
    if (!pending) pending = setTimeout(() => {
      pending = null;
      if (APP.view !== "live") return;
      const nearBottom = window.scrollY + innerHeight > document.body.scrollHeight - 220;
      APP.render();
      if (nearBottom) window.scrollTo(0, document.body.scrollHeight);
      // The run is now blocked on you. Reading further up the scene is the normal thing to be
      // doing when it arrives, and a question nobody scrolls to is a run that looks hung.
      if (APP.wantReaderView) {
        APP.wantReaderView = false;
        const q = document.querySelector(".reader.pending");
        if (q) q.scrollIntoView({ block:"center", behavior:"smooth" });
      }
    });
  };
  es.onerror = () => setSrc(LIVEV, "live (reconnecting…)", false);
}

// ---- the out-of-budget prompt (live only) -------------------------------
function showPrompt(p) {
  $("promptText").textContent = `${p.steps} steps used and the scene is not finished.`;
  $("promptN").value = p.suggested || 8;
  $("prompt").classList.add("on");
}
const answerPrompt = async n => {
  $("prompt").classList.remove("on");
  await post("/continue", { steps:n });
};
$("promptGo").onclick = () => answerPrompt(Math.max(0, parseInt($("promptN").value, 10) || 0));
$("promptStop").onclick = () => answerPrompt(0);
