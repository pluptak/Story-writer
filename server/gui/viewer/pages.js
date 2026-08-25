import { $, esc, basename, wireBackdropClose, tid } from "./util.js";
import { APP, LIVEV, READV, READER, FIELDS, open, storyName } from "./state.js";
import { build } from "./events.js";
import { renderBlock, wireReader } from "./blocks.js";
import { pickerHtml, wirePicker, castChips } from "./shelf.js";
import { storyPageHtml, wireStoryPage } from "./story-page.js";
import { storyEditHtml, wireStoryEditor } from "./story-edit.js";
import { handoffPageHtml, wireHandoff } from "./handoff.js";
import { readChromeHtml, wireSavedRuns } from "./saved-runs.js";
import { paintSrcbar, paintTitle, renderRail, phaseOf } from "./hud.js";
import { renderTimeline, wireTimeline } from "./timeline.js";
import { characterCardModalHtml, wireCharacterCard, settleModalWant } from "./character-card.js";
import { runEndedModalHtml, wireRunEndedModal } from "./run-ended.js";
import { scaffoldHtml, wireScaffold } from "./interview.js";
import { readerPageHtml, wireReaderPage } from "./reader.js";
import { comparisonPageHtml, wireComparison } from "./compare.js";
import { go, generating, syncHash, noteFocus, tagFocus, clearFocus } from "./nav.js";
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
  const first = page.querySelector(
    ".iv #f-folder:not([disabled]), .iv textarea:not([disabled]), " +
    ".scpage #f-folder:not([disabled]), .scpage #f-say:not([disabled])");
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
  const shown = APP.view === "story" || APP.view === "handoff" || APP.view === "compare" || APP.view === "scaffold" ? "shelf" : APP.view === "readstory" ? "read" : APP.view;
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
  // Reader mode: show the story name, no cast
  if (APP.view === "readstory") {
    const name = storyName(READER.dir) || basename(READER.dir) || "reader";
    $("title").textContent = name;
    $("question").textContent = "reading · " + name;
    $("cast").innerHTML = ""; $("castcard").hidden = true;
    return;
  }
  const m = APP.view === "live" ? LIVEV.meta : APP.view === "read" ? READV.meta : null;
  if (!m) { $("title").textContent = "story-writer"; $("question").textContent = ""; $("cast").innerHTML = ""; $("castcard").hidden = true; return; }
  $("title").textContent = basename(m.story) || "story-writer";
  // The live page shows the question as its headline, so the topbar says what the run is doing
  // instead of repeating it.
  const ph = APP.view === "live" ? phaseOf(LIVEV) : "";
  $("question").textContent = APP.view === "live" ? (ph ? `live chapter · ${ph}` : "") : (m.question || "");
  // Live only: the read page carries its own "Cast" section, and the same pills in the header too
  // is one set too many.
  $("cast").innerHTML = APP.view === "live" ? castChips(m.characters, m.story) : "";
  $("castcard").hidden = !(APP.view === "live" && m.characters?.length);
}

function paintRibbon() {
  const el = $("ribbon");
  if (APP.view !== "read" || !READV.meta) { el.hidden = true; el.textContent = ""; return; }
  const who = basename(READV.meta.story) || "saved run";
  el.hidden = false;
  el.textContent = `reading a saved run · ${who}${READV.label ? " · " + READV.label : ""}`;
}

function renderShelf(page, keepFocus) {
  page.innerHTML = pickerHtml();
  $("railstats").innerHTML = "";
  // The new-story card opens the scaffold page (a route now, not a modal); an interview already
  // running on the server is continued there rather than started again.
  wirePicker(page, () => go("story"), () => go("scaffold"));
  restoreFocus(page, keepFocus);
  setFoldable(false);
}

function renderScaffold(page, keepFocus) {
  page.innerHTML = scaffoldHtml();
  $("railstats").innerHTML = "";
  wireScaffold(page); wireModal(page);
  restoreFocus(page, keepFocus);
  setFoldable(false);
}

function renderStoryPage(page) {
  page.innerHTML = storyPageHtml();
  $("railstats").innerHTML = "";
  wireStoryPage(page);
  setFoldable(false);
}

function renderHandoff(page, keepFocus) {
  page.innerHTML = handoffPageHtml();
  $("railstats").innerHTML = "";
  wireHandoff(page);
  restoreFocus(page, keepFocus);
  setFoldable(false);
}

function renderReader(page) {
  page.innerHTML = readerPageHtml();
  $("railstats").innerHTML = "";
  wireReaderPage(page);
  setFoldable(false);
}

