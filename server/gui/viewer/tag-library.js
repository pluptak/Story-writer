import { APP, FACET_LABELS } from "./state.js";
import { esc, tid, postJson, reasonOr } from "./util.js";
import { button, errorLine, hint, thinking, warnLine, confirmDialog, storyNote } from "./ui.js";
import { loadVocab, refreshUsage } from "./catalog.js";
import { go } from "./nav.js";
import { inspectorEmpty, editorHead, actions, section, editorFooter, clone, newId, needsSave, catalogPageOpen, catalogPageClose } from "./lib-inspector.js";

// The character/style tag pickers and the scaffold's tag picker all read this same cache. A write
// here has to drop it, or they keep offering a tag this page has already renamed or deleted.
const invalidateVocab = loadVocab.invalidate;

const emptyDraft = () => ({ id:"", facet:"", label:"" });
const draftOf = t => ({ id:t?.id || "", facet:t?.facet || "", label:t?.label || "" });
const entryOf = d => ({ id:d.id, facet:d.facet.trim(), label:d.label.trim() });

const folded = s => String(s ?? "").trim().toLowerCase();
/** Whether any style carries the label -- the whole of the derived STYLE cut used to group the
 *  list. A tag is never authored as STORY or STYLE; it is observed from what actually uses it. */
const tagIsStyle = label => (APP.catalog.usage?.tags?.[folded(label)]?.styles?.length ?? 0) > 0;
const tagStyles = label => APP.catalog.usage?.tags?.[folded(label)]?.styles ?? [];
function usageLine(label) {
  const u = APP.catalog.usage?.tags?.[folded(label)];
  if (!u) return "";
  const parts = [];
  if (u.styles.length) parts.push(`${u.styles.length} style${u.styles.length === 1 ? "" : "s"}`);
  return parts.length ? `<i>used by ${parts.join(" · ")}</i>` : "";
}

function visibleEntries() {
  const s = APP.tagLibrary;
  const q = s.search.trim().toLowerCase();
  const filtered = s.entries.filter(t => !q || `${t.label} ${t.facet}`.toLowerCase().includes(q));
  return filtered.sort((a, b) => s.sort === "name"
    ? String(a.label).localeCompare(String(b.label))
    : (Number(b.updatedAt || b.version || 0) - Number(a.updatedAt || a.version || 0)));
}

function dirtyFromDraft() {
  const s = APP.tagLibrary;
  s.dirty = !!s.selected && JSON.stringify(entryOf(s.draft)) !== JSON.stringify(entryOf(draftOf(s.selected)));
}

function facetOptionsHtml(selected) {
  return `<option value="">Select a facet…</option>` + APP.catalogConfig.tagFacets
    .map(f => `<option value="${esc(f)}"${selected === f ? " selected" : ""}>${esc(FACET_LABELS[f] ?? f)}</option>`).join("");
}

function listHtml() {
  const s = APP.tagLibrary;
  const entries = visibleEntries();
  if (!entries.length) return `<div class="lib-empty"><div class="lib-empty-mark">⁂</div><h3>${s.search ? "No tags match" : "Your tag vocabulary is empty"}</h3><p>${s.search ? "Try a different search." : "Define the descriptors the architect and story editor draw on."}</p>${button({label:"New tag", id:"taglib-empty-new", variant:"primary"})}</div>`;
  return entries.map(t => {
    const selected = s.selected?.id === t.id;
    return `<div class="lib-row${selected ? " selected" : ""}" data-tag-id="${esc(t.id)}" role="button" tabindex="0" ${tid("tag-library.row")}>
      <span class="lib-row-copy"><strong>${esc(t.label || "Untitled tag")}</strong><span>${esc(FACET_LABELS[t.facet] ?? t.facet)}</span></span>
      <span class="lib-cut">${tagIsStyle(t.label) ? "Style" : "Story"}</span>
      <button class="lib-more" data-tag-select-id="${esc(t.id)}" aria-label="Open ${esc(t.label)} in editor">•••</button>
    </div>`;
  }).join("");
}

