import { esc, verdictText } from "./util.js";
import { APP } from "./state.js";
import { modal, button, hint } from "./ui.js";
import { on, wireModalClose } from "./wire.js";

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
      <p class="sub">${esc(e.words)} words</p>
      <details class="engine-details" data-tid="runended.details"><summary>${esc(e.steps)} steps</summary>
        <div class="tech">${esc(e.steps)} steps taken</div></details>
      ${hint(`nothing is running anymore. Chapters and past runs are on the story page.`)}
      <div class="btns mt-sm">
        ${button({ label: "back to the story", id: "runended-story", variant: "primary" })}
        ${button({ label: "stay here", id: "runended-stay" })}
      </div>`,
  });
}

/** `goStory` is injected (pages.js, which owns navigation and repaints this every render via its
 *  own `paintModals`) rather than imported, keeping this module ignorant of how "go to the story"
 *  is done. */
export function wireRunEndedModal(root, goStory) {
  const stay = () => { APP.runEnded = null; APP.render(); };
  wireModalClose(root, { backdropId: "runended-backdrop", onClose: stay });
  on(root, "runended-stay", stay);
  on(root, "runended-story", () => { APP.runEnded = null; goStory(); });
}
