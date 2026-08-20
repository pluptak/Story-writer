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
  $("src").textContent = store.source || "nothing loaded";
  $("dot").className = "dot" + (store.isLive ? " live" : "");
}
export function setSrc(store, text, isLive) { store.source = text; store.isLive = isLive; paintSrcbar(); }

const BASE_TITLE = document.title;
export function paintTitle() {
  document.title = APP.awaitingReader ? "● you're asked — " + BASE_TITLE : BASE_TITLE;
}

export function renderRail(store, blocks) {
  const words = store.events.filter(e => e.t === "draft").reduce((n, e) => Math.max(n, e.words || 0), 0);
  const target = store.meta?.target || 0;
  const consults = blocks.filter(b => b.kind === "consult");
  const count = t => store.events.filter(e => e.t === t).length;
  const pct = target ? Math.min(100, Math.round(words / target * 100)) : 0;
  const stat = (k, v, cls) => `<div class="stat"><span>${k}</span><span class="n ${cls||""}">${v}</span></div>`;
  const flags = count("skill_flag"), retries = count("retry");
  $("railstats").innerHTML = `
    <div class="bar"><i style="width:${pct}%"></i></div>
    ${stat("words", target ? `${words} / ${target}` : words)}
    ${stat("steps", count("draft"))}
    ${stat("consults", consults.length)}
    ${stat("asked back", count("clarify"))}
    ${stat("retries", retries, retries ? "warn" : "")}
    ${stat("skill flags", flags, flags ? "bad" : "")}
    ${store === LIVEV && APP.composing ? `<div class="composing"><i></i><span class="who">${esc(APP.composing.who)}</span>
       composing… ${APP.composing.secs}s</div>` : ""}`;
}
