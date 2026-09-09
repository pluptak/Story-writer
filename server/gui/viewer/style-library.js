import { APP } from "./state.js";
import { esc, tid, parseLines, postJson, reasonOr } from "./util.js";
import { button, errorLine, hint, thinking, warnLine, confirmDialog, storyNote } from "./ui.js";
import { loadVocab, loadStyles, refreshUsage } from "./catalog.js";
import { go } from "./nav.js";
import { inspectorEmpty, editorHead, actions, section, editorFooter, tabs, clone, newId, needsSave, catalogPageOpen, catalogPageClose } from "./lib-inspector.js";

const emptyDraft = () => ({ id:"", name:"", description:"", voice:"", tags:[] });
const draftOf = s => ({ id:s?.id || "", name:s?.name || "", description:s?.description || "", voice:s?.voice || "", tags:[...(s?.tags || [])] });
const entryOf = d => ({ id:d.id, name:d.name.trim(), description:d.description.trim(), voice:d.voice.trim(), tags:[...(d.tags || [])] });

function visibleEntries() {
  const s = APP.styleLibrary, q = s.search.trim().toLowerCase();
  return s.entries.filter(x => {
    if (!s.showHidden && x.hidden) return false;
    if (s.visibility === "visible" && x.hidden) return false;
    if (s.visibility === "hidden" && !x.hidden) return false;
    return !q || `${x.name} ${x.description} ${x.voice}`.toLowerCase().includes(q);
  }).sort((a, b) => s.sort === "name" ? String(a.name).localeCompare(String(b.name))
    : Number(b.updatedAt || b.version || 0) - Number(a.updatedAt || a.version || 0));
}

function dirtyFromDraft() {
  const s = APP.styleLibrary;
  s.dirty = !!s.selected && JSON.stringify(entryOf(s.draft)) !== JSON.stringify(entryOf(draftOf(s.selected)));
}

// A freshly created or duplicated style is never dirty -- its draft is derived from the very
// object it is compared against -- but it also has never been persisted (version 0, set by
// createNew()/duplicate()). Save is gated on needsSave() from lib-inspector.js: an edit, or
// nothing to lose by pressing it.

function field(id, label, value, hintText = "") {
  return `<label class="lib-field"><span>${label}</span><textarea class="lib-input lib-textarea" id="${id}" rows="${id.includes("voice") ? 8 : 4}">${esc(value)}</textarea>${hintText ? `<small>${hintText}</small>` : ""}</label>`;
}

function listHtml() {
  const s = APP.styleLibrary, entries = visibleEntries();
  if (!entries.length) return `<div class="lib-empty"><div class="lib-empty-mark">⁂</div><h3>${s.search ? "No styles match" : "Your style library is empty"}</h3><p>${s.search ? "Try a different search." : "Create a reusable writing approach for your stories."}</p>${button({label:"New style", id:"stylib-empty-new", variant:"primary"})}</div>`;
  return entries.map(x => {
    const selected = s.selected?.id === x.id;
    return `<div class="lib-row${selected ? " selected" : ""}" data-style-id="${esc(x.id)}" role="button" tabindex="0">
      <span class="lib-row-copy"><strong>${esc(x.name || "Untitled style")}</strong><span>${esc(x.description || "Describe the writing approach in one sentence.")}</span><small>v${esc(x.version || 1)}</small></span>
      <button class="lib-more" data-style-select-id="${esc(x.id)}" aria-label="Open ${esc(x.name)} in editor">•••</button>
    </div>`;
  }).join("");
}

