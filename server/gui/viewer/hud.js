import { $, esc, basename, tid } from "./util.js";
import { APP, LIVEV, READV, READER, storyName } from "./state.js";

/** The Libraries group's display names — the breadcrumb says which library, not which kind key. */
const CATALOG_CRUMB = { characters: "characters", styles: "writer styles", tags: "tags", skills: "skill bible" };

// The two small "paint a fixed chrome region from store state" pieces -- the `#src`/`#dot` source
// indicator and the `#rail` progress panel. `pages.js` owns `#page`.

const chapterSuffix = m => (m && m.chapters > 1) ? ` · chapter ${m.chapter} of ${m.chapters}` : "";

/** Where the open interview sits, named with the SAME six stages interview.js's own stepper
 *  shows -- idea, direction, cast & world, structure, review, accept -- never a second, compressed
 *  vocabulary of its own. A presentation mirror of interview.js:stageOf (which owns the canonical
 *  gate→stage mapping); hud.js cannot import it directly without closing a module cycle (saved-
 *  runs.js already imports hud.js, and interview.js imports saved-runs.js), so the mapping is
 *  duplicated here and must be kept in sync by hand. Two levels max: shelf › step. Exported for
 *  the shelf's resume panel — same derivation, one home. */
export function scaffoldLifecycle() {
  const s = APP.scaffold || {};
  if (!s.spec && !s.haveDraft) return "idea";
  if (s.needsFolder || APP.folderOpen) return "accept";
  const complete = !!s.last && s.last.kind === "nothing" && /checklist is complete/.test(s.last.why || "");
  if (s.mode === "oneshot") return (complete || s.haveStory) ? "review" : "direction";
  if (complete) return "review";
  const gate = s.gate || "story";
  if (gate === "story") return "direction";
  if (gate === "cast" || gate === "settings") return "cast & world";
  return "structure";
}

/** The breadcrumb for the current view: earlier crumbs are clickable ancestors, the last is where
 *  you are. Ancestor links appear only with an engine attached -- the shelf and a story page are
 *  unreachable without one (go() would rewrite them to the read tab). */
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
    case "scaffold":  return [shelf, { label: "architect · " + scaffoldLifecycle() }];
    case "edit":      return APP.editNew
                        ? [shelf, { label: "new story", view: "scaffold" }, { label: "edit in full" }]
                        : [shelf, { label: name(APP.editDir), view: "story", dir: APP.editDir }, { label: "edit story" }];
    case "handoff":   return [shelf, { label: name(APP.handoffDir), view: "story", dir: APP.handoffDir }, { label: "prepare chapter" }];
    case "compare":   return [shelf, { label: name(APP.compareDir), view: "story", dir: APP.compareDir }, { label: "compare runs" }];
    case "readstory": return [shelf, { label: name(READER.dir), view: "story", dir: READER.dir }, { label: "read story" }];
    case "catalog":   return [{ label: "libraries" }, { label: CATALOG_CRUMB[APP.catalog.kind] || APP.catalog.kind }];
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
      ? `${tid("chrome.crumb")} class="crumb" role="link" tabindex="0" data-view="${esc(c.view || "story")}" data-dir="${esc(c.dir || "")}"`
      : ` class="crumb${last ? " here" : ""}"`;
    return `<span${attrs}>${esc(c.label)}</span>`;
  }).join(`<span class="crumb-sep">›</span>`);
  const store = APP.view === "read" ? READV : LIVEV;
  const isLive = (APP.view === "read" || APP.view === "live") && store.isLive;
  $("dot").className = "dot" + (isLive ? " live" : "");
  paintProviderChip();
}

/** The provider chip in the srcbar: which server is serving, what its request line is doing,
 *  and whether the last model call failed. Painted from the provider_state SSE frames; hidden
 *  until the first one arrives, so a bare harness or a detached read shows nothing. */