function renderComparison(page) {
  page.innerHTML = comparisonPageHtml();
  $("railstats").innerHTML = "";
  wireComparison(page);
  setFoldable(false);
}

// The editor repaints whole on every render -- including the one 400ms after a keystroke, when
// /story/check answers. Focus, caret and which sections are unfolded are carried across by hand,
// or typing a premise would jump out of the field and collapse the section around it.
function renderEdit(page) {
  const active = document.activeElement;
  const focused = active && page.contains(active) && active.id ? active.id : "";
  const caret = focused && typeof active.selectionStart === "number"
    ? [active.selectionStart, active.selectionEnd] : null;
  const folds = [...page.querySelectorAll("details.editor-section")].map(d => d.open);

  page.innerHTML = storyEditHtml();
  $("railstats").innerHTML = "";
  wireStoryEditor(page);

  const sections = page.querySelectorAll("details.editor-section");
  if (folds.length === sections.length) sections.forEach((d, i) => { d.open = folds[i]; });
  if (focused) {
    const el = page.querySelector("#" + focused);
    if (el && !el.disabled) {
      el.focus();
      if (caret) try { el.setSelectionRange(caret[0], caret[1]); } catch {}
    }
  }
  setFoldable(false);
}

/** The mockup's headline block. The scene question is the headline: it is what this chapter exists
 *  to answer, and the topbar stops repeating it while the live page is showing. */
function liveHeaderHtml() {
  const m = LIVEV.meta;
  if (!m) return "";
  const where = m.chapters > 1 ? `chapter ${m.chapter} of ${m.chapters}` : "chapter";
  return `<div class="livehead" data-tid="live.head">
    <p class="eyebrow">${esc(where)} · ${esc(storyName(m.story))}</p>
    <h2>${esc(m.question || "")}</h2>
    <p class="lede">The writer drafts only as far as the next choice that is a character's to make,
      then asks them for it. It never sees their personas.</p>
  </div>`;
}

/** Titles reuse the app's own existing wording for each state rather than inventing a second
 *  vocabulary for the same thing -- "the writer wants your call" is what the reader card says, and
 *  "the step budget is spent" is what the budget prompt says. */
const PHASE_TITLE = {
  "writing": "A draft is arriving",
  "consulting": "A choice is being checked",
  "reader wait": "The writer wants your call",
  "budget wait": "The step budget is spent",
  "paused": "Paused at the last boundary",
  "pausing": "Pausing at the next boundary",
  "stopping": "Stopping",
  "idle": "The scene so far",
};

function renderLive(page, blocks) {
  if (!blocks.length) {
    const warming = APP.live && (APP.picked || (APP.session.running && !APP.session.picking));
    const idle = APP.live && APP.session.picking && !warming;
    let html;
    if (warming) {
      const name = storyName(APP.picked || LIVEV.meta?.story || "");
      html = `<div class="empty starting" data-tid="live.empty">
        <h2>Starting${name ? ` <em>${esc(name)}</em>` : ""}…</h2>
        <p class="thinking"><i></i>waiting for the writer — a cold model can take a few seconds</p>
        <p class="hint">use <b>stop</b> in the run controls to cancel, once they appear</p>
      </div>`;
    } else {
      const text = APP.live ? "The scene will appear here as soon as the engine starts writing."
                             : "Run the engine with <code>--serve</code> to watch a scene as it is written.";
      html = `<div class="empty" data-tid="live.empty"><h2>Nothing written yet</h2>
        <p>${text}</p>
        ${idle ? `<div class="btns" style="justify-content:center">
          <button ${tid("live.go-shelf-btn")} class="btn" id="go-shelf">choose a story</button></div>` : ""}
      </div>`;
    }
    page.innerHTML = html;
    $("railstats").innerHTML = "";
    const gb = page.querySelector("#go-shelf");
    if (gb) gb.addEventListener("click", () => go("shelf"));
    setFoldable(false);
    return;
  }
  const steps = LIVEV.events.filter(e => e.t === "draft").length;
  const target = LIVEV.meta?.target || 0;
  const words = LIVEV.events.filter(e => e.t === "draft").reduce((n, e) => Math.max(n, e.words || 0), 0);
  const consults = blocks.filter(b => b.kind === "consult").length;
  const phase = phaseOf(LIVEV);
  const chip = t => `<span class="metachip">${esc(t)}</span>`;
  page.innerHTML = liveHeaderHtml() + `<section ${tid("live.prose-card")} class="prosecard">
    <div class="head">
      <div><span class="label">live prose</span><h3>${esc(PHASE_TITLE[phase] || "The scene so far")}</h3></div>
      <span class="label">step ${steps}</span>
    </div>
    <div class="body">
      <div class="runmeta">
        ${chip(target ? `${words} / ${target} words` : `${words} words`)}
        ${chip(`${consults} consult${consults === 1 ? "" : "s"}`)}
        ${chip(APP.session.interactive ? "interactive" : "hands off")}
      </div>
      <div class="prose">` + blocks.map(b => renderBlock(b, true)).join("") + `</div>
    </div>
  </section>`;
  wireConsultToggles(page);
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
    page.innerHTML = chrome + `<div class="empty" data-tid="read.empty"><h2>${empty ? "This run is empty" : "Nothing loaded"}</h2>
      <p>${empty ? `${esc(READV.label || "it")} — the run was stopped before a word of it was written.
             Pick an earlier one, which may have more in it.`
                 : `Open a story on the shelf and "read" a previous run, drop a saved
             <code>out/writing-log.jsonl</code> onto this page, or open one from disk.`}</p></div>`;
    $("railstats").innerHTML = "";
    wireSavedRuns(page);
    setFoldable(false);
    return;
  }
  page.innerHTML = chrome + `<div class="prose">` + blocks.map(b => renderBlock(b, false)).join("") + `</div>`;
  wireConsultToggles(page);
  wireSavedRuns(page);
  setFoldable(blocks.some(b => b.kind === "consult"));
  renderRail(READV, blocks);
}

