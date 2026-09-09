import { esc, tid, modelOptionsHtml } from "./util.js";

// Small shared markup builders for the modal-backdrop pattern (character card, the new-story idea
// modal, the library picker, the end-of-run modal, the confirm dialog) and the `.btn` family.
// Each modal's header/footer stays caller-built -- only the wrapper genuinely identical across
// all of them is shared here.

/** The `.modal-backdrop` > `.picker.iv[.extraClass]` wrapper every modal uses. `body` is the raw
 *  inner HTML the caller already builds (header, form, footer). */
export function modal({ id, dataTid, ariaLabel, extraClass, body }) {
  const cls = extraClass ? `picker iv ${extraClass}` : "picker iv";
  return `<div class="modal-backdrop" id="${id}"${tid(dataTid)} role="dialog" aria-modal="true"
               aria-label="${esc(ariaLabel)}">
    <section class="${cls}">${body}</section>
  </div>`;
}

/** One page-title recipe (eyebrow · serif title · lede), shared by the shelf, story, reader,
 *  scaffold, live and library headers. `eyebrow`/`lede` are optional; `title` is plain text,
 *  `dataTid` names the area (`shelf.`, `story.`, …) so locators keep working. `extraClass`
 *  keeps a view's scoping class (e.g. `sc-head`) on the same node while it migrates. */
export function pageTitle({ eyebrow, title, lede, dataTid, extraClass }) {
  const cls = extraClass ? `page-title ${extraClass}` : "page-title";
  return `<div class="${cls}"${dataTid ? tid(dataTid) : ""}>`
    + (eyebrow ? `<p class="eyebrow">${esc(eyebrow)}</p>` : "")
    + `<h2>${esc(title)}</h2>`
    + (lede ? `<p class="lede">${esc(lede)}</p>` : "")
    + `</div>`;
}

/** Promise-based styled confirm on the shared modal() kit. Renders into #modalroot so it
 *  stacks above page content like every other modal; resolves true on confirm, false on
 *  cancel / backdrop / Escape. `danger` paints the confirm button red; `confirmLabel` defaults
 *  to "confirm". Tids name the role, never the state: `confirm.dialog`, `confirm.ok`,
 *  `confirm.cancel`. A confirm already open owns the decision -- a second call while one is
 *  showing resolves false immediately rather than stacking a duplicate #confirm-backdrop. */
export function confirmDialog({ title, body, confirmLabel = "confirm", danger = false } = {}) {
  return new Promise(resolve => {
    const root = document.getElementById("modalroot");
    if (!root || document.getElementById("confirm-backdrop")) { resolve(false); return; }
    const wrap = document.createElement("div");
    wrap.innerHTML = modal({
      id: "confirm-backdrop", dataTid: "confirm.dialog", ariaLabel: title || "confirm",
      body: `<div class="confirm-body"><h2>${esc(title || "Are you sure?")}</h2>`
        + (body ? `<p class="sub">${esc(body)}</p>` : "")
        + `<div class="btns mt-sm">`
        + `<button class="btn${danger ? " danger" : " primary"}" id="confirm-ok"${tid("confirm.ok")}>${esc(confirmLabel)}</button>`
        + `<button class="btn" id="confirm-cancel"${tid("confirm.cancel")}>cancel</button>`
        + `</div></div>`,
    });
    const bd = wrap.firstElementChild;
    // Focus returns to whoever opened the confirm -- a repaint never touches #modalroot's
    // detached node, so the opener is still there when the decision is a cancel (on confirm
    // the navigation owns what happens next, and a removed opener simply skips the restore).
    const invoker = document.activeElement;
    const done = v => {
      bd.remove();
      if (invoker && document.contains(invoker)) {
        try { invoker.focus(); } catch { /* a disabled opener keeps focus where it is */ }
      }
      resolve(v);
    };
    bd.querySelector("#confirm-ok").addEventListener("click", () => done(true));
    bd.querySelector("#confirm-cancel").addEventListener("click", () => done(false));
    bd.addEventListener("click", e => { if (e.target === bd) done(false); });
    // Escape routing lives in chrome.js, which knows nothing about this promise -- stash the
    // resolver on the node so the topmost-backdrop handler can settle it as a cancel.
    bd._confirmResolve = done;
    root.appendChild(bd);
    const ok = bd.querySelector("#confirm-ok");
    if (ok) ok.focus();
  });
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

/** Two-layer failure presentation: what this means for the story first, the raw technical
 *  detail behind a collapsed disclosure second. Nothing is hidden -- the detail stays in the
 *  DOM, machine-readable and searchable -- but the author is never forced to interpret a server
 *  or model error to know what happened. `meaning` and `detail` are raw HTML (escape before
 *  calling, as with errorLine/warnLine); `tone` reuses the existing said/prob visual tokens. */
export function storyNote({ tone = "bad", meaning, detail = "", tidName = "", extraClass = "" }) {
  const cls = tone === "warn" ? "prob" : "said bad";
  return `<div class="${cls}${extraClass ? " " + extraClass : ""}"${tidName ? tid(tidName) : ""}>`
    + `<div class="meaning">${meaning}</div>`
    + (detail ? `<details class="engine-details"><summary>Technical details</summary>`
      + `<div class="tech">${detail}</div></details>` : "")
    + `</div>`;
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
