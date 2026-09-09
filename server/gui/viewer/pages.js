import { $, esc, basename, wireBackdropClose, tid, scrollToEl } from "./util.js";
import { APP, LIVEV, READV, READER, FIELDS, open, storyName } from "./state.js";
import { build } from "./events.js";
import { renderBlocks, wireReader } from "./blocks.js";
import { pickerHtml, wirePicker, castChips } from "./shelf.js";
import { storyPageHtml, wireStoryPage } from "./story-page.js";
import { storyEditHtml, wireStoryEditor } from "./story-edit.js";
import { handoffPageHtml, wireHandoff } from "./handoff.js";
import { readChromeHtml, wireSavedRuns } from "./saved-runs.js";
import { characterLibraryHtml, wireCharacterLibrary, loadCharacterLibrary } from "./character-library.js";
import { styleLibraryHtml, wireStyleLibrary, loadStyleLibrary } from "./style-library.js";
import { tagLibraryHtml, wireTagLibrary, loadTagLibrary } from "./tag-library.js";
import { skillLibraryHtml, wireSkillLibrary, loadSkillLibrary } from "./skill-library.js";
import { paintSrcbar, paintTitle, renderRail, clearRail, phaseOf } from "./hud.js";
import { ensureLiveCast } from "./cast-sheet.js";
import { renderTimeline, wireTimeline } from "./timeline.js";
import { characterCardModalHtml, wireCharacterCard, settleModalWant } from "./character-card.js";
import { consultInspectorHtml, wireConsultInspector, wireConsultInspectButtons, settleInspectWant } from "./consult-inspector.js";
import { runEndedModalHtml, wireRunEndedModal } from "./run-ended.js";
import { libraryPickerHtml, wireLibraryPicker } from "./library-picker.js";
import { scaffoldHtml, wireScaffold } from "./interview.js";
import { readerPageHtml, wireReaderPage, loadReader } from "./reader.js";
import { comparisonPageHtml, wireComparison, prepareComparison, loadComparisonRuns } from "./compare.js";
import { paintFocus } from "./focus.js";
import { go, generating, syncHash, tagFocus, clearFocus, parseHashParams } from "./nav.js";
import { renderSession } from "./session.js";
import { button, hint, thinking } from "./ui.js";

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
  // Map views to their nav items: the story page reads as the story map; the scaffold (the
  // new-story interview) reads as "+ New story", which is also its entry point; the chapter
  // preparation reads as the story map that launched it; the edit page reads as "story" too.
  const viewToNav = {
    shelf: "nav-shelf",
    story: "nav-story",
    scaffold: "nav-new",
    handoff: "nav-story",
    edit: "nav-story",
    live: "nav-live",
    read: "nav-read",
    readstory: "nav-readstory",
    compare: "nav-read",
    catalog: `nav-cat-${APP.catalog.kind || "characters"}`,
  };
  const currentNav = viewToNav[APP.view] || "nav-shelf";
  // Reachability is go()'s rule, not a second list of it: with no engine attached go() rewrites
  // everything but read/readstory/compare, so an item pointing anywhere else would land somewhere
  // other than where it says. Hide those rather than let them lie.
  const reachable = v => APP.live || v === "read" || v === "readstory" || v === "compare";
  for (const item of document.querySelectorAll("#sidenav .navitem")) {
    const isCurrent = item.id === currentNav;
    item.classList.toggle("current", isCurrent);
    item.setAttribute("aria-current", isCurrent ? "page" : "false");
    item.hidden = !reachable(item.dataset.view);
  }
  // A group whose every item is hidden would render as a bare heading, so it follows its children
  // rather than being hidden by name -- one rule, and a new item cannot forget to be counted.
  for (const g of document.querySelectorAll("#sidenav .navgroup"))
    g.hidden = ![...g.querySelectorAll(".navitem")].some(i => !i.hidden);
  $("tabdot").hidden = !(generating() || APP.awaitingReader);
  $("tabdot").classList.toggle("asked", APP.awaitingReader);
  $("tabasked").hidden = !APP.awaitingReader;
}

