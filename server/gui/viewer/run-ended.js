import { esc, wireBackdropClose, verdictText } from "./util.js";
import { APP } from "./state.js";
import { modal, button } from "./ui.js";

// ---- the end-of-run modal ----------------------------------------------------
// The engine parks back in awaitPick() the instant a run ends (story-writer.ts's for(;;) loop),
// one tick after the run_state frame saying running:false. Without this, the next pick window was
// the only visible sign a scene had finished, silently swapping the shelf in under whatever was on
// screen -- sse.js no longer follows it there; this says so and leaves the choice to the reader.
export function runEndedModalHtml() {
  const e = APP.runEnded;
  if (!e) return "";
  const verdict = verdictText(e);
  return modal({
    id: "runended-backdrop", dataTid: "runended.modal", ariaLabel: "run ended", extraClass: "runended",
    body: `<div class="iv-head"><h2>${esc(verdict)}</h2></div>
      <p class="sub">${esc(e.words)} words · ${esc(e.steps)} steps</p>
      <div class="btns" style="margin-top:14px">
        ${button({ label: "back to shelf", id: "runended-shelf", variant: "primary" })}
        ${button({ label: "stay here", id: "runended-stay" })}
      </div>`,
  });
}

/** `goShelf` is injected (pages.js, which owns navigation and repaints this every render via its
 *  own `paintModals`) rather than imported, keeping this module ignorant of how "go to the shelf"
 *  is done. */
export function wireRunEndedModal(root, goShelf) {
  const stay = () => { APP.runEnded = null; APP.render(); };
  wireBackdropClose(root, "runended-backdrop", stay);
  const on = (id, fn) => { const el = root.querySelector("#" + id); if (el) el.addEventListener("click", fn); };
  on("runended-stay", stay);
  on("runended-shelf", () => { APP.runEnded = null; goShelf(); });
}