function editorHtml() {
  const s = APP.styleLibrary, d = s.draft, a = s.assistant;
  if (!d) return inspectorEmpty("Select a style to edit", "Or create a new reusable writing approach.");
  const c = s.selected;
  return `${editorHead(`<div><strong>${esc(d.name || "Untitled style")}</strong><small>ID: ${esc(d.id || "not saved")}</small></div><button class="lib-close" id="stylib-close" aria-label="Close style editor">×</button>`)}
  ${actions(`${button({label:"Duplicate", id:"stylib-duplicate", extraClass:"small"})}${button({label:c?.hidden ? "Restore" : "Hide", id:"stylib-toggle-hidden", extraClass:"small", title:"Hiding entries isn't available yet"})}<span class="lib-soon">soon</span>${button({label:"Delete", id:"stylib-delete", variant:"danger", extraClass:"small"})}`)}
  ${tabs(`<button class="lib-tab active">Overview</button><button class="lib-tab" id="stylib-ai-tab">AI Assistant <b>soon</b></button><button class="lib-tab" disabled>Revisions</button>`)}
  ${s.error ? errorLine(esc(s.error)) : ""}${s.dirty ? warnLine("unsaved changes") : ""}
  ${section("Style identity", "Define a reusable writing approach. Keep story-specific instructions outside the library.", `
    <label class="lib-field"><span>Name</span><input class="lib-input" id="stylib-name" value="${esc(d.name)}"></label>
    ${field("stylib-description", "Description", d.description, "A short description shown when choosing a style.")}
    <div class="lib-meta"><span>Version</span><b>v${esc(c?.version || 1)}</b></div>
    ${field("stylib-voice", "Style guidelines", d.voice, "Person, tense, dialogue handling, vocabulary, and what to leave out.")}
  `)}
  ${section("Tags", "Writing-style descriptors from the tag vocabulary.", `
    <div class="lib-chips" id="stylib-tags">${tagChipsHtml()}</div>
  `)}
  <div class="lib-guides"><h3>Principles</h3><p>Quickly visible reminders derived from the style guidelines.</p><div class="lib-guide-grid">${principles(d.voice).map(p => `<div class="lib-guide"><strong>${esc(p)}</strong><span>Reusable style principle</span></div>`).join("") || `<div class="lib-guide empty">Add guidelines to develop principles.</div>`}</div></div>
  <div class="lib-assistant"><div><strong>✦ Style assistant</strong><span class="lib-soon">coming soon</span></div><p>Ask for a tonal, structural, or guideline revision. Not available yet — the button reports back until it lands.</p>${button({label:"Open AI assistant →", id:"stylib-ai-open", extraClass:"small"})}</div>
  ${editorFooter(`${button({label:"Cancel", id:"stylib-cancel", disabled:!s.dirty})}${button({label:"Save changes", id:"stylib-save", variant:"primary", disabled:!needsSave(s)})}`)}
  ${a.open ? assistantHtml() : ""}`;
}

function principles(voice) {
  return parseLines(voice).filter(x => x.length > 0).slice(0, 4).map(x => x.length > 54 ? `${x.slice(0, 54)}…` : x);
}

const expandedFacets = new Set();

function tagChipsHtml() {
  const s = APP.styleLibrary;
  const vocab = APP.catalog.vocab || [];
  if (!vocab.length) return `<p class="hint">No tags defined yet — open the tag vocabulary to add some.</p>`;
  const selected = s.draft?.tags || [];
  let html = "";
  for (const facet of APP.catalogConfig.tagFacets) {
    const tags = vocab.filter(t => t.facet === facet);
    if (!tags.length) continue;
    const isExpanded = expandedFacets.has(facet);
    const visible = isExpanded ? tags : tags.slice(0, 5);
    const rest = tags.length - 5;
    html += `<div class="lib-chips" data-facet="${facet}">`;
    for (const t of visible) {
      const on = selected.includes(t.label);
      html += `<button class="lib-chip${on ? " on" : ""}" data-style-tag="${esc(t.label)}" type="button" ${tid("style-library.tag")}>${esc(t.label)}</button>`;
    }
    if (rest > 0 && !isExpanded) {
      html += `<button class="lib-chip" data-style-tag="__facet-${facet}__" type="button" ${tid("style-library.tag-more")}>+${rest}</button>`;
    } else if (rest > 0 && isExpanded) {
      html += `<button class="lib-chip" data-style-tag="__facet-${facet}__" type="button" ${tid("style-library.tag-less")}>−${rest}</button>`;
    }
    html += `</div>`;
  }
  return html;
}

