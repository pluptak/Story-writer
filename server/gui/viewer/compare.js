import { APP, COMPAREV, COMPARE_AGENTS } from "./state.js";
import { esc, fmtRun, tid } from "./util.js";
import { hint, errorLine, thinking, divider } from "./ui.js";
import { parseHashParams, syncHash } from "./nav.js";
import { build } from "./events.js";
import { renderBlock } from "./blocks.js";
import { loadSavedRun, readChromeHtml } from "./saved-runs.js";
import { wireAgents } from "./agents.js";

const runChapter = run => typeof run?.chapter === "number" ? run.chapter : null;
const runsForStory = () => (APP.stories || []).find(s => s.dir === APP.compareDir)?.runs || [];
const selectedRuns = () => {
  const runs = runsForStory();
  return [runs.find(r => r.id === APP.compareA), runs.find(r => r.id === APP.compareB)];
};

export function assembledProse(store) {
  return store.events.filter(e => e.t === "draft" && e.prose).map(e => e.prose).join("\n\n");
}

function words(text) { return String(text).match(/\S+/g) || []; }

// ~16MB Uint32Array matrix at this size -- past it a full word-diff would freeze the tab, so
// diffHtml() skips straight to the side-by-side panes instead of building it.
const MAX_DIFF_CELLS = 4_000_000;

function wordDiff(a, b) {
  const rows = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      rows[i][j] = a[i] === b[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push(["same", a[i++]]); j++; }
    else if (rows[i + 1][j] >= rows[i][j + 1]) out.push(["removed", a[i++]]);
    else out.push(["added", b[j++]]);
  }
  while (i < a.length) out.push(["removed", a[i++]]);
  while (j < b.length) out.push(["added", b[j++]]);
  return out;
}

function diffHtml(left, right) {
  const a = words(left), b = words(right);
  if (!a.length && !b.length) return hint(`neither run contains accepted prose.`);
  if ((a.length + 1) * (b.length + 1) > MAX_DIFF_CELLS)
    return hint(`these chapters are too long to diff word-by-word (${a.length} vs ${b.length} words) — read them side by side above instead.`);
  const ops = wordDiff(a, b);
  return `<section ${tid("compare.diff")} class="prose-diff" aria-label="word-level prose diff">${ops.map(([kind, word]) =>
    kind === "same" ? esc(word) + " " : `<span class="diff-${kind}">${esc(word)}</span> `).join("")}</section>`;
}

/** A run named the way history names it: what chapter it wrote first, then when/how it ended.
 *  Shared by the picker options, the versus line and the pane titles, so all three agree. */
const runLabel = r => `${typeof r?.chapter === "number" ? `chapter ${r.chapter} · ` : ""}${fmtRun(r || {})}`;

function optionHtml(runs, selected) {
  return runs.map(r => `<option value="${esc(r.id)}"${r.id === selected ? " selected" : ""}>${esc(runLabel(r))}</option>`).join("");
}

export function prepareComparison(dir, a = "", b = "") {
  APP.compareDir = dir;
  APP.compareA = a;
  APP.compareB = b;
  APP.compareError = "";
  const runs = runsForStory();
  if (!runs.some(r => r.id === APP.compareA)) APP.compareA = runs[0]?.id || "";
  const firstChapter = runChapter(runs.find(r => r.id === APP.compareA));
  if (!runs.some(r => r.id === APP.compareB && r.id !== APP.compareA))
    APP.compareB = runs.find(r => r.id !== APP.compareA && runChapter(r) === firstChapter)?.id || "";
}

export function loadDeepLinkedComparison() {
  const p = parseHashParams();
  prepareComparison(p.get("dir") || "", p.get("a") || "", p.get("b") || "");
}

function selectionError() {
  const [a, b] = selectedRuns();
  if (!a || !b) return "choose two retained runs from this story";
  if (a.id === b.id) return "choose two different runs";
  if (runChapter(a) === null || runChapter(b) === null) return "only runs with known chapter numbers can be compared";
  if (runChapter(a) !== runChapter(b)) return "choose two runs from the same chapter";
  return "";
}

function updateSelection(which, value) {
  APP[which] = value;
  APP.compareError = selectionError();
  syncHash();
  APP.render();
  if (!APP.compareError) loadComparisonRuns();
}

