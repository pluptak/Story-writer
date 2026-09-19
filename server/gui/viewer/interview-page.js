/**
 * INTERVIEW PAGE — the scaffold interview's page assembly, posting and wiring: open stages,
 * the whole-page render entry points (`scaffoldHtml`, `wireScaffold`, the `disarm*` timers
 * `sse.js` calls), and every event handler. Pure HTML builders live in interview.js and are
 * imported here; `postScaffold` lives there too, since the revert helpers post through it.
 */
import { $, esc, slugify, armConfirm } from "./util.js";
import { APP, draft } from "./state.js";
import { go } from "./nav.js";
import { loadStories } from "./saved-runs.js";
import { loadVocab, loadLibrary, loadStyles } from "./catalog.js";
import { button, hint, thinking, pageTitle, storyNote } from "./ui.js";
import { on, onKey } from "./wire.js";
import {
  STAGES, STAGE_LABELS, MAX_IMPORTS, goCatalogFromScaffold,
  directionPickersHtml, castworldPickersHtml, ideaModalHtml, technicalHtml,
  composerHtml, stageSection, lockedSection, doneSection, stageOf, stageIndex,
  stagesHtml, statusBlock, findingsHtml, bibleCardHtml, directionBits,
  castworldBits, structureBits, reviewDecisionsHtml, reviewBlueprintDetails,
  folderHtml, folderTaken, folderNoteHtml, regenRowHtml, revertRowHtml,
  cloneJson, revertPlan, revertOne, rejectEntriesOf, addedEntryFor, fieldEntryFor,
  postScaffold,
} from "./interview.js";

// ── open stages ─────────────────────────────────────────────────────────────
// One open stage at a time. Each shows what is decided, what still needs a decision, what was
// generated, what can be edited, and what happens next. The approve button passes the backend
// gate exactly as before -- only its home changed.

function openDirection(s) {
  const next = s.mode === "oneshot"
    ? "The proposal covers the whole story — continue to review."
    : "Accept the direction to assemble the cast against it.";
  return stageSection(s, "direction", {
    primary: directionBits(s),
    action: directionPickersHtml(s) + composerHtml(s, "What should change about the direction?"),
    next,
    advanced: findingsHtml(s) + regenRowHtml(s) + revertRowHtml(s),
  });
}

function openCastworld(s) {
  const next = s.gate === "settings"
    ? "Accept the style to shape the structure."
    : "Accept the cast to decide the style.";
  return stageSection(s, "castworld", {
    primary: castworldBits(s),
    action: castworldPickersHtml(s) + composerHtml(s, "What should change about the cast or style?"),
    next,
    advanced: findingsHtml(s) + regenRowHtml(s) + revertRowHtml(s),
  });
}

function openStructure(s) {
  const next = s.gate === "technical"
    ? "Nothing to configure here — approve to continue to scene 1."
    : s.gate === "world"
    ? "Accept the world to review the whole Blueprint."
    : "Accept to continue shaping the structure.";
  // Run config genuinely has nothing to decide (technicalHtml mostly just says so), so it lives
  // in Advanced rather than competing with the scene and world-ledger content for the eye.
  const tech = technicalHtml(s.spec) || hint(`Run settings come from the defaults — nothing to decide here.`);
  return stageSection(s, "structure", {
    primary: structureBits(s),
    action: composerHtml(s, "What should change about the structure?"),
    next,
    advanced: tech + findingsHtml(s) + regenRowHtml(s) + revertRowHtml(s),
  });
}

function openProposal(s) {
  // The one-shot walk: one complete proposal covers direction, cast and structure at once.
  // reviewDecisionsHtml() is the same curated distillation Review uses -- one-shot's single stage
  // IS "the whole story," the same shape Review already handles well -- with the full flat dump
  // (what reviewBits() used to render inline) demoted into the same collapsed blueprint Review uses.
  return stageSection(s, "direction", {
    primary: reviewDecisionsHtml(s),
    action: composerHtml(s, "What should change about the proposal?"),
    next: "The proposal covers the whole story — continue to review.",
    advanced: reviewBlueprintDetails(s) + regenRowHtml(s) + revertRowHtml(s),
  });
}

