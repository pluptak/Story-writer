import { $, esc } from "./util.js";
import { APP, LIVEV, open } from "./state.js";
import { build } from "./events.js";

/** A compact horizontal consult-timeline strip below the run controls. Each marker shows one consult
 *  block: the character's name, whether it was retried, whether it hit the chapter-wide ceiling.
 *  Clicking a marker scrolls to and auto-expands that block. Rebuilt on every render(). */
export function renderTimeline() {
  const store = APP.view === "live" ? LIVEV : APP.view === "read" ? LIVEV : null;
  if (!store || !store.events.length) { $("timeline").innerHTML = ""; $("timeline").hidden = true; return; }
  const blocks = build(store);
  const consults = blocks.filter(b => b.kind === "consult");
  if (!consults.length) { $("timeline").innerHTML = ""; $("timeline").hidden = true; return; }

  $("timeline").hidden = false;
  $("timeline").innerHTML = `<span class="tl-label">consults</span>` + consults.map(b => {
    const retried = b.attempts.length > 1;
    const capped = !!b.capped;
    const cls = "tl-marker" + (retried ? " retried" : "") + (capped ? " capped" : "");
    const title = `${b.who}${retried ? ` · ${b.attempts.length - 1} retr${b.attempts.length > 2 ? "ies" : "y"}` : ""}${capped ? " · capped" : ""}`;
    return `<button class="${cls}" data-seq="${b.seq}" title="${esc(title)}">${esc(b.who)}</button>`;
  }).join("");
}

export function wireTimeline(page) {
  for (const m of page.querySelectorAll(".tl-marker")) {
    m.addEventListener("click", () => {
      const seq = Number(m.dataset.seq);
      const el = document.querySelector(`[data-seq="${seq}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        open.add(seq);
        APP.render();
      }
    });
  }
}
