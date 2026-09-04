// ---- the library picker overlay ---------------------------------------------
// A focused modal that reads entries from a library (skills, characters, styles, tags) and lets
// the caller pick a subset -- so a page can draw on a library without navigating away to it.
//
// The picker is READ-ONLY. Editing a library entry stays on that library's own page, which is what
// makes "the architect consumes the library, it does not manage it" true of the mechanism and not
// only of the prose. It holds its own APP.picker slice for the same reason: `APP.catalog` is the
// catalog PAGE, and an overlay sharing it would wipe the half-filled form underneath.

import { esc, tid, reasonOr, wireBackdropClose } from "./util.js";
import { APP } from "./state.js";
import { modal, closeButton, button, hint as hintLine } from "./ui.js";

let onDone = null;            // the caller's resolver
let preselectNames = [];      // matched against entry names once the fetch lands
let gen = 0;                  // guard against stale responses

/** One place that knows how each kind displays. Returns { id, name, blurb, meta }. */
export function entryFace(kind, e) {
  if (kind === "skills") {
    return { id: e.id, name: e.name, blurb: e.meaning, meta: (e.tags || []).join(" · ") };
  } else if (kind === "characters") {
    return { id: e.id, name: e.name, blurb: e.portablePersona, meta: (e.tags || []).join(" · ") };
  } else if (kind === "styles") {
    return { id: e.id, name: e.name, blurb: e.description, meta: (e.tags || []).join(" · ") };
  } else if (kind === "tags") {
    return { id: e.id, name: e.label, blurb: "", meta: e.facet };
  }
  return { id: e.id, name: e.name || e.label || e.id, blurb: "", meta: "" };
}

export async function openLibraryPicker({ kind, title, hint = "", preselect = [], done }) {
  APP.picker = { open: true, kind, title, hint, loading: true, error: "", entries: [], search: "", chosen: [] };
  onDone = done;
  preselectNames = preselect;
  gen++;
  const currentGen = gen;
  APP.render();

  try {
    const r = await fetch("/catalog?kind=" + encodeURIComponent(kind));
    const j = await r.json();

    if (gen !== currentGen) return; // stale response

    if (!j.ok) {
      APP.picker.error = reasonOr(j, "the library did not load");
      APP.picker.loading = false;
      APP.render();
      return;
    }

    APP.picker.entries = j.entries || [];

    // Seed chosen with ids of entries whose display name matches any preselectNames (case-insensitive)
    if (preselectNames.length > 0) {
      const preselectLower = new Set(preselectNames.map(n => n.trim().toLowerCase()));
      APP.picker.chosen = APP.picker.entries
        .filter(e => preselectLower.has((entryFace(kind, e).name || "").trim().toLowerCase()))
        .map(e => e.id);
    }

    APP.picker.loading = false;
    APP.render();
  } catch {
    if (gen !== currentGen) return; // stale response
    APP.picker.error = "the engine did not answer";
    APP.picker.loading = false;
    APP.render();
  }
}

export function closeLibraryPicker() {
  APP.picker.open = false;
  onDone = null;
  preselectNames = [];
}

export function cancelLibraryPicker() {
  closeLibraryPicker();
  APP.render();
}

