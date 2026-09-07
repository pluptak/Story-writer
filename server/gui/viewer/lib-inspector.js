import { esc } from "./util.js";

// Shared inspector-panel builders for the four GUI catalogs (characters, tags, styles, skills).
// Each library keeps its own editorHtml() for content-specific fields, pickers and modals --
// only the genuinely identical structure (empty state, page open/close wrapper, aside wrapper,
// head/actions/section/footer/tabs shells, the no-inspector toggle) and the identical draft
// utilities (clone, newId, needsSave) live here. `description` on section() is raw HTML like
// hint() in ui.js: callers mix plain text with the odd <code>, and escape their own interpolated
// values.

export function inspectorEmpty(title, subtitle) {
  return `<div class="lib-inspector-empty"><span>${esc(title)}</span><small>${esc(subtitle)}</small></div>`;
}

export function inspector(content) {
  return `<aside class="lib-inspector">${content}</aside>`;
}

export function editorHead(inner) {
  return `<div class="lib-editor-head">${inner}</div>`;
}

export function actions(buttons) {
  return `<div class="lib-actions">${buttons}</div>`;
}

export function section(title, description, body, attrs = "") {
  return `<div class="lib-section"${attrs ? ` ${attrs}` : ""}><h3>${esc(title)}</h3><p>${description}</p>${body}</div>`;
}

export function editorFooter(content) {
  return `<div class="lib-editor-footer">${content}</div>`;
}

export function tabs(items) {
  return `<div class="lib-tabs">${items}</div>`;
}

export function noInspectorClass(condition) {
  return condition ? "" : " no-inspector";
}

// `tidAttr` is a tid() call's return value, which already carries its own leading space.
export function catalogPageOpen(type, draft, tidAttr) {
  return `<section class="lib-page lib-${type}${noInspectorClass(draft)}"${tidAttr || ""}><div class="lib-main">`;
}

export function catalogPageClose(s, editorHtml) {
  return `</div>${s.draft ? inspector(editorHtml) : ""}</section>`;
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// A freshly created or duplicated entry is never dirty -- its draft is derived from the very
// object it is compared against -- but it also has never been persisted (version 0). Gate Save
// on either: an edit, or nothing to lose by pressing it.
export function needsSave(s) {
  return s.dirty || (!!s.selected && !s.selected.version);
}