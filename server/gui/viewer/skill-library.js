import { APP } from "./state.js";
import { esc, tid, postJson, reasonOr, glyphAvailable } from "./util.js";
import { button, errorLine, hint, thinking, warnLine, confirmDialog } from "./ui.js";
import { loadVocab, refreshUsage } from "./catalog.js";

// Three kinds share this one catalog. A GENERAL skill is one every character starts with; a
// SPECIAL skill is one a story gives a character by name; an ORIGIN is a named group of general
// skills a kind of being starts with. So the editor carries both shapes: kind, and the origin's
// general list (sent empty for the other two, which is what the catalog's own validation demands).
const KINDS = ["general", "special", "origin"];
const KIND_LABEL = { general:"General", special:"Special", origin:"Origin" };
// One glyph per kind, with the kind's own initial as the fallback when the browser has no glyph for
// it. The name is always in the title, so the icon is decoration that survives being missing — it
// is never the only thing saying which kind this is.
const KIND_GLYPH = { general:"◆", special:"✦", origin:"⚑" };
const kindMark = kind => (glyphAvailable(KIND_GLYPH[kind]) ? KIND_GLYPH[kind] : KIND_LABEL[kind][0]);
const kindOf = k => (KINDS.includes(k?.kind) ? k.kind : "special");
const emptyDraft = () => ({ id:"", name:"", meaning:"", kind:"special", general:[] });
const draftOf = k => ({ id:k?.id || "", name:k?.name || "", meaning:k?.meaning || "",
                        kind:kindOf(k), general:[...(k?.general || [])] });