function assistantHtml() {
  const a = APP.styleLibrary.assistant, changes = a.proposal?.changes || [];
  return `<div class="lib-modal-backdrop"><section class="lib-modal" role="dialog" aria-modal="true" aria-label="AI style assistant"><div class="lib-modal-head"><div><h2>AI style assistant</h2><p>Not available yet. Describe a change and the button reports back; the saved style is untouched.</p></div><button class="lib-close" id="stylib-ai-close">×</button></div>
    <label class="lib-field"><span>Instruction</span><textarea class="lib-input lib-textarea" id="stylib-ai-instruction" rows="4" placeholder="Make the prose more restrained and concrete, but preserve the short-sentence rhythm.">${esc(a.instruction)}</textarea></label>
    ${a.error ? errorLine(esc(a.error)) : ""}${a.loading ? thinking("preparing proposal…") : a.proposal ? `<div class="lib-proposal"><strong>Proposed changes</strong>${changes.length ? changes.map(x => `<div class="lib-change"><b>${esc(x.field)}</b><div><small>Before</small><del>${esc(x.before || "(empty)")}</del><small>After</small><em>${esc(x.after || "(empty)")}</em></div></div>`).join("") : `<p>No fields changed. The instruction was preserved without guessing.</p>`}</div>` : hint("The assistant only works on reusable style fields.")}
    <div class="lib-modal-actions">${button({label:"Cancel", id:"stylib-ai-cancel"})}${a.proposal ? button({label:"Apply proposal", id:"stylib-ai-apply", variant:"primary"}) : button({label:"Prepare proposal", id:"stylib-ai-submit", variant:"primary"})}</div>
  </section></div>`;
}

export function styleLibraryHtml() {
  const s = APP.styleLibrary;
  if (s.loading) return `<section class="lib-page lib-styles"><div class="lib-loading">${thinking("loading style library…")}</div></section>`;
  if (s.error && !s.entries.length) return `<section class="lib-page lib-styles"><div class="lib-loading">${storyNote({ meaning: "Couldn't load the style library — your stories are unaffected.",
    detail: esc(s.error) })}${button({label:"Try again", id:"stylib-retry", variant:"primary"})}</div></section>`;
  return `${catalogPageOpen("styles", s.draft, tid("style-library.page"))}<header class="lib-top"><div class="page-title"><p class="eyebrow">library · styles</p><h1>Style Library <span class="lib-info">i</span></h1><p class="lede">Reusable writing styles you can apply to any story.</p></div><div class="lib-top-actions">${button({label:"＋ New style", id:"stylib-new", variant:"primary"})}</div></header>
    <div class="lib-toolbar"><input class="lib-input" id="stylib-search" placeholder="⌕  Search styles…" value="${esc(s.search)}"><select class="lib-input" id="stylib-sort"><option value="updated"${s.sort === "updated" ? " selected" : ""}>Recently updated</option><option value="name"${s.sort === "name" ? " selected" : ""}>Name A–Z</option></select></div>
    <div class="lib-list">${listHtml()}</div><footer class="lib-list-footer">Showing ${visibleEntries().length} of ${s.entries.length} styles</footer>${catalogPageClose(s, editorHtml())}`;
}

async function load() {
  const s = APP.styleLibrary; if (s.loading || s.loaded) return;
  s.loading = true; s.error = ""; APP.render();
  try { const j = await (await fetch("/catalog?kind=styles")).json(); if (!j.ok) throw new Error(reasonOr(j, "could not load styles")); s.entries = (j.entries || []).map(x => ({ ...x, hidden:!!x.hidden, updatedAt:x.updatedAt || x.version || 0 })); s.loaded = true; }
  catch (e) { s.error = e.message || "could not load styles"; }
  s.loading = false; APP.render();
  await loadVocab();
  refreshUsage();
}

