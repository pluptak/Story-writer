// DOM/network primitives with no app-state dependency of their own.
export const $ = id => document.getElementById(id);
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));

/** The stable-locator attribute, `<area>.<component>` (GUI-CHECKLIST "Locators"). Names the ROLE,
 *  never the state or position -- instances are told apart by the data-* key they already carry
 *  (data-seq, data-dir, data-view). Elements with a unique id= don't need one. */
export const tid = name => ` data-tid="${esc(name)}"`;
export const basename = p => (p || "").replace(/^.*[\\/]/, "");
export const fmtRun = r => {
  const when = new Date(r.mtimeMs).toLocaleString(undefined,
    { month:"short", day:"numeric", hour:"numeric", minute:"2-digit" });
  const status = r.stopped ? "stopped" : r.done ? "finished" : r.words != null ? "unfinished" : "no output";
  return [when, r.words != null ? `${r.words}w` : "", status].filter(Boolean).join(" · ");
};

/** How a run ended, in words -- shared by the "end" block (blocks.js) and the end-of-run modal
 *  (run-ended.js), which read the same {stopped, done} shape off different sources. */
export const verdictText = e => e.stopped ? "stopped by request" : e.done ? "scene finished" : "stopped early";

/** The engine's own reason for a refusal, or a fallback when it didn't give one (or didn't answer
 *  at all -- `j` is null then). */
export const reasonOr = (j, fallback) => (j && j.reason) || fallback;

/** Options for a model-picking <select>, shared by the live session bar and the story page. */
export const modelOptionsHtml = (ids, selectedId) =>
  ids.map(id => `<option value="${esc(id)}"${id === selectedId ? " selected" : ""}>${esc(id)}</option>`).join("");

/** Backdrop click closes (never submits) -- shared by every modal (interview, character card,
 *  run-ended). */
export function wireBackdropClose(root, id, onClose) {
  const bd = root.querySelector("#" + id);
  if (bd) bd.addEventListener("click", e => { if (e.target === bd) onClose(); });
}

const noticeTimers = {};
/** Set (or clear) the text at a notice slot, `#notice` by default -- auto-clears after 8s so a
 *  refusal doesn't linger once it's stale. `at: false` means nowhere: the caller renders the
 *  refusal itself (inline, keyed to its own state) and does not want it echoed to a DOM slot too. */
export function notify(text, at = "notice") {
  if (at === false) return;
  const el = $(at);
  if (!el) return;
  el.textContent = text || "";
  clearTimeout(noticeTimers[at]);
  if (text) noticeTimers[at] = setTimeout(() => { el.textContent = ""; }, 8000);
}

/** POST, and say why if the engine says no. `at` picks which notice slot reports the refusal, or
 *  `false` to report nowhere (the caller handles it). Returns the parsed body, or null if it never
 *  answered. */
export async function post(path, body, at = "notice") {
  let j = null;
  try {
    const r = await fetch(path, body === undefined ? { method:"POST" }
      : { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
    j = await r.json();
  } catch { notify("the engine did not answer", at); return null; }
  notify(j && j.ok === false ? reasonOr(j, "that did not go through") : "", at);
  return j;
}