function editorHtml() {
  const s = APP.tagLibrary;
  const d = s.draft;
  if (!d) return inspectorEmpty("Select a tag to edit", "Or define a new one.");
  const c = s.selected;
  const stylesFor = tagStyles(d.label);
  return `${editorHead(`
    <span class="lib-avatar">${esc((d.label || "?").slice(0, 2).toUpperCase())}</span><div><strong>${esc(d.label || "Untitled tag")}</strong><small>ID: ${esc(d.id || "not saved")}</small></div>
    <button class="lib-close" id="taglib-close" aria-label="Close tag editor">×</button>
  `)}
  ${actions(`
    ${button({label:"Duplicate", id:"taglib-duplicate", extraClass:"small"})}
    ${button({label:"Delete", id:"taglib-delete", variant:"danger", extraClass:"small"})}
  `)}
  ${s.error ? errorLine(esc(s.error)) : ""}${s.dirty ? warnLine("unsaved changes") : ""}
  ${section("Tag identity", "A controlled vocabulary entry the architect and story editor offer as a choice.", `
    <label class="lib-field"><span>Facet</span><select class="lib-input" id="taglib-facet">${facetOptionsHtml(d.facet)}</select></label>
    <label class="lib-field"><span>Label</span><input class="lib-input" id="taglib-label" value="${esc(d.label)}" placeholder="e.g. Science Fiction, Comedy, Melancholic"></label>
  `)}
  ${c ? section("Usage", "What actually references this tag today, observed from the other catalogs.", `${usageLine(d.label) || hint("nothing uses this tag yet")}
    ${stylesFor.length ? `<div class="lib-chips">${stylesFor.map(name => `<span class="lib-chip">${esc(name)}</span>`).join("")}</div>` : ""}
  `) : ""}
  ${editorFooter(`${button({label:"Cancel", id:"taglib-cancel", disabled:!s.dirty})}${button({label:"Save changes", id:"taglib-save", variant:"primary", disabled:!needsSave(s)})}`)}`;
}

export function tagLibraryHtml() {
  const s = APP.tagLibrary;
  if (s.loading) return `<section class="lib-page lib-tags"><div class="lib-loading">${thinking("loading tag vocabulary…")}</div></section>`;
  if (s.error && !s.entries.length) return `<section class="lib-page lib-tags"><div class="lib-loading">${storyNote({ meaning: "Couldn't load the tag library — your stories are unaffected.",
    detail: esc(s.error) })}${button({label:"Try again", id:"taglib-retry", variant:"primary"})}</div></section>`;
  return `${catalogPageOpen("tags", s.draft, tid("tag-library.page"))}
    <header class="lib-top"><div class="page-title"><p class="eyebrow">library · tags</p><h1>Tag Vocabulary <span class="lib-info">i</span></h1><p class="lede">Define a controlled vocabulary of story descriptors.</p></div><div class="lib-top-actions">${button({label:"＋ New tag", id:"taglib-new", variant:"primary"})}</div></header>
    <div class="lib-toolbar"><input class="lib-input" id="taglib-search" placeholder="⌕  Search tags…" value="${esc(s.search)}"><select class="lib-input" id="taglib-sort"><option value="updated"${s.sort === "updated" ? " selected" : ""}>Recently updated</option><option value="name"${s.sort === "name" ? " selected" : ""}>Name A–Z</option></select></div>
    <div class="lib-list">${listHtml()}</div><footer class="lib-list-footer">Showing ${visibleEntries().length} of ${s.entries.length} tags</footer>
  ${catalogPageClose(s, editorHtml())}`;
}

async function load() {
  const s = APP.tagLibrary;
  if (s.loading || s.loaded) return;
  s.loading = true; s.error = ""; APP.render();
  try {
    const j = await (await fetch("/catalog?kind=tags")).json();
    if (!j.ok) throw new Error(reasonOr(j, "could not load tags"));
    s.entries = (j.entries || []).map(t => ({ ...t, updatedAt:t.updatedAt || t.version || 0 }));
    s.loaded = true;
    refreshUsage();
  } catch (e) { s.error = e.message || "could not load tags"; }
  s.loading = false; APP.render();
}

function setSelected(t) { const s = APP.tagLibrary; s.selected = t; s.draft = draftOf(t); s.dirty = false; s.error = ""; APP.render(); }
function createNew() { const s = APP.tagLibrary; const t = { ...entryOf({...emptyDraft(), id:newId("tag")}), version:0, updatedAt:Date.now() }; s.entries.unshift(t); setSelected(t); }
function duplicate() { const s = APP.tagLibrary; if (!s.selected) return; const t = { ...clone(s.selected), id:newId("tag"), version:0, updatedAt:Date.now() }; s.entries.splice(s.entries.indexOf(s.selected) + 1, 0, t); setSelected(t); }
function collectDraft() { const s = APP.tagLibrary; if (!s.draft) return; for (const key of ["facet","label"]) { const el = document.getElementById(`taglib-${key}`); if (el) s.draft[key] = el.value; } dirtyFromDraft(); }

