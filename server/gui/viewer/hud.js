import { $, esc } from "./util.js";
import { APP, LIVEV, READV, storyName } from "./state.js";

// The two small "paint a fixed chrome region from store state" pieces -- the `#src`/`#dot` source
// indicator and the `#rail` progress panel -- as opposed to `#page`, which `pages.js` owns.

export function paintSrcbar() {
  if (APP.view === "shelf") { $("src").textContent = "choosing a story"; $("dot").className = "dot"; return; }
  if (APP.view === "story") {
    const name = storyName(APP.storyDir);
    $("src").textContent = name ? `looking at ${name}` : "looking at a story";
    $("dot").className = "dot";
    return;
  }
  const store = APP.view === "read" ? READV : LIVEV;
  // Which chapter this is, when the story has more than one -- the same condition the CLI uses for
  // its own run header, so the two cannot disagree. RunMeta carries chapter/chapters.
  const m = store.meta;
  const which = m && m.chapters > 1 ? ` · chapter ${m.chapter} of ${m.chapters}` : "";
  $("src").textContent = (store.source || "nothing loaded") + which;
  $("dot").className = "dot" + (store.isLive ? " live" : "");
}
export function setSrc(store, text, isLive) { store.source = text; store.isLive = isLive; paintSrcbar(); }

const BASE_TITLE = document.title;
export function paintTitle() {
  document.title = APP.awaitingReader ? "● you're asked — " + BASE_TITLE : BASE_TITLE;
}

/** What the run is doing right now, in the mockup's vocabulary. Derived rather than sent: the engine
 *  has no `phase` field (Writer.MD tracks that as a gap). The budget wait is read off the `#prompt`
 *  element's own class because that element IS that state today -- a second copy on APP would be one
 *  more thing to keep in sync, and sse.js clears it from more than one place. */
export function phaseOf(store) {
  if (store !== LIVEV || !APP.live) return "";
  const s = APP.session;
  if (!s.running) return "idle";
  if (s.stopping) return "stopping";
  if ($("prompt")?.classList.contains("on")) return "budget wait";
  if (APP.awaitingReader) return "reader wait";
  if (s.paused) return "paused";
  if (s.pausing) return "pausing";
  if (APP.composing) return APP.composing.who === "WRITER" ? "writing" : "consulting";
  return "writing";
}

export function renderRail(store, blocks) {
  const words = store.events.filter(e => e.t === "draft").reduce((n, e) => Math.max(n, e.words || 0), 0);
  const target = store.meta?.target || 0;
  const consults = blocks.filter(b => b.kind === "consult");
  const count = t => store.events.filter(e => e.t === t).length;
  const pct = target ? Math.min(100, Math.round(words / target * 100)) : 0;
  const stat = (k, v, cls) => `<div class="stat"><span>${k}</span><span class="n ${cls||""}">${v}</span></div>`;
  const flags = count("skill_flag"), retries = count("retry");
  const live = store === LIVEV && APP.live;
  // The starting budget is not in RunMeta; a `budget` event is the only place the number appears,
  // so steps show a denominator only once the budget has actually been extended at least once.
  const budget = store.events.filter(e => e.t === "budget").pop()?.budget;
  const fmtMs = ms => ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
  const fmtTokens = (s, key) => s.tokenCalls === s.calls ? s[key].toLocaleString() : "unavailable";
  const agentStats = store === LIVEV ? Object.values(store.agentStats || {}) : [];
  const statsPanel = live && agentStats.length ? `<section class="agentstats">
    <h3>model calls</h3>
    <div class="agentstats-head"><span>agent</span><span>calls</span><span>avg</span><span>tokens</span></div>
    ${agentStats.map(s => `<div class="agentstat">
      <span class="agentstat-who">${esc(s.who)}</span>
      <span>${s.calls}</span>
      <span>${fmtMs(s.durationMs / s.calls)}</span>
      <span title="prompt / completion tokens">${fmtTokens(s, "promptTokens")} / ${fmtTokens(s, "completionTokens")}</span>
    </div>`).join("")}
  </section>` : "";
  $("railstats").innerHTML = `
    ${live ? stat("phase", esc(phaseOf(store))) : ""}
    ${stat("steps", budget ? `${count("draft")} / ${budget}` : count("draft"))}
    ${stat("words", target ? `${words} / ${target}` : words)}
    ${live ? stat("model", esc(APP.session.model || "story default")) : ""}
    <div class="bar"><i style="width:${pct}%"></i></div>
    ${stat("consults", consults.length)}
    ${stat("asked back", count("clarify"))}
    ${stat("retries", retries, retries ? "warn" : "")}
    ${stat("skill flags", flags, flags ? "bad" : "")}
     ${store === LIVEV && APP.composing ? `<div class="composing"><i></i><span class="who">${esc(APP.composing.who)}</span>
        composing… ${APP.composing.secs}s</div>` : ""}
     ${statsPanel}`;
}