export function libraryPickerHtml() {
  if (!APP.picker.open) return "";

  const { title, hint, loading, error, entries, chosen } = APP.picker;

  // Every entry is rendered, and the search hides rows in place. Filtering here instead would take
  // the non-matching rows out of the DOM, and then clearing the search -- which never re-renders --
  // would have nothing left to bring back.
  const rowsHtml = entries.map(e => {
    const face = entryFace(APP.picker.kind, e);
    const isChosen = chosen.includes(face.id);
    return `<button class="pick-row${isChosen ? " on" : ""}" data-id="${esc(face.id)}" ${tid("picker.row")}
          aria-pressed="${isChosen}">
    <b>${esc(face.name)}</b>${face.blurb ? `<span>${esc(face.blurb)}</span>` : ""}${face.meta ? `<span class="meta">${esc(face.meta)}</span>` : ""}
  </button>`;
  }).join("");

  let contentHtml;
  if (loading) {
    contentHtml = hintLine(`reading the library…`);
  } else if (error) {
    contentHtml = `<div class="said bad">${esc(error)}</div>`;
  } else if (!entries.length) {
    contentHtml = hintLine(`this library has no entries yet — they are created on its own page`);
  } else {
    contentHtml = `<div class="pick-list" id="picker-list">${rowsHtml}</div>
      ${hintLine(`nothing matches that search`, { id: "picker-none", hidden: true })}`;
  }

  return modal({
    id: "picker-backdrop", dataTid: "picker.modal", ariaLabel: title, extraClass: "libpick",
    body: `<div class="iv-head">
        <div><h2>${esc(title)}</h2>${hint ? `<p class="sub">${esc(hint)}</p>` : ""}</div>
        ${closeButton("picker-close")}
      </div>
      <input type="text" id="picker-search" placeholder="Search…" value="${esc(APP.picker.search)}">
      ${contentHtml}
      <div class="composer-foot">
        <span class="hint" id="picker-count">Selected: ${chosen.length}</span>
        ${button({ label: "cancel", id: "picker-cancel" })}
        ${button({ label: "use selected", id: "picker-done", variant: "primary" })}
      </div>`,
  });
}

/** The search, applied in place. Never renders: the page underneath repaints on every SSE frame,
 *  and a full repaint would fight the caret in the search box -- the same reason the interview's
 *  folder step updates its own dependent nodes by hand. */
function applyFilter(root) {
  const q = APP.picker.search.trim().toLowerCase();
  const rows = [...root.querySelectorAll(".pick-row")];
  let shown = 0;
  for (const row of rows) {
    const hit = !q || row.textContent.toLowerCase().includes(q);
    row.hidden = !hit;
    if (hit) shown++;
  }
  const none = root.querySelector("#picker-none");
  if (none) none.hidden = !rows.length || shown > 0;
}

export function wireLibraryPicker(root) {
  const searchEl = root.querySelector("#picker-search");
  if (searchEl) {
    searchEl.addEventListener("input", () => {
      APP.picker.search = searchEl.value;
      applyFilter(root);
    });
  }

  // Row click: toggle selection
  for (const row of root.querySelectorAll(".pick-row")) {
    row.addEventListener("click", () => {
      const id = row.dataset.id;
      const idx = APP.picker.chosen.indexOf(id);
      if (idx >= 0) APP.picker.chosen.splice(idx, 1);
      else APP.picker.chosen.push(id);
      const on = row.classList.toggle("on");
      row.setAttribute("aria-pressed", String(on));
      const count = root.querySelector("#picker-count");
      if (count) count.textContent = `Selected: ${APP.picker.chosen.length}`;
    });
  }

  // Done button
  const doneBtn = root.querySelector("#picker-done");
  if (doneBtn) {
    doneBtn.addEventListener("click", () => {
      // The caller gets what was CHOSEN and what was OFFERED. It needs both: only the offered set
      // says which of the caller's existing lines this library owns, and so which a deselection
      // should remove rather than leave standing as a line the picker never knew about.
      const all = APP.picker.entries;
      const chosenEntries = all.filter(e => APP.picker.chosen.includes(e.id));
      const callback = onDone;
      closeLibraryPicker();
      if (callback) callback(chosenEntries, all);
      APP.render();
    });
  }

  // Cancel and close buttons
  const cancelBtn = root.querySelector("#picker-cancel");
  const closeBtn = root.querySelector("#picker-close");
  if (cancelBtn) cancelBtn.addEventListener("click", cancelLibraryPicker);
  if (closeBtn) closeBtn.addEventListener("click", cancelLibraryPicker);

  wireBackdropClose(root, "picker-backdrop", cancelLibraryPicker);

  // A repaint re-emits every row unfiltered, so the standing search has to be re-applied or a
  // render arriving mid-search would silently show the whole library again.
  applyFilter(root);
}