function setSelected(x) { const s = APP.styleLibrary; s.selected = x; s.draft = draftOf(x); s.dirty = false; s.error = ""; s.assistant = { open:false, instruction:"", loading:false, proposal:null, error:"" }; APP.render(); }
function createNew() { const s = APP.styleLibrary, x = { ...entryOf({...emptyDraft(), id:newId("sty"), name:"New style"}), hidden:false, version:0, updatedAt:Date.now() }; s.entries.unshift(x); setSelected(x); }
function duplicate() { const s = APP.styleLibrary; if (!s.selected) return; const x = { ...clone(s.selected), id:newId("sty"), name:`${s.selected.name} Copy`, version:0, updatedAt:Date.now(), hidden:false }; s.entries.splice(s.entries.indexOf(s.selected) + 1, 0, x); setSelected(x); }
// Tags are not re-read from the DOM here: the chip click handler already keeps s.draft.tags in
// sync directly, and a collapsed facet only renders its first 5 chips, so deriving tags from
// `.lib-chip.on` would silently drop any selected tag past that cutoff.
function collectDraft() { const s = APP.styleLibrary; if (!s.draft) return; for (const k of ["name","description","voice"]) { const el = document.getElementById(`stylib-${k}`); if (el) s.draft[k] = el.value; } dirtyFromDraft(); }
async function save() {
  const s = APP.styleLibrary; collectDraft(); if (!s.draft || !needsSave(s)) return;
  const payload = entryOf(s.draft); if (!payload.name) { s.error = "A style needs a name."; APP.render(); return; }
  const j = await postJson("/catalog/save", { kind:"styles", entry:payload }, msg => { s.error = msg; APP.render(); });
  if (!j?.ok) { s.error = reasonOr(j, "could not save style"); APP.render(); return; }
  // The scaffold's voice picker reads its own lazy cache — drop it, or the tray keeps offering
  // the list from before this save (the character and tag saves already invalidate theirs).
  loadStyles.invalidate();
  const next = { ...j.entry, hidden:s.selected?.hidden || false, updatedAt:Date.now() };
  const i = s.entries.findIndex(x => x.id === next.id); if (i >= 0) s.entries[i] = next; else s.entries.unshift(next);
  setSelected(next);
  // Create-then-return: same shape as character-library.js's save.
  if (APP.catalog.returnTo?.view === "scaffold" && APP.scaffold?.active) {
    APP.catalog.pendingSelect = { kind: "styles", selectId: next.id };
    APP.catalog.returnTo = null;
    go("scaffold");
  }
}
// Visibility is not built yet: ask the placeholder endpoint, report its answer, don't flip locally.
async function toggleHidden() {
  const s = APP.styleLibrary; if (!s.selected) return;
  const j = await postJson("/catalog/visibility", { kind:"styles", id:s.selected.id, hidden:!s.selected.hidden });
  s.error = reasonOr(j, "visibility isn't available yet");
  APP.render();
}
// Response-driven, like character-library.js's remove(): the row leaves the list only once the
// server confirms the entry is gone, against the same real route save() already uses.
async function remove() {
  const s = APP.styleLibrary; if (!s.selected) return;
  if (!await confirmDialog({ title: "Delete this style?",
    body: "This cannot be undone. For normal cleanup, use Hide instead.",
    confirmLabel: "delete style", danger: true })) return;
  const id = s.selected.id;
  const j = await postJson("/catalog/delete", { kind:"styles", id }, msg => { s.error = msg; APP.render(); });
  if (!j?.ok) { s.error = reasonOr(j, "could not delete style"); APP.render(); return; }
  s.entries = s.entries.filter(x => x.id !== id); s.selected = null; s.draft = null; s.dirty = false; s.error = ""; APP.render();
}
// The catalog assistant is not built yet -- calls the placeholder endpoint, renders what it
// returns, never fabricates. A returned `proposal` is all the real endpoint needs to draw the diff.
async function assistant() {
  const s = APP.styleLibrary, a = s.assistant;
  a.instruction = document.getElementById("stylib-ai-instruction")?.value || "";
  if (!a.instruction.trim()) { a.error = "Add an instruction first."; APP.render(); return; }
  a.loading = true; a.error = ""; a.proposal = null; APP.render();
  const j = await postJson("/catalog/assist", { kind:"styles", instruction:a.instruction, style:entryOf(s.draft) });
  a.loading = false;
  if (j?.ok && j.proposal) {
    const next = j.proposal.draft || j.proposal, base = entryOf(s.draft), fields = ["name","description","voice"];
    a.proposal = { draft:next, changes:fields.filter(k => String(next[k] || "") !== String(base[k] || "")).map(k => ({ field:k, before:base[k] || "", after:next[k] || "" })) };
  } else {
    a.error = reasonOr(j, "the assistant isn't available yet");
  }
  APP.render();
}
function applyProposal() { const s = APP.styleLibrary; if (!s.assistant.proposal) return; s.draft = draftOf(s.assistant.proposal.draft); dirtyFromDraft(); s.assistant.open = false; s.assistant.proposal = null; APP.render(); }

