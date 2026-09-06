import { APP, FACET_LABELS } from "./state.js";
import { esc, tid, postJson, reasonOr, parseCommaSeparated } from "./util.js";
import { button, errorLine, hint, thinking, warnLine } from "./ui.js";
import { loadVocab, refreshUsage } from "./catalog.js";

// An origin is a named GROUP of general skills a kind of being starts with; a special skill is one
// a character can be given by name. Both live in this one catalog (kind: "special" | "origin"),
// so the editor carries both shapes: kind, and the origin's general list (always sent empty for a
// special skill, which is what the catalog's own validation demands).
const emptyDraft = () => ({ id:"", name:"", meaning:"", tags:"", kind:"special", general:[] });
const draftOf = k => ({ id:k?.id || "", name:k?.name || "", meaning:k?.meaning || "", tags:(k?.tags || []).join(", "),
                        kind:k?.kind === "origin" ? "origin" : "special", general:[...(k?.general || [])] });
const entryOf = d => ({ id:d.id, name:d.name.trim(), meaning:d.meaning.trim(), tags:parseCommaSeparated(d.tags),
                        kind:d.kind === "origin" ? "origin" : "special",
                        general:d.kind === "origin"
                          ? [...new Set((d.general || []).map(g => String(g).trim()).filter(Boolean))]
                          : [] });