export function paintProviderChip() {
  const el = $("provchip");
  if (!el) return;
  const p = APP.provider;
  if (!p) { el.hidden = true; return; }
  el.hidden = false;
  const busy = p.current ? ` · ${p.current}` : "";
  const queued = p.depth ? ` · ${p.depth} queued` : "";
  const fail = p.lastFailure ? ` · ⚠ ${p.lastFailure.kind}` : "";
  el.textContent = `${p.provider}${busy}${queued}${fail}`;
  el.title = (p.baseUrl || "") + (p.lastFailure ? `\n${p.lastFailure.what}: ${p.lastFailure.message}` : "");
  el.classList.toggle("warn", !!p.lastFailure);
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

/** What the run is doing right now, in the mockup's vocabulary. Derived rather than sent: the
 *  engine has no `phase` field (Writer.MD tracks that as a gap). The budget wait is read off the
 *  `#prompt` element's own class because that element IS that state today -- a second copy on APP
 *  would be one more thing to keep in sync, and sse.js clears it from more than one place. */
/** The coarse HUD word for whoever is composing. The judges collapse into one word here; the
 *  model-calls panel keeps them apart by their own names. Anything unnamed is a character. */
const COMPOSING_WORD = {
  WRITER: "writing",
  JUDGE: "judging", "BATCH-JUDGE": "judging", "NARRATION-JUDGE": "judging",
  CLARIFIER: "clarifying",
};

export function phaseOf(store) {
  if (store !== LIVEV || !APP.live) return "";
  const s = APP.session;
  if (!s.running) return "idle";
  if (s.stopping) return "stopping";
  if ($("prompt")?.classList.contains("on")) return "budget wait";
  if (APP.awaitingReader) return "reader wait";
  if (s.paused) return "paused";
  if (s.pausing) return "pausing";
  if (APP.composing) return COMPOSING_WORD[APP.composing.who] ?? "consulting";
  return "writing";
}

/** Clear both rail containers (status card + engine disclosure). Non-live views call this
 *  instead of touching either div by hand, so the two can never disagree about a previous run. */
export function clearRail() { $("railstatus").innerHTML = ""; $("railstats").innerHTML = ""; }

export function renderRail(store, blocks) {
  const words = store.events.filter(e => e.t === "draft").reduce((n, e) => Math.max(n, e.words || 0), 0);
  const target = store.meta?.target || 0;
  const consults = blocks.filter(b => b.kind === "consult");
  const count = t => store.events.filter(e => e.t === t).length;
  const pct = target ? Math.min(100, Math.round(words / target * 100)) : 0;
  const stat = (k, v, cls) => `<div class="stat" data-tid="rail.stat" data-k="${esc(k)}"><span>${k}</span><span class="n ${cls||""}">${v}</span></div>`;
  const retries = count("retry");
  const live = store === LIVEV && APP.live;
  // The starting budget is not in RunMeta; a `budget` event is the only place the number appears,
  // so steps show a denominator only once the budget was extended at least once.
  const budget = store.events.filter(e => e.t === "budget").pop()?.budget;
  const fmtMs = ms => !Number.isFinite(ms) ? "—" : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
  const fmtTokens = (s, key) => s.tokenCalls === s.calls ? s[key].toLocaleString() : "unavailable";
  const agentStats = store === LIVEV ? Object.values(store.agentStats || {}) : [];
  const statsPanel = live && agentStats.length ? `<section class="agentstats" data-tid="rail.agentstats">
    <h3>model calls</h3>
    <div class="agentstats-head"><span>agent</span><span>calls</span><span>avg</span><span>tokens</span></div>
    ${agentStats.map(s => `<div class="agentstat" data-tid="rail.agent-row" data-who="${esc(s.who)}">
      <span class="agentstat-who">${esc(s.who)}</span>
      <span>${s.calls}</span>
      <span>${fmtMs(s.durationMs / s.calls)}</span>
      <span title="prompt / completion tokens">${fmtTokens(s, "promptTokens")} / ${fmtTokens(s, "completionTokens")}</span>
    </div>`).join("")}
  </section>` : "";
  // Writer-first rail, split across two containers so DOM order is the hierarchy: the Scene
  // card (status + where-am-I-in-the-chapter progress) paints at the top of the rail, above the
  // cast and the controls; every engine number (steps/budget, model, consult/ask/retry counts,
  // per-agent tokens) folds into the collapsed Run details disclosure at the bottom. The phase
  // line lives only here, not twice -- the disclosure below used to repeat it as a stat.
  const composing = store === LIVEV && APP.composing
    ? `<div class="composing" data-tid="rail.composing"><i></i><span class="who">${esc(APP.composing.who)}</span> composing… ${APP.composing.secs}s</div>` : "";
  const status = live ? `<div class="railstatus" data-tid="rail.status"><span class="phasename">${esc(phaseOf(store))}</span>${composing}</div>` : composing;
  $("railstatus").innerHTML = `
    ${status}
    ${stat("words", target ? `${words} / ${target}` : words)}
    <div class="bar"><i style="width:${pct}%"></i></div>`;
  $("railstats").innerHTML = `
    <details class="raildetails" data-tid="rail.engine-details"${APP.railDetailOpen ? " open" : ""}>
      <summary>Run details</summary>
      ${stat("steps", budget ? `${count("draft")} / ${budget}` : count("draft"))}
      ${live ? stat("model", esc(APP.session.model || "story default")) : ""}
      ${stat("consults", consults.length)}
      ${count("reaction_fanout") ? stat("reactions", count("reaction_fanout")) : ""}
      ${stat("asked back", count("clarify"))}
      ${stat("retries", retries, retries ? "warn" : "")}
      ${statsPanel}
    </details>`;
  // Native <details> state would be wiped by the next SSE re-render (railstats is rebuilt whole
  // every frame), so the toggle persists onto APP -- a reading preference, never reset by render.
  const det = $("railstats").querySelector("details.raildetails");
  if (det) det.ontoggle = () => { APP.railDetailOpen = det.open; };
}