export async function loadComparisonRuns() {
  const key = `${APP.compareDir}\n${APP.compareA}\n${APP.compareB}`;
  if (COMPAREV.key === key && !COMPAREV.error) return;
  const [a, b] = selectedRuns();
  if (!a || !b || selectionError()) return;
  COMPAREV.key = key;
  COMPAREV.loading = true;
  COMPAREV.error = "";
  APP.render();
  const [left, right] = await Promise.all([
    loadSavedRun(APP.compareDir, a.id, COMPAREV.a, false, COMPARE_AGENTS.a),
    loadSavedRun(APP.compareDir, b.id, COMPAREV.b, false, COMPARE_AGENTS.b),
  ]);
  if (COMPAREV.key !== key) return;
  COMPAREV.loading = false;
  if (left !== true || right !== true) COMPAREV.error = "could not load one of those runs";
  APP.render();
}

function paneHtml(store, title, side) {
  if (!store.events.length) return `<section ${tid("compare.pane")} class="compare-pane" data-side="${side}"><h3>${esc(title)}</h3>${hint(COMPAREV.loading ? "reading…" : "this run is empty")}</section>`;
  const blocks = build(store);
  // A comparison is about the prose: a pane whose run logged no model calls drops its Model
  // calls section rather than showing an empty one twice. Anything still loading (or failed)
  // keeps the panel, so "reading…" and errors still surface.
  const ag = COMPARE_AGENTS[side];
  const noCalls = !!ag?.agents && ag.agents.dir === store.dir && ag.agents.id === store.id
    && !ag.agents.logs.length && !ag.agentsError;
  return `<section ${tid("compare.pane")} class="compare-pane" data-side="${side}"><h3>${esc(title)}</h3>${readChromeHtml(store, !noCalls, ag, false)}<div class="prose">${blocks.map(b => renderBlock(b, false)).join("")}</div></section>`;
}

export function comparisonPageHtml() {
  const story = (APP.stories || []).find(s => s.dir === APP.compareDir);
  if (!story) return `<section class="picker"><h2>Comparison unavailable</h2><p class="sub">this story is no longer on the shelf.</p></section>`;
  const runs = story.runs || [];
  if (runs.length < 2) return `<section class="picker"><h2>${esc(story.name)}</h2><p class="sub">two retained runs from the same chapter are needed to compare.</p></section>`;
  const [a, b] = selectedRuns();
  const error = APP.compareError || selectionError();
  return `<section ${tid("compare.picker")} class="picker compare-picker">
    <h2>Compare runs</h2>
    <p class="sub">${esc(story.name)} · two attempts at the same chapter, side by side. Choose two runs from the same chapter.</p>
    <div class="row"><label for="compare-a">first run</label><select class="btn" id="compare-a">${optionHtml(runs, APP.compareA)}</select></div>
    <div class="row"><label for="compare-b">second run</label><select class="btn" id="compare-b">${optionHtml(runs, APP.compareB)}</select></div>
    ${error ? errorLine(esc(error)) : hint(`${esc(runLabel(a))} versus ${esc(runLabel(b))}`)}
    ${divider("comparison")}
    ${COMPAREV.error ? errorLine(esc(COMPAREV.error)) : COMPAREV.loading ? thinking('reading both runs…', { tag: "p" })
      : `<div class="prose-diff-card"><div class="label">accepted prose diff
           <span class="diff-legend"><span class="diff-added">only in second</span> <span class="diff-removed">only in first</span></span></div>${diffHtml(assembledProse(COMPAREV.a), assembledProse(COMPAREV.b))}</div>
         <div class="compare-panes">${paneHtml(COMPAREV.a, runLabel(a), "a")}${paneHtml(COMPAREV.b, runLabel(b), "b")}</div>`}
  </section>`;
}

export function wireComparison(page) {
  const a = page.querySelector("#compare-a");
  const b = page.querySelector("#compare-b");
  if (a) a.addEventListener("change", () => updateSelection("compareA", a.value));
  if (b) b.addEventListener("change", () => updateSelection("compareB", b.value));
  for (const pane of page.querySelectorAll(".compare-pane"))
    wireAgents(pane, COMPARE_AGENTS[pane.dataset.side]);
}
