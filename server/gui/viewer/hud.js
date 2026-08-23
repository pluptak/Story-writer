import { $, esc, basename } from "./util.js";
import { APP, LIVEV, READV, READER, storyName } from "./state.js";
import { castSheetHtml } from "./cast-sheet.js";

// The two small "paint a fixed chrome region from store state" pieces -- the `#src`/`#dot` source
// indicator and the `#rail` progress panel -- as opposed to `#page`, which `pages.js` owns.

const chapterSuffix = m => (m && m.chapters > 1) ? ` · chapter ${m.chapter} of ${m.chapters}` : "";

/** The breadcrumb for the current view: earlier crumbs are clickable ancestors, the last is where
 *  you are. Ancestor links appear only with an engine attached — the shelf and a story page are not
 *  reachable without one (go() would just rewrite them to the read tab). */
function crumbsFor() {
  const name = dir => storyName(dir) || basename(dir) || "a story";
  if (!APP.live) {
    if (APP.view === "readstory") return [{ label: "reading " + name(READER.dir) }];
    return [{ label: (READV.source || "nothing loaded") + chapterSuffix(READV.meta) }];
  }
  const shelf = { label: "shelf", view: "shelf" };
  switch (APP.view) {
    case "shelf":     return [{ label: "choosing a story" }];
    case "story":     return [shelf, { label: name(APP.storyDir) }];
    case "scaffold":  return [shelf, { label: "new story" }];
    case "edit":      return APP.editNew
                        ? [shelf, { label: "new story", view: "scaffold" }, { label: "edit in full" }]
                        : [shelf, { label: name(APP.editDir), view: "story", dir: APP.editDir }, { label: "edit story" }];
    case "handoff":   return [shelf, { label: name(APP.handoffDir), view: "story", dir: APP.handoffDir }, { label: "prepare chapter" }];
    case "compare":   return [shelf, { label: name(APP.compareDir), view: "story", dir: APP.compareDir }, { label: "compare runs" }];
    case "readstory": return [shelf, { label: name(READER.dir), view: "story", dir: READER.dir }, { label: "read story" }];
    case "read": {
      const d = READV.dir;
      if (!d) return [shelf, { label: (READV.source || "a run") + chapterSuffix(READV.meta) }];
      return [shelf, { label: name(d), view: "story", dir: d }, { label: "saved run" + chapterSuffix(READV.meta) }];
    }
    case "live": {
      const d = LIVEV.meta?.story;
      if (!d) return [shelf, { label: "writing" }];
      return [shelf, { label: name(d) }, { label: "writing" + chapterSuffix(LIVEV.meta) }];
    }
    default:          return [{ label: "nothing loaded" }];
  }
}

export function paintSrcbar() {
  const crumbs = crumbsFor();
  $("src").innerHTML = crumbs.map((c, i) => {
    const last = i === crumbs.length - 1;
    const clickable = !last && (c.view || c.dir);
    const attrs = clickable
      ? ` class="crumb" role="link" tabindex="0" data-view="${esc(c.view || "story")}" data-dir="${esc(c.dir || "")}"`
      : ` class="crumb${last ? " here" : ""}"`;
    return `<span${attrs}>${esc(c.label)}</span>`;
  }).join(`<span class="crumb-sep">›</span>`);
  const store = APP.view === "read" ? READV : LIVEV;
  const isLive = (APP.view === "read" || APP.view === "live") && store.isLive;
  $("dot").className = "dot" + (isLive ? " live" : "");
}
export function setSrc(store, text, isLive) { store.source = text; store.isLive = isLive; paintSrcbar(); }

const BASE_TITLE = document.title;
/** The browser tab tracks what is on screen -- so two tabs are tellable apart, and a reader-ask
 *  marker is visible even when the tab is in the background. The "asked" prefix stays outermost. */
export function paintTitle() {
  const ctx = titleContext();
  const base = ctx ? `${ctx} — ${BASE_TITLE}` : BASE_TITLE;
  document.title = APP.awaitingReader ? "● you're asked — " + base : base;
}
function titleContext() {
  switch (APP.view) {
    case "story":     return storyName(APP.storyDir);
    case "handoff":   return "handoff · " + storyName(APP.handoffDir);
    case "scaffold":  return "new story";
    case "edit":      return APP.editNew ? "new story" : "editing " + storyName(APP.editDir);
    case "readstory": return "reading " + (storyName(READER.dir) || basename(READER.dir));
    case "compare":   return "compare · " + storyName(APP.compareDir);
    case "read":
    case "live": {
      const store = APP.view === "read" ? READV : LIVEV;
      const name = storyName(store === LIVEV ? store.meta?.story : store.dir);
      const m = store.meta;
      const chap = m && m.chapters > 1 ? ` · chapter ${m.chapter}` : "";
      return name ? name + chap : "";
    }
    default: return "";
  }
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
    ${count("reaction_fanout") ? stat("reactions", count("reaction_fanout")) : ""}
    ${stat("asked back", count("clarify"))}
    ${stat("retries", retries, retries ? "warn" : "")}
    ${stat("skill flags", flags, flags ? "bad" : "")}
     ${store === LIVEV && APP.composing ? `<div class="composing"><i></i><span class="who">${esc(APP.composing.who)}</span>
        composing… ${APP.composing.secs}s</div>` : ""}
     ${statsPanel}
     ${castSheetHtml()}`;
}
