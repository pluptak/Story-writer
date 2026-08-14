import { $, esc } from "./util.js";
import { APP, LIVEV, READV, FIELDS, open } from "./state.js";
import { build } from "./events.js";
import { renderBlock, wireReader } from "./blocks.js";
import { pickerHtml, wirePicker } from "./shelf.js";
import { confirmModalHtml, wireConfirm } from "./confirm.js";
import { savedRunsHtml, wireSavedRuns } from "./saved-runs.js";
import { paintSrcbar, renderRail } from "./hud.js";
import { interviewModalHtml, wireInterview } from "./interview.js";
import { userNav, navBlocked, generating } from "./nav.js";
import { renderSession } from "./session.js";

function restoreFocus(page, id) {
  if (id) {
    const el = page.querySelector("#" + id);
    if (el && !el.disabled) {
      el.focus();
      try { el.setSelectionRange(el.value.length, el.value.length); } catch {}
      return;
    }
  }
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
  // Only a tab whose destination is actually refused goes dead -- the read tab stays live during a
  // run so a saved run is one click away, and the run keeps streaming behind it (tabdot below).
  for (const t of [shelfTab, liveTab, readTab]) {
    const blocked = navBlocked(t.dataset.view) && t.dataset.view !== APP.view;
    t.disabled = blocked;
    t.title = blocked ? "stop the run to choose another story" : "";
  }
  $("tabdot").hidden = !generating();
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

function storyName(dir) {
  const s = (APP.stories || []).find(x => x.dir === dir);
  return s?.name || (dir || "").replace(/^.*[\\/]/, "");
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
    const warming = APP.live && (APP.picked || (APP.session.running && !APP.session.picking));
    const idle = APP.live && APP.session.picking && !warming;
    let html;
    if (warming) {
      const name = storyName(APP.picked || LIVEV.meta?.story || "");
      html = `<div class="empty starting">
        <h2>Starting${name ? ` <em>${esc(name)}</em>` : ""}…</h2>
        <p class="thinking"><i></i>waiting for the writer — a cold model can take a few seconds</p>
        <p class="hint">use <b>stop</b> above to cancel once the run controls appear</p>
      </div>`;
    } else if (idle) {
      html = `<div class="empty"><h2>Nothing written yet</h2>
        <p>The scene will appear here as soon as the engine starts writing.</p>
        <div class="btns" style="justify-content:center">
          <button class="btn" id="go-shelf">choose a story</button></div>
      </div>`;
    } else {
      html = `<div class="empty"><h2>Nothing written yet</h2>
        <p>${APP.live ? "The scene will appear here as soon as the engine starts writing."
                     : "Run the engine with <code>--serve</code> to watch a scene as it is written."}</p>
      </div>`;
    }
    page.innerHTML = html;
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
