import { esc, post } from "./util.js";
import { APP } from "./state.js";
import { castChips } from "./shelf.js";

// ---- the play confirmation -------------------------------------------------
// A card click no longer starts a run by itself -- it opens this, showing exactly what the shelf's
// card already showed, plus the two ways forward: play it, or (not yet built) edit it first.
export function confirmModalHtml() {
  if (!APP.confirmDir) return "";
  const s = (APP.stories || []).find(x => x.dir === APP.confirmDir);
  if (!s) { APP.confirmDir = ""; return ""; }   // the shelf refreshed under us; nothing to confirm anymore
  return `<div class="modal-backdrop" id="confirm-backdrop" role="dialog" aria-modal="true"
               aria-label="play ${esc(s.name)}">
    <section class="picker iv confirm">
      <div class="iv-head"><h2>${esc(s.name)}</h2>
        <button class="btn" id="confirm-close" title="cancel">×</button></div>
      ${s.ok ? `<p class="q">${esc(s.scene?.question || "(no scene question)")}</p>
                <p class="premise">${esc(s.premise || "")}</p>
                <div class="row">${castChips(s.characters)}<span class="meta">~${s.scene?.length ?? "?"} words
                  · ${s.maxSteps ?? "?"} steps${s.scene?.pov ? " · pov " + esc(s.scene.pov) : ""}</span></div>`
            : `<div class="said bad">does not load — ${esc(s.error || "unknown error")}</div>`}
      ${(s.warnings || []).map(w => `<div class="prob">⚠ ${esc(w)}</div>`).join("")}
      ${APP.confirmError ? `<div class="said bad">${esc(APP.confirmError)}</div>` : ""}
      <div class="btns" style="margin-top:14px">
        <button class="btn primary" id="confirm-play"${APP.picked || !s.ok ? " disabled" : ""}>play</button>
        <button class="btn" id="confirm-edit" disabled title="not built yet">edit scenario</button>
        <span class="spacer"></span>
        <button class="btn" id="confirm-cancel">cancel</button>
      </div>
    </section>
  </div>`;
}

export function wireConfirm(page) {
  const bd = page.querySelector("#confirm-backdrop");
  if (!bd) return;
  const close = () => { APP.confirmDir = ""; APP.confirmError = ""; APP.render(); };
  bd.addEventListener("click", e => { if (e.target === bd) close(); });
  const on = (id, fn) => { const el = page.querySelector("#" + id); if (el) el.addEventListener("click", fn); };
  on("confirm-close", close);
  on("confirm-cancel", close);
  on("confirm-play", () => choose({ dir: APP.confirmDir }));
}

export async function choose(payload) {
  if (APP.picked) return;                       // a double-click is one choice, not two
  APP.picked = payload.dir;
  APP.confirmError = "";
  APP.render();
  const j = await post("/select", payload);
  if (!j || j.ok === false) { APP.picked = ""; APP.confirmError = (j && j.reason) || "that did not go through"; APP.render(); }
  else { APP.confirmDir = ""; APP.render(); }        // the run starting flips the view to `live` on its own
}