function openReview(s) {
  const acceptable = s.haveStory && !s.needsFolder && !APP.folderOpen && !s.busy;
  const unsent = !!draft.say.trim();
  const flags = (s.problems || []).length;
  const acceptLabel = !APP.acceptArmed ? "Approve the Blueprint →"
    : unsent ? "discard what you typed and approve"
    : `approve over ${flags} flag(s)`;
  const actions = [
    acceptable ? button({ label: acceptLabel, id: "iv-accept", variant: "primary",
      extraClass: APP.acceptArmed ? "armed" : "" }) : "",
  ].filter(Boolean).join("");
  return stageSection(s, "review", {
    primary: statusBlock(s) + reviewDecisionsHtml(s) + reviewBlueprintDetails(s) + bibleCardHtml(s),
    action: composerHtml(s, "What needs fixing before approval?")
      + revertRowHtml(s)
      + (actions ? `<div class="side-actions">${actions}</div>` : ""),
    next: "Approval opens Accept: name the folder, write story.json, start chapter 1.",
  });
}

function openHandoff(s) {
  return stageSection(s, "handoff", {
    primary: folderHtml(s),
    next: "Start writing opens chapter 1 with the Writer, from this Blueprint exactly.",
  });
}

function openIdeaWorking(s) {
  return stageSection(s, "idea", {
    primary: statusBlock(s) + hint(`The architect is reading your idea — the direction lands here first.`),
    action: composerHtml(s, "Say more about it"),
    next: "The direction lands first then the cast, style and structure.",
  });
}

// ── page assembly ─────────────────────────────────────────────────────────────

function activePageHtml(s) {
  const open = stageOf(s);
  const cur = stageIndex(open);
  const err = APP.scaffoldError ? storyNote({ meaning: "Couldn't do that — nothing changed.",
    detail: esc(APP.scaffoldError) }) : "";

  const statusText = s.busy ? "the architect is working…"
    : s.pendingAsk ? "a question stands — answer it to continue"
    : open === "handoff" ? "name the folder — nothing is written until you do"
    : open === "review" ? "read it whole — approve the Blueprint when it holds"
    : "nothing is on disk until you accept";
  const meta = STAGES[cur];

  // One open stage, the rest decided or locked. Passed stages collapse to what they decided;
  // upcoming stages name what they wait on. The open stage carries the round, the pickers and
  // the composer -- nothing is repeated anywhere else.
  const locks = {
    idea: "Propose the idea first.",
    direction: "Propose the idea first.",
    castworld: "Decide the direction first.",
    structure: "Choose the cast and style first.",
    review: s.mode === "oneshot"
      ? "The proposal lands first."
      : "Shape the structure first — approve through the world gate.",
    handoff: "Approve the Blueprint in review first.",
  };
  const flow = [];
  for (const t of STAGES) {
    const i = stageIndex(t.key);
    if (i < cur) { flow.push(doneSection(s, t.key)); continue; }
    if (i > cur) { flow.push(lockedSection(t.key, locks[t.key])); continue; }
    if (t.key === "idea") flow.push(openIdeaWorking(s));
    else if (t.key === "direction")
      flow.push(s.mode === "oneshot" ? openProposal(s) : openDirection(s));
    else if (t.key === "castworld") flow.push(openCastworld(s));
    else if (t.key === "structure") flow.push(openStructure(s));
    else if (t.key === "review") flow.push(openReview(s));
    else flow.push(openHandoff(s));
  }

  return `
    ${pageTitle({ eyebrow: `architect · ${s.mode === "oneshot" ? "one-shot" : "staged"}`,
      title: meta.q, lede: s.idea || "", extraClass: "sc-head" })}
    <div class="statusbar">
      <span class="status-dot${s.busy ? " busy" : ""}"></span>
      <span>step ${cur + 1} of 6 · ${esc(STAGE_LABELS[meta.key])} — ${statusText}</span>
      <span class="spacer">${s.mode === "oneshot" ? "one-shot walk" : "staged walk"}</span>
      ${s.haveStory && !s.needsFolder && !APP.folderOpen ? button({ label: "edit in full →", id: "iv-edit",
        title: "Edit this same Blueprint field-by-field instead of through conversation — nothing is written until you accept." }) : ""}
      ${button({ label: APP.abandonArmed ? "abandon — sure?" : "abandon", id: "iv-abandon",
        variant: "danger", extraClass: APP.abandonArmed ? "armed" : "" })}
    </div>
    ${stagesHtml(s)}
    <div class="stage-flow">${err}${flow.join("")}</div>`;
}