const clone = value => JSON.parse(JSON.stringify(value));
const newId = () => `skl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

const folded = s => String(s ?? "").trim().toLowerCase();
function usageLine(name) {
  const n = APP.catalog.usage?.skills?.[folded(name)] ?? 0;
  return n ? `<i>used by ${n} character${n === 1 ? "" : "s"}</i>` : "";
}

/** The general skills an origin grants, as one display line. Names only — the meanings live in the
 *  picker's tooltips, and a coverage line that spelled them all out would outgrow the row. */
const coverageLine = k => (k.general || []).length ? (k.general || []).join(", ") : "";

function visibleEntries() {
  const s = APP.skillLibrary;
  const q = s.search.trim().toLowerCase();
  // Origins are findable by what they grant: a covered skill's name should surface the origin
  // that carries it, not just its own name and meaning.
  const filtered = s.entries.filter(k =>
    !q || `${k.name} ${k.meaning} ${(k.general || []).join(" ")}`.toLowerCase().includes(q));
  return filtered.sort((a, b) => s.sort === "name"
    ? String(a.name).localeCompare(String(b.name))
    : (Number(b.updatedAt || b.version || 0) - Number(a.updatedAt || a.version || 0)));
}

function dirtyFromDraft() {
  const s = APP.skillLibrary;
  s.dirty = !!s.selected && JSON.stringify(entryOf(s.draft)) !== JSON.stringify(entryOf(draftOf(s.selected)));
}

// Same reasoning as character/style/tag: a fresh or duplicated skill is never dirty on its own
// (the draft is derived from the object it's diffed against) but has never been persisted either.
const needsSave = s => s.dirty || (!!s.selected && !s.selected.version);

/** The tag chip picker, shared shape with the old generic catalog form: vocabulary grouped by
 *  facet, plus an off-vocabulary group for a tag this skill already carries that the vocabulary
 *  does not know. */
function tagPickerHtml(d) {
  const vocab = APP.catalog.vocab || [];
  const byFacet = Object.fromEntries(APP.catalogConfig.tagFacets.map(f => [f, []]));
  for (const t of vocab) if (Object.prototype.hasOwnProperty.call(byFacet, t.facet)) byFacet[t.facet].push(t);
  const current = new Set(parseCommaSeparated(d.tags));

  let html = `<div class="lib-tags-picker">`;
  for (const [facet, tags] of Object.entries(byFacet)) {
    if (!tags.length) continue;
    html += `<div class="lib-tags-group"><div class="lib-facet-heading">${esc(FACET_LABELS[facet] ?? facet)}</div><div class="lib-tags-row">`;
    for (const t of tags) html += `<button class="lib-pick${current.has(t.label) ? " on" : ""}" data-tag-label="${esc(t.label)}" type="button">${esc(t.label)}</button>`;
    html += `</div></div>`;
  }
  const vocabLabels = new Set(vocab.map(t => t.label));
  const offVocab = [...current].filter(t => !vocabLabels.has(t));
  if (offVocab.length) {
    html += `<div class="lib-tags-group"><div class="lib-facet-heading">Off-vocabulary</div><div class="lib-tags-row">`;
    for (const label of offVocab) html += `<button class="lib-pick on off-vocab" data-tag-label="${esc(label)}" type="button" title="This tag is not in the vocabulary">${esc(label)}</button>`;
    html += `</div><p class="lib-tags-notice">Kept when you save, though the vocabulary does not carry it.</p></div>`;
  }
  html += `</div>`;
  return html;
}

// The list is two sections, special skills then origins, each sorted the way the toolbar asks.
// With a search on, a section with no matches drops out rather than showing an empty heading.
function listHtml() {
  const s = APP.skillLibrary;
  const entries = visibleEntries();
  if (!s.entries.length) {
    return `<div class="lib-empty"><div class="lib-empty-mark">◇</div><h3>Your skill catalog is empty</h3><p>Define the special skills a story can draw on by name, and the origins that group general skills.</p>${button({label:"New skill", id:"skilllib-empty-new", variant:"primary"})}</div>`;
  }
  if (!entries.length) {
    return `<div class="lib-empty"><div class="lib-empty-mark">◇</div><h3>No skills match</h3><p>Try a different search.</p></div>`;
  }
  const row = k => {
    const selected = s.selected?.id === k.id;
    const origin = k.kind === "origin";
    const coverage = origin ? coverageLine(k) : "";
    return `<div class="lib-row${selected ? " selected" : ""}" data-skill-id="${esc(k.id)}" role="button" tabindex="0" ${tid("skill-library.row")}>
      <span class="lib-row-copy"><strong>${esc(k.name || "Untitled skill")}</strong><span>${esc(origin ? (coverage ? `grants ${coverage}` : "grants no general skills yet") : (k.meaning || "Describe what this skill lets a character do."))}</span></span>
      ${origin ? `<i class="lib-kind-badge" ${tid("skill-library.kind-badge")}>Origin</i>` : ""}
      <button class="lib-more" data-skill-select-id="${esc(k.id)}" aria-label="Open ${esc(k.name)} in editor">•••</button>
    </div>`;
  };
  const section = (title, kind) => {
    const group = entries.filter(k => (k.kind === "origin" ? "origin" : "special") === kind);
    if (!group.length) return "";
    return `<div class="lib-tags-group"><div class="lib-facet-heading">${esc(title)}</div>${group.map(row).join("")}</div>`;
  };
  return section("Special skills", "special")
       + section("Origins", "origin");
}

// The kind toggle: two pills acting as one radio group. Switching never destroys the draft's
// general list — it is only *sent* for an origin (entryOf) — so a special→origin→special round
// trip on an unsaved draft loses nothing and still shows as dirty the moment it would save
// differently.
function kindPickerHtml(d) {
  const pill = (value, label, testid) =>
    `<button class="lib-chip${(d.kind === "origin") === (value === "origin") ? " on" : ""}"
       data-skill-kind="${value}" type="button" ${tid(testid)} role="radio"
       aria-checked="${d.kind === value}">${esc(label)}</button>`;
  return `<div class="lib-chips" role="radiogroup" aria-label="Skill kind">${pill("special", "Special skill", "skill-library.kind-special")}${pill("origin", "Origin", "skill-library.kind-origin")}</div>`;
}

// The general-skill universe an origin grants from — every SKILL_CATALOG entry, name → meaning,
// from /catalog/config. A chosen name the vocabulary does not know (an externally-authored catalog,
// a spelling variant) is shown as off-list but kept, exactly like the tag picker's off-vocabulary
// group, because silently dropping a persisted grant would change what characters of that kind
// start with.
function generalPickerHtml(d) {
  const skills = APP.catalogConfig.generalSkills || {};
  const names = Object.keys(skills);
  const chosen = new Set(d.general || []);
  if (!names.length) return `<p class="hint">The general-skill catalog has not loaded yet — reopen this skill in a moment.</p>`;
  let html = `<div class="lib-tags-picker">`;
  html += `<div class="lib-tags-group"><div class="lib-facet-heading">General skills</div><div class="lib-tags-row">`;
  for (const name of names) {
    html += `<button class="lib-pick${chosen.has(name) ? " on" : ""}" data-general-skill="${esc(name)}" type="button" title="${esc(skills[name] || "")}">${esc(name)}</button>`;
  }
  html += `</div></div>`;
  const offList = [...chosen].filter(n => !Object.prototype.hasOwnProperty.call(skills, n));
  if (offList.length) {
    html += `<div class="lib-tags-group"><div class="lib-facet-heading">Off-list</div><div class="lib-tags-row">`;
    for (const name of offList) html += `<button class="lib-pick on off-vocab" data-general-skill="${esc(name)}" type="button" title="This skill is not in the general catalog">${esc(name)}</button>`;
    html += `</div><p class="lib-tags-notice">Kept when you save, though the general catalog does not carry it.</p></div>`;
  }
  html += `</div>`;
  return html;
}

function editorHtml() {
  const s = APP.skillLibrary;
  const d = s.draft;
  if (!d) return `<div class="lib-inspector-empty"><span>Select a skill to edit</span><small>Or define a new one.</small></div>`;
  const c = s.selected;
  const origin = d.kind === "origin";
  const total = Object.keys(APP.catalogConfig.generalSkills || {}).length;
  const coverage = origin
    ? `<p class="hint">Grants ${d.general.length} of ${total} general skill${total === 1 ? "" : "s"} — a character of this kind starts with exactly these.</p>`
    : "";
  return `<div class="lib-editor-head">
    <span class="lib-avatar">${esc((d.name || "?").slice(0, 2).toUpperCase())}</span><div><strong>${esc(d.name || "Untitled skill")}</strong><small>ID: ${esc(d.id || "not saved")}</small></div>
    <button class="lib-close" id="skilllib-close" aria-label="Close skill editor">×</button>
  </div>
  <div class="lib-actions">
    ${button({label:"Duplicate", id:"skilllib-duplicate", extraClass:"small"})}
    ${button({label:"Delete", id:"skilllib-delete", variant:"danger", extraClass:"small"})}
  </div>
  ${s.error ? errorLine(esc(s.error)) : ""}${s.dirty ? warnLine("unsaved changes") : ""}
  <div class="lib-section"><h3>Skill identity</h3>
    <p>${origin
      ? "An origin is a kind of being: the general skills below are what a character of this kind starts with."
      : "The canonical name and meaning a story writes when it grants this skill."}</p>
    ${kindPickerHtml(d)}
    <label class="lib-field"><span>Name</span><input class="lib-input" id="skilllib-name" value="${esc(d.name)}" placeholder="The canonical spelling a story writes"></label>
    <label class="lib-field"><span>Meaning</span><textarea class="lib-input lib-textarea" id="skilllib-meaning" rows="3" placeholder="${origin ? "What kind of being this is" : "What the skill lets a character do"}">${esc(d.meaning)}</textarea></label>
  </div>
  ${origin ? `<div class="lib-section" id="skilllib-general-section"><h3>General skills</h3><p>What a character of this kind starts with. A story can still add or take away per character.</p>${coverage}${generalPickerHtml(d)}</div>` : ""}
  <div class="lib-section"><h3>Tags</h3><p>Reusable descriptors, drawn from the tag vocabulary.</p>${tagPickerHtml(d)}</div>
  ${c ? `<div class="lib-section"><h3>Usage</h3><p>What actually carries this ${origin ? "origin" : "skill"} today.</p>${usageLine(d.name) || hint("no character carries it yet")}</div>` : ""}
  <div class="lib-editor-footer">${button({label:"Cancel", id:"skilllib-cancel", disabled:!s.dirty})}${button({label:"Save changes", id:"skilllib-save", variant:"primary", disabled:!needsSave(s)})}</div>`;
}

export function skillLibraryHtml() {
  const s = APP.skillLibrary;
  if (s.loading) return `<section class="lib-page lib-skills"><div class="lib-loading">${thinking("loading skill bible…")}</div></section>`;
  if (s.error && !s.entries.length) return `<section class="lib-page lib-skills"><div class="lib-loading">${errorLine(esc(s.error))}${button({label:"Try again", id:"skilllib-retry", variant:"primary"})}</div></section>`;
  return `<section class="lib-page lib-skills" ${tid("skill-library.page")}><div class="lib-main">
    <header class="lib-top"><div><h1>Skill Bible <span class="lib-info">i</span></h1><p>The special skills a story can draw on by name, and the origins that group general skills.</p></div><div class="lib-top-actions">${button({label:"＋ New skill", id:"skilllib-new", variant:"primary"})}</div></header>
    <div class="lib-toolbar"><input class="lib-input" id="skilllib-search" placeholder="⌕  Search skills and origins…" value="${esc(s.search)}"><select class="lib-input" id="skilllib-sort"><option value="updated"${s.sort === "updated" ? " selected" : ""}>Recently updated</option><option value="name"${s.sort === "name" ? " selected" : ""}>Name A–Z</option></select></div>
    <div class="lib-list">${listHtml()}</div><footer class="lib-list-footer">Showing ${visibleEntries().length} of ${s.entries.length} skills and origins</footer>
  </div><aside class="lib-inspector">${editorHtml()}</aside></section>`;
}

async function load() {
  const s = APP.skillLibrary;
  if (s.loading || s.loaded) return;
  s.loading = true; s.error = ""; APP.render();
  try {
    const j = await (await fetch("/catalog?kind=skills")).json();
    if (!j.ok) throw new Error(reasonOr(j, "could not load skills"));
    s.entries = (j.entries || []).map(k => ({ ...k, updatedAt:k.updatedAt || k.version || 0 }));
    s.loaded = true;
    loadVocab();
    refreshUsage();
  } catch (e) { s.error = e.message || "could not load skills"; }
  s.loading = false; APP.render();
}

function setSelected(k) { const s = APP.skillLibrary; s.selected = k; s.draft = draftOf(k); s.dirty = false; s.error = ""; APP.render(); }
function createNew() { const s = APP.skillLibrary; const k = { ...entryOf({...emptyDraft(), id:newId(), name:"New skill"}), version:0, updatedAt:Date.now() }; s.entries.unshift(k); setSelected(k); }
function duplicate() { const s = APP.skillLibrary; if (!s.selected) return; const k = { ...clone(s.selected), id:newId(), name:`${s.selected.name} Copy`, version:0, updatedAt:Date.now() }; s.entries.splice(s.entries.indexOf(s.selected) + 1, 0, k); setSelected(k); }
function collectDraft() { const s = APP.skillLibrary; if (!s.draft) return; for (const key of ["name","meaning","tags"]) { const el = document.getElementById(`skilllib-${key}`); if (el) s.draft[key] = el.value; } dirtyFromDraft(); }

async function save() {
  const s = APP.skillLibrary; collectDraft(); if (!s.draft || !needsSave(s)) return;
  const payload = entryOf(s.draft);
  if (!payload.name) { s.error = "A skill needs a name."; APP.render(); return; }
  if (!payload.meaning) { s.error = "A skill needs a meaning."; APP.render(); return; }
  const j = await postJson("/catalog/save", { kind:"skills", entry:payload }, msg => { s.error = msg; APP.render(); });
  if (!j?.ok) { s.error = reasonOr(j, "could not save skill"); APP.render(); return; }
  const next = { ...j.entry, updatedAt:Date.now() };
  const idx = s.entries.findIndex(k => k.id === next.id); if (idx >= 0) s.entries[idx] = next; else s.entries.unshift(next);
  refreshUsage();
  setSelected(next);
}

async function remove() {
  const s = APP.skillLibrary; if (!s.selected) return;
  if (!confirm("Permanently delete this skill? This cannot be undone.")) return;
  const id = s.selected.id;
  const j = await postJson("/catalog/delete", { kind:"skills", id }, msg => { s.error = msg; APP.render(); });
  if (!j?.ok) { s.error = reasonOr(j, "could not delete skill"); APP.render(); return; }
  s.entries = s.entries.filter(k => k.id !== id); s.selected = null; s.draft = null; s.dirty = false; s.error = "";
  refreshUsage();
  APP.render();
}

export async function loadSkillLibrary() { await load(); }

export function wireSkillLibrary(page) {
  const s = APP.skillLibrary;
  page.querySelector("#skilllib-search")?.addEventListener("input", e => { s.search = e.target.value; APP.render(); });
  page.querySelector("#skilllib-sort")?.addEventListener("change", e => { s.sort = e.target.value; APP.render(); });
  page.querySelector("#skilllib-new")?.addEventListener("click", createNew);
  page.querySelector("#skilllib-empty-new")?.addEventListener("click", createNew);
  page.querySelector("#skilllib-retry")?.addEventListener("click", () => { s.loaded = false; load(); });
  page.querySelectorAll("[data-skill-id]").forEach(row => row.addEventListener("click", e => { if (e.target.closest("button")) return; collectDraft(); if (s.dirty && !confirm("Discard unsaved changes?")) return; setSelected(s.entries.find(k => k.id === row.dataset.skillId)); }));
  page.querySelectorAll("[data-skill-select-id]").forEach(action => action.addEventListener("click", e => {
    e.stopPropagation(); collectDraft(); if (s.dirty && !confirm("Discard unsaved changes?")) return;
    setSelected(s.entries.find(k => k.id === action.dataset.skillSelectId));
  }));
  for (const key of ["name","meaning"]) page.querySelector(`#skilllib-${key}`)?.addEventListener("input", () => { s.draft[key] = document.getElementById(`skilllib-${key}`).value; dirtyFromDraft(); page.querySelector("#skilllib-save").disabled = !needsSave(s); page.querySelector("#skilllib-cancel").disabled = !s.dirty; });
  // Kind pills and general-skill chips mutate the draft and re-render (like the tag chips), so the
  // save/cancel buttons and the coverage line recompute from the same draft the render drew from.
  page.querySelectorAll("[data-skill-kind]").forEach(pill => pill.addEventListener("click", () => {
    if (!s.draft) return;
    const kind = pill.getAttribute("data-skill-kind");
    if (!kind || s.draft.kind === kind) return;
    s.draft.kind = kind; dirtyFromDraft(); APP.render();
  }));
  page.querySelectorAll("[data-general-skill]").forEach(chip => chip.addEventListener("click", () => {
    if (!s.draft) return;
    const name = chip.getAttribute("data-general-skill"); if (!name) return;
    const general = s.draft.general || (s.draft.general = []);
    const idx = general.indexOf(name);
    if (idx >= 0) general.splice(idx, 1); else general.push(name);
    dirtyFromDraft(); APP.render();
  }));
  page.querySelectorAll(".lib-pick[data-tag-label]").forEach(chip => chip.addEventListener("click", () => {
    if (!s.draft) return;
    const label = chip.getAttribute("data-tag-label"); if (!label) return;
    const tags = parseCommaSeparated(s.draft.tags);
    const idx = tags.findIndex(t => t === label);
    if (idx >= 0) tags.splice(idx, 1); else tags.push(label);
    s.draft.tags = tags.join(", "); dirtyFromDraft(); APP.render();
  }));
  page.querySelector("#skilllib-close")?.addEventListener("click", () => { if (!s.dirty || confirm("Discard unsaved changes?")) { s.selected = null; s.draft = null; s.dirty = false; APP.render(); } });
  page.querySelector("#skilllib-save")?.addEventListener("click", save);
  page.querySelector("#skilllib-cancel")?.addEventListener("click", () => { s.draft = draftOf(s.selected); s.dirty = false; APP.render(); });
  page.querySelector("#skilllib-duplicate")?.addEventListener("click", duplicate);
  page.querySelector("#skilllib-delete")?.addEventListener("click", remove);
}
