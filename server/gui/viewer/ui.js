import { esc, tid } from "./util.js";

// Small shared markup builders for the modal-backdrop pattern (character card, the new-story idea
// modal, the library picker, the end-of-run modal) and the `.btn` family. Each modal's header/footer
// stays caller-built -- only the wrapper genuinely identical across all four is shared here.

/** The `.modal-backdrop` > `.picker.iv[.extraClass]` wrapper every modal uses. `body` is the raw
 *  inner HTML the caller already builds (header, form, footer). */
export function modal({ id, dataTid, ariaLabel, extraClass, body }) {
  const cls = extraClass ? `picker iv ${extraClass}` : "picker iv";
  return `<div class="modal-backdrop" id="${id}"${tid(dataTid)} role="dialog" aria-modal="true"
               aria-label="${esc(ariaLabel)}">
    <section class="${cls}">${body}</section>
  </div>`;
}

/** The `×` icon button every modal's own close affordance uses (not every modal has one). */
export function closeButton(id) {
  return `<button class="btn" id="${id}" title="close" aria-label="close">×</button>`;
}

/** A `.btn` (optionally `.primary`/`.danger`, or any other extra class). */
export function button({ label, id, tidName, variant, title, disabled, extraClass }) {
  const cls = ["btn", variant, extraClass].filter(Boolean).join(" ");
  return `<button class="${cls}"${id ? ` id="${id}"` : ""}${tidName ? tid(tidName) : ""}` +
    `${title ? ` title="${esc(title)}"` : ""}${disabled ? " disabled" : ""}>${esc(label)}</button>`;
}

/** A `<p class="hint">` note or empty-state line. `body` is raw HTML -- callers already mix plain
 *  text with the odd `<a>`/`<b>`, and escape their own interpolated values where that matters. */
export function hint(body, { id, extraClass, style, hidden } = {}) {
  const cls = extraClass ? `hint ${extraClass}` : "hint";
  return `<p class="${cls}"${id ? ` id="${id}"` : ""}${style ? ` style="${style}"` : ""}${hidden ? " hidden" : ""}>${body}</p>`;
}
