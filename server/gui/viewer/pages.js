import { $, esc } from "./util.js";
import { APP, LIVEV, READV, FIELDS, open } from "./state.js";
import { build } from "./events.js";
import { renderBlock, wireReader } from "./blocks.js";
import { pickerHtml, wirePicker } from "./shelf.js";
import { confirmModalHtml, wireConfirm } from "./confirm.js";
import { savedRunsHtml, wireSavedRuns } from "./saved-runs.js";
import { paintSrcbar, renderRail } from "./hud.js";
import { interviewModalHtml, wireInterview } from "./interview.js";
import { userNav, navLocked } from "./nav.js";
import { renderSession } from "./session.js";

/** Give focus back to whatever field had it when the render began, caret at the end — and failing
 *  that, put it where the typing goes. A modal that opens with focus still on the page behind it
 *  makes the keyboard useless until you click, which is half of why the buttons were doing the
 *  talking. */
function restoreFocus(page, id) {
  if (id) {
    const el = page.querySelector("#" + id);
    if (el && !el.disabled) {
      el.focus();
      try { el.setSelectionRange(el.value.length, el.value.length); } catch {}
      return;
    }
  }
  // Document order, so the folder question — which renders above the say box — takes the caret
  // while it is open. It is the thing being asked.
  const first = page.querySelector(".iv #f-folder:not([disabled]), .iv textarea:not([disabled])");
  if (first) first.focus();
}

// ---- the three pages --------------------------------------------------------
function renderNav() {
  document.body.dataset.view = APP.view;
  const shelfTab = $("tab-shelf"), liveTab = $("tab-live"), readTab = $("tab-read");
  shelfTab.hidden = !APP.live || !APP.session.picking;
  liveTab.hidden = !APP.live;
  readTab.hidden = false;
  for (const t of [shelfTab, liveTab, readTab]) {
    const isCurrent = t.dataset.view === APP.view;
    t.classList.toggle("current", isCurrent);
    t.setAttribute("aria-current", isCurrent ? "page" : "false");
  }
  const locked = navLocked();
  for (const t of [shelfTab, liveTab, readTab]) {
    t.disabled = locked && t.dataset.view !== APP.view;
    t.title = t.disabled ? "pause or stop the run to leave" : "";
  }
  $("tabdot").hidden = !(APP.live && APP.session.running && !APP.session.paused);
}

function renderHeader() {
  const m = APP.view === "live" ? LIVEV.meta : APP.view === "read" ? READV.meta : null;
  if (!m) { $("title").textContent = "story-writer"; $("question").textContent = ""; $("cast").innerHTML = ""; return; }
  $("title").textContent = (m.story || "").replace(/^.*[\\/]/, "") || "story-writer";
  $("question").textContent = m.question || "";
  $("cast").innerHTML = (m.characters || []).map(c => {
    const bits = [];
    if (c.skills?.length) bits.push(`<span class="yes">+${c.skills.join(", ")}</span>`);
    if (c.lacks?.length)  bits.push(`<span class="no">no ${c.lacks.join(", ")}</span>`);
    return `<span class="chip"><b>${esc(c.name)}</b>${bits.length ? " " + bits.join(" ") : ""}</span>`;
  }).join("");
}

function paintRibbon() {
  const el = $("ribbon");
  if (APP.view !== "read" || !READV.meta) { el.hidden = true; el.textContent = ""; return; }
  const who = (READV.meta.story || "").replace(/^.*[\\/]/, "") || "saved run";
  el.hidden = false;
  el.textContent = `reading a saved run · ${who}${READV.label ? " · " + READV.label : ""}`;
}

function renderShelf(page, keepFocus) {
  const modal = interviewModalHtml() || confirmModalHtml();
  page.innerHTML = pickerHtml() + modal;
  $("rail").innerHTML = "";
  wirePicker(page); wireInterview(page); wireConfirm(page); wireModal(page);
  restoreFocus(page, keepFocus);
  setFoldable(false);
}

function renderLive(page, blocks) {
  if (!blocks.length) {
    page.innerHTML = `<div class="empty"><h2>Nothing written yet</h2>
      <p>${APP.live ? "The scene will appear here as soon as the engine starts writing."
                 : "Run the engine with <code>--serve</code> to watch a scene as it is written."}</p>
      ${APP.live && APP.session.picking ? `<div class="btns" style="justify-content:center">
        <button class="btn" id="go-shelf">choose a story</button></div>` : ""}
      </div>`;
    $("rail").innerHTML = "";
    const gb = page.querySelector("#go-shelf");
    if (gb) gb.addEventListener("click", () => userNav("shelf"));
    setFoldable(false);
    return;
  }
  page.innerHTML = `<div class="prose">` + blocks.map(b => renderBlock(b, true)).join("") + `</div>`;
  for (const d of page.querySelectorAll("details.consult")) {
    d.addEventListener("toggle", () => {
      const s = Number(d.dataset.seq);
      d.open ? open.add(s) : open.delete(s);
    });
  }
  wireReader(page);
  setFoldable(blocks.some(b => b.kind === "consult"));
  renderRail(LIVEV, blocks);
}

function renderRead(page, blocks) {
  const chrome = savedRunsHtml();
  if (!blocks.length) {
    page.innerHTML = chrome + `<div class="empty"><h2>Nothing loaded</h2>
      <p>Pick a retained run above, drop a saved <code>out/writing-log.jsonl</code> onto this page,
      or open one from disk.</p></div>`;
    $("rail").innerHTML = "";
    wireSavedRuns(page);
    setFoldable(false);
    return;
  }
  page.innerHTML = chrome + `<div class="prose">` + blocks.map(b => renderBlock(b, false)).join("") + `</div>`;
  for (const d of page.querySelectorAll("details.consult")) {
    d.addEventListener("toggle", () => {
      const s = Number(d.dataset.seq);
      d.open ? open.add(s) : open.delete(s);
    });
  }
  wireSavedRuns(page);
  setFoldable(blocks.some(b => b.kind === "consult"));
  renderRail(READV, blocks);
}

/** Backdrop click closes (hides) the interview modal, same as the × button — never abandons. */
function wireModal(page) {
  const bd = page.querySelector("#iv-backdrop");
  if (bd) bd.addEventListener("click", e => { if (e.target === bd) { APP.ivHidden = true; APP.render(); } });
}

/** A run whose drafts were all salvaged has no consults in it at all, and "expand all" over a page
 *  with nothing foldable looks like a broken button rather than an empty run. Say which it is. */
function setFoldable(foldable) {
  $("expand").disabled = !foldable;
  $("expand").title = foldable ? "" : "nothing to expand — no consults in this run";
}

export function render() {
  renderNav();
  const store = APP.view === "live" ? LIVEV : APP.view === "read" ? READV : null;
  const blocks = store ? build(store) : [];
  renderHeader();
  renderSession();
  paintSrcbar();
  paintRibbon();
  const page = $("page");
  const active = document.activeElement;
  const keepFocus = active && FIELDS.test(active.id || "") ? active.id : "";
  if (APP.view === "shelf") renderShelf(page, keepFocus);
  else if (APP.view === "read") renderRead(page, blocks);
  else renderLive(page, blocks);
}
