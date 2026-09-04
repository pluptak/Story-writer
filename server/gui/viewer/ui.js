import { esc, tid, modelOptionsHtml } from "./util.js";

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

/** A `<div class="said bad[ …]">` refusal or failure line. `body` is raw HTML, same convention as
 *  hint(): escape your own interpolated values. */
export function errorLine(body, extraClass = "") {
  return `<div class="said bad${extraClass ? " " + extraClass : ""}">${body}</div>`;
}

/** A `<div class="prob">` warning line. `body` is raw HTML; callers that want the `⚠` glyph pass
 *  it themselves, since not every `.prob` line carries one. */
export function warnLine(body, extraClass = "") {
  return `<div class="prob${extraClass ? " " + extraClass : ""}">${body}</div>`;
}

/** The `<i></i>…` thinking indicator; the element varies by where it sits (span inside a button
 *  row, p or div on its own line), so the caller names it. */
export function thinking(text, { show = true, tag = "div" } = {}) {
  return `<${tag} class="thinking${show ? " show" : ""}"><i></i>${text}</${tag}>`;
}

/** The `<div class="divider"><span>…</span></div>` section break. `label` is plain text. */
export function divider(label) {
  return `<div class="divider"><span>${esc(label)}</span></div>`;
}

/** A model-picking `<select>`: the story/architect default as the blank option, then every id the
 *  configured server knows. Callers keep their own selection state and change handlers. */
export function modelSelect({ id, tidName, title, defaultLabel, selected = "", extraClass = "", modelIds = [] }) {
  return `<select id="${id}"${tidName ? tid(tidName) : ""}${extraClass ? ` class="${extraClass}"` : ""}` +
    `${title ? ` title="${esc(title)}"` : ""}>
    <option value=""${selected ? "" : " selected"}>${defaultLabel}</option>
    ${modelOptionsHtml(modelIds, selected)}
  </select>`;
}
