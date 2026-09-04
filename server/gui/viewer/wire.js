// Wiring primitives with no app-state dependency of their own -- the `on(id, fn)` triplet every
// wire*() re-declares locally, and the backdrop+close-button pair every modal wires. Callers pass
// the root they already have (the page, or #modalroot); nothing here re-renders or knows APP.

/** Click handler by element id. No element, no handler -- pages render conditionally. */
export const on = (root, id, fn) => {
  const el = root.querySelector("#" + id);
  if (el) el.addEventListener("click", fn);
};

/** Keydown handler by element id. */
export const onKey = (root, id, fn) => {
  const el = root.querySelector("#" + id);
  if (el) el.addEventListener("keydown", fn);
};

/** Input handler by element id; the handler receives the element. */
export const onInput = (root, id, fn) => {
  const el = root.querySelector("#" + id);
  if (el) el.addEventListener("input", () => fn(el));
};

/** Backdrop click closes (never submits), and the modal's own `×` button with it -- the two
 *  affordances every dismissible modal wires to the same close. */
export function wireModalClose(root, { backdropId, closeId, onClose }) {
  const bd = root.querySelector("#" + backdropId);
  if (bd) bd.addEventListener("click", e => { if (e.target === bd) onClose(); });
  const btn = root.querySelector("#" + closeId);
  if (btn) btn.addEventListener("click", onClose);
}
