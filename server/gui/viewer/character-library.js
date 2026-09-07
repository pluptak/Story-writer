import { APP } from "./state.js";
import { esc, tid, parseLines, postJson, reasonOr } from "./util.js";
import { button, errorLine, hint, thinking, warnLine, confirmDialog } from "./ui.js";
import { loadLibrary } from "./catalog.js";

// The scaffold's import picker reads the same library through a lazy cache. A write here has to drop
// it, or the tray keeps offering a character this page has already changed or deleted.
const invalidateLibrary = loadLibrary.invalidate;

const emptyDraft = () => ({
  id:"", name:"", portablePersona:"", belief:"", impulse:"", voice:"", origin:"", skills:"", restrictions:"",
});

const draftOf = c => ({
  id:c?.id || "", name:c?.name || "", portablePersona:c?.portablePersona || "",
  belief:c?.belief || "", impulse:c?.impulse || "", voice:(c?.voice || []).join("\n"),
  origin:c?.origin || "", skills:(c?.skills || []).join("\n"), restrictions:(c?.restrictions || []).join("\n"),
});

const entryOf = d => ({
  id:d.id, name:d.name.trim(), portablePersona:d.portablePersona.trim(), belief:d.belief.trim(),
  impulse:d.impulse.trim(), voice:parseLines(d.voice).slice(0, 3), origin:d.origin.trim(),
  skills:parseLines(d.skills), restrictions:parseLines(d.restrictions),
});

