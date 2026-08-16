import { $, esc, basename, wireBackdropClose } from "./util.js";
import { APP, LIVEV, READV, FIELDS, open, storyName } from "./state.js";
import { build } from "./events.js";
import { renderBlock, wireReader } from "./blocks.js";
import { pickerHtml, wirePicker, castChips } from "./shelf.js";
import { storyPageHtml, wireStoryPage } from "./story-page.js";
import { readChromeHtml, wireSavedRuns } from "./saved-runs.js";
import { paintSrcbar, paintTitle, renderRail } from "./hud.js";
import { characterCardModalHtml, wireCharacterCard } from "./character-card.js";
import { runEndedModalHtml, wireRunEndedModal } from "./run-ended.js";
import { interviewModalHtml, wireInterview } from "./interview.js";
import { go, generating } from "./nav.js";
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
  // The shelf is the hub: reachable any time an engine is attached, mid-run included -- so nothing
  // here disables a tab any more. The story page has no tab of its own; it reads as "shelf".
  shelfTab.hidden = !APP.live;
  liveTab.hidden = !APP.live;
  readTab.hidden = false;
  const shown = APP.view === "story" ? "shelf" : APP.view;
  for (const t of [shelfTab, liveTab, readTab]) {
    const isCurrent = t.dataset.view === shown;
    t.classList.toggle("current", isCurrent);
    t.setAttribute("aria-current", isCurrent ? "page" : "false");
  }
  $("tabdot").hidden = !(generating() || APP.awaitingReader);
  $("tabdot").classList.toggle("asked", APP.awaitingReader);
  $("tabasked").hidden = !APP.awaitingReader;
}

function renderHeader() {
  const m = APP.view === "live" ? LIVEV.meta : APP.view === "read" ? READV.meta : null;
  if (!m) { $("title").textContent = "story-writer"; $("question").textContent = ""; $("cast").innerHTML = ""; return; }
  $("title").textContent = basename(m.story) || "story-writer";
  $("question").textContent = m.question || "";
  // Live only: the read page carries its own "Cast" section, and the same pills in the header too
  // is one set too many.
  $("cast").innerHTML = APP.view === "live" ? castChips(m.characters, m.story) : "";
}

function paintRibbon() {
  const el = $("ribbon");
  if (APP.view !== "read" || !READV.meta) { el.hidden = true; el.textContent = ""; return; }
  const who = basename(READV.meta.story) || "saved run";
  el.hidden = false;
  el.textContent = `reading a saved run · ${who}${READV.label ? " · " + READV.label : ""}`;
}

function renderShelf(page, keepFocus) {
  page.innerHTML = pickerHtml() + interviewModalHtml();
  $("rail").innerHTML = "";
  wirePicker(page, () => go("story")); wireInterview(page); wireModal(page);
  restoreFocus(page, keepFocus);
  setFoldable(false);
}

function renderStoryPage(page) {
  page.innerHTML = storyPageHtml();
  $("rail").innerHTML = "";
  wireStoryPage(page);
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
    } else {
      const text = APP.live ? "The scene will appear here as soon as the engine starts writing."
                             : "Run the engine with <code>--serve</code> to watch a scene as it is written.";
      html = `<div class="empty"><h2>Nothing written yet</h2>
        <p>${text}</p>
        ${idle ? `<div class="btns" style="justify-content:center">
          <button class="btn" id="go-shelf">choose a story</button></div>` : ""}
      </div>`;
    }
    page.innerHTML = html;
    $("rail").innerHTML = "";
    const gb = page.querySelector("#go-shelf");
    if (gb) gb.addEventListener("click", () => go("shelf"));
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
  const chrome = readChromeHtml();
  if (!blocks.length) {
    // A run CAN load fine and still have nothing to show -- a run killed before its first draft
    // leaves a log holding only `scene_start`. Saying "nothing loaded" there blames the wrong thing
    // and reads exactly like a failed fetch, so an empty run says it is empty.
    const empty = READV.events.length > 0;
    page.innerHTML = chrome + `<div class="empty"><h2>${empty ? "This run is empty" : "Nothing loaded"}</h2>
      <p>${empty ? `${esc(READV.label || "it")} — the run was stopped before a word of it was written.
             Pick an earlier one, which may have more in it.`
                 : `Open a story on the shelf and "read" a previous run, drop a saved
             <code>out/writing-log.jsonl</code> onto this page, or open one from disk.`}</p></div>`;
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
  wireBackdropClose(page, "iv-backdrop", () => { APP.ivHidden = true; APP.render(); });
}

function setFoldable(foldable) {
  $("expand").disabled = !foldable;
  $("expand").title = foldable ? "" : "nothing to expand — no consults in this run";
}

/** Repainted every render(), regardless of view -- the header pill that opens the character card
 *  is visible on the live and read pages too, not just the shelf, so neither modal can live inside
 *  `#page` like the interview's does. Character card last: if a header pill is clicked while the
 *  run-ended modal is up, it stacks on top rather than being clicked through. Owned here rather
 *  than by either modal's own module, since painting "every overlay modal" isn't either one's job. */
function paintModals(goShelf) {
  const root = $("modalroot");
  if (!APP.runEnded && !APP.charCard) { if (root.innerHTML) root.innerHTML = ""; return; }
  root.innerHTML = runEndedModalHtml() + characterCardModalHtml();
  wireRunEndedModal(root, goShelf);
  wireCharacterCard(root);
}

export function render() {
  renderNav();
  const store = APP.view === "live" ? LIVEV : APP.view === "read" ? READV : null;
  const blocks = store ? build(store) : [];
  renderHeader();
  renderSession();
  paintSrcbar();
  paintRibbon();
  paintTitle();
  paintModals(() => go("shelf"));
  const page = $("page");
  const active = document.activeElement;
  const keepFocus = active && FIELDS.test(active.id || "") ? active.id : "";
  if (APP.view === "shelf") renderShelf(page, keepFocus);
  else if (APP.view === "story") renderStoryPage(page);
  else if (APP.view === "read") renderRead(page, blocks);
  else renderLive(page, blocks);
}