function renderHeader(blocks = []) {
  // Manuscript mode: show the story name, no cast, no engine question
  if (APP.view === "readstory") {
    const name = storyName(READER.dir) || basename(READER.dir) || "manuscript";
    $("title").textContent = name;
    $("question").textContent = "manuscript · " + name;
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
  // The header pills carry each character's chat shortcut: enabled while they have a consultation
  // in this run, which is what the consulted names below say.
  const consulted = new Set(blocks.filter(b => b.kind === "consult").map(b => String(b.who || "").toLowerCase()));
  $("cast").innerHTML = APP.view === "live" ? castChips(m.characters, m.story, m.chapter ?? null, consulted) : "";
  $("castcard").hidden = !(APP.view === "live" && m.characters?.length);
  // The authored sheet behind a pill's character card fetches once per story, first live frame --
  // so the card is full when a pill is clicked instead of filling in as it is read.
  if (APP.view === "live") ensureLiveCast();
}

function paintRibbon() {
  const el = $("ribbon");
  if (APP.view !== "read" || !READV.meta) { el.hidden = true; el.textContent = ""; return; }
  const who = basename(READV.meta.story) || "history";
  el.hidden = false;
  el.textContent = `history · ${who}${READV.label ? " · " + READV.label : ""}`;
}

function renderShelf(page, keepFocus) {
  page.innerHTML = pickerHtml();
  clearRail();
  // The new-story card opens the scaffold page (a route now, not a modal); an interview already
  // running on the server is continued there, not started again.
  wirePicker(page, () => go("story"), () => go("scaffold"), () => go("catalog"),
    dir => { go("readstory"); loadReader(dir); },
    dir => { APP.editDir = dir; go("edit"); });
  restoreFocus(page, keepFocus);
  setFoldable(false);
}

function renderScaffold(page, keepFocus) {
  page.innerHTML = scaffoldHtml();
  clearRail();
  wireScaffold(page); wireModal(page);
  restoreFocus(page, keepFocus);
  setFoldable(false);
}

function renderStoryPage(page) {
  page.innerHTML = storyPageHtml();
  clearRail();
  wireStoryPage(page);
  setFoldable(false);
}

function renderHandoff(page, keepFocus) {
  page.innerHTML = handoffPageHtml();
  clearRail();
  wireHandoff(page);
  restoreFocus(page, keepFocus);
  setFoldable(false);
}

// ---- create-then-return ------------------------------------------------------
// While the scaffold armed APP.catalog.returnTo, each of the three libraries it links to
// (characters, styles, tags) carries a way back. Prepended after the library's own HTML so it
// shows the whole visit — even while the list itself is a spinner or an error. Hidden when the
// scaffold is gone (abandoned or accepted elsewhere), since "your story" would point nowhere.
const returnToScaffoldArmed = () => APP.catalog.returnTo?.view === "scaffold" && !!APP.scaffold?.active;
function catalogReturnBannerHtml() {
  return `<div class="lib-return" data-tid="catalog.return-banner" role="status">`
    + `<span class="label">new story in progress</span>`
    + `<span>Creating for your story — it stays open underneath.</span>`
    + `${button({ label: "back to your story →", id: "lib-return", tidName: "catalog.return-btn" })}</div>`;
}
function wireCatalogReturnBanner(page) {
  if (!returnToScaffoldArmed()) return;
  page.insertAdjacentHTML("afterbegin", catalogReturnBannerHtml());
  page.querySelector("#lib-return")?.addEventListener("click", () => {
    APP.catalog.returnTo = null; APP.catalog.pendingSelect = null;
    go("scaffold");
  });
}

function renderCharacterLibrary(page, keepFocus) {
  page.innerHTML = characterLibraryHtml();
  clearRail();
  wireCharacterLibrary(page);
  wireCatalogReturnBanner(page);
  restoreFocus(page, keepFocus);
  setFoldable(false);
  loadCharacterLibrary();
}

function renderStyleLibrary(page, keepFocus) {
  page.innerHTML = styleLibraryHtml();
  clearRail();
  wireStyleLibrary(page);
  wireCatalogReturnBanner(page);
  restoreFocus(page, keepFocus);
  setFoldable(false);
  loadStyleLibrary();
}

function renderTagLibrary(page, keepFocus) {
  page.innerHTML = tagLibraryHtml();
  clearRail();
  wireTagLibrary(page);
  wireCatalogReturnBanner(page);
  restoreFocus(page, keepFocus);
  setFoldable(false);
  loadTagLibrary();
}

function renderSkillLibrary(page, keepFocus) {
  page.innerHTML = skillLibraryHtml();
  clearRail();
  wireSkillLibrary(page);
  restoreFocus(page, keepFocus);
  setFoldable(false);
  loadSkillLibrary();
}

function renderReader(page) {
  page.innerHTML = readerPageHtml();
  clearRail();
  wireReaderPage(page);
  setFoldable(false);
}

function renderComparison(page) {
  page.innerHTML = comparisonPageHtml();
  clearRail();
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
  clearRail();
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

/** The headline block. Story + chapter identity and the scene question come first: they
 *  are what the chapter exists to answer. The static explainer lede used to sit here on every
 *  frame and compete with the prose; it now lives nowhere on this screen. */
function liveHeaderHtml() {
  const m = LIVEV.meta;
  if (!m) return "";
  const where = m.chapters > 1 ? `chapter ${m.chapter} of ${m.chapters}` : "chapter";
  return `<div class="livehead page-title" data-tid="live.head">
    <p class="eyebrow">${esc(where)} · ${esc(storyName(m.story))}</p>
    <h2>${esc(m.question || "")}</h2>
  </div>`;
}

/** Titles reuse the app's own wording for each state rather than inventing a second vocabulary for
 *  the same thing -- "the writer wants your call" is what the reader card says, "the step budget
 *  is spent" what the budget prompt says. */
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
        ${thinking("loading the story and reaching the model — the first reply can take a while", { tag: "p" })}
        ${hint(`nothing needed. Safe to look around — the run keeps going, and <b>stop</b> appears in the run controls once it starts`)}
      </div>`;
    } else {
      const text = APP.live ? "The scene will appear here as soon as the engine starts writing."
                             : "Run the engine with <code>--serve</code> to watch a scene as it is written.";
      html = `<div class="empty" data-tid="live.empty"><h2>Nothing written yet</h2>
        <p>${text}</p>
        ${idle ? `<div class="btns" style="justify-content:center">
          ${button({ label: "choose a story", id: "go-shelf", tidName: "live.go-shelf-btn" })}</div>` : ""}
      </div>`;
    }
    page.innerHTML = html;
    clearRail();
    const gb = page.querySelector("#go-shelf");
    if (gb) gb.addEventListener("click", () => go("shelf"));
    setFoldable(false);
    return;
  }
  const target = LIVEV.meta?.target || 0;
  const words = LIVEV.events.filter(e => e.t === "draft").reduce((n, e) => Math.max(n, e.words || 0), 0);
  const phase = phaseOf(LIVEV);
  // A pending author decision outranks the stream: surface it above the prose as its own banner
  // (the reader card itself still renders inline, unchanged, further down).
  const pending = blocks.filter(b => b.kind === "reader" && b.answer === null).length;
  const decision = pending
    ? `<div class="livedecision" data-tid="live.decision" role="status"><span class="label">needs your call</span>` +
      `<span>${pending === 1 ? "The writer is waiting on one choice below." : `The writer is waiting on ${pending} choices below.`} The run waits as long as needed.</span></div>`
    : "";
  // Writer-first prose card: the head carries identity (phase) + one quiet progress line (words).
  // Step number, consult counts and the interactive/hands-off mode used to sit here as chips at
  // the same visual weight as the prose; they now live in the rail's Run details disclosure.
  page.innerHTML = liveHeaderHtml() + decision + `<section ${tid("live.prose-card")} class="prosecard">
    <div class="head">
      <div><span class="label">live prose</span><h3>${esc(PHASE_TITLE[phase] || "The scene so far")}</h3></div>
      <span class="label livewords" data-tid="live.words">${esc(target ? `${words} / ${target} words` : `${words} words`)}</span>
    </div>
    <div class="body">
      <div class="prose">` + renderBlocks(blocks, true) + `</div>
    </div>
  </section>`;
  wireConsultToggles(page);
  wireConsultInspectButtons(page);
  wireReader(page);
  setFoldable(blocks.some(b => b.kind === "consult"));
  renderRail(LIVEV, blocks);
}
function renderRead(page, blocks) {
  const chrome = readChromeHtml();
  if (!blocks.length) {
    // A run CAN load fine and still have nothing to show -- a run killed before its first draft
    // leaves a log holding only `scene_start`. Saying "nothing loaded" there blames the wrong thing
    // and reads like a failed fetch, so an empty run says it is empty.
    const empty = READV.events.length > 0;
    // The incomplete run keeps its machine identity one disclosure down -- the meaning and the
    // next step stay the headline.
    const emptyTech = empty && READV.id
      ? `<details class="engine-details read-empty-tech" data-tid="read.empty-tech"><summary>Technical details</summary>`
        + `<div class="tech">run ${esc(READV.id)}${READV.dir ? ` · ${esc(READV.dir)}` : ""}</div></details>` : "";
    page.innerHTML = chrome + `<div class="empty" data-tid="read.empty"><h2>${empty ? "This run is empty" : "Nothing loaded"}</h2>
      <p>${empty ? `${esc(READV.label || "it")} — the run was stopped before a word of it was written.
             Pick an earlier one, which may have more in it.`
                  : `Open a story on the shelf and "read" a run from its history, drop a saved
              <code>out/writing-log.jsonl</code> onto this page, or open one from disk.`}</p>${emptyTech}</div>`;
    clearRail();
    wireSavedRuns(page);
    setFoldable(false);
    return;
  }
  page.innerHTML = chrome + `<div class="prose">` + renderBlocks(blocks, false) + `</div>`;
  wireConsultToggles(page);
  wireConsultInspectButtons(page);
  wireSavedRuns(page);
  // "Compare this run" preselects the run on screen; prepareComparison defaults the other side
  // to a mate from the same chapter (story-page.js: the same pairing rule as the history rows).
  const cmp = page.querySelector("#read-compare");
  if (cmp) cmp.addEventListener("click", () => {
    prepareComparison(READV.dir, READV.id);
    go("compare");
    loadComparisonRuns();
  });
  setFoldable(blocks.some(b => b.kind === "consult"));
  renderRail(READV, blocks);
}

/** Backdrop click on the idea modal returns to the shelf -- the interview lives on the server, so
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

/** Lifecycle deep link: `#/scaffold?step=` scrolls to the first matching stage section once it
 *  exists on screen. Inbound only — syncHash keeps writing the bare `#/scaffold`, so repaints
 *  never leak the step into the URL. Fires once per step value (SSE repaints must not yank the
 *  page back); a step with no matching section — structure on the one-shot walk, which has no
 *  structure stage — simply never fires. The six keys are the same six stages the stepper and
 *  breadcrumb show (hud.js:scaffoldLifecycle), so a deep link and the page it lands on always
 *  agree on what to call the moment. */
const STEP_SECTIONS = {
  idea: ["idea"],
  direction: ["direction"],
  castworld: ["castworld"],
  structure: ["structure"],
  review: ["review"],
  accept: ["handoff"],
};
function settleStep(page) {
  if (APP.view !== "scaffold") { APP.stepScrolledFor = null; return; }
  const step = (parseHashParams().get("step") || "").toLowerCase();
  if (!STEP_SECTIONS[step] || APP.stepScrolledFor === step) return;
  const t = STEP_SECTIONS[step].map(k => page.querySelector(`[data-stage="${k}"]`)).find(Boolean);
  if (!t) return;                       // stage not on screen yet -- retry on a later frame
  APP.stepScrolledFor = step;
  scrollToEl(t);
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
  scrollToEl(t, "center");
}

/** Repainted every render(), regardless of view -- the header pill that opens the character card is
 *  visible on the live and read pages too, not just the shelf, so neither modal can live inside
 *  `#page` like the interview's does. Modals stack in order of increasing z-index: run-ended,
 *  character card, then picker as the topmost active task. The consultation inspector paints with
 *  them but is modeless -- a floating panel with no backdrop, below every modal -- and reads the
 *  blocks the current view just built, so it always shows the run on screen. Owned here rather
 *  than by the modals' own modules, since painting "every overlay" isn't any one's job. */
function paintModals(goShelf, blocks) {
  const root = $("modalroot");
  // A styled confirm (ui.js confirmDialog) owns a promise that settles on click/backdrop/Escape --
  // a repaint clearing #modalroot would strand that promise forever (the backdrop is gone but the
  // await never resolves). Detach it across the repaint and re-append it topmost.
  const confirm = root.querySelector("#confirm-backdrop");
  if (confirm) confirm.remove();
  const inspect = consultInspectorHtml(blocks);
  if (!APP.runEnded && !APP.charCard && !APP.picker.open && !inspect) { if (root.innerHTML) root.innerHTML = ""; }
  else {
    root.innerHTML = runEndedModalHtml() + characterCardModalHtml() + libraryPickerHtml() + inspect;
    wireRunEndedModal(root, goShelf);
    wireCharacterCard(root);
    wireLibraryPicker(root);
    wireConsultInspector(root);
  }
  if (confirm) root.appendChild(confirm);
}

export function render() {
  renderNav();
  paintFocus();
  const store = APP.view === "live" ? LIVEV : APP.view === "read" ? READV : null;
  const blocks = store ? build(store) : [];
  renderHeader(blocks);
  renderSession();
  paintSrcbar();
  paintRibbon();
  paintTitle();
  // A pending &modal= resolves against the PREVIOUS frame's chips -- they are still in the DOM
  // here, before the page below repaints -- so the card paints in this same pass. A pending
  // &inspect= resolves against the blocks just built instead: the run they name may still be
  // loading, in which case it stays pending for a later frame.
  settleModalWant();
  if (store && (APP.view === "live" || APP.view === "read")) settleInspectWant(blocks, APP.view, store);
  // The run-ended modal returns to the story that ran -- the next chapter, the manuscript
  // and the history all live there, not on the shelf. The shelf stays one sidenav click away.
  paintModals(() => {
    if (!APP.storyDir && LIVEV.meta?.story) APP.storyDir = LIVEV.meta.story;
    go(APP.storyDir ? "story" : "shelf");
  }, blocks);
  const page = $("page");
  const active = document.activeElement;
  const keepFocus = active && FIELDS.test(active.id || "") ? active.id : "";
  // Whatever inside #page had focus is about to be rebuilt -- during a live run that is every
  // SSE frame. Remember it (by id, or by consult seq for summaries, which carry none) so a
  // focus genuinely destroyed by the rebuild can be put back below.
  const focusEl = active instanceof HTMLElement && page.contains(active) ? active : null;
  const seqHost = focusEl && focusEl.tagName === "SUMMARY" ? focusEl.closest("details.consult") : null;
  const doomed = focusEl ? {
    id: focusEl.id || "",
    seq: seqHost instanceof HTMLElement ? seqHost.dataset.seq ?? "" : "",
    start: typeof focusEl.selectionStart === "number" ? focusEl.selectionStart : null,
    end: typeof focusEl.selectionEnd === "number" ? focusEl.selectionEnd : null,
  } : null;
  if (APP.view === "shelf") renderShelf(page, keepFocus);
  else if (APP.view === "story") renderStoryPage(page);
  else if (APP.view === "handoff") renderHandoff(page, keepFocus);
   else if (APP.view === "catalog" && APP.catalog.kind === "characters") renderCharacterLibrary(page, keepFocus);
   else if (APP.view === "catalog" && APP.catalog.kind === "styles") renderStyleLibrary(page, keepFocus);
   else if (APP.view === "catalog" && APP.catalog.kind === "skills") renderSkillLibrary(page, keepFocus);
  else if (APP.view === "catalog") renderTagLibrary(page, keepFocus);
  else if (APP.view === "compare") renderComparison(page);
  else if (APP.view === "edit") renderEdit(page);
  else if (APP.view === "scaffold") renderScaffold(page, keepFocus);
  else if (APP.view === "readstory") renderReader(page);
  else if (APP.view === "read") renderRead(page, blocks);
  else renderLive(page, blocks);
  // The rebuild drops whatever inside #page had focus. When focus truly died with it (it fell
  // back to <body>, rather than moving somewhere on purpose), put it back -- caret and all.
  // Views that restore their own focus above already refocused, so this is a no-op for them.
  if (doomed && (doomed.id || doomed.seq) && document.activeElement === document.body) {
    const el = doomed.id ? document.getElementById(doomed.id)
      : page.querySelector(`details.consult[data-seq="${Number(doomed.seq)}"] > summary`);
    if (el) {
      el.focus();
      if (doomed.start != null) {
        try { el.setSelectionRange(doomed.start, doomed.end); } catch { /* not a text field */ }
      }
    }
  }
  // Empty on the shelf/story/handoff pages -- an empty bordered card with just a header is worse
  // than no card at all. The engine disclosure needs no such toggle: an empty div renders as
  // nothing on its own, and it lives outside any card (hud.js:renderRail).
  $("runctrl").hidden = $("sessionbar").hidden;
  $("runscene").hidden = !$("railstatus").innerHTML;
  renderTimeline(blocks);
  wireTimeline();
  // The scroll needs the NEW DOM, so it runs after the page above is painted. syncHash last:
  // every state change above (focus tag/clear, modal want) lands in the address bar without each
  // mutator having to remember to call it. replaceState-only, so nothing re-enters go().
  settleFocus(page);
  settleStep(page);
  // View-enter animation, navigation only: go() sets the flag, SSE repaints never do, so a
  // mid-run rebuild never replays it. Reflow between remove/add restarts the keyframes.
  if (APP.wantViewEnter) {
    APP.wantViewEnter = false;
    page.classList.remove("view-enter");
    void page.offsetWidth;
    page.classList.add("view-enter");
  }
  syncHash();
}