/** The whole page. An accept in flight shows a writing state rather than falling back to the idea
 *  modal in the window between the {active:false} SSE frame and the run starting. */
function scaffoldPageHtml() {
  const s = APP.scaffold;
  if (APP.scaffoldAccepting) {
    return `<div class="scpage"><div class="shell"><div class="workspace"><section class="card">
      <div class="card-body">${thinking("writing story.json and preflighting…", { tag: "p" })}</div>
    </section></div></div></div>`;
  }
  if (!s.active) {
    return `<div class="scpage">
      ${pageTitle({ eyebrow: "scaffold interview", title: "Nothing proposed yet",
        lede: "Describe an idea below. The editor stays empty until the first proposal lands.",
        extraClass: "sc-head" })}
      ${ideaModalHtml()}
    </div>`;
  }
  return `<div class="scpage">${activePageHtml(s)}</div>`;
}

// The render entry point. `pages.js` calls these two.
export function scaffoldHtml() { return scaffoldPageHtml(); }

// ── posting & wiring ──────────────────────────────────────────────────────────
// postScaffold lives in interview.js (the revert helpers post through it).

/** Also called from `sse.js`: a `scaffold` SSE frame with no problems left disarms the
 *  accept-over-a-complaint confirmation, the same as clicking through it. */
export const disarmAccept  = () => { clearTimeout(APP.acceptArmed);  APP.acceptArmed  = 0; APP.render(); };
/** Also called from `sse.js`: any scaffold frame whose last round is no longer `blocked` means the
 *  gate moved on, so an armed override must not survive to overrule a later gate by accident. */
export const disarmApprove = () => { clearTimeout(APP.approveArmed); APP.approveArmed = 0; };


/** A change, sent. The text stays in the draft until the round actually lands, so a 409 or dropped
 *  connection doesn't lose what you had written with nothing said about it. */
async function sendSay() {
  const text = draft.say.trim();
  if (!text || APP.scaffold.busy) return;
  const j = await postScaffold("say", { text });
  if (j && j.active !== undefined) { draft.say = ""; APP.render(); }
}

/** A fresh take on the open stage, requested. Re-running keeps the conversation, so this is a
 *  proposal that remembers the refinements — never a reset. */
async function regenStage() {
  if (APP.scaffold.busy) return;
  await postScaffold("regenerate", {});
}

/** Put back exactly what the latest edits round changed, verified field by field against the
 *  draft before anything is written. A revert that cannot verify every field explains why
 *  instead of putting half a round back. */
async function revertRound() {
  const s = APP.scaffold;
  if (!s || s.busy || !s.last || s.last.kind !== "edits" || !s.storyDraft) return;
  const plan = revertPlan(s.last.applied || [], s.storyDraft);
  if (!plan.ok) { APP.scaffoldError = `cannot revert this round: ${plan.reason}`; APP.render(); return; }
  const patched = cloneJson(s.storyDraft);
  plan.apply(patched);
  await postScaffold("set", { story: patched, source: "revert" });
}