export async function loadStyleLibrary() { await load(); }
export function wireStyleLibrary(page) {
  const s = APP.styleLibrary;
  page.querySelector("#stylib-search")?.addEventListener("input", e => { s.search = e.target.value; APP.render(); });
  page.querySelector("#stylib-sort")?.addEventListener("change", e => { s.sort = e.target.value; APP.render(); });
  page.querySelector("#stylib-new")?.addEventListener("click", createNew); page.querySelector("#stylib-empty-new")?.addEventListener("click", createNew);
  page.querySelector("#stylib-retry")?.addEventListener("click", () => { s.loaded = false; load(); });
  page.querySelectorAll("[data-style-id]").forEach(row => row.addEventListener("click", async e => { if (e.target.closest("button")) return; collectDraft(); if (s.dirty && !await confirmDialog({ title: "Discard unsaved changes?", body: "Your unsaved edits will be lost.", confirmLabel: "discard", danger: true })) return; setSelected(s.entries.find(x => x.id === row.dataset.styleId)); }));
  page.querySelectorAll("[data-style-select-id]").forEach(action => action.addEventListener("click", async e => { e.stopPropagation(); collectDraft(); if (s.dirty && !await confirmDialog({ title: "Discard unsaved changes?", body: "Your unsaved edits will be lost.", confirmLabel: "discard", danger: true })) return; setSelected(s.entries.find(x => x.id === action.dataset.styleSelectId)); }));
  page.querySelectorAll("[data-style-tag]").forEach(chip => chip.addEventListener("click", () => {
    const s = APP.styleLibrary; if (!s.draft) return;
    const tag = chip.dataset.styleTag;
    if (tag.startsWith("__facet-")) {
      const facet = tag.slice(8, -2);
      if (expandedFacets.has(facet)) expandedFacets.delete(facet); else expandedFacets.add(facet);
      APP.render(); return;
    }
    const idx = s.draft.tags.indexOf(tag);
    if (idx >= 0) s.draft.tags.splice(idx, 1); else s.draft.tags.push(tag);
    dirtyFromDraft(); APP.render();
  }));
  for (const k of ["name","description","voice"]) page.querySelector(`#stylib-${k}`)?.addEventListener("input", () => { s.draft[k] = document.getElementById(`stylib-${k}`).value; dirtyFromDraft(); page.querySelector("#stylib-save").disabled = !needsSave(s); page.querySelector("#stylib-cancel").disabled = !s.dirty; });
  page.querySelector("#stylib-close")?.addEventListener("click", async () => { if (!s.dirty || await confirmDialog({ title: "Discard unsaved changes?", body: "Your unsaved edits will be lost.", confirmLabel: "discard", danger: true })) { s.selected = null; s.draft = null; s.dirty = false; APP.render(); } });
  page.querySelector("#stylib-save")?.addEventListener("click", save); page.querySelector("#stylib-cancel")?.addEventListener("click", () => { s.draft = draftOf(s.selected); s.dirty = false; APP.render(); });
  page.querySelector("#stylib-duplicate")?.addEventListener("click", duplicate); page.querySelector("#stylib-toggle-hidden")?.addEventListener("click", toggleHidden); page.querySelector("#stylib-delete")?.addEventListener("click", remove);
  page.querySelector("#stylib-ai-open")?.addEventListener("click", () => { s.assistant.open = true; APP.render(); }); page.querySelector("#stylib-ai-tab")?.addEventListener("click", () => { s.assistant.open = true; APP.render(); });
  page.querySelector("#stylib-ai-close")?.addEventListener("click", () => { s.assistant.open = false; APP.render(); }); page.querySelector("#stylib-ai-cancel")?.addEventListener("click", () => { s.assistant.open = false; s.assistant.proposal = null; APP.render(); });
  page.querySelector("#stylib-ai-submit")?.addEventListener("click", assistant); page.querySelector("#stylib-ai-apply")?.addEventListener("click", applyProposal);
}