const entryOf = d => ({ id:d.id, name:d.name.trim(), meaning:d.meaning.trim(),
                        kind:kindOf(d),
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

/** Both directions a skill can be in use: carried by a library character, and — for a general skill
 *  — granted by an origin, which is what makes it undeletable. */
function usageHtml(d) {
  const carried = usageLine(d.name);
  const granting = d.kind === "general" ? originsGranting(d.name) : [];
  const granted = granting.length
    ? `<i ${tid("skill-library.granted-by")}>granted by origin ${granting.map(esc).join(", ")}</i>` : "";
  const both = [carried, granted].filter(Boolean).join(" ");
  return both || hint(d.kind === "origin" ? "no character is of this kind yet" : "nothing carries it yet");
}

/** The general skills an origin grants, as one display line. Names only — the meanings live in the
 *  picker's tooltips, and a coverage line that spelled them all out would outgrow the row. */
const coverageLine = k => (k.general || []).length ? (k.general || []).join(", ") : "";

/** Which origins grant a general skill, by name. Read off the loaded entries rather than asked for:
 *  the list is already here, and the server refuses the delete anyway — this is so the author is
 *  told before they try, not instead of the check. */
const originsGranting = name => APP.skillLibrary.entries
  .filter(k => kindOf(k) === "origin" && (k.general || []).some(g => folded(g) === folded(name)))
  .map(k => k.name);

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

// The list is two sections, special skills then origins, each sorted the way the toolbar asks.
// With a search on, a section with no matches drops out rather than showing an empty heading.
function listHtml() {
  const s = APP.skillLibrary;
  const entries = visibleEntries();
  if (!s.entries.length) {
    return `<div class="lib-empty"><div class="lib-empty-mark">⁂</div><h3>Your skill catalog is empty</h3><p>Define the special skills a story can draw on by name, and the origins that group general skills.</p>${button({label:"New skill", id:"skilllib-empty-new", variant:"primary"})}</div>`;
  }
  if (!entries.length) {
    return `<div class="lib-empty"><div class="lib-empty-mark">⁂</div><h3>No skills match</h3><p>Try a different search.</p></div>`;
  }
  const row = k => {
    const selected = s.selected?.id === k.id;
    const kind = kindOf(k);
    const coverage = coverageLine(k);
    const line = kind === "origin"
      ? (coverage ? `starts with ${coverage}` : "starts with no general skills yet")
      : (k.meaning || "Describe what this skill lets a character do.");
    return `<div class="lib-row lib-row-${kind}${selected ? " selected" : ""}" data-skill-id="${esc(k.id)}" role="button" tabindex="0" ${tid("skill-library.row")}>
      <span class="lib-row-copy"><strong>${esc(k.name || "Untitled skill")}</strong><span>${esc(line)}</span></span>
      ${kind === "special" ? "" : `<i class="lib-kind-badge lib-kind-${kind}" title="${esc(KIND_LABEL[kind])} skill" ${tid("skill-library.kind-badge")}><span class="lib-kind-mark" aria-hidden="true">${esc(kindMark(kind))}</span>${kind === "origin" ? "Origin" : "General"}</i>`}
      <button class="lib-more" data-skill-select-id="${esc(k.id)}" aria-label="Open ${esc(k.name)} in editor">•••</button>
    </div>`;
  };
  // Three sections, each saying what its kind is for -- the three are easy to confuse, and the
  // difference decides what a character starts with. A section with no matches drops out under a
  // search rather than showing an empty heading.
  const section = (title, kind, copy) => {
    const group = entries.filter(k => kindOf(k) === kind);
    if (!group.length) return "";
    return `<div class="lib-tags-group" ${tid(`skill-library.section-${kind}`)}>
      <div class="lib-facet-heading">${esc(title)}</div>
      <p class="lib-section-copy">${esc(copy)}</p>
      ${group.map(row).join("")}</div>`;
  };
  return section("General skills", "general",
                 "What every character starts with, unless their origin narrows it or a restriction takes it away.")
       + section("Special skills", "special",
                 "Named skills a story gives a character one at a time.")
       + section("Origins", "origin",
                 "Groups of general skills a kind of being starts with: human, dwarf, elf, robot…");
}

// The kind toggle: pills acting as one radio group. Switching never destroys the draft's general
// list — it is only *sent* for an origin (entryOf) — so a special→origin→special round trip on an
// unsaved draft loses nothing and still shows as dirty the moment it would save differently.
//
// `general` is offered only while the entry has never been persisted. Turning a saved special skill
// into a general one would hand it to every character in every story at once, and turning a general
// one into a special skill would take it away from all of them — neither is an edit, it is a
// different entry. So the kind of a saved general is fixed, and the other two convert as before.
function kindPickerHtml(d, selected) {
  const saved = !!selected?.version;
  if (saved && d.kind === "general")
    return `<p class="hint" ${tid("skill-library.kind-fixed")}>Every character starts with this one, so it cannot become a special skill or an origin. Delete it instead.</p>`;
  const labels = { general:"General skill", special:"Special skill", origin:"Origin" };
  const offered = saved ? ["special", "origin"] : KINDS;
  const pill = value =>
    `<button class="lib-chip${d.kind === value ? " on" : ""}"
       data-skill-kind="${value}" type="button" ${tid(`skill-library.kind-${value}`)} role="radio"
       aria-checked="${d.kind === value}">${esc(labels[value])}</button>`;
  return `<div class="lib-chips" role="radiogroup" aria-label="Skill kind">${offered.map(pill).join("")}</div>`;
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
    <span class="lib-avatar lib-avatar-${d.kind}" title="${esc(KIND_LABEL[d.kind])} skill" aria-label="${esc(KIND_LABEL[d.kind])} skill" ${tid("skill-library.kind-avatar")}>${esc(kindMark(d.kind))}</span><div><strong>${esc(d.name || "Untitled skill")}</strong><small>ID: ${esc(d.id || "not saved")}</small></div>
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
      : d.kind === "general"
      ? "A general skill every character starts with, unless their origin narrows it or a restriction takes it away."
      : "The canonical name and meaning a story writes when it grants this skill."}</p>
    ${kindPickerHtml(d, c)}
    <label class="lib-field"><span>Name</span><input class="lib-input" id="skilllib-name" value="${esc(d.name)}" placeholder="The canonical spelling a story writes"></label>
    <label class="lib-field"><span>Meaning</span><textarea class="lib-input lib-textarea" id="skilllib-meaning" rows="3" placeholder="${origin ? "What kind of being this is" : "What the skill lets a character do"}">${esc(d.meaning)}</textarea></label>
  </div>
  ${origin ? `<div class="lib-section" id="skilllib-general-section"><h3>General skills</h3><p>What a character of this kind starts with. A story can still add or take away per character.</p>${coverage}${generalPickerHtml(d)}</div>` : ""}
  ${c ? `<div class="lib-section"><h3>Usage</h3><p>What actually carries this ${origin ? "origin" : "skill"} today.</p>${usageHtml(d)}</div>` : ""}
  <div class="lib-editor-footer">${button({label:"Cancel", id:"skilllib-cancel", disabled:!s.dirty})}${button({label:"Save changes", id:"skilllib-save", variant:"primary", disabled:!needsSave(s)})}</div>`;
}

export function skillLibraryHtml() {
  const s = APP.skillLibrary;
  if (s.loading) return `<section class="lib-page lib-skills"><div class="lib-loading">${thinking("loading skill bible…")}</div></section>`;
  if (s.error && !s.entries.length) return `<section class="lib-page lib-skills"><div class="lib-loading">${errorLine(esc(s.error))}${button({label:"Try again", id:"skilllib-retry", variant:"primary"})}</div></section>`;
  // The inspector is not rendered at all until something is selected, so the list gets the whole
  // width rather than sitting beside a panel saying nothing.
  return `<section class="lib-page lib-skills${s.draft ? "" : " no-inspector"}" ${tid("skill-library.page")}><div class="lib-main">
    <header class="lib-top"><div class="page-title"><p class="eyebrow">library · skills</p><h1>Skill Bible <span class="lib-info">i</span></h1><p class="lede">The special skills a story can draw on by name, and the origins that group general skills.</p></div><div class="lib-top-actions">${button({label:"＋ New skill", id:"skilllib-new", variant:"primary"})}</div></header>
    <div class="lib-toolbar"><input class="lib-input" id="skilllib-search" placeholder="⌕  Search skills and origins…" value="${esc(s.search)}"><select class="lib-input" id="skilllib-sort"><option value="updated"${s.sort === "updated" ? " selected" : ""}>Recently updated</option><option value="name"${s.sort === "name" ? " selected" : ""}>Name A–Z</option></select></div>
    <div class="lib-list">${listHtml()}</div><footer class="lib-list-footer">Showing ${visibleEntries().length} of ${s.entries.length} skills and origins</footer>
  </div>${s.draft ? `<aside class="lib-inspector">${editorHtml()}</aside>` : ""}</section>`;
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
function collectDraft() { const s = APP.skillLibrary; if (!s.draft) return; for (const key of ["name","meaning"]) { const el = document.getElementById(`skilllib-${key}`); if (el) s.draft[key] = el.value; } dirtyFromDraft(); }

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
  const k = s.selected;
  // The server refuses this too; catching it here means the author reads why before a round trip,
  // and never sees a confirm for something that was never going to happen.
  const granting = kindOf(k) === "general" ? originsGranting(k.name) : [];
  if (granting.length) {
    s.error = `"${k.name}" is granted by origin ${granting.join(", ")} — remove it from ${granting.length > 1 ? "them" : "it"} first.`;
    APP.render(); return;
  }
  const used = APP.catalog.usage?.skills?.[folded(k.name)] ?? 0;
  const carried = used ? ` ${used} character${used === 1 ? "" : "s"} in your library carr${used === 1 ? "ies" : "y"} it.` : "";
  if (!await confirmDialog({ title: `Delete "${k.name}"?`, body: `${carried} This cannot be undone.`,
    confirmLabel: "delete skill", danger: true })) return;
  const id = k.id;
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
  page.querySelectorAll("[data-skill-id]").forEach(row => row.addEventListener("click", async e => { if (e.target.closest("button")) return; collectDraft(); if (s.dirty && !await confirmDialog({ title: "Discard unsaved changes?", body: "Your unsaved edits will be lost.", confirmLabel: "discard", danger: true })) return; setSelected(s.entries.find(k => k.id === row.dataset.skillId)); }));
  page.querySelectorAll("[data-skill-select-id]").forEach(action => action.addEventListener("click", async e => {
    e.stopPropagation(); collectDraft(); if (s.dirty && !await confirmDialog({ title: "Discard unsaved changes?", body: "Your unsaved edits will be lost.", confirmLabel: "discard", danger: true })) return;
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
  page.querySelector("#skilllib-close")?.addEventListener("click", async () => { if (!s.dirty || await confirmDialog({ title: "Discard unsaved changes?", body: "Your unsaved edits will be lost.", confirmLabel: "discard", danger: true })) { s.selected = null; s.draft = null; s.dirty = false; APP.render(); } });
  page.querySelector("#skilllib-save")?.addEventListener("click", save);
  page.querySelector("#skilllib-cancel")?.addEventListener("click", () => { s.draft = draftOf(s.selected); s.dirty = false; APP.render(); });
  page.querySelector("#skilllib-duplicate")?.addEventListener("click", duplicate);
  page.querySelector("#skilllib-delete")?.addEventListener("click", remove);
}