const clone = value => JSON.parse(JSON.stringify(value));
const initials = name => String(name || "?").split(/\s+/).filter(Boolean).map(x => x[0]).join("").slice(0, 2).toUpperCase();
const excerpt = value => String(value || "Start with a short, portable identity.").replace(/\s+/g, " ").trim().slice(0, 100);
const newId = () => `chr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

// The fields a temporary revision can name -- content only, never id/version/hidden/updatedAt.
// The assistant's own diff (below) shares this list and these labels, so the two look like one
// mechanism to the reader even though only this one is a real change history.
const DIFF_FIELDS = ["name", "portablePersona", "belief", "impulse", "voice", "origin", "skills", "restrictions"];
const FIELD_LABELS = {
  name:"Name", portablePersona:"Portable persona", belief:"Belief", impulse:"Impulse",
  voice:"Voice samples", origin:"Origin", skills:"Skills", restrictions:"Restrictions",
};
// A field's DOM id suffix, where it differs from its own key -- portablePersona's control is
// #charlib-persona (predates this file's other ids). Every reader of a #charlib-<field> id goes
// through this so the two names never have to be kept in sync by hand a second time.
const FIELD_DOM_ID = key => key === "portablePersona" ? "persona" : key;

// Arrays (voice/skills/restrictions) render and compare as one line-per-entry block -- the same
// shape the textarea holds them in -- so a change is never reported for formatting entryOf() would
// have normalized away anyway (a trailing blank line, inconsistent spacing).
const displayValue = v => Array.isArray(v) ? v.join("\n") : v;

/** What changed between the persisted baseline and the current draft, field by field. Both sides
 *  go through entryOf(draftOf(...)) so the comparison is apples to apples -- a baseline is a
 *  catalog entry shape, a draft is the editor's text-field shape, and normalizing both the same way
 *  is what keeps a UI-only formatting difference from reading as a content change. */
function diffDraft(baseline, draft) {
  if (!baseline || !draft) return [];
  const before = entryOf(draftOf(baseline));
  const after = entryOf(draft);
  const changes = [];
  for (const key of DIFF_FIELDS) {
    const b = displayValue(before[key]), a = displayValue(after[key]);
    if (b !== a) changes.push({ field:key, label:FIELD_LABELS[key], before:b, after:a });
  }
  return changes;
}

const byVisibility = (entries, visibility) => visibility === "visible" ? entries.filter(c => !c.hidden)
  : visibility === "hidden" ? entries.filter(c => c.hidden) : entries;

// Every field the plan lists as searchable, normalized the same way regardless of shape: arrays
// join into the same lowercase blob a plain string field contributes to.
const searchBlob = c => [c.name, c.portablePersona, c.belief, c.impulse, ...(c.voice || []),
  c.origin, ...(c.skills || []), ...(c.restrictions || [])].join(" \n ").toLowerCase();

const bySearch = (entries, query) => {
  const q = query.trim().toLowerCase();
  return q ? entries.filter(c => searchBlob(c).includes(q)) : entries;
};

const byName = (a, b) => String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id));

// Non-mutating: .sort() runs on the array bySearch/byVisibility already produced fresh, never on
// s.entries itself.
function sortEntries(entries, sort) {
  const arr = [...entries];
  if (sort === "name-asc") return arr.sort(byName);
  if (sort === "name-desc") return arr.sort((a, b) => -byName(a, b));
  if (sort === "version") return arr.sort((a, b) =>
    (Number(b.version || 0) - Number(a.version || 0)) || (Number(b.updatedAt || 0) - Number(a.updatedAt || 0)) || byName(a, b));
  // "updated", and the fallback for anything unrecognized.
  return arr.sort((a, b) => (Number(b.updatedAt || b.version || 0) - Number(a.updatedAt || a.version || 0)) || byName(a, b));
}

/** Steps 1-3 of the pipeline: visibility, then search, then sort. Pagination (steps 4-6) is kept
 *  separate in paginate() below, because the footer and the pager need the FILTERED total (for
 *  "Showing 11-20 of 42") as well as the one page slice the list itself renders. */
function filteredSorted() {
  const s = APP.characterLibrary;
  return sortEntries(bySearch(byVisibility(s.entries, s.visibility), s.search), s.sort);
}

/** Steps 4-6: page count, clamp, slice. Clamping writes s.page back -- a filter that shrinks the
 *  result out from under the current page (or a page-size change) must not strand it past the end. */
function paginate(entries) {
  const s = APP.characterLibrary;
  const pageCount = Math.max(1, Math.ceil(entries.length / s.pageSize));
  s.page = Math.min(Math.max(1, s.page), pageCount);
  const start = (s.page - 1) * s.pageSize;
  return { slice: entries.slice(start, start + s.pageSize), pageCount, total: entries.length, start };
}

// After a save/hide/restore/duplicate/create, jump to whatever page the selected entry now falls
// on -- a sort key it just changed (updatedAt, version) or a page-size change can move it off the
// page the user was looking at. Does nothing if the selection itself was filtered out (e.g. it
// just became hidden and the visibility filter is "visible").
function ensureSelectedVisible() {
  const s = APP.characterLibrary; if (!s.selected) return;
  const idx = filteredSorted().findIndex(c => c.id === s.selected.id);
  if (idx >= 0) s.page = Math.floor(idx / s.pageSize) + 1;
}

// The single place that recomputes both dirty and the change list -- dirty is just "changes is
// non-empty", so keeping one comparison rather than two is what stops them from ever disagreeing.
// Closes the review panel the moment nothing is left to review (a revert or a cancel can empty it).
function dirtyFromDraft() {
  const s = APP.characterLibrary;
  s.changes = diffDraft(s.baseline, s.draft);
  s.dirty = s.changes.length > 0;
  if (!s.changes.length) s.changesOpen = false;
}

// A freshly created or duplicated character is never dirty -- its draft is derived from the very
// object it is compared against -- but it also has never been persisted (version 0, set by
// createNew()/duplicate()). Gate Save on either: an edit, or nothing to lose by pressing it.
const needsSave = s => s.dirty || (!!s.selected && !s.selected.version);

function field(id, label, value, type = "textarea", hintText = "") {
  const control = type === "input"
    ? `<input class="lib-input" id="${id}" value="${esc(value)}">`
    : `<textarea class="lib-input lib-textarea" id="${id}" rows="${id.includes("voice") ? 4 : 3}">${esc(value)}</textarea>`;
  return `<label class="lib-field"><span>${label}</span>${control}${hintText ? `<small>${hintText}</small>` : ""}</label>`;
}

// The origin input suggests the catalog's own origins (from /catalog/config) but accepts anything —
// an unknown name still reaches the story, where the engine warns and falls back to all general
// skills, so the editor must not silently rewrite what the author typed.
function originField(d) {
  const known = Object.keys(APP.catalogConfig.originSkills || {});
  const options = known.map(o => `<option value="${esc(o)}"></option>`).join("");
  return `<label class="lib-field"><span>Origin</span>
    <input class="lib-input" id="charlib-origin" list="charlib-origin-options" value="${esc(d.origin)}" placeholder="blank = every general skill">
    <datalist id="charlib-origin-options">${options}</datalist>
    <small>Blank means every general skill. A known origin starts the character from that kind's own group.</small>
  </label>`;
}

function listHtml(pageEntries) {
  const s = APP.characterLibrary;
  if (!pageEntries.length) {
    const filtering = s.search.trim() || s.visibility !== "all";
    return `<div class="lib-empty"><div class="lib-empty-mark">⁂</div><h3>${filtering ? "No characters match" : "Your library is empty"}</h3><p>${filtering ? "Try a different search or filter." : "Create a reusable character identity to bring into any story."}</p>${button({label:"New character", id:"charlib-empty-new", variant:"primary"})}</div>`;
  }
  return pageEntries.map(c => {
    const selected = s.selected?.id === c.id;
    const skillCount = (c.skills || []).length;
    const voiceCount = (c.voice || []).length;
    return `<div class="lib-row${selected ? " selected" : ""}${c.hidden ? " hidden-row" : ""}" data-char-id="${esc(c.id)}" role="button" tabindex="0" ${tid("character-library.row")}>
      <span class="lib-avatar">${esc(initials(c.name))}</span>
      <span class="lib-row-copy"><strong>${esc(c.name || "Untitled character")}</strong><span>${esc(excerpt(c.portablePersona))}</span>
        <span class="lib-chips">${c.hidden ? `<i class="lib-hidden-badge" ${tid("character-library.hidden-badge")}>Hidden</i>` : ""}${c.origin ? `<i ${tid("character-library.origin-badge")}>${esc(c.origin)}</i>` : ""}<i>${skillCount} skill${skillCount === 1 ? "" : "s"}</i><i>${voiceCount} voice sample${voiceCount === 1 ? "" : "s"}</i></span></span>
      <button class="lib-more" data-char-select-id="${esc(c.id)}" aria-label="Open ${esc(c.name)} in editor">•••</button>
    </div>`;
  }).join("");
}

function editorHtml() {
  const s = APP.characterLibrary;
  const d = s.draft;
  if (!d) return `<div class="lib-inspector-empty"><span>Select a character to edit</span><small>Or create a new reusable identity.</small></div>`;
  const c = s.selected;
  const a = s.assistant;
  return `<div class="lib-editor-head">
    <span class="lib-avatar">${esc(initials(d.name))}</span><div><strong>${esc(d.name || "Untitled character")}</strong><small>ID: ${esc(d.id || "not saved")}${c?.hidden ? ` · <span class="lib-hidden-badge" ${tid("character-library.hidden-badge")}>Hidden</span>` : ""}</small></div>
    <button class="lib-close" id="charlib-close" aria-label="Close character editor">×</button>
  </div>
  <div class="lib-actions">
    ${button({label:"Duplicate", id:"charlib-duplicate", extraClass:"small"})}
    ${c?.version ? button({label:c.hidden ? "Restore character" : "Hide character", id:"charlib-toggle-hidden", extraClass:"small", disabled:s.togglingHiddenId === c?.id}) : ""}
    ${button({label:s.changes.length ? `Review changes (${s.changes.length})` : "Review changes", id:"charlib-review-changes", extraClass:"small", disabled:!s.changes.length})}
    ${button({label:"Delete", id:"charlib-delete", variant:"danger", extraClass:"small", disabled:s.deletingId === c?.id})}
  </div>
  <div class="lib-tabs"><button class="lib-tab active">Overview</button><button class="lib-tab" id="charlib-ai-tab">AI Assistant</button><button class="lib-tab" disabled>Revisions</button></div>
  ${s.error ? errorLine(esc(s.error)) : ""}${s.dirty ? warnLine("unsaved changes") : ""}
  <div class="lib-section"><h3>Essence</h3><p>Reusable character identity. Keep story-specific goals and knowledge out of the library.</p>
    ${field("charlib-name", "Name", d.name, "input")}
    ${field("charlib-persona", "Portable persona", d.portablePersona, "textarea", "The identity that travels between stories.")}
    ${field("charlib-belief", "Belief", d.belief)}
    ${field("charlib-impulse", "Impulse", d.impulse, "textarea", "What this character tends to do under pressure.")}
    ${field("charlib-voice", "Voice samples", d.voice, "textarea", "One line per sample, maximum 3.")}
  </div>
  <div class="lib-section"><h3>Capabilities</h3><p>Reusable capabilities, one per line. Skills may use <code>name :: meaning</code>.</p>
    ${originField(d)}
    ${field("charlib-skills", "Skills", d.skills)}${field("charlib-restrictions", "Restrictions", d.restrictions, "textarea", "One restriction per line.")}
  </div>
  <div class="lib-assistant"><div><strong>✦ Character assistant</strong></div><p>Create, revise, or review a subset of this character's fields from a plain-language instruction, on its own model.</p>${button({label:"Open AI assistant →", id:"charlib-ai-open", extraClass:"small"})}</div>
  <div class="lib-editor-footer">${button({label:"Cancel", id:"charlib-cancel", disabled:!s.dirty || s.saving})}${button({label:s.saving ? "Saving…" : "Save changes", id:"charlib-save", variant:"primary", disabled:!needsSave(s) || s.saving})}</div>
  ${a.open ? assistantHtml() : ""}${s.changesOpen ? changesHtml() : ""}`;
}

function changesHtml() {
  const changes = APP.characterLibrary.changes;
  return `<div class="lib-modal-backdrop"><section class="lib-modal" role="dialog" aria-modal="true" aria-label="Review unsaved changes">
    <div class="lib-modal-head"><div><h2>Unsaved changes</h2><p>What differs from the saved version. Nothing here is written until you save.</p></div><button class="lib-close" id="charlib-changes-close">×</button></div>
    ${changes.length ? changes.map(x => `<div class="lib-change" data-change-field="${esc(x.field)}">
      <div class="lib-change-label"><b>${esc(x.label)}</b><button class="btn small" data-revert-field="${esc(x.field)}" ${tid("character-library.revert-field")}>Revert field</button></div>
      <div><small>Before</small><del>${esc(x.before || "(empty)")}</del><small>After</small><em>${esc(x.after || "(empty)")}</em></div>
    </div>`).join("") : `<p>No changes to review.</p>`}
    <div class="lib-modal-actions">${button({label:"Close", id:"charlib-changes-done", variant:"primary"})}</div>
  </section></div>`;
}

// Reverting one field writes the baseline's own draft-shaped value back onto the live draft --
// nothing else in it moves, so the rest of the change list survives untouched.
function revertField(fieldKey) {
  const s = APP.characterLibrary; if (!s.baseline || !s.draft) return;
  s.draft[fieldKey] = draftOf(s.baseline)[fieldKey];
  dirtyFromDraft();
  APP.render();
}

// A mode's blurb, said once above the field picker -- what pressing "prepare proposal" actually
// asks for, since "revise" and "review" read very differently against the same field chips.
const ASSIST_MODE_HINT = {
  create: "Fills in the fields you pick, from your instruction.",
  revise: "Changes only the fields you pick, following your instruction.",
  review: "Reports what it finds in the fields you pick, and may propose a fix for one of them.",
};

function assistFieldChipsHtml(a) {
  return DIFF_FIELDS.map(f => `<button class="lib-chip${a.fields.includes(f) ? " on" : ""}"
    data-assist-field="${f}" type="button" ${a.loading ? "disabled" : ""} ${tid("character-library.assist-field")}>${esc(FIELD_LABELS[f])}</button>`).join("");
}

function assistProposalHtml(mode, changes, warnings) {
  const changesBlock = changes.length
    ? `<div class="lib-proposal"><strong>Proposed changes</strong>${changes.map(x => `<div class="lib-change" data-assist-change-field="${esc(x.field)}"><b>${esc(FIELD_LABELS[x.field] || x.field)}</b><div><small>Before</small><del>${esc(displayValue(x.before) || "(empty)")}</del><small>After</small><em>${esc(displayValue(x.after) || "(empty)")}</em></div></div>`).join("")}</div>`
    : `<p>${mode === "review" ? "No correction proposed — see the findings below." : "No fields changed. The instruction was preserved without guessing."}</p>`;
  const label = mode === "review" ? "Findings" : "Warnings";
  const warnBlock = warnings.length
    ? `<div class="lib-assist-warnings" ${tid("character-library.assist-warnings")}><strong>${label}</strong>${warnings.map(w => warnLine(esc(w))).join("")}</div>`
    : "";
  return `${changesBlock}${warnBlock}`;
}

function assistantHtml() {
  const a = APP.characterLibrary.assistant;
  const changes = a.proposal?.changes || [];
  const warnings = a.proposal?.warnings || [];
  return `<div class="lib-modal-backdrop"><section class="lib-modal" role="dialog" aria-modal="true" aria-label="Character assistant">
    <div class="lib-modal-head"><div><h2>Character assistant</h2><p>Proposes a change to the fields you pick, on its own model. Applying a proposal only fills the draft — Save changes still persists it.</p></div><button class="lib-close" id="charlib-ai-close" ${a.loading ? "disabled" : ""}>×</button></div>
    <div class="lib-mode">
      <button class="lib-tab${a.mode === "create" ? " active" : ""}" data-ai-mode="create" ${a.loading ? "disabled" : ""}>Create</button>
      <button class="lib-tab${a.mode === "revise" ? " active" : ""}" data-ai-mode="revise" ${a.loading ? "disabled" : ""}>Revise</button>
      <button class="lib-tab${a.mode === "review" ? " active" : ""}" data-ai-mode="review" ${a.loading ? "disabled" : ""}>Review</button>
    </div>
    <p class="hint">${ASSIST_MODE_HINT[a.mode]}</p>
    <label class="lib-field"><span>Fields</span><div class="lib-chips" ${tid("character-library.assist-fields")}>${assistFieldChipsHtml(a)}</div>${!a.fields.length ? `<small>Pick at least one field.</small>` : ""}</label>
    <label class="lib-field"><span>Instruction</span><textarea class="lib-input lib-textarea" id="charlib-ai-instruction" rows="4" placeholder="Make her more guarded, but keep her hopeful tone.">${esc(a.instruction)}</textarea></label>
    ${a.error ? errorLine(esc(a.error)) : ""}
    ${a.loading ? thinking("preparing proposal…") : a.proposal ? assistProposalHtml(a.mode, changes, warnings) : hint("Pick at least one field and describe what you want, then prepare a proposal.")}
    <div class="lib-modal-actions">${button({label:"Cancel", id:"charlib-ai-cancel", disabled:a.loading})}${a.proposal
      ? button({label:"Apply proposal", id:"charlib-ai-apply", variant:"primary", disabled:!changes.length})
      : button({label:"Prepare proposal", id:"charlib-ai-submit", variant:"primary", disabled:!a.fields.length || a.loading})}</div>
  </section></div>`;
}

function pagerHtml(pageCount) {
  const s = APP.characterLibrary;
  if (pageCount <= 1) return "";
  return `<div class="lib-pager">
    ${button({label:"‹ Prev", id:"charlib-page-prev", extraClass:"small", disabled:s.page <= 1})}
    <span>Page ${s.page} of ${pageCount}</span>
    ${button({label:"Next ›", id:"charlib-page-next", extraClass:"small", disabled:s.page >= pageCount})}
  </div>`;
}

export function characterLibraryHtml() {
  const s = APP.characterLibrary;
  if (s.loading) return `<section class="lib-page lib-characters"><div class="lib-loading">${thinking("loading character library…")}</div></section>`;
  if (s.error && !s.entries.length) return `<section class="lib-page lib-characters"><div class="lib-loading">${errorLine(esc(s.error))}${button({label:"Try again",id:"charlib-retry",variant:"primary"})}</div></section>`;
  const { slice, pageCount, total, start } = paginate(filteredSorted());
  const rangeText = total === 0 ? "Showing 0 characters" : `Showing ${start + 1}-${start + slice.length} of ${total} characters`;
  return `<section class="lib-page lib-characters" ${tid("character-library.page")}><div class="lib-main">
    <header class="lib-top"><div class="page-title"><p class="eyebrow">library · characters</p><h1>Character Library <span class="lib-info">i</span></h1><p class="lede">Reusable characters you can import into any story.</p></div><div class="lib-top-actions">${button({label:"＋ New character", id:"charlib-new", variant:"primary"})}</div></header>
    <div class="lib-toolbar"><input class="lib-input" id="charlib-search" placeholder="⌕  Search characters…" value="${esc(s.search)}">
      <select class="lib-input" id="charlib-visibility"><option value="all"${s.visibility === "all" ? " selected" : ""}>All characters</option><option value="visible"${s.visibility === "visible" ? " selected" : ""}>Visible only</option><option value="hidden"${s.visibility === "hidden" ? " selected" : ""}>Hidden only</option></select>
      <select class="lib-input" id="charlib-sort">
        <option value="updated"${s.sort === "updated" ? " selected" : ""}>Recently updated</option>
        <option value="name-asc"${s.sort === "name-asc" ? " selected" : ""}>Name A–Z</option>
        <option value="name-desc"${s.sort === "name-desc" ? " selected" : ""}>Name Z–A</option>
        <option value="version"${s.sort === "version" ? " selected" : ""}>Version</option>
      </select></div>
    <div class="lib-list">${listHtml(slice)}</div>
    <footer class="lib-list-footer">
      <span>${rangeText}</span>
      ${pagerHtml(pageCount)}
      <select class="lib-input" id="charlib-page-size">
        <option value="10"${s.pageSize === 10 ? " selected" : ""}>10 / page</option>
        <option value="25"${s.pageSize === 25 ? " selected" : ""}>25 / page</option>
        <option value="50"${s.pageSize === 50 ? " selected" : ""}>50 / page</option>
      </select>
    </footer>
  </div><aside class="lib-inspector">${editorHtml()}</aside></section>`;
}

async function load() {
  const s = APP.characterLibrary;
  if (s.loading || s.loaded) return;
  s.loading = true; s.error = ""; APP.render();
  try {
    // includeHidden=1: unlike every selectable-characters surface, the editor itself must see and
    // manage a hidden entry, not just the visible ones.
    const j = await (await fetch("/catalog?kind=characters&includeHidden=1")).json();
    if (!j.ok) throw new Error(reasonOr(j, "could not load characters"));
    s.entries = (j.entries || []).map(c => ({ ...c, hidden: !!c.hidden, updatedAt:c.updatedAt || c.version || 0 }));
    s.loaded = true;
  } catch (e) { s.error = e.message || "could not load characters"; }
  s.loading = false; APP.render();
}

// baseline is a fresh clone of whatever was just selected/created/duplicated/saved -- including a
// brand-new, never-persisted character, so its own initial draft is what a later edit diffs against
// (plan: "changes should show edits relative to the initial draft").
function setSelected(c) { const s = APP.characterLibrary; s.selected = c; s.baseline = clone(c); s.draft = draftOf(c); s.dirty = false; s.changes = []; s.changesOpen = false; s.menuId = ""; s.error = ""; s.assistant = { open:false, mode:"revise", fields:[], instruction:"", loading:false, proposal:null, error:"" }; ensureSelectedVisible(); APP.render(); }

function createNew() { const s = APP.characterLibrary; const c = { ...entryOf({...emptyDraft(), id:newId(), name:"New character"}), hidden:false, version:0, updatedAt:Date.now() }; s.entries.unshift(c); setSelected(c); }

function duplicate() { const s = APP.characterLibrary; if (!s.selected) return; const c = { ...clone(s.selected), id:newId(), name:`${s.selected.name} Copy`, version:0, updatedAt:Date.now(), hidden:false }; s.entries.splice(s.entries.indexOf(s.selected) + 1, 0, c); setSelected(c); }

function collectDraft() { const s = APP.characterLibrary; if (!s.draft) return; for (const key of DIFF_FIELDS) { const el = document.getElementById(`charlib-${FIELD_DOM_ID(key)}`); if (el) s.draft[key] = el.value; } dirtyFromDraft(); }

async function save() {
  const s = APP.characterLibrary; collectDraft(); if (!s.draft || !needsSave(s) || s.saving) return;
  const payload = entryOf(s.draft); if (!payload.name) { s.error = "A character needs a name."; APP.render(); return; }
  // savingId, not s.selected, is what the response is checked against below -- the user is free to
  // switch to a different character (or none) while this request is in flight, and the save must
  // still land in the list without touching whatever is now on screen.
  const savingId = payload.id;
  s.saving = true; APP.render();
  const j = await postJson("/catalog/save", { kind:"characters", entry:payload },
    msg => { if (s.selected?.id === savingId) s.error = msg; });
  s.saving = false;
  if (!j?.ok) {
    if (s.selected?.id === savingId) { s.error = reasonOr(j, "could not save character"); APP.render(); }
    return;
  }
  invalidateLibrary();
  // The server is authoritative for both fields: it preserves `hidden` across a content save and
  // stamps the real save time, so the saved entry is trusted as-is rather than re-derived here.
  const next = { ...j.entry, hidden: !!j.entry.hidden, updatedAt: j.entry.updatedAt || 0 };
  const idx = s.entries.findIndex(c => c.id === next.id); if (idx >= 0) s.entries[idx] = next; else s.entries.unshift(next);
  if (s.selected?.id === savingId) setSelected(next); else APP.render();
}

// Response-driven, not optimistic: the row and badge only flip once the server confirms the
// write. The draft is never touched -- hide/restore is not a content change. togglingHiddenId (not
// a bare boolean) is what the button below disables on -- a toggle pending for a character the user
// has since navigated away from must not freeze a different, unrelated character's own button.
async function toggleHidden() {
  const s = APP.characterLibrary; if (!s.selected || s.togglingHiddenId === s.selected.id) return;
  const id = s.selected.id, hidden = !s.selected.hidden;
  s.togglingHiddenId = id; s.error = ""; APP.render();
  const j = await postJson("/catalog/visibility", { kind:"characters", id, hidden },
    msg => { if (s.selected?.id === id) s.error = msg; });
  s.togglingHiddenId = "";
  if (!j?.ok) {
    if (s.selected?.id === id) { s.error = reasonOr(j, "could not change visibility"); APP.render(); }
    return;
  }
  invalidateLibrary();
  const idx = s.entries.findIndex(c => c.id === id);
  if (idx >= 0) s.entries[idx] = { ...s.entries[idx], hidden };
  if (s.selected?.id === id) s.selected = { ...s.selected, hidden };
  ensureSelectedVisible();
  APP.render();
}

// Permanent delete is the one lifecycle action whose route already exists, so it is response-driven
// rather than optimistic: the row goes only once the server says the entry is gone. Like the
// toggle above, the id this delete was for is what gates both the button (deletingId) and whether
// the response is allowed to clear the editor -- a delete finishing after the user has already
// moved on to a different character must remove the old row without closing the new one's editor.
async function remove() {
  const s = APP.characterLibrary; if (!s.selected || s.deletingId === s.selected.id) return;
  if (!await confirmDialog({ title: "Delete this character?",
    body: "This cannot be undone. For normal cleanup, use Hide instead.",
    confirmLabel: "delete character", danger: true })) return;
  const id = s.selected.id;
  s.deletingId = id; APP.render();
  const j = await postJson("/catalog/delete", { kind:"characters", id }, msg => { if (s.selected?.id === id) s.error = msg; });
  s.deletingId = "";
  if (!j?.ok) {
    if (s.selected?.id === id) { s.error = reasonOr(j, "could not delete character"); APP.render(); }
    return;
  }
  invalidateLibrary();
  s.entries = s.entries.filter(c => c.id !== id);
  if (s.selected?.id === id) { s.selected = null; s.draft = null; s.dirty = false; s.baseline = null; s.changes = []; s.changesOpen = false; s.error = ""; }
  APP.render();
}

// The server is authoritative for the proposal: it enforces field scope itself, so whatever it
// returns is drawn as-is -- this never recomputes a diff or trusts a field the author did not pick.
// reqSeq guards against the reply landing after the request it answers no longer owns the panel --
// mode/field pickers and the close controls are disabled while a.loading (see assistantHtml/
// assistFieldChipsHtml), so today that can only happen via a character switch, which replaces
// s.assistant outright and leaves this closure's `a` orphaned; the counter is kept anyway as the
// one thing standing between a slower-moving UI later and a proposal silently reappearing under
// a request nobody is waiting on.
async function assistant() {
  const s = APP.characterLibrary, a = s.assistant;
  if (!a.fields.length) { a.error = "Pick at least one field first."; APP.render(); return; }
  if (!a.instruction.trim()) { a.error = "Add an instruction first."; APP.render(); return; }
  const seq = (a.reqSeq = (a.reqSeq || 0) + 1);
  a.loading = true; a.error = ""; a.proposal = null; APP.render();
  const j = await postJson("/catalog/assist",
    { kind:"characters", mode:a.mode, fields:a.fields, instruction:a.instruction, character:entryOf(s.draft) },
    msg => { if (a.reqSeq === seq) a.error = msg; });
  if (a.reqSeq !== seq) return;
  a.loading = false;
  if (j?.ok && j.proposal) {
    a.proposal = j.proposal;
  } else {
    a.error = reasonOr(j, "the assistant could not prepare a proposal");
  }
  APP.render();
}

function applyProposal() { const s = APP.characterLibrary; if (!s.assistant.proposal) return; s.draft = draftOf(s.assistant.proposal.draft); dirtyFromDraft(); s.assistant.open = false; s.assistant.proposal = null; APP.render(); }

export async function loadCharacterLibrary() { await load(); }

export function wireCharacterLibrary(page) {
  const s = APP.characterLibrary;
  page.querySelector("#charlib-search")?.addEventListener("input", e => { s.search = e.target.value; s.page = 1; APP.render(); });
  page.querySelector("#charlib-sort")?.addEventListener("change", e => { s.sort = e.target.value; s.page = 1; APP.render(); });
  page.querySelector("#charlib-visibility")?.addEventListener("change", e => { s.visibility = e.target.value; s.page = 1; APP.render(); });
  page.querySelector("#charlib-page-size")?.addEventListener("change", e => { s.pageSize = Number(e.target.value) || 10; s.page = 1; APP.render(); });
  page.querySelector("#charlib-page-prev")?.addEventListener("click", () => { s.page = Math.max(1, s.page - 1); APP.render(); });
  page.querySelector("#charlib-page-next")?.addEventListener("click", () => { s.page = s.page + 1; APP.render(); });
  page.querySelector("#charlib-new")?.addEventListener("click", createNew);
  page.querySelector("#charlib-empty-new")?.addEventListener("click", createNew);
  page.querySelector("#charlib-retry")?.addEventListener("click", () => { s.loaded = false; load(); });
  page.querySelectorAll("[data-char-id]").forEach(row => row.addEventListener("click", async e => { if (e.target.closest("button")) return; collectDraft(); if (s.dirty && !await confirmDialog({ title: "Discard unsaved changes?", body: "Your unsaved edits will be lost.", confirmLabel: "discard", danger: true })) return; setSelected(s.entries.find(c => c.id === row.dataset.charId)); }));
  page.querySelectorAll("[data-char-select-id]").forEach(action => action.addEventListener("click", async e => {
    e.stopPropagation(); collectDraft(); if (s.dirty && !await confirmDialog({ title: "Discard unsaved changes?", body: "Your unsaved edits will be lost.", confirmLabel: "discard", danger: true })) return;
    setSelected(s.entries.find(c => c.id === action.dataset.charSelectId));
  }));
  for (const key of DIFF_FIELDS) page.querySelector(`#charlib-${FIELD_DOM_ID(key)}`)?.addEventListener("input", () => {
    s.draft[key] = document.getElementById(`charlib-${FIELD_DOM_ID(key)}`).value;
    dirtyFromDraft();
    page.querySelector("#charlib-save").disabled = !needsSave(s) || s.saving;
    page.querySelector("#charlib-cancel").disabled = !s.dirty || s.saving;
    const reviewBtn = page.querySelector("#charlib-review-changes");
    if (reviewBtn) {
      reviewBtn.disabled = !s.changes.length;
      reviewBtn.textContent = s.changes.length ? `Review changes (${s.changes.length})` : "Review changes";
    }
  });
  page.querySelector("#charlib-close")?.addEventListener("click", async () => { if (!s.dirty || await confirmDialog({ title: "Discard unsaved changes?", body: "Your unsaved edits will be lost.", confirmLabel: "discard", danger: true })) { s.selected = null; s.draft = null; s.dirty = false; s.baseline = null; s.changes = []; s.changesOpen = false; APP.render(); } });
  page.querySelector("#charlib-save")?.addEventListener("click", save);
  page.querySelector("#charlib-cancel")?.addEventListener("click", () => { s.draft = draftOf(s.selected); dirtyFromDraft(); APP.render(); });
  page.querySelector("#charlib-duplicate")?.addEventListener("click", duplicate);
  page.querySelector("#charlib-toggle-hidden")?.addEventListener("click", toggleHidden);
  page.querySelector("#charlib-review-changes")?.addEventListener("click", () => { s.changesOpen = true; APP.render(); });
  page.querySelector("#charlib-changes-close")?.addEventListener("click", () => { s.changesOpen = false; APP.render(); });
  page.querySelector("#charlib-changes-done")?.addEventListener("click", () => { s.changesOpen = false; APP.render(); });
  page.querySelectorAll("[data-revert-field]").forEach(btn => btn.addEventListener("click", () => revertField(btn.dataset.revertField)));
  page.querySelector("#charlib-delete")?.addEventListener("click", remove);
  page.querySelector("#charlib-ai-open")?.addEventListener("click", () => { s.assistant.open = true; APP.render(); });
  page.querySelector("#charlib-ai-tab")?.addEventListener("click", () => { s.assistant.open = true; APP.render(); });
  page.querySelector("#charlib-ai-close")?.addEventListener("click", () => { s.assistant.open = false; APP.render(); });
  page.querySelector("#charlib-ai-cancel")?.addEventListener("click", () => { s.assistant.open = false; s.assistant.proposal = null; APP.render(); });
  page.querySelector("#charlib-ai-submit")?.addEventListener("click", assistant);
  page.querySelector("#charlib-ai-apply")?.addEventListener("click", applyProposal);
  page.querySelectorAll("[data-ai-mode]").forEach(b => b.addEventListener("click", () => {
    s.assistant.mode = b.dataset.aiMode; s.assistant.proposal = null; s.assistant.error = ""; APP.render();
  }));
  page.querySelectorAll("[data-assist-field]").forEach(chip => chip.addEventListener("click", () => {
    const a = s.assistant, f = chip.dataset.assistField, at = a.fields.indexOf(f);
    if (at >= 0) a.fields.splice(at, 1); else a.fields.push(f);
    a.proposal = null; a.error = "";
    APP.render();
  }));
  // Not tied to dirtyFromDraft()/a full render, same reason the character fields above are not:
  // an unrelated re-render (a page-size change, another SSE-driven repaint) must not wipe out an
  // instruction the author is still typing.
  page.querySelector("#charlib-ai-instruction")?.addEventListener("input", e => { s.assistant.instruction = e.target.value; });
}