async function save() {
  const s = APP.tagLibrary; collectDraft(); if (!s.draft || !needsSave(s)) return;
  const payload = entryOf(s.draft);
  if (!payload.facet) { s.error = "A tag needs a facet."; APP.render(); return; }
  if (!payload.label) { s.error = "A tag needs a label."; APP.render(); return; }
  const j = await postJson("/catalog/save", { kind:"tags", entry:payload }, msg => { s.error = msg; APP.render(); });
  if (!j?.ok) { s.error = reasonOr(j, "could not save tag"); APP.render(); return; }
  invalidateVocab();
  const next = { ...j.entry, updatedAt:Date.now() };
  const idx = s.entries.findIndex(t => t.id === next.id); if (idx >= 0) s.entries[idx] = next; else s.entries.unshift(next);
  refreshUsage();
  setSelected(next);
  // Create-then-return: same shape as character-library.js's save — the scaffold's tag chips key
  // on labels, not ids, so the one-shot carries the label.
  if (APP.catalog.returnTo?.view === "scaffold" && APP.scaffold?.active) {
    APP.catalog.pendingSelect = { kind: "tags", selectLabel: next.label };
    APP.catalog.returnTo = null;
    go("scaffold");
  }
}

async function remove() {
  const s = APP.tagLibrary; if (!s.selected) return;
  if (!await confirmDialog({ title: "Delete this tag?", body: "This cannot be undone.",
    confirmLabel: "delete tag", danger: true })) return;
  const id = s.selected.id;
  const j = await postJson("/catalog/delete", { kind:"tags", id }, msg => { s.error = msg; APP.render(); });
  if (!j?.ok) { s.error = reasonOr(j, "could not delete tag"); APP.render(); return; }
  invalidateVocab();
  s.entries = s.entries.filter(t => t.id !== id); s.selected = null; s.draft = null; s.dirty = false; s.error = "";
  refreshUsage();
  APP.render();
}

export async function loadTagLibrary() { await load(); }

export function wireTagLibrary(page) {
  const s = APP.tagLibrary;
  page.querySelector("#taglib-search")?.addEventListener("input", e => { s.search = e.target.value; APP.render(); });
  page.querySelector("#taglib-sort")?.addEventListener("change", e => { s.sort = e.target.value; APP.render(); });
  page.querySelector("#taglib-new")?.addEventListener("click", createNew);
  page.querySelector("#taglib-empty-new")?.addEventListener("click", createNew);
  page.querySelector("#taglib-retry")?.addEventListener("click", () => { s.loaded = false; load(); });
  page.querySelectorAll("[data-tag-id]").forEach(row => row.addEventListener("click", async e => { if (e.target.closest("button")) return; collectDraft(); if (s.dirty && !await confirmDialog({ title: "Discard unsaved changes?", body: "Your unsaved edits will be lost.", confirmLabel: "discard", danger: true })) return; setSelected(s.entries.find(t => t.id === row.dataset.tagId)); }));
  page.querySelectorAll("[data-tag-select-id]").forEach(action => action.addEventListener("click", async e => {
    e.stopPropagation(); collectDraft(); if (s.dirty && !await confirmDialog({ title: "Discard unsaved changes?", body: "Your unsaved edits will be lost.", confirmLabel: "discard", danger: true })) return;
    setSelected(s.entries.find(t => t.id === action.dataset.tagSelectId));
  }));
  for (const key of ["facet","label"]) page.querySelector(`#taglib-${key}`)?.addEventListener("input", () => { s.draft[key] = document.getElementById(`taglib-${key}`).value; dirtyFromDraft(); page.querySelector("#taglib-save").disabled = !needsSave(s); page.querySelector("#taglib-cancel").disabled = !s.dirty; });
  page.querySelector("#taglib-facet")?.addEventListener("change", () => { s.draft.facet = document.getElementById("taglib-facet").value; dirtyFromDraft(); page.querySelector("#taglib-save").disabled = !needsSave(s); page.querySelector("#taglib-cancel").disabled = !s.dirty; });
  page.querySelector("#taglib-close")?.addEventListener("click", async () => { if (!s.dirty || await confirmDialog({ title: "Discard unsaved changes?", body: "Your unsaved edits will be lost.", confirmLabel: "discard", danger: true })) { s.selected = null; s.draft = null; s.dirty = false; APP.render(); } });
  page.querySelector("#taglib-save")?.addEventListener("click", save);
  page.querySelector("#taglib-cancel")?.addEventListener("click", () => { s.draft = draftOf(s.selected); s.dirty = false; APP.render(); });
  page.querySelector("#taglib-duplicate")?.addEventListener("click", duplicate);
  page.querySelector("#taglib-delete")?.addEventListener("click", remove);
}