/** Backdrop click on the idea modal returns to the shelf — the interview lives on the server, so
 *  leaving the page never abandons it; the shelf's "continue new story…" card comes back to it. */
function wireModal(page) {
  wireBackdropClose(page, "iv-backdrop", () => go("shelf"));
}

function setFoldable(foldable) {
  $("expand").disabled = !foldable;
  $("expand").title = foldable ? "" : "nothing to expand — no consults in this run";
}

/** Consult open/close keeps the URL honest: opening one tags it as the &block= target, closing it
 *  drops the tag. Shared by live and read, which wire the same toggles. */
function wireConsultToggles(page) {
  for (const d of page.querySelectorAll("details.consult")) {
    d.addEventListener("toggle", () => {
      const s = Number(d.dataset.seq);
      if (d.open) { open.add(s); tagFocus(s); }
      else { open.delete(s); if (APP.focusSeq === s) clearFocus(); }
    });
  }
}

/** One-shot scroll to the &block=/timeline target once it exists on screen. Runs after each render;
 *  fires only until it has scrolled for the current focusSeq, so a mid-run rebuild never yanks the
 *  page back. */
function settleFocus(page) {
  if (APP.focusSeq == null || APP.focusScrolled) return;
  const t = page.querySelector(`details.consult[data-seq="${APP.focusSeq}"]`)
         || page.querySelector(`[data-seq="${APP.focusSeq}"]`);
  if (!t) return;                       // not written yet -- retry on a later frame
  APP.focusScrolled = true;
  if (t instanceof HTMLDetailsElement) t.open = true;
  open.add(APP.focusSeq);
  t.scrollIntoView({ behavior: "smooth", block: "center" });
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
  // A pending &modal= resolves against the PREVIOUS frame's chips -- they are still in the DOM
  // here, before the page below repaints -- so the card paints in this same pass.
  settleModalWant();
  paintModals(() => go("shelf"));
  const page = $("page");
  const active = document.activeElement;
  const keepFocus = active && FIELDS.test(active.id || "") ? active.id : "";
  if (APP.view === "shelf") renderShelf(page, keepFocus);
  else if (APP.view === "story") renderStoryPage(page);
  else if (APP.view === "handoff") renderHandoff(page, keepFocus);
  else if (APP.view === "compare") renderComparison(page);
  else if (APP.view === "edit") renderEdit(page);
  else if (APP.view === "scaffold") renderScaffold(page, keepFocus);
  else if (APP.view === "readstory") renderReader(page);
  else if (APP.view === "read") renderRead(page, blocks);
  else renderLive(page, blocks);
  // Empty on the shelf/story/handoff pages, and on live/read before there is anything to show --
  // an empty bordered card with just the header is worse than no card at all.
  $("runctrl").hidden = !$("railstats").innerHTML && $("sessionbar").hidden;
  renderTimeline(blocks);
  wireTimeline();
  // The scroll needs the NEW DOM, so it runs after the page above has been painted. syncHash last:
  // every state change above (focus tag/clear, modal want) is reflected in the address bar without
  // each mutator having to remember to call it. replaceState-only, so nothing re-enters go().
  settleFocus(page);
  syncHash();
}
