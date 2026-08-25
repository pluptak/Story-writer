import { $, esc, tid } from "./util.js";
import { APP, open } from "./state.js";

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
 *  rather than a child of it. The jump target is looked up inside `#page` for the same reason: a
 *  marker carries the same `data-seq` as the block it points at, and it comes first in the document. */
export function wireTimeline() {
  const el = $("timeline");
  if (!el) return;
  for (const m of el.querySelectorAll(".tl-marker")) {
    m.addEventListener("click", () => {
      const seq = Number(m.dataset.seq);
      const target = $("page")?.querySelector(`[data-seq="${seq}"]`);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        open.add(seq);
        APP.render();
      }
    });
  }
}