/** Block C: structured goal/knows edit for one cast member. Same whole-draft-replace path as
 *  revertRound(), so setSpec()/normalizeSpec() validates it — matched by name, the key both
 *  surfaces render into data-role-name. A change that somehow fires while busy (the inputs are
 *  disabled then) re-renders the authoritative value instead of posting over a running gate. */
async function setCharacterField(name, field, value) {
  const s = APP.scaffold;
  if (!s || s.busy || !s.storyDraft || (field !== "goal" && field !== "knows")) { APP.render(); return; }
  const patched = cloneJson(s.storyDraft);
  const c = (patched.characters || []).find(c => c.name === name);
  if (!c) { APP.render(); return; }
  c[field] = value;
  await postScaffold("set", { story: patched, source: "role" });
}

async function startInterview() {
  const idea = draft.idea.trim();
  if (!idea || APP.scaffold.busy) return;
  const mode = draft.mode === "oneshot" ? "oneshot" : "staged";
  APP.scaffoldError = "";
  APP.folderOpen = false;
  APP.scaffoldInspect = null;
  APP.catalog.returnTo = null; APP.catalog.pendingSelect = null;
  APP.scaffold = { active:true, busy:true, idea, problems:[], haveStory:false, model:draft.model,
                   mode, gate: mode === "staged" ? "story" : null };
  APP.render();
  // The idea travels alone now: kind, cast and voice are decided in their own stages, where the
  // choice can see what it steers.
  const j = await postScaffold("start", { idea, model: draft.model, mode });
  // A refusal leaves the page holding an optimistic "busy" that nothing will ever clear -- fall
  // back to an inactive session so the idea modal comes back with the idea still in it.
  if (!j || j.active === undefined) { APP.scaffold = { active:false }; APP.render(); }
}

function acceptStory() {
  // Two things make accepting deliberate. UNSENT TEXT: the story is written from the spec, so
  // whatever is still in the box would be silently thrown away. A COMPLAINT: accepting over it is
  // allowed -- they are judgements about the design -- but takes a confirming second click.
  const unsent = !!draft.say.trim();
  const flagged = !!(APP.scaffold.problems && APP.scaffold.problems.length);
  if ((unsent || flagged) && !APP.acceptArmed) { APP.acceptArmed = setTimeout(disarmAccept, 5000); APP.render(); return; }
  if (APP.scaffold.busy) return;
  clearTimeout(APP.acceptArmed); APP.acceptArmed = 0;
  // The folder defaults to the title slug — the engine still requires an explicit name, and
  // refuses a taken one, so this only saves typing, never decides.
  if (!draft.folder.trim()) draft.folder = slugify(APP.scaffold.spec?.title || "");
  // Open the folder step; "Start writing" owns the actual accept and the run it starts. The
  // shelf's story list is what the taken-folder check reads, and the scaffold page never loads it.
  APP.folderOpen = true; APP.render();
  loadStories();
}

/** Accept into a named folder — the answer to needs_folder. A blank name is not an answer. */
async function acceptIntoFolder() {
  const folder = draft.folder.trim();
  if (!folder || APP.scaffold.busy) return;
  APP.scaffoldAccepting = true; APP.render();
  const j = await postScaffold("accept", { folder });
  if (j && j.ok) { draft.idea = draft.say = draft.folder = ""; APP.scaffoldAccepting = false; APP.folderOpen = false; APP.scaffoldInspect = null; APP.catalog.returnTo = null; APP.catalog.pendingSelect = null; go("live"); }
  // A refusal is usually needs_folder, which forces the step open without going through
  // acceptStory() -- so the taken-folder check needs the story list fetched here too.
  else { APP.scaffoldAccepting = false; APP.render(); loadStories(); }
}

