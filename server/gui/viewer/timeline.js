import { $, esc, tid } from "./util.js";
import { APP } from "./state.js";
import { noteFocus } from "./nav.js";

/** A compact horizontal consult-timeline strip below the run controls. Each marker shows one consult
 *  block: the character's name, whether it was retried, whether it hit the chapter-wide ceiling.
 *  Clicking a marker scrolls to and auto-expands that block. Rebuilt on every render() from the
 *  blocks render() already built, so it follows whichever store the current view reads and empties
 *  itself on the views that have none -- the strip lives outside `#page` and would otherwise survive
 *  a view change. */
export function renderTimeline(blocks) {
  const el = $("timeline");
  if (!el) return;
  const consults = blocks.filter(b => b.kind === "consult");
  if (!consults.length) { el.innerHTML = ""; el.hidden = true; return; }

  el.hidden = false;
  el.innerHTML = `<span class="tl-label">consults</span>` + consults.map(b => {
    const retried = b.attempts.length > 1;
    const capped = !!b.capped;
    const cls = "tl-marker" + (retried ? " retried" : "") + (capped ? " capped" : "");
    const title = `${b.who}${retried ? ` · ${b.attempts.length - 1} retr${b.attempts.length > 2 ? "ies" : "y"}` : ""}${capped ? " · capped" : ""}`;
    return `<button ${tid("timeline.marker")} class="${cls}" data-seq="${esc(b.seq)}" title="${esc(title)}">${esc(b.who)}</button>`;
  }).join("");
}

/** Wired from the strip's own element, not from `#page`, because it is a sibling of the layout
 *  rather than a child of it. The jump goes through noteFocus + render: pages.js's settle does the
 *  scroll-and-open against the fresh DOM, and the URL gains `&block=` so what you jumped to is
 *  what a pasted link reopens. */
export function wireTimeline() {
  const el = $("timeline");
  if (!el) return;
  for (const m of el.querySelectorAll(".tl-marker")) {
    m.addEventListener("click", () => {
      noteFocus(Number(m.dataset.seq));
      APP.render();
    });
  }
}