export function wireScaffold(page) {
  const plain = e => !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing;

  // Keep what is being typed across the re-renders SSE frames cause.
  for (const [id, key] of [["f-idea","idea"], ["f-say","say"], ["f-folder","folder"]]) {    const el = page.querySelector("#" + id);
    // A full render on every keystroke would fight the caret, so the folder step updates its own
    // two dependent nodes in place instead.
    if (el) el.addEventListener("input", () => {
      draft[key] = el.value;
      if (key !== "folder") return;
      const note = $("iv-folder-note"), write = $("iv-folder");
      if (note) note.innerHTML = folderNoteHtml();
      if (write) write.disabled = folderTaken();
    });
  }
  const model = page.querySelector("#f-model");
  if (model) model.addEventListener("change", () => { draft.model = model.value; });
  for (const b of page.querySelectorAll("[data-promote]"))
    b.addEventListener("click", () => postScaffold("promote", { name: b.getAttribute("data-promote") }));
  for (const r of page.querySelectorAll('input[name="mode"]'))
    r.addEventListener("change", () => { if (r.checked) { draft.mode = r.value; APP.render(); } });

  // The pickers read the catalogs, fetched once each; each loader re-renders when it lands, so a
  // picker fills itself in rather than staying empty on a cold first open.
  if (page.querySelector(".scpage")) {
    loadVocab();
    loadLibrary();
    loadStyles();
  }

  // Catalog pickers post straight to the session -- the session is the truth, there is no
  // draft to save. The concept route replaces each half wholesale, so every post carries the
  // session's current values with one half changed; omitted would mean cleared.
  const sessionConcept = () => {
    const c = APP.scaffold.concept || {};
    return { tags: [...(c.tags || [])], castSize: c.castSize || 0, styleId: c.styleId || "" };
  };
  const sessionTray = () => (APP.scaffold.concept?.imported || []).map(i => i.libraryId);

  // Outbound to a library from the scaffold: arm the return loop, then go. The kind is set
  // explicitly because the hash alone doesn't carry it (nav.js routes on path only).
  for (const b of page.querySelectorAll("[data-goto-catalog]"))
    b.addEventListener("click", () => goCatalogFromScaffold(b.getAttribute("data-goto-catalog")));

  // Create-then-return: a library save armed pendingSelect and navigated back. The loaders above
  // refetch the invalidated caches; once the new entry is visible, fire the same POST its chip
  // would send — once. Consumed before posting so the SSE re-renders (which re-run this wiring)
  // never re-fire it. While the entry hasn't landed the flag is kept for a later frame; a settled
  // cache that still lacks it means it never lands (failed refetch, deleted meanwhile), so the
  // one-shot is dropped rather than carried stale into some later visit. A dead scaffold, or an
  // unknown kind, just clears it.
  const pend = APP.catalog.pendingSelect;
  if (pend && page.querySelector(".scpage")) {
    if (!APP.scaffold?.active) { APP.catalog.pendingSelect = null; APP.catalog.returnTo = null; }
    else if (!APP.scaffold.busy) {
      if (pend.kind === "characters") {
        const target = (APP.catalog.library || []).find(x => x.id === pend.selectId);
        if (target) {
          APP.catalog.pendingSelect = null;
          const ids = sessionTray();
          if (!ids.includes(target.id) && ids.length < MAX_IMPORTS)
            postScaffold("import", { importIds: [...ids, target.id] });
        } else if (loadLibrary.settled()) APP.catalog.pendingSelect = null;
      } else if (pend.kind === "styles") {
        const target = (APP.catalog.styles || []).find(x => x.id === pend.selectId);
        if (target) {
          APP.catalog.pendingSelect = null;
          if (sessionConcept().styleId !== target.id)
            postScaffold("concept", { ...sessionConcept(), styleId: target.id });
        } else if (loadStyles.settled()) APP.catalog.pendingSelect = null;
      } else if (pend.kind === "tags") {
        const target = (APP.catalog.vocab || []).find(t => t.label === pend.selectLabel);
        if (target) {
          APP.catalog.pendingSelect = null;
          const concept = sessionConcept();
          if (!concept.tags.includes(target.label))
            postScaffold("concept", { ...concept, tags: [...concept.tags, target.label] });
        } else if (loadVocab.settled()) APP.catalog.pendingSelect = null;
      } else { APP.catalog.pendingSelect = null; }
    }
  }

  for (const chip of page.querySelectorAll(".cat-chip[data-tag-label]"))
    chip.addEventListener("click", () => {
      if (APP.scaffold.busy) return;
      const label = chip.getAttribute("data-tag-label");
      const tags = sessionConcept().tags;
      const at = tags.indexOf(label);
      if (at >= 0) tags.splice(at, 1); else tags.push(label);
      postScaffold("concept", { ...sessionConcept(), tags });
    });

  for (const chip of page.querySelectorAll(".cat-chip[data-import-id]"))
    chip.addEventListener("click", () => {
      if (APP.scaffold.busy) return;
      const id = chip.getAttribute("data-import-id");
      const ids = sessionTray();
      const at = ids.indexOf(id);
      if (at >= 0) ids.splice(at, 1);
      else if (ids.length < MAX_IMPORTS) ids.push(id);
      postScaffold("import", { importIds: ids });
    });
  for (const b of page.querySelectorAll("[data-remove-import]"))
    b.addEventListener("click", () => {
      if (APP.scaffold.busy) return;
      const id = b.getAttribute("data-remove-import");
      postScaffold("import", { importIds: sessionTray().filter(x => x !== id) });
    });
  // One at a time, and clicking the chosen one clears it: "no preset" is a real answer, not the
  // absence of one, and it is what the settings gate did before this existed.
  for (const chip of page.querySelectorAll(".cat-chip[data-style-id]"))
    chip.addEventListener("click", () => {
      if (APP.scaffold.busy) return;
      const id = chip.getAttribute("data-style-id");
      postScaffold("concept", { ...sessionConcept(), styleId: sessionConcept().styleId === id ? "" : id });
    });
  for (const b of page.querySelectorAll("[data-clear-style]"))
    b.addEventListener("click", () => {
      if (APP.scaffold.busy) return;
      postScaffold("concept", { ...sessionConcept(), styleId: "" });
    });
  // Block C: commit on change (blur/Enter), one whole-draft POST per field edit — never mid-keystroke,
  // so the SSE re-render the post causes cannot steal typing.
  for (const el of page.querySelectorAll("[data-role-field]"))
    el.addEventListener("change", () => {
      setCharacterField(el.getAttribute("data-role-name") || "",
        el.getAttribute("data-role-field") || "", el.value);
    });
  // Block F: one member reconsidered, everything else untouched by construction. The button only
  // renders at the staged cast gate; the route re-validates the scope, so this posts blind.
  for (const b of page.querySelectorAll("[data-regen-character]"))
    b.addEventListener("click", () => {
      if (APP.scaffold.busy) return;
      postScaffold("regenerate", { scope: { kind: "character", name: b.getAttribute("data-regen-character") || "" } });
    });
  // Block G: put one generated item back — a member, or a single goal/knows value. The entry is
  // re-matched at click time against the live last round, so a stale button can never fire.
  for (const b of page.querySelectorAll("[data-reject-character]"))
    b.addEventListener("click", () => {
      if (APP.scaffold.busy) return;
      const entry = addedEntryFor(rejectEntriesOf(APP.scaffold),
        b.getAttribute("data-reject-character") || "");
      if (entry) revertOne(entry);
      else APP.render();
    });
  for (const b of page.querySelectorAll("[data-reject-field]"))
    b.addEventListener("click", () => {
      if (APP.scaffold.busy) return;
      const entry = fieldEntryFor(rejectEntriesOf(APP.scaffold),
        b.getAttribute("data-reject-name") || "", b.getAttribute("data-reject-field") || "");
      if (entry) revertOne(entry);
      else APP.render();
    });
  // Inspect-before-select: the ⓘ beside a chip previews that candidate in the one shared panel
  // below its row. Local UI only — never posts, never changes selection. Selecting stays chip-only.
  for (const b of page.querySelectorAll("[data-inspect-import],[data-inspect-style]"))
    b.addEventListener("click", e => {
      e.stopPropagation();
      const isImport = b.hasAttribute("data-inspect-import");
      const kind = isImport ? "import" : "style";
      const id = b.getAttribute(isImport ? "data-inspect-import" : "data-inspect-style");
      const cur = APP.scaffoldInspect;
      APP.scaffoldInspect = (cur && cur.kind === kind && cur.id === id) ? null : { kind, id };
      APP.render();
    });

  const cast = page.querySelector("#f-cast-size");
  if (cast) cast.addEventListener("change", () => {
    if (APP.scaffold.busy) return;
    postScaffold("concept", { ...sessionConcept(), castSize: Number(cast.value) || 0 });
  });

  // Enter sends; the idea box is a paragraph, so there the modifier sends and Enter is a newline.
  onKey(page, "f-say", e => { if (e.key === "Enter" && plain(e)) { e.preventDefault(); sendSay(); } });
  onKey(page, "f-idea", e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); startInterview(); } });
  onKey(page, "f-folder", e => { if (e.key === "Enter" && plain(e)) { e.preventDefault(); acceptIntoFolder(); } });

  on(page, "iv-back", () => go("shelf"));
  on(page, "iv-start", startInterview);
  on(page, "iv-say", sendSay);
  on(page, "iv-regen", regenStage);
  on(page, "iv-revert", revertRound);
  on(page, "iv-approve", async () => {
    // The gate's explicit pass: one click opens the next stage. A double-click must not POST twice.
    if (APP.scaffold.busy) return;
    // Unlike accept, the first click discovers the block -- so the override is armed by the reply,
    // not by a check before sending, and the second click is what carries it.
    const override = !!APP.approveArmed;
    disarmApprove();
    const j = await postScaffold("approve", override ? { override: true } : {});
    if (!override && j && j.last && j.last.kind === "blocked") {
      APP.approveArmed = setTimeout(() => { disarmApprove(); APP.render(); }, 8000);
      APP.render();
    }
  });
  on(page, "iv-edit", () => {
    // The optional full editor for the same in-memory draft -- it syncs back through /scaffold/set.
    APP.editNew = true; APP.editDir = "";
    go("edit");
  });
  on(page, "iv-abandon", () => {
    // Abandoning throws away the whole interview; nothing on the server keeps a copy, so it gets
    // a confirming second click (armConfirm).
    armConfirm({
      get: () => APP.abandonArmed,
      set: v => { APP.abandonArmed = v; APP.render(); },
      ms: 4000,
      action: () => postScaffold("abandon", {}).then(() => {
        APP.scaffold = { active:false }; APP.scaffoldError = ""; APP.folderOpen = false;
        APP.scaffoldInspect = null;
        APP.catalog.returnTo = null; APP.catalog.pendingSelect = null;
        draft.idea = draft.say = draft.folder = "";
        draft.tags = [];
        draft.castSize = 0;
        draft.importIds = [];
        draft.styleId = "";
        go("shelf");
      }),
    });
  });
  on(page, "iv-folder", acceptIntoFolder);
  on(page, "iv-folder-back", () => {
    // Only the locally-opened step can be dismissed -- a needs_folder demand stays until answered.
    APP.folderOpen = false; APP.render();
  });
  on(page, "iv-save-leave", () => {
    // Leave the session live on the server and step out: the shelf's resume panel shows it, and
    // the interview continues where it stood. Nothing is written, nothing is abandoned.
    APP.folderOpen = false; go("shelf");
  });
  on(page, "iv-accept", acceptStory);
}
