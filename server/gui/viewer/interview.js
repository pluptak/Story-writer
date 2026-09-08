import { $, esc, reasonOr, slugify, tid, postJson, armConfirm } from "./util.js";
import { APP, draft, FACET_LABELS } from "./state.js";
import { go } from "./nav.js";
import { loadStories } from "./saved-runs.js";
import { loadVocab, loadLibrary, loadStyles } from "./catalog.js";
import { modal, button, hint, errorLine, warnLine, thinking, pageTitle, modelSelect } from "./ui.js";
import { on, onKey } from "./wire.js";

// ---- the scaffold interview --------------------------------------------------
// One page, four things always visible in the staged walk: the step they are on, the proposed
// story, the current round, and a state sidebar owning accept and abandon. The idea step is still
// a modal, shown over an empty scaffold shell until the first proposal lands. Base styling ported
// from mockups/architect; the stepper is the mockup's left rail.

const IDEA_PLACEHOLDER =
  "e.g. A locksmith is asked to open a door they installed years ago, for someone they don't recognise.";

// Must match ScaffoldSession.CHECKLIST. The gate the session is on drives the chip strip, the
// draft label and which section renders as current, so a stage missing here loses all three.
const GATES = ["story", "cast", "settings", "technical", "scene", "world"];

// The six decision stages. The engine's gate strings never change -- CHECKLIST owns them -- so
// the author-facing progression lives here beside the gate keys. Each stage names the decision,
// why it matters, and which gates it covers; the stage is presentation, the gates are the
// backend transitions (approve passes one gate at a time, exactly as before).
const STAGES = [
  { key: "idea", q: "What is this story?",
    why: "Everything is built from one situation — a moment with pressure in it, not a plot.",
    gates: [] },
  { key: "direction", q: "What kind of story should it become?",
    why: "The premise and tension steer every later choice: the cast, the style, the scenes.",
    gates: ["story"] },
  { key: "castworld", q: "Which library assets belong to it?",
    why: "Reusable characters and a style, chosen for this story. Their role here is shaped in conversation.",
    gates: ["cast", "settings"] },
  { key: "structure", q: "What is the story's shape?",
    why: "One fully-built opening scene; the world ledger only if the story needs it.",
    gates: ["technical", "scene", "world"] },
  { key: "review", q: "Does this Blueprint make sense?",
    why: "The last look before anything is written — read it whole, fix what is off.",
    gates: [] },
  { key: "handoff", q: "Accept the Blueprint and start writing.",
    why: "Naming the folder writes story.json and starts chapter 1. Nothing is on disk until then.",
    gates: [] },
];
const STAGE_LABELS = { idea: "Idea", direction: "Direction", castworld: "Cast & world",
  structure: "Structure", review: "Review", handoff: "Accept" };
const APPROVE_LABELS = {
  story: "accept the concept", cast: "accept the cast", settings: "accept the style",
  technical: "accept the run shape", scene: "accept the scene", world: "accept the world",
};

// ── the idea step (modal) ────────────────────────────────────────────────────

const modeChoice = (value, title, blurb) => {
  const on = value === "oneshot" ? draft.mode === "oneshot" : draft.mode !== "oneshot";
  return `<label class="choice${on ? " selected" : ""}">
    <input type="radio" name="mode" value="${value}"${on ? " checked" : ""}>
    <b>${title}</b><span>${blurb}</span></label>`;
};

// Create-then-return: the scaffold session lives server-side and survives navigation untouched,
// so going to a library is pure client routing — but a plain outbound anchor would lose the way
// back (and the hash alone doesn't even carry the catalog kind: nav.js routes on path only).
// These buttons set the kind explicitly, arm APP.catalog.returnTo for the library's return banner,
// and go() from there. The libraries auto-return after a successful save; wireScaffold's return
// hook fires the one-shot pendingSelect once the refetched caches hold the new entry.
function goCatalogFromScaffold(kind) {
  APP.catalog.kind = kind;
  APP.catalog.returnTo = { view: "scaffold", kind };
  go("catalog");
}

// The vocabulary is the tag catalog's, and only the catalog authors it: an off-vocabulary tag is
// something the route tolerates, not something this picker offers. Curated is the point -- free
// text here would be a second idea box. Choosing a tag says what KIND of story this one is; the
// vocabulary itself is managed under Libraries, never here. Chips read the session and post
// straight back to it -- the session is the truth, there is no draft to save.
function tagChipsHtml(s) {
  const c = s.concept || {};
  const chosen = c.tags || [];
  const vocab = APP.catalog.vocab || [];
  if (!vocab.length)
    return hint(`No tags in the library yet — <button class="hint-link" data-goto-catalog="tags" type="button">add some under Libraries</button> and they show up here.`);
  const rows = APP.catalogConfig.tagFacets.map(facet => {
    const mine = vocab.filter(t => t.facet === facet);
    if (!mine.length) return "";
    const chips = mine.map(t =>
      `<button class="cat-chip${chosen.includes(t.label) ? " on" : ""}" data-tag-label="${esc(t.label)}" type="button">${esc(t.label)}</button>`).join("");
    return `<div class="cat-tags-group"><div class="cat-facet-heading">${esc(FACET_LABELS[facet] ?? facet)}</div>
      <div class="cat-tags-row">${chips}</div></div>`;
  }).join("");
  return `<div class="cat-tags-picker">${rows}</div>`
    + hint(`Tags steer this story's direction only. The vocabulary itself is managed <button class="hint-link" data-goto-catalog="tags" type="button">under Libraries</button>.`);
}

const castSizeFieldHtml = s => {
  const c = s.concept || {};
  const size = c.castSize || 0;
  return `<div class="field"><label for="f-cast-size">opening cast size</label>
    <select id="f-cast-size">
      ${[[0, "let the architect decide"], [2, "2 characters"], [3, "3 characters"], [4, "4 characters"]]
        .map(([n, label]) => `<option value="${n}"${size === n ? " selected" : ""}>${label}</option>`).join("")}
    </select></div>`;
};

const MAX_IMPORTS = 4;   // the cast stage's ceiling, mirrored from server/scaffold-routes.ts

// Reusable characters, cast in THIS story. Picking one is not the same as the architect
// inventing one: the cast gate switches to a different prompt entirely, and the fields that
// travel with a character stop being the architect's to change. Selecting here never edits the
// catalog entry -- it only says who walks into scene 1. Editing the reusable character happens
// under Libraries; shaping their role in this story (goal, knowledge, placement) happens in
// conversation below -- say what you want them to want and know here.
function importPickerHtml(s) {
  const c = s.concept || {};
  const pickedIds = (c.imported || []).map(i => i.libraryId);
  const lib = APP.catalog.library || [];
  if (!lib.length)
    return hint(`No characters in the library yet — <button class="hint-link" data-goto-catalog="characters" type="button">add some under Libraries</button> and you can cast them here.`);
  // Inspecting previews a candidate in the shared panel below; selecting stays chip-only.
  // The info button lives beside its chip (never inside it — a button in a button is invalid,
  // and a full/disabled chip must still be inspectable).
  const insp = APP.scaffoldInspect;
  const chips = lib.map(x => {
    const on = pickedIds.includes(x.id);
    const full = !on && pickedIds.length >= MAX_IMPORTS;
    const expanded = !!insp && insp.kind === "import" && insp.id === x.id;
    return `<span class="cat-chip-wrap">`
      + `<button class="cat-chip${on ? " on" : ""}" data-import-id="${esc(x.id)}" type="button"${full ? " disabled" : ""}`
      + ` title="${esc(x.portablePersona || x.name)}">${esc(x.name)}</button>`
      + `<button class="cat-chip-info${expanded ? " on" : ""}" data-inspect-import="${esc(x.id)}" type="button"`
      + ` aria-expanded="${expanded ? "true" : "false"}" aria-label="inspect ${esc(x.name)}" title="inspect ${esc(x.name)}">ⓘ</button>`
      + `</span>`;
  }).join("");
  // One shared preview panel under the row: the inspected candidate, when it exists and is not
  // already selected (a selected character already shows its full detail in the cast list below —
  // duplicating it here would read as a second copy, not a preview).
  let preview = "";
  if (insp && insp.kind === "import") {
    const target = lib.find(x => x.id === insp.id);
    if (target && !pickedIds.includes(target.id)) {
      const skills = (target.skills || []).join(", ");
      preview = `<details class="story-cast-member is-inspecting" data-tid="scaffold.story-cast-preview" data-cast-id="${esc(target.id)}" open>`
        + `<summary>${esc(target.name)} — previewing</summary>`
        + `<div class="story-cast-body">`
        + `${target.portablePersona ? `<p>${esc(target.portablePersona)}</p>` : ""}`
        + `${target.belief ? `<p><span class="label">belief</span> ${esc(target.belief)}</p>` : ""}`
        + `${target.impulse ? `<p><span class="label">impulse</span> ${esc(target.impulse)}</p>` : ""}`
        + `${(target.voice || []).map(v => `<p><span class="label">voice</span> “${esc(v)}”</p>`).join("")}`
        + `${skills ? `<p><span class="label">brings</span> ${esc(skills)}</p>` : ""}`
        + `${target.origin ? `<p><span class="label">origin</span> ${esc(target.origin)}</p>` : ""}`
        + `<p class="hint">Preview — use its chip above to cast it in this story.</p>`
        + `</div></details>`;
    }
  }
  const picked = lib.filter(x => pickedIds.includes(x.id));
  const busy = !!s.busy;
  const entries = rejectEntriesOf(s);
  // The detail below is catalog data, but goal/knows live on the spec character — so the inputs
  // bind the same-named spec entry, and only render when the cast actually holds one (the tray is
  // live while no cast exists, and there is nothing to edit yet then).
  const specRoleOf = name =>
    (s.spec?.characters || []).find(sc => String(sc.name || "").toLowerCase() === String(name || "").toLowerCase());
  const cast = !picked.length ? "" : `<div class="story-cast">${picked.map(x => {
    const skills = (x.skills || []).join(", ");
    const specChar = specRoleOf(x.name);
    return `<details class="story-cast-member" data-tid="scaffold.story-cast-member" data-cast-id="${esc(x.id)}">
      <summary>${esc(x.name)} — in this story</summary>
      <div class="story-cast-body">
        ${x.portablePersona ? `<p>${esc(x.portablePersona)}</p>` : ""}
        ${x.belief ? `<p><span class="label">belief</span> ${esc(x.belief)}</p>` : ""}
        ${x.impulse ? `<p><span class="label">impulse</span> ${esc(x.impulse)}</p>` : ""}
        ${(x.voice || []).map(v => `<p><span class="label">voice</span> “${esc(v)}”</p>`).join("")}
        ${skills ? `<p><span class="label">brings</span> ${esc(skills)}</p>` : ""}
        ${x.origin ? `<p><span class="label">origin</span> ${esc(x.origin)}</p>` : ""}
        ${specChar ? roleFieldHtml(specChar, "knows", busy, entries) + roleFieldHtml(specChar, "goal", busy, entries) : ""}
        <p class="hint">Reusable character — what they want and know HERE lives in this story, not on them: edit it here, or shape it in conversation.</p>
        <div class="side-actions"><button class="btn" data-remove-import="${esc(x.id)}" type="button">remove from this story</button></div>
      </div>
    </details>`;
  }).join("")}</div>`;
  return `<div class="cat-tags-row">${chips}</div>${preview}${cast}`
    + hint(`Removing here takes them out of this story only — the library entry is unchanged. `
      + `<button class="hint-link" data-goto-catalog="characters" type="button">Manage characters under Libraries</button>.`);
}

// The presets the author's tags speak to, first. Ranking is ALL this does with them: a tag is a
// steering word for the story gate and nothing else, and passing one into the settings prompt as
// well would give it a second, unarbitrated channel into the story. Every preset stays on offer.
function rankedStyles(s) {
  const c = s.concept || {};
  const chosen = new Set((c.tags || []).map(t => t.toLowerCase()));
  const hits = e => (e.tags || []).filter(t => chosen.has(String(t).toLowerCase())).length;
  return (APP.catalog.styles || []).map((e, i) => ({ e, i, n: hits(e) }))
    .sort((a, b) => b.n - a.n || a.i - b.i).map(x => x.e);
}

// One reusable voice telling THIS story, or none. Picking one narrows the settings gate to this
// story's own narration rules; picking none leaves it writing the whole house style, which is
// what it has always done. The preset itself is read-only here -- what this cast and POV make
// impossible to narrate is derived per story, and the preset is managed under Libraries.
function stylePickerHtml(s) {
  const c = s.concept || {};
  const styles = rankedStyles(s);
  if (!styles.length)
    return hint(`No styles in the library yet — <button class="hint-link" data-goto-catalog="styles" type="button">add some under Libraries</button> and you can pick one here.`);
  const insp = APP.scaffoldInspect;
  const chips = styles.map(e => {
    const expanded = !!insp && insp.kind === "style" && insp.id === e.id;
    return `<span class="cat-chip-wrap">`
      + `<button class="cat-chip${c.styleId === e.id ? " on" : ""}" data-style-id="${esc(e.id)}" type="button"`
      + ` title="${esc(e.description || e.voice)}">${esc(e.name)}</button>`
      + `<button class="cat-chip-info${expanded ? " on" : ""}" data-inspect-style="${esc(e.id)}" type="button"`
      + ` aria-expanded="${expanded ? "true" : "false"}" aria-label="inspect ${esc(e.name)}" title="inspect ${esc(e.name)}">ⓘ</button>`
      + `</span>`;
  }).join("");
  let preview = "";
  if (insp && insp.kind === "style") {
    const target = styles.find(e => e.id === insp.id);
    if (target && target.id !== c.styleId) {
      preview = `<details class="story-cast-member is-inspecting" data-tid="scaffold.story-style-preview" open>`
        + `<summary>${esc(target.name)} — previewing</summary>`
        + `<div class="story-cast-body">`
        + `${target.description ? `<p>${esc(target.description)}</p>` : ""}`
        + `${target.voice ? `<p><span class="label">style</span> ${esc(target.voice)}</p>` : ""}`
        + `<p class="hint">Preview — use its chip above to tell this story in this style.</p>`
        + `</div></details>`;
    }
  }
  const picked = styles.find(e => e.id === c.styleId);
  const detail = !picked ? ""
    : `<details class="story-cast-member" data-tid="scaffold.story-style-detail">
      <summary>${esc(picked.name)} — telling this story</summary>
      <div class="story-cast-body">
        ${picked.description ? `<p>${esc(picked.description)}</p>` : ""}
        ${picked.voice ? `<p><span class="label">style</span> ${esc(picked.voice)}</p>` : ""}
        <p class="hint">Reusable style — this story's own narration rules are derived at the style gate. The preset itself is untouched.</p>
        <div class="side-actions"><button class="btn" data-clear-style type="button">use no preset for this story</button></div>
      </div>
    </details>`;
  return `<div class="cat-tags-row">${chips}</div>${preview}${detail}` + (picked
    ? hint(`The architect is handed this style and asked only what THIS cast and POV make impossible to narrate. `
      + `<button class="hint-link" data-goto-catalog="styles" type="button">Manage styles under Libraries</button>.`)
    : hint(`Pick none and the architect writes the house style itself. `
      + `<button class="hint-link" data-goto-catalog="styles" type="button">New style? Add it under Libraries first</button>.`));
}

function directionPickersHtml(s) {
  const c = s.concept || {};
  const tagsLive = s.mode !== "oneshot" && c.tagsSteer;
  const trayLive = s.mode !== "oneshot" && (c.castSizeSteers || c.importsSteer);
  const styleLive = s.mode !== "oneshot" && c.styleSteers;
  const warning = c.unknownTags && c.unknownTags.length
    ? warnLine(`not in the tag library: ${esc(c.unknownTags.join(", "))} — sent to the architect anyway`)
    : "";
  return `<div class="stage-pick" data-tid="scaffold.direction-pickers">
    <label class="field-label">Story vocabulary <span class="hint">optional — reusable tags, chosen for this story</span></label>
    ${tagsLive ? tagChipsHtml(s) + warning : (c.tags || []).length
      ? hint(`Tags steered the direction and are now decided: ${esc(c.tags.join(", "))}.`) + warning : ""}
    ${trayLive ? `<label class="field-label">Characters for this story <span class="hint">optional — reusable characters, cast here before the cast exists</span></label>`
      + trayBlockHtml(s) : ""}
    ${styleLive ? `<label class="field-label">Story style <span class="hint">optional — a reusable style preset, telling this story</span></label>`
      + styleBlockHtml(s) : ""}
  </div>`;
}

// The tray and the size steer the cast prompt, so they are live only while no cast exists --
// usually while the direction is open; at the cast gate only when the architect asked instead
// of proposing. Wherever they are live, they live in the open stage and nowhere else.
function trayBlockHtml(s) {
  const c = s.concept || {};
  const tray = (c.imported || []).map(i => i.libraryId);
  const importsWarning = c.missingImports && c.missingImports.length
    ? warnLine(`no longer in the library: ${esc(c.missingImports.join(", "))} — these were dropped from the cast`)
    : "";
  return importPickerHtml(s) + importsWarning
    + (!tray.length ? castSizeFieldHtml(s)
      : hint(`The cast chosen above already sets the opening cast size.`));
}

function styleBlockHtml(s) {
  const c = s.concept || {};
  const styleWarning = c.missingStyle
    ? warnLine(`the style "${esc(c.missingStyle)}" is no longer in the library — the architect writes the house style itself`)
    : "";
  return stylePickerHtml(s) + styleWarning;
}

function castworldPickersHtml(s) {
  const c = s.concept || {};
  const tray = (c.imported || []).map(i => i.libraryId);
  const trayLive = s.mode !== "oneshot" && (c.castSizeSteers || c.importsSteer);
  const styleLive = s.mode !== "oneshot" && c.styleSteers;
  return `<div class="stage-pick" data-tid="scaffold.castworld-pickers">
    ${trayLive ? `<label class="field-label">Characters for this story <span class="hint">optional — reusable characters, cast here before the cast exists</span></label>`
      + trayBlockHtml(s) : tray.length
      ? hint(`Cast for this story: ${esc((c.imported || []).map(i => i.name).join(", "))} — placed.`) : ""}
    ${styleLive ? `<label class="field-label">Story style <span class="hint">optional — a reusable style preset, telling this story</span></label>`
      + styleBlockHtml(s) : c.styleName
      ? hint(`Voice for this story: ${esc(c.styleName)}.`) : ""}
  </div>`;
}

function ideaModalHtml() {
  const err = APP.scaffoldError ? errorLine(esc(APP.scaffoldError)) : "";
  // The override genuinely can't wait past the first call (unlike retries), so the collapsed state
  // names the model that proposing will actually use — the default stays valid with Advanced shut.
  const using = draft.model || APP.modelDefault || "";
  return modal({
    id: "iv-backdrop", dataTid: "scaffold.idea-modal", ariaLabel: "new story",
    body: `<span class="label">step 1 of 6 · Story idea</span>
      <h2>What is this story?</h2>
      <p class="sub">A situation, not a plot — it will find the pressure in it, and ask if it needs more.
        Kind, cast and style come next, each where it is decided.</p>
      <div class="field"><label for="f-idea">the idea</label>
        <textarea id="f-idea" rows="4" placeholder="${esc(IDEA_PLACEHOLDER)}">${esc(draft.idea)}</textarea></div>
      <label class="field-label">how it proposes</label>
      <div class="choice-grid">
        ${modeChoice("staged", "stage by stage",
            "Decide direction, cast and structure one stage at a time, approving between each.")}
        ${modeChoice("oneshot", "the whole story at once",
            "One complete proposal, then review and refinement.")}
      </div>
      <div class="field"><span class="field-label">built by</span>
        <p class="hint">using ${using ? esc(using) : "the story default"}</p>
        <details class="sc-setup" data-tid="idea.advanced">
          <summary>Advanced — choose a different model</summary>
          <div class="field"><label for="f-model">built by</label>
            ${modelSelect({ id: "f-model", defaultLabel: `defaults${APP.modelDefault ? " · " + esc(APP.modelDefault) : ""}`,
                            selected: draft.model, modelIds: APP.modelIds })}</div>
        </details></div>
      ${err}
      <div class="btns">${button({ label: "propose →", id: "iv-start", variant: "primary" })}
        ${button({ label: "back to the shelf", id: "iv-back" })}
        <span class="hint">ctrl/⌘ + ↵</span></div>`,
  });
}

// ── the proposal panel ────────────────────────────────────────────────────────

// Provenance: a character either rode in on the author's import tray (catalog-derived, enforced
// by the adaptation contract) or was invented for this story (AI-generated). The badge names
// which — the stage's status pill says whether it is draft, proposed, edited or approved.
// Block C: goal/knows are story-positional — they live on the spec character, never on a
// catalog entry — so each cast card edits them inline. Always rendered (empty with a placeholder
// when unset, so an author can shape a proposed character too); disabled while a gate runs, so
// no typed-but-unsaved value can diverge from the session. Block G's per-field reject hooks onto
// the same data-role-name / data-role-field attributes.
const roleFieldHtml = (c, field, busy, entries = []) => {
  const rej = fieldEntryFor(entries, c.name, field);
  return `<label class="role-field"><span>${field}</span>`
    + `<input type="text" value="${esc(c[field] || "")}" placeholder="—"`
    + ` data-role-name="${esc(c.name)}" data-role-field="${field}"${busy ? " disabled" : ""}></label>`
    + (rej ? `<button class="hint-link" data-reject-name="${esc(c.name)}" data-reject-field="${field}"`
      + ` type="button">reject this ${field}</button>` : "");
};
function castHtml(spec, catalog, scoped = false, entries = []) {
  // Reach is scene-scoped, so it is shown per character but labelled with the scene that grants it
  // -- never as an intrinsic skill.
  const reachOf = name => (spec.scenes?.[0]?.reach || {})[name]
    || Object.entries(spec.scene?.reach || {}).find(([k]) => k === name)?.[1] || [];
  return `<div class="cast">${spec.characters.map(c => {
    const tag = (t, cls = "") => `<span class="tag${cls}">${t}</span>`;
    const skills = c.skills.map(s => esc(s.text) + (s.meaning ? ` :: ${esc(s.meaning)}` : "")).join(", ");
    const reach = reachOf(c.name);
    const fromCatalog = catalog && catalog.has(String(c.name || "").toLowerCase());
    const busy = !!APP.scaffold?.busy;
    return `<div class="person" data-tid="scaffold.person" data-name="${esc(c.name)}">
      <div class="person-top"><span class="person-name">${esc(c.name)}</span>`
      + (fromCatalog ? tag(`from your library`, " prov-catalog") : tag(`proposed`, " prov-ai")) + `</div>
      ${c.persona ? `<p>${esc(c.persona)}</p>` : ""}
      ${roleFieldHtml(c, "knows", busy, entries)}
      ${roleFieldHtml(c, "goal", busy, entries)}
      ${scoped || addedEntryFor(entries, c.name) ? `<p class="hint">`
        + (scoped ? `<button class="hint-link" data-regen-character="${esc(c.name)}" type="button">regenerate just ${esc(c.name)}</button>` : "")
        + (scoped && addedEntryFor(entries, c.name) ? " · " : "")
        + (addedEntryFor(entries, c.name) ? `<button class="hint-link" data-reject-character="${esc(c.name)}" type="button">reject ${esc(c.name)}</button>` : "")
        + `</p>` : ""}
      ${c.belief ? tag(`belief: ${esc(c.belief)}`) : ""}
      ${c.impulse ? tag(`impulse: ${esc(c.impulse)}`) : ""}
      ${(c.voice || []).map(v => tag(`voice: “${esc(v)}”`)).join("")}
      ${skills ? tag(`skills: ${skills}`) : ""}
      ${(Array.isArray(reach) ? reach : []).map(r =>
        tag(`reach · scene 1: ${esc(r)}`, " reach")).join("")}
      ${c.restrictions.map(r => tag(`restriction: ${esc(r)}`, " warn")).join("")}
    </div>`;
  }).join("")}</div>`;
}

function sceneHtml(spec) {
  const sc = spec.scene;
  if (!sc || !(sc.place || sc.question || sc.pov)) return "";
  const meta = [sc.length ? `~${sc.length} words` : "", sc.pov ? `POV ${esc(sc.pov)}` : ""]
    .filter(Boolean).join(" · ");
  return `<div class="scene">
    ${sc.place ? `<h4>${esc(sc.place)}</h4>` : ""}
    <p class="scene-meta">scene 1${meta ? " · " + meta : ""}</p>
    ${sc.question ? `<div class="question"><span class="label">dramatic question</span> <span class="tag prov-ai">proposed</span>${esc(sc.question)}</div>` : ""}
  </div>`;
}

function factsHtml(spec) {
  const facts = spec.facts || [];
  if (!facts.length) return "";
  return `<div class="facts"><span class="tag prov-ai">proposed</span>${facts.map(f =>
    `<div class="fact"><strong>fact</strong><span>${esc(f)}</span></div>`).join("")}</div>`;
}

/** Execution configuration never renders here as values: retries, budgets, timeouts and
 *  thinking levels change how the engine runs, not what the story is. They live under the
 *  editor's Advanced section (and Config/Models there), so this stage names them once and moves
 *  on to the decisions that do change the story. */
function technicalHtml(spec) {
  const keys = Object.keys(spec.config || {});
  if (!keys.length) return "";
  return hint(`Execution settings (${esc(keys.length)} from the defaults — retries, budgets, thinking) live under Advanced in the editor. Nothing to decide here.`);
}

/** The world-event ledger, held and fired forms side by side. The memories are shown too: they are
 *  the author's to judge here, and this is the only screen that sees them before a run hides them
 *  inside a character. An empty ledger renders nothing -- most stories have one. */
function timelineHtml(spec) {
  const beats = spec.timeline || [];
  if (!beats.length) return "";
  return beats.map((b, i) => {
    const mem = Object.entries(b.memories || {});
    return `<div class="scene" data-tid="scaffold.beat">
      <p class="scene-meta">world event ${i + 1} · chapter ${esc(b.chapter)} · fires at ${esc(b.at)} of the target <span class="tag prov-ai">proposed</span></p>
      <div class="facts">
        <div class="fact"><strong>held</strong><span>${esc(b.hold)}</span></div>
        <div class="fact"><strong>fired</strong><span>${esc(b.fired)}</span></div>
        ${mem.map(([who, m]) => `<div class="fact"><strong>${esc(who)} remembers</strong><span>${esc(m)}</span></div>`).join("")}
      </div>
    </div>`;
  }).join("");
}

// ── artifact provenance & status ────────────────────────────────────────────
// Four origins, never mixed: you wrote it (the idea, refinements you typed), it came from your
// catalog (tray characters, preset voice, tags), the architect proposed it, or you approved it
// (a passed gate, the accepted blueprint). Statuses are derived, never stored: the snapshot's
// round kind says whether the open stage is a fresh proposal or carries your refinements — no
// versioning is invented, there is only ever one spec.

// The import tray, as a lookup: characters whose names match rode in from the catalog.
function catalogOf(s) {
  return new Set(((s.concept || {}).imported || []).map(i => String(i.name || "").toLowerCase()));
}

// Which generated block(s) the latest round touched, from its applied field list. A proposal
// round carries no applied list, so nothing highlights until a change actually lands.
function changedSections(s) {
  const out = new Set();
  const applied = (s.last && s.last.kind === "edits" && Array.isArray(s.last.applied)) ? s.last.applied : [];
  for (const a of applied) {
    const f = String((a && a.field) || "").toLowerCase();
    if (/^(title|premise|tension|facts|fact_|updated fact|added fact|removed fact)/.test(f)) out.add("direction");
    else if (/^writer_style/.test(f)) out.add("voice");
    else if (/^(scene|added scene|removed scene|beat|added beat|removed beat|timeline|config|models)/.test(f)) out.add("structure");
    else out.add("cast");
  }
  return out;
}

const changedTag = (set, key) =>
  set.has(key) ? `<span class="tag changed">changed this round</span>` : "";

// Draft · Generated proposal · Edited · Approved, plus Needs your call while a question or a
// blocked gate stands. Derived from the snapshot on every frame: a proposal round means fresh,
// an edits round means your refinements are in it, a passed gate means approved.
function artifactStatus(s, key) {
  const unsent = draft.say.trim() ? " · unsent refinement in the box" : "";
  if (key === "handoff") return { label: "Approved", cls: "st-approved", note: "The Blueprint was approved — naming the folder writes it." };
  if (key === "idea") return { label: "Draft", cls: "", note: "The direction hasn't landed yet." };
  if (key === "review") {
    return (s.last && s.last.kind === "edits")
      ? { label: "Edited", cls: "st-edited", note: "Your fixes are in — approve the Blueprint when it holds." + unsent }
      : { label: "Generated proposal", cls: "st-proposal", note: "The whole Blueprint, awaiting approval." + unsent };
  }
  if (s.pendingAsk) return { label: "Needs your call", cls: "st-call", note: "Answer the question to continue." };
  const k = s.last && s.last.kind;
  if (k === "blocked") return { label: "Needs your call", cls: "st-call", note: "The cast gate's judgement stands — refine or overrule." };
  if (k === "failed") return { label: "Draft", cls: "", note: "The last round failed — nothing changed." + unsent };
  if (k === "proposal") return { label: "Generated proposal", cls: "st-proposal", note: "Accept it, refine it, regenerate it, or leave it." + unsent };
  if (k === "edits") return { label: "Edited", cls: "st-edited", note: "Your refinements are in." + unsent };
  return { label: "Draft", cls: "", note: "This stage hasn't landed yet." + unsent };
}

// ── stage sections ──────────────────────────────────────────────────────────
// Every open stage shows the same five things: what is decided, what still needs a decision,
// what was generated, what can be edited, and what happens next. Passed stages collapse to
// their decision summary; upcoming stages stay locked behind what they wait on.

/** The composer: refine within the stage, or pass the gate. Refinement never advances a gate;
 *  only the approve button does. Hidden while a question stands (answer first) and while busy. */
function composerHtml(s, label) {
  if (s.busy) return thinking("the architect is thinking…", { show: true, tag: "div" });
  const answering = !!s.pendingAsk;
  const unsent = !!draft.say.trim();
  const foot = [`<span class="hint">↵ send · ⇧↵ new line</span>`];
  if (answering) {
    foot.push(button({ label: "send answer →", id: "iv-say", variant: "primary" }));
  } else {
    foot.push(button({ label: "send", id: "iv-say", variant: unsent ? "primary" : "" }));
    // approve passes the open gate; hidden at the last gate and while a question stands. Once a
    // gate came back blocked, the same button overrules it and says so. The label names the gate
    // being passed -- "accept the cast" -- because "approve" stopped saying what the click does.
    if (s.gate && GATES.indexOf(s.gate) < GATES.length - 1 && s.mode !== "oneshot")
      foot.push(APP.approveArmed
        ? button({ label: "approve anyway →", id: "iv-approve", variant: "danger" })
        : button({ label: `${APPROVE_LABELS[s.gate]} & continue →`, id: "iv-approve", variant: unsent ? "" : "primary" }));
  }
  return `<label class="field-label" for="f-say">${answering ? "Your answer" : label}</label>
    <textarea id="f-say" rows="3">${esc(draft.say)}</textarea>
    <div class="composer-foot">${foot.join("")}</div>`;
}

/** Whether this stage is waiting on something only the author can resolve -- a standing
 *  question, or a judge's block. When true, that's the one decision on screen; nothing else
 *  (content-completeness, round narration) competes with it for attention. */
function isUrgent(s) {
  return !!s.pendingAsk || (s.last && s.last.kind === "blocked");
}

/** Tier "focus": the standing question or the cast gate's judgement, read prominently above the
 *  generated content -- it IS the decision, not one more status line among several. Nothing here
 *  once it's resolved; the composer already reflects that (its own label, its own button). */
function urgentHtml(s) {
  if (s.pendingAsk)
    return `<div class="round-question"><span class="label">the architect's question</span><p>${esc(s.pendingAsk)}</p></div>`;
  if (s.last && s.last.kind === "blocked")
    return `<div class="round-note"><span class="label">the cast gate</span><p>${esc(s.last.why)}</p>`
      + hint(`Refine the cast below, or approve again to overrule this judgement.`) + `</div>`;
  return "";
}

/** The architect's own words about the round that just landed, plus what mechanically changed --
 *  read as the tail of a conversation about the content just shown, not a status log. Nothing
 *  here while urgentHtml() owns the turn (a standing question or a block already said this). */
function roundNoteHtml(s) {
  const last = s.last;
  if (!last || isUrgent(s)) return "";
  if (last.kind === "failed") return errorLine(`that round failed (${esc(last.error)}) — nothing changed`);
  if (last.kind === "edits") {
    const note = last.note ? `<div class="round-note"><span class="label">architect note</span><p>${esc(last.note)}</p></div>` : "";
    const changed = last.applied.length ? `changed: ${esc(last.applied.join(", "))}` : "it changed nothing";
    const ig = last.ignored.map(x => errorLine(`ignored ${esc(x)}`)).join("");
    return `${note}<div class="said good">${changed}</div>${ig}`;
  }
  if (last.kind === "proposal" && last.note)
    return `<div class="round-note"><span class="label">architect note</span><p>${esc(last.note)}</p></div>`;
  if (last.kind === "nothing" && !/has not landed/.test(last.why || "") && !/checklist is complete/.test(last.why || ""))
    return errorLine(`it didn't come back with anything — ${esc(last.why || "try saying who is in the scene and what is at stake")}`);
  return "";
}

/** What still needs a decision before this stage can pass, or "" when nothing is missing --
 *  the "next" hint already says what approving does, so this only speaks up when there's a real
 *  gap. Suppressed while urgentHtml() or the composer's own busy state already own the turn. */
function missingHtml(s, gates) {
  if (isUrgent(s) || s.busy) return "";
  const missing = {
    story: s.spec.title?.trim() || s.spec.premise?.trim() ? "" : "a title or premise",
    cast: s.spec.characters.length ? "" : "at least one character",
    settings: s.spec.writerStyle?.trim() ? "" : "the house style",
    technical: "",
    scene: (s.spec.scenes?.[0]?.question || s.spec.scene?.question || "").trim() ? "" : "scene 1's dramatic question",
    world: "",
  };
  const need = gates.map(g => missing[g]).filter(Boolean);
  return need.length ? hint(`Still needed: ${esc(need.join("; "))}.`) : "";
}

// Advanced/diagnostic count for the collapsed disclosure's own summary -- same "· N …" idiom the
// consult transcript's own engine-details uses, so the two collapsed-details patterns in the app
// read as one language rather than two.
function advancedLabel(s) {
  const n = (s.problems || []).length;
  return n ? `Advanced · ${n} engine note${n === 1 ? "" : "s"}, regenerate, revert` : `Advanced · regenerate, revert`;
}

// One open stage, five tiers, in reading order: the question (card head), what the architect
// currently believes (primary), its own words about the round that produced it (a conversational
// aside, not a status log), the one place the author acts (composer + any inline pickers), what's
// still missing or what approving does next, and -- collapsed, never competing for the eye --
// validation findings, regenerate and revert. A standing question or a judge's block pre-empts all
// of it: urgentHtml() renders once, right under the stage's own subtitle, and IS the decision.
function stageSection(s, key, { primary = "", action = "", next = "", advanced = "" }) {
  const meta = STAGES.find(t => t.key === key);
  const gates = meta.gates;
  const skipMissing = key === "review" || key === "handoff" || key === "idea";
  const st = artifactStatus(s, key);
  return `<section class="card stage-open" data-tid="scaffold.stage-section" data-stage="${key}">
    <div class="card-head">
      <div><span class="label">${esc(STAGE_LABELS[key])} · deciding now</span><h3>${esc(meta.q)}</h3></div>
      <span class="status-pill ${st.cls}" data-tid="scaffold.artifact-status">${esc(st.label)}</span>
    </div>
    <div class="card-body">
      <p class="sub">${esc(meta.why)}</p>
      ${urgentHtml(s)}
      <div class="stage-primary">${primary}</div>
      ${roundNoteHtml(s)}
      ${action ? `<div class="stage-action">${action}</div>` : ""}
      ${skipMissing ? "" : missingHtml(s, gates)}
      ${next ? `<p class="hint">Next: ${esc(next)}</p>` : ""}
      ${advanced ? `<details class="engine-details" data-tid="scaffold.advanced"><summary>${esc(advancedLabel(s))}</summary>${advanced}</details>` : ""}
    </div>
  </section>`;
}

function lockedSection(key, waitsOn) {
  const meta = STAGES.find(t => t.key === key);
  return `<section class="card stage-locked" data-tid="scaffold.stage-section" data-stage="${key}">
    <div class="card-head">
      <div><span class="label">${esc(STAGE_LABELS[key])} · ahead</span><h3>${esc(meta.q)}</h3></div>
      <span class="status-pill" data-tid="scaffold.artifact-status">Draft</span>
    </div>
    <div class="card-body">${hint(esc(waitsOn))}</div>
  </section>`;
}

function doneSection(s, key) {
  const meta = STAGES.find(t => t.key === key);
  const decided = decidedHtml(s, key);
  return `<details class="card stage-done" data-tid="scaffold.stage-section" data-stage="${key}">
    <summary><span class="label">${esc(STAGE_LABELS[key])} · approved</span> <strong>${esc(meta.q)}</strong>
      <span class="status-pill st-approved" data-tid="scaffold.artifact-status">Approved</span></summary>
    <div class="card-body">${decided || hint(`Approved earlier — expand to revisit; refinements can still touch it.`)}</div>
  </details>`;
}

// ── the six stages ──────────────────────────────────────────────────────────

// Which stage is open. Staged: the open gate decides, until the checklist completes (review)
// or the folder step opens (handoff). One-shot: content presence decides, since there are no
// gates -- the whole-story proposal covers direction, cast and structure at once.
function reviewComplete(s) {
  return !!s.last && s.last.kind === "nothing" && /checklist is complete/.test(s.last.why || "");
}

function stageOf(s) {
  if (!s.spec && !s.haveDraft) return "idea";
  if (s.needsFolder || APP.folderOpen) return "handoff";
  if (s.mode === "oneshot") {
    if (reviewComplete(s) || s.haveStory) return "review";
    return "direction";
  }
  if (reviewComplete(s)) return "review";
  const gate = s.gate || "story";
  if (gate === "story") return "direction";
  if (gate === "cast" || gate === "settings") return "castworld";
  return "structure";
}

function stageIndex(key) { return STAGES.findIndex(t => t.key === key); }

// One-line account of what a passed stage decided -- the "already decided" half of every stage.
function decidedHtml(s, key) {
  const spec = s.spec || {};
  const c = s.concept || {};
  if (key === "idea") return s.idea
    ? `<p class="side-copy"><span class="tag prov-user">you wrote</span> “${esc(s.idea)}”</p>` : "";
  if (key === "direction") {
    const bits = [];
    if (spec.title) bits.push(`<strong>${esc(spec.title)}</strong>`);
    if (s.tension) bits.push(esc(s.tension));
    if ((c.tags || []).length) bits.push(`vocabulary: ${esc(c.tags.join(", "))} <span class="tag prov-catalog">your library</span>`);
    if ((spec.facts || []).length) bits.push(`${spec.facts.length} fact(s)`);
    return bits.length ? `<p class="side-copy">${bits.join(" · ")}</p>` : "";
  }
  if (key === "castworld") {
    const names = (spec.characters || []).map(x => x.name);
    const bits = [];
    if (names.length) bits.push(esc(names.join(", ")));
    if (spec.writerStyle) bits.push("style decided");
    else if (c.styleName) bits.push(`style: ${esc(c.styleName)}`);
    if ((c.imported || []).length) bits.push("cast from your library");
    return bits.length ? `<p class="side-copy">${bits.join(" · ")}</p>` : "";
  }
  if (key === "structure") {
    const q = spec.scenes?.[0]?.question || spec.scene?.question;
    const bits = [];
    if (q) bits.push(`scene 1 asks: ${esc(q)}`);
    if ((spec.timeline || []).length) bits.push(`${spec.timeline.length} world event(s)`);
    else if (s.gate === "world" || stageIndex(stageOf(s)) > stageIndex("structure"))
      bits.push("no world events — pressure runs between people");
    return bits.length ? `<p class="side-copy">${bits.join(" · ")}</p>` : "";
  }
  return "";
}

/** The progression header: six decisions, each done, open, or ahead. It answers "where am I"
 *  on every frame, so no stage section has to recite the position itself. */
function stagesHtml(s) {
  const open = stageOf(s);
  const cur = stageIndex(open);
  return `<ol class="stages" aria-label="architect progression" data-tid="scaffold.stages">${STAGES.map((t, i) =>
    `<li${tid("scaffold.stage")} class="stage${i < cur ? " done" : i === cur ? " open" : ""}" data-stage="${t.key}"`
    + (i === cur ? ` aria-current="step"` : "") + `>`
    + `<span class="stage-num">${i < cur ? "✓" : i + 1}</span>`
    + `<span class="stage-copy"><b>${STAGE_LABELS[t.key]}</b><small>${esc(t.q)}</small></span></li>`
  ).join("")}</ol>`;
}

// ── shared round status ─────────────────────────────────────────────────────
// The last round's outcome (or the standing question), shown at the top of whichever stage is
// open. Mirrors showRound() at the console.

function statusBlock(s) {
  if (s.pendingAsk)
    return `<div class="round-question"><span class="label">the architect's question</span><p>${esc(s.pendingAsk)}</p></div>`;
  return lastHtml(s.last);
}

/** Findings: validation presented as story-design problems, not a flat warning list.
 *  Three buckets over signals the engine already emits — nothing here invents a check:
 *  Blocking (load-bearing content absent, or a gate state that already refuses approve),
 *  Needs attention (an ambiguity or contradiction in the architecture), Suggestion
 *  (hygiene the author can proceed past). Every finding names what is wrong, where it
 *  occurs, why it matters, and the shortest fix. An unrecognized string lands in the
 *  unsorted bucket, visible — never dropped to make the groups look clean. */
const FINDING_RULES = [
  // Blocking — the Writer cannot reasonably start without these.
  { sev: "blocking", re: /^no title/i, where: "direction",
    why: "An untitled story gives the Writer nothing to shape toward.",
    fix: "Say the title." },
  { sev: "blocking", re: /^no premise/i, where: "direction",
    why: "Without a premise the cast, style and scenes answer to nothing.",
    fix: "Say what happens, to whom, and what is at stake." },
  { sev: "blocking", re: /no characters at all/i, where: "cast",
    why: "No cast means no scene can be written and no consult can fire.",
    fix: "Say who walks into scene 1." },
  { sev: "blocking", re: /(scene \d+) has no question/i, where: 1,
    why: "A scene with nothing to answer gives the Writer no objective to write toward.",
    fix: "Say what that scene asks." },
  { sev: "blocking", re: /came back as text rather than an object/i, where: "structure",
    why: "Scene 1 has no usable shape — the reply carried no scene to keep.",
    fix: "Say where scene 1 happens and what it asks." },
  // Needs attention — the architecture contradicts itself or names someone absent.
  { sev: "attention", re: /(scene \d+) roster "([^"]+)" is not one of the characters/i, where: 1,
    why: "A scene requiring someone outside the cast asks the Writer for a stranger.",
    fix: "Rename them to a cast member, or add the character." },
  { sev: "attention", re: /roster "[^"]+" is not one of the characters/i, where: "the Blueprint",
    why: "A scene requiring someone outside the cast asks the Writer for a stranger.",
    fix: "Rename them to a cast member, or add the character." },
  { sev: "attention", re: /(scene \d+) pov "[^"]+" is not in the roster/i, where: 1,
    why: "The reader would sit inside the perception of someone not placed in the room.",
    fix: "Add them to the roster, or move the POV to someone in it." },
  { sev: "attention", re: /pov "[^"]+" is not one of the characters/i, where: "the Blueprint",
    why: "The POV was cleared, so scene 1 currently has no eyes.",
    fix: "Say whose eyes scene 1 is seen through." },
  { sev: "attention", re: /grants reach to "[^"]+", who is not/i, where: "the Blueprint",
    why: "A capability granted to someone absent never reaches a run.",
    fix: "Grant it to a roster member, or place them in the scene." },
  { sev: "attention", re: /keys a memory to "[^"]+", who is not/i, where: "the Blueprint",
    why: "A memory for someone absent silently never implants.",
    fix: "Key it to a roster member, or place them in the chapter." },
  { sev: "attention", re: /aimed at chapter (\d+), past the story's last scene/i, where: "the world ledger",
    why: "A beat aimed past the last scene can never fire.",
    fix: "Re-aim it at a written chapter, or void it." },
  { sev: "attention", re: /beats fire in authored order/i, where: "the world ledger",
    why: "Two beats compete for the same page — the later one fires early.",
    fix: "Reorder their `at` points so the authored order matches the intended one." },
  { sev: "attention", re: /carries quoted speech/i, where: "the world ledger",
    why: "An event with a voice reads as an invented line to the quote lint.",
    fix: "Keep the held and fired forms wordless." },
  { sev: "attention", re: /still names "[^"]+", who was renamed/i, where: "the Blueprint",
    why: "A rename left a stale reference — that field still talks about someone gone.",
    fix: "Say what the field should name now." },
  { sev: "attention", re: /is not one of the imported characters/i, where: "cast",
    why: "The cast gate added someone the author never chose from the library.",
    fix: "Reject them, or keep them deliberately." },
  { sev: "attention", re: /reverted to/i, where: "the Blueprint",
    why: "The architect rewrote something the author chose (a library field or the preset style) and the engine put it back.",
    fix: "Change it under Libraries if the new value is what you want." },
  { sev: "attention", re: /persona restates/i, where: "the Blueprint",
    why: "The persona repeats a rendered field and will contradict it on the page.",
    fix: "Say what the persona should carry instead." },
  { sev: "attention", re: /was left out of the proposal — added back/i, where: "cast",
    why: "An import the reply omitted was restored — worth checking it still fits.",
    fix: "Reject them if they do not, or leave them placed." },
  { sev: "suggestion", re: /with no name — dropped|two characters called|keeping the first \d+/i, where: "cast",
    why: "The engine kept the Blueprint unambiguous by dropping the extra entry.",
    fix: "Re-add them with a distinct name if they matter." },
  { sev: "attention", re: /— dropped/i, where: "the Blueprint",
    why: "The engine discarded something malformed rather than keep a broken entry.",
    fix: "Re-add it in the shape the note names." },
  // Suggestion — potential improvement, safe to proceed past.
  { sev: "suggestion", re: /has no belief|has no impulse|has no voice samples/i, where: "the Blueprint",
    why: "A character without psychology defaults to agreeable — friction costs extra later.",
    fix: "Give them the missing belief, impulse, or voice line." },
  { sev: "suggestion", re: /has no persona/i, where: "the Blueprint",
    why: "Without a persona the character arrives as a name with a job.",
    fix: "Say who they are beyond their role." },
  { sev: "suggestion", re: /not a bible skill, and it carries no ":: meaning"/i, where: "the Blueprint",
    why: "Nobody — engine or reader — can tell what the skill lets them do.",
    fix: "Write it as `name :: what it lets them do`, or promote it to the bible." },
  { sev: "suggestion", re: /not a known skill, so it would remove nothing/i, where: "the Blueprint",
    why: "The restriction names nothing the character has, so it changes no behavior.",
    fix: "Name a general, bible, or own skill — or drop it." },
  { sev: "suggestion", re: /more than 3 voice samples/i, where: "the Blueprint",
    why: "Only the first three reach the prompt; the rest is dead weight.",
    fix: "Keep the three that sound most like them." },
  { sev: "suggestion", re: /arrived with "learned"/i, where: "the Blueprint",
    why: "Housekeeping only — it was folded into knows.",
    fix: "Nothing to do." },
  { sev: "suggestion", re: /nobody has any restrictions/i, where: "cast",
    why: "Without one restriction the consult has no perceptual asymmetry to bite on.",
    fix: "Give one character something they cannot do." },
  { sev: "suggestion", re: /against maxSteps|consulted at each beat/i, where: "structure",
    why: "A wide cast spends the step budget on breadth instead of depth.",
    fix: "Narrow the roster, or raise config.maxSteps." },
];

function findingOf(text) {
  for (const r of FINDING_RULES) {
    // A rule without a matcher must never match-all: skip it loudly in structure,
    // invisibly here — the unsorted bucket below is the honest fallback.
    if (!(r.re instanceof RegExp) || typeof r.sev !== "string") continue;
    const m = String(text || "").match(r.re);
    if (m) return { sev: r.sev, what: String(text),
      where: typeof r.where === "number" ? (m[r.where] || "the Blueprint") : r.where,
      why: r.why, fix: r.fix };
  }
  return { sev: "unsorted", what: String(text), where: "the Blueprint",
    why: "An engine note with no category yet — shown rather than hidden to keep the groups honest.",
    fix: "Say what should change about it." };
}

function findingsHtml(s) {
  const list = [...(s.problems || [])].map(findingOf);
  if (s.pendingAsk) list.unshift({ sev: "blocking",
    what: "A question stands — nothing passes until it is answered.",
    where: s.gate ? `${s.gate} gate` : "the open gate",
    why: "The architect cannot proceed without a call only the author can make.",
    fix: "Answer in the composer below." });
  if (s.last && s.last.kind === "blocked") list.unshift({ sev: "blocking",
    what: s.last.why || "The cast gate is blocked.",
    where: "cast gate",
    why: "A stateless judge found this cast's asymmetry does not bite on the tension.",
    fix: "Refine the cast below, or approve again to overrule." });
  if (!list.length) return "";
  const groups = [
    ["blocking", "Blocking — the Writer cannot reasonably start"],
    ["attention", "Needs attention — ambiguity or contradiction"],
    ["suggestion", "Suggestion — safe to proceed"],
    ["unsorted", "Unsorted engine note"],
  ];
  return groups.map(([sev, label]) => {
    const mine = list.filter(f => f.sev === sev);
    if (!mine.length) return "";
    return `<div class="stage-problems"><span class="label">${label}</span>` + mine.map(f =>
      `<div class="finding finding-${sev}" data-tid="scaffold.finding" data-sev="${sev}">`
      + `<p><strong>${esc(f.what)}</strong><span class="hint"> · ${esc(f.where)}</span></p>`
      + `<p class="hint">Why it matters: ${esc(f.why)}</p>`
      + `<p class="hint">Shortest fix: ${esc(f.fix)}</p></div>`).join("") + `</div>`;
  }).join("");
}

// A bespoke skill is the architect telling you this cast needed a capability the bible does not
// have. The bible itself is managed under Libraries -- this names what this story invented, so
// nothing here writes the reusable catalog and accepting the story never does.
function bibleCardHtml(s) {
  const candidates = s.bibleCandidates || [];
  if (!candidates.length) return "";
  return `<div class="side-card card" data-tid="scaffold.bible-candidates">
    <h3>new skills in this story</h3>
    <p class="side-copy">Invented for this cast, and not in your skill bible. They live in this
      story only, unless you adopt one as reusable.</p>
    ${candidates.map(c => `<div class="stat"><span>${esc(c.name)}</span>
        <strong>${esc(c.heldBy.join(", "))}</strong></div>
      <p class="side-copy">${esc(c.meaning)}</p>`).join("")}
    <p class="side-copy"><a href="#/catalog?kind=skills">Adopt one under Libraries → Skills</a> and the
      next story can reuse it by name instead of inventing it again.</p>
  </div>`;
}

/** What the last round did, said plainly. Mirrors showRound() at the console. */
function lastHtml(last) {
  if (!last) return "";
  const at = last.stage ? `<span class="hint">[${esc(last.stage)}] </span>` : "";
  if (last.kind === "failed")  return errorLine(`${at}that round failed (${esc(last.error)}) — nothing changed`);
  if (last.kind === "nothing") {
    if (/review the draft and accept/.test(last.why))
      return `<div class="said good">${at}checklist complete — review the Blueprint, then accept</div>`;
    if (/has not landed/.test(last.why))
      return errorLine(`${at}this stage has nothing yet — ${esc(last.why)}`);
    return errorLine(`${at}it didn't come back with anything — ${esc(last.why || "try saying who is in the scene and what is at stake")}`);
  }
  // A blocked gate is not a failure and not an empty round: the stage landed, and a judge says it
  // is not yet worth advancing past. It is the author's to overrule, so it reads as a judgement.
  if (last.kind === "blocked")
    return `<div class="round-note"><span class="label">the cast gate</span><p>${esc(last.why)}</p>`
      + hint(`refine the cast, or approve again to overrule this.`) + `</div>`;
  if (last.kind === "edits") {
    const changed = last.applied.length ? `changed: ${esc(last.applied.join(", "))}` : "it changed nothing";
    const ig = last.ignored.map(x => errorLine(`ignored ${esc(x)}`)).join("");
    const note = last.note ? `<div class="round-note"><span class="label">architect note</span><p>${esc(last.note)}</p></div>` : "";
    return `${note}<div class="said good">${at}${changed}</div>${ig}`;
  }
  if (last.kind === "proposal")
    return last.note ? `<div class="round-note"><span class="label">architect note</span><p>${esc(last.note)}</p></div>` : "";
  return "";
}

// ── generated content per stage ─────────────────────────────────────────────
// The same proposal, dealt into the stage that owns it. Later scenes render as question-only
// provisional sketches -- the handoff re-authors them. An empty ledger says so out loud rather
// than rendering as a blank section the author cannot tell apart from a stage that failed.

function directionBits(s) {
  const spec = s.spec;
  const ch = changedSections(s);
  return [
    changedTag(ch, "direction"),
    spec.title ? `<h4>${esc(spec.title)} <span class="tag prov-ai">proposed</span></h4>` : "",
    spec.premise ? `<p class="stage-copy">${esc(spec.premise)} <span class="tag prov-ai">proposed</span></p>` : "",
    s.tension ? `<div class="question"><span class="label">load-bearing tension</span> <span class="tag prov-ai">proposed</span>${esc(s.tension)}</div>` : "",
    factsHtml(spec),
  ].join("");
}

function voiceBadge(s) {
  // A set styleId means the voice standing is the reusable preset verbatim (the settings gate
  // reverts any rewrite); otherwise the architect authored it for this story.
  return ((s.concept || {}).styleId && s.spec.writerStyle)
    ? `<span class="tag prov-catalog">reusable style · from your library</span>`
    : `<span class="tag prov-ai">proposed style</span>`;
}

// The accept step names what rode in from the catalog, because the link ends here: story.json
// keeps the words, never where they came from (engine/architect.ts's provenance invariant, kept).
// Renders nothing when everything was proposed for this story.
function acceptProvenanceHtml(s) {
  const spec = s.spec || {};
  const catalog = catalogOf(s);
  const names = (spec.characters || [])
    .filter(c => catalog.has(String(c.name || "").toLowerCase()))
    .map(c => c.name);
  const styleId = (s.concept || {}).styleId;
  const styleFromCatalog = Boolean(styleId && spec.writerStyle);
  if (!names.length && !styleFromCatalog) return "";
  const bits = [];
  if (names.length) bits.push(`cast from your library: ${esc(names.join(", "))}`);
  if (styleFromCatalog) {
    const styleName = (s.concept || {}).styleName;
    bits.push(styleName ? `style from your library: “${esc(styleName)}”` : `style from your library`);
  }
  return hint(`${bits.join(" · ")} — story.json keeps the words, not where they came from.`);
}

function castworldBits(s) {
  const spec = s.spec;
  const ch = changedSections(s);
  // Scoped regenerate is offered on the member's own card, and only at the staged cast gate —
  // openCastworld spans the settings gate too, and reviewBits (oneshot + final review) keeps the
  // whole-gate button only. Same availability as regenRowHtml: a scoped re-run would overwrite
  // full-editor touches on that member just as surely.
  const fromEditor = !!s.last && s.last.kind === "edits" && s.last.note === "updated from the story editor";
  const scoped = s.mode === "staged" && s.gate === "cast" && !s.busy && !s.pendingAsk && !fromEditor;
  const entries = rejectEntriesOf(s);
  return [
    changedTag(ch, "cast"),
    spec.characters.length ? castHtml(spec, catalogOf(s), scoped, entries)
      : hint(`No cast yet — the architect proposes one, or cast reusable characters above.`),
    changedTag(ch, "voice"),
    spec.writerStyle ? `<p class="stage-copy">${voiceBadge(s)} ${esc(spec.writerStyle)}</p>`
      : hint(`No style yet — pick a reusable style above, or leave the house style to the architect.`),
  ].join("");
}

function structureBits(s) {
  const spec = s.spec;
  const ch = changedSections(s);
  const out = [changedTag(ch, "structure")];
  out.push(sceneHtml(spec)
    || ((s.gate === "scene" || s.gate === "world")
      ? hint(`Scene 1 has no shape yet — say where it happens and what it asks.`) : ""));
  // Later scenes are provisional question sketches -- the handoff re-authors them, so they render
  // as questions and nothing else.
  const sketches = (spec.scenes || []).slice(1).filter(sc => sc.question);
  if (sketches.length) out.push(`<div class="mt-sm"><span class="label">later scenes · provisional</span>${
    sketches.map(sc => `<div class="question mt-xs">${esc(sc.question)}</div>`).join("")}</div>`);
  out.push(timelineHtml(spec)
    || ((s.gate === "world")
      ? `<p class="stage-copy">No world events — the pressure in this story runs between the people in it.</p>` : ""));
  return out.join("");
}

// ── review: decisions first, blueprint behind expandables ────────────────────
// Review answers one question — "would I trust this plan enough to let the Writer
// start?" — so the decisions that carry the story render prominently and the complete
// Blueprint sits behind expandables reusing the stage renderers above. No new data:
// the protagonist is derived from scene 1's POV (labelled as derived), and open
// contradictions are s.problems folded in here — which is why openReview drops the
// separate engine-notes block the other stages keep.
function reviewDecisionsHtml(s) {
  const spec = s.spec || {};
  const scenes = spec.scenes || [];
  const sc1 = scenes[0] || {};
  const pov = sc1.pov || "";
  const cast = spec.characters || [];
  const protagonist = cast.find(c => c.name === pov) || cast[0] || null;
  const beats = spec.timeline || [];
  const decision = (label, body) =>
    `<div class="decision"><span class="label">${label}</span>${body}</div>`;
  const roles = cast.length
    ? `<ul class="decision-roles">${cast.map(c =>
        `<li><strong>${esc(c.name)}</strong>${c.goal ? ` — ${esc(c.goal)}` : " — no goal yet"}</li>`).join("")}</ul>`
    : hint(`No cast yet — say who walks into scene 1.`);
  const structure = [
    ...scenes.filter(sc => sc.question)
      .map((sc, i) => `<div class="question mt-xs"><span class="label">scene ${i + 1}</span>${esc(sc.question)}</div>`),
    ...beats.map((b, i) =>
      `<div class="question mt-xs"><span class="label">world event ${i + 1} · chapter ${esc(b.chapter)}</span>${esc(b.hold)}</div>`),
  ].join("") || hint(`No structural beats yet — scene 1's dramatic question lands first.`);
  return `<div data-tid="scaffold.review-decisions">`
    + `<p class="hint">Would you trust this plan enough to let the Writer start? Read the decisions below — the full Blueprint waits behind the expandables.</p>`
    + decision("premise", spec.premise
      ? `<p class="stage-copy">${esc(spec.premise)} <span class="tag prov-ai">proposed</span></p>`
      : hint(`No premise yet.`))
    + decision("protagonist · derived from scene 1's POV", protagonist
      ? `<p class="stage-copy"><strong>${esc(protagonist.name)}</strong>${protagonist.goal ? ` — ${esc(protagonist.goal)}` : ""}</p>`
      : hint(`No POV yet — say whose eyes scene 1 is seen through.`))
    + decision("central conflict", [
        s.tension ? `<div class="question"><span class="label">load-bearing tension</span> <span class="tag prov-ai">proposed</span>${esc(s.tension)}</div>` : "",
        sc1.question ? `<div class="question"><span class="label">scene 1 asks</span> <span class="tag prov-ai">proposed</span>${esc(sc1.question)}</div>` : "",
      ].join("") || hint(`No conflict yet — the tension and scene 1's question land in their stages.`))
    + decision("character roles", roles)
    + decision("structural beats", structure)
    + decision("open contradictions", findingsHtml(s)
      || `<p class="stage-copy">None flagged — the engine's checks pass. Approval still takes a confirming click.</p>`)
    + `</div>`;
}

function reviewBlueprintDetails(s) {
  const spec = s.spec;
  const ch = changedSections(s);
  const sketches = (spec.scenes || []).slice(1).filter(sc => sc.question);
  const group = (key, label, body) => body
    ? `<details class="card stage-done" data-tid="scaffold.blueprint-details" data-stage="${key}">`
      + `<summary><span class="label">complete Blueprint</span> <strong>${label}</strong></summary>`
      + `<div class="card-body">${body}</div></details>` : "";
  return group("direction", "Direction — title, tension, facts", [
      changedTag(ch, "direction"),
      spec.title ? `<h4>${esc(spec.title || "(untitled)")} <span class="tag prov-ai">proposed</span></h4>` : "",
      spec.premise ? `<p class="stage-copy">${esc(spec.premise)} <span class="tag prov-ai">proposed</span></p>` : "",
      s.tension ? `<div class="question"><span class="label">load-bearing tension</span> <span class="tag prov-ai">proposed</span>${esc(s.tension)}</div>` : "",
      factsHtml(spec),
    ].join(""))
    + group("cast", "Cast & style", [
      changedTag(ch, "cast"),
      spec.characters.length ? castHtml(spec, catalogOf(s), false, rejectEntriesOf(s)) : "",
      changedTag(ch, "voice"),
      spec.writerStyle ? `<p class="stage-copy">${voiceBadge(s)} ${esc(spec.writerStyle)}</p>` : "",
    ].join(""))
    + group("structure", "Structure — scenes & world events", [
      technicalHtml(spec),
      changedTag(ch, "structure"),
      sceneHtml(spec),
      sketches.length ? `<div class="mt-sm"><span class="label">later scenes · provisional</span>${
        sketches.map(sc => `<div class="question mt-xs">${esc(sc.question)}</div>`).join("")}</div>` : "",
      timelineHtml(spec)
        || `<p class="stage-copy">No world events — the pressure in this story runs between the people in it.</p>`,
    ].join(""));
}

/** The handoff summary — one screen answering "is this ready to write?". Premise, main
 *  characters, major structure with its scene count, and validation via the same grouped
 *  findings Review shows (blocking and non-blocking stay in their groups). The Writer entry
 *  names the story it opens, so the blueprint link is stated before anything is written. */
function handoffSummaryHtml(s) {
  const spec = s.spec || {};
  const cast = spec.characters || [];
  const scenes = spec.scenes || [];
  const questions = scenes.filter(sc => sc.question);
  const flags = s.problems || [];
  const title = spec.title?.trim() || "(untitled)";
  return `<div data-tid="scaffold.handoff-summary">`
    + `<p class="stage-copy"><strong>Your story is ready to write.</strong> `
    + `Start writing opens “${esc(title)}” — chapter 1, written from the approved Blueprint exactly as it stands.</p>`
    + (spec.premise ? `<p class="stage-copy">${esc(spec.premise)} <span class="tag prov-ai">proposed</span></p>` : "")
    + (cast.length
      ? `<div class="decision"><span class="label">main characters · ${cast.length}</span><ul class="decision-roles">`
        + cast.map(c => `<li><strong>${esc(c.name)}</strong>${c.goal ? ` — ${esc(c.goal)}` : ""}</li>`).join("")
        + `</ul></div>` : "")
    + (questions.length
      ? `<div class="decision"><span class="label">major structure · ${scenes.length} scene${scenes.length === 1 ? "" : "s"}</span>`
        + questions.map((sc, i) => `<div class="question mt-xs"><span class="label">scene ${i + 1}</span>${esc(sc.question)}</div>`).join("")
        + `</div>` : "")
    + `<div class="decision"><span class="label">validation · ${flags.length ? `${flags.length} open flag${flags.length === 1 ? "" : "s"}` : "checks pass"}</span>`
    + (findingsHtml(s)
      || `<p class="stage-copy">None flagged — the engine's checks pass.</p>`) + `</div>`
    + `</div>`;
}

/** The accept step -- opened by the sidebar's accept button, or forced open by a needs_folder
 *  answer. Owns acceptance while it is open -- "Start writing" IS the accept, through the same
 *  folder-scoped POST that writes story.json verbatim from the approved spec. */
function folderHtml(s) {
  // The folder is the story's identity on disk, and two stories built from one premise land on the
  // same title and so the same slug. accept() refuses a taken folder, but only after the click --
  // say it here, while the name is still being typed.
  return `<section class="card" data-tid="scaffold.folder-card">
    <div class="card-head">
      <div><span class="label">accept</span><h3>Your story is ready to write</h3></div>
      ${s.needsFolder ? `<span class="label">needs_folder</span>` : ""}
    </div>
    <div class="card-body">
      ${handoffSummaryHtml(s)}
      ${acceptProvenanceHtml(s)}
      <label class="field-label" for="f-folder">story folder</label>
      <input type="text" id="f-folder" value="${esc(draft.folder)}">
      <div id="iv-folder-note">${folderNoteHtml()}</div>
      <div class="composer-foot">
        <span class="hint">nothing is written until Start writing answers</span>
        ${thinking("writing &amp; preflighting…", { show: s.busy, tag: "span" })}
      </div>
      <div class="side-actions">${button({ label: "Start writing →", id: "iv-folder", variant: "primary", disabled: folderTaken() })}</div>
      <div class="side-actions secondary">
        ${!s.needsFolder && APP.folderOpen ? button({ label: "← return to Blueprint", id: "iv-folder-back" }) : ""}
        ${button({ label: "save and leave", id: "iv-save-leave" })}
      </div>
      <details class="card stage-done" data-tid="scaffold.handoff-details">
        <summary><span class="label">complete Blueprint</span> <strong>Inspect details</strong></summary>
        <div class="card-body">${reviewBlueprintDetails(s)}</div>
      </details>
    </div>
  </section>`;
}

/** Whether the typed folder would land on a story that already exists. The engine refuses this
 *  anyway; knowing it here is what lets the step say so before the click, not after. */
function folderTaken() {
  const slug = slugify(draft.folder);
  return Boolean(slug) && (APP.stories || []).some(x => x.dir === slug);
}

/** What the name will actually become, or why it cannot be used. */
function folderNoteHtml() {
  const slug = slugify(draft.folder);
  if (!draft.folder.trim()) return "";
  if (!slug) return warnLine("that gives no usable folder name.");
  if (folderTaken()) return warnLine(`data/stories/${esc(slug)} already exists — pick another name.`);
  return slug !== draft.folder.trim() ? `<div class="hint">this lands in <b>data/stories/${esc(slug)}</b></div>` : "";
}

// ── proposal lifecycle: regenerate & revert ───────────────────────────────────
// Regenerating re-runs the open stage's prompt through /scaffold/regenerate — staged
// re-proposes only the open gate's fields (the merge starts from the current spec, so every
// other gate keeps what it has), one-shot re-proposes the whole story. At the staged cast gate
// each member also carries its own regenerate button, posting the same action with a scope —
// only that entry is ever replaced. The conversation is kept, so refinements usually survive;
// nothing reaches disk either way, and anything it
// replaces can be re-said, reverted below, or abandoned with the session. Reverting puts back
// exactly what the latest edits round changed, field by field through /scaffold/set — the same
// path as the full editor — after verifying each field still holds what the round left.

function regenSubject(s) {
  if (s.mode === "oneshot") return "proposal";
  if (s.gate === "story") return "direction";
  if (s.gate === "cast") return "cast";
  if (s.gate === "settings") return "style";
  return "structure";
}

function regenRowHtml(s) {
  const subject = regenSubject(s);
  const fromEditor = !!s.last && s.last.kind === "edits" && s.last.note === "updated from the story editor";
  if (s.busy || s.pendingAsk || fromEditor) {
    const why = s.busy ? "a round is already in flight"
      : s.pendingAsk ? "answer the question first — answering already re-runs the gate"
      : "the last change came from the full editor — re-running would overwrite it; say what should change instead";
    return hint(`Regenerating the ${esc(subject)} is unavailable: ${why}.`);
  }
  const scope = s.mode === "oneshot"
    ? "A fresh whole-story proposal."
    : "Only this stage's prompt re-runs — other stages keep what they have.";
  const one = s.mode === "staged" && s.gate === "cast"
    ? " For one member, use the regenerate button on its card." : "";
  return `<div class="side-actions">${button({ label: `regenerate ${subject}`, id: "iv-regen" })}</div>`
    + hint(`${scope} The conversation is kept, so refinements usually survive. For one field, say what you want instead.${one}`);
}

function revertRowHtml(s) {
  if (!s.last || s.last.kind !== "edits" || s.busy || !s.storyDraft) return "";
  const plan = revertPlan(s.last.applied || [], s.storyDraft);
  if (!plan.ok) return hint(`This round can't be reverted in place (${plan.reason}) — say what should come back instead.`);
  const n = plan.count;
  return `<div class="side-actions">${button({ label: `revert this round (${n} field${n === 1 ? "" : "s"})`, id: "iv-revert" })}</div>`
    + hint(`Puts back what this round changed, field by field. Nothing is written to disk.`);
}

const eqJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cloneJson = o => JSON.parse(JSON.stringify(o ?? null));

// One applied entry → verify/apply against the StoryJson-shaped draft, or a reason it cannot
// be put back: structural adds/removes (except by verified value), renames (references were
// rewritten alongside), tension (session-only, never on the draft), and whole-draft replaces.
function revertOp(field, before, after, snapshot) {
  const fail = reason => ({ ok: false, reason });
  const scalar = (get, set) => ({
    ok: true,
    verify: d => eqJson(get(d), after) ? { ok: true } : fail(`"${field}" changed since — say what you want instead`),
    apply: d => { set(d, cloneJson(before)); return { ok: true }; },
  });
  let m;
  if (field === "title" || field === "premise")
    return scalar(d => d[field], (d, v) => { d[field] = v; });
  if (field === "writer_style") return scalar(d => d.writerStyle, (d, v) => { d.writerStyle = v; });
  if (field === "writer_style_constraints")
    return scalar(d => d.writerStyleConstraints, (d, v) => { d.writerStyleConstraints = v; });
  if (field === "facts") return scalar(d => d.facts, (d, v) => { d.facts = v; });
  if ((m = field.match(/^updated fact (\d+)$/))) {
    const i = Number(m[1]) - 1;
    return scalar(d => (d.facts || [])[i], (d, v) => { d.facts[i] = v; });
  }
  if (field === "added fact") return {
    ok: true,
    verify: d => eqJson((d.facts || [])[(d.facts || []).length - 1], snapshot)
      ? { ok: true } : fail(`the added fact changed since — say what you want instead`),
    apply: d => { d.facts.pop(); return { ok: true }; },
  };
  if ((m = field.match(/^removed fact (\d+)$/))) {
    const i = Number(m[1]) - 1;
    return { ok: true, verify: () => ({ ok: true }), apply: d => { d.facts.splice(i, 0, before); return { ok: true }; } };
  }
  if ((m = field.match(/^scene(?:_(\d+))?\.(place|question|pov|length|roster|reach|writerThink|writerModel)$/))) {
    const i = m[1] ? Number(m[1]) - 1 : 0, k = m[2];
    return scalar(d => (d.scenes || [])[i]?.[k], (d, v) => { d.scenes[i][k] = v; });
  }
  if ((m = field.match(/^added scene (\d+)$/))) {
    const i = Number(m[1]) - 1;
    return {
      ok: true,
      verify: d => eqJson((d.scenes || [])[i], snapshot)
        ? { ok: true } : fail(`the added scene changed since — say what you want instead`),
      apply: d => { d.scenes.splice(i, 1); return { ok: true }; },
    };
  }
  if ((m = field.match(/^removed scene (\d+)$/))) {
    const i = Number(m[1]) - 1;
    return { ok: true, verify: () => ({ ok: true }), apply: d => { d.scenes.splice(i, 0, cloneJson(before)); return { ok: true }; } };
  }
  if ((m = field.match(/^added beat (\d+)$/))) {
    const i = Number(m[1]) - 1;
    return {
      ok: true,
      verify: d => eqJson(((d.timeline || []))[i], snapshot)
        ? { ok: true } : fail(`the added beat changed since — say what you want instead`),
      apply: d => { d.timeline.splice(i, 1); return { ok: true }; },
    };
  }
  if ((m = field.match(/^removed beat (\d+)$/))) {
    const i = Number(m[1]) - 1;
    return { ok: true, verify: () => ({ ok: true }), apply: d => { d.timeline.splice(i, 0, cloneJson(before)); return { ok: true }; } };
  }
  if ((m = field.match(/^beat_(\d+)\.(chapter|at|hold|fired|state|memories)$/))) {
    const i = Number(m[1]) - 1, k = m[2];
    return scalar(d => (d.timeline || [])[i]?.[k], (d, v) => { d.timeline[i][k] = v; });
  }
  if ((m = field.match(/^added (.+)$/))) {
    const name = m[1].toLowerCase();
    return {
      ok: true,
      verify: d => {
        const c = (d.characters || []).find(x => String(x.name).toLowerCase() === name);
        return c && eqJson(c, snapshot) ? { ok: true } : fail(`"${m[1]}" changed since — say what you want instead`);
      },
      apply: d => { d.characters = d.characters.filter(x => String(x.name).toLowerCase() !== name); return { ok: true }; },
    };
  }
  if ((m = field.match(/^removed (.+)$/))) {
    return { ok: true, verify: () => ({ ok: true }), apply: d => { d.characters.push(cloneJson(before)); return { ok: true }; } };
  }
  if ((m = field.match(/^(?:characters\.)?(.+?)\.learned$/))) {
    const name = m[1].toLowerCase();
    const find = d => (d.characters || []).find(x => String(x.name).toLowerCase() === name);
    return scalar(d => find(d)?.knows, (d, v) => { find(d).knows = v; });
  }
  if ((m = field.match(/^(?:characters\.)?(.+?)\.(persona|knows|goal|belief|impulse|voice|origin|skills|restrictions|lacks|maxRetries)$/))) {
    const name = m[1].toLowerCase();
    const k = m[2] === "lacks" ? "restrictions" : m[2];
    const find = d => (d.characters || []).find(x => String(x.name).toLowerCase() === name);
    return scalar(d => find(d)?.[k], (d, v) => { find(d)[k] = v; });
  }
  if (/\.name$/.test(field))
    return fail(`renames also rewrote scene references — say what should come back instead`);
  if ((m = field.match(/^config\.thinking\.([a-z]+)$/))) {
    const k = m[1];
    return scalar(d => d.config?.thinking?.[k], (d, v) => { d.config.thinking[k] = v; });
  }
  if ((m = field.match(/^config\.([a-zA-Z]+)$/))) {
    const k = m[1];
    return scalar(d => d.config?.[k], (d, v) => { d.config[k] = v; });
  }
  if ((m = field.match(/^models\.(default|writer|summary)$/))) {
    const k = m[1];
    return scalar(d => d.models?.[k], (d, v) => { d.models[k] = v; });
  }
  if (field === "tension") return fail(`tension lives on the session, not the Blueprint`);
  if (field === "story") return fail(`a full Blueprint replacement has no single round to put back`);
  return fail(`unknown field "${field}"`);
}

function revertPlan(applied, draft) {
  const ops = [];
  for (const a of applied || []) {
    const op = revertOp(String((a && a.field) || ""), a && a.before, a && a.after, a && a.snapshot);
    if (!op.ok) return { ok: false, reason: op.reason };
    ops.push(op);
  }
  if (!ops.length) return { ok: false, reason: "the round changed nothing to put back" };
  // Verify every field against the draft BEFORE touching any of them: a revert either puts the
  // whole round back or explains why, never half a round.
  for (const op of ops) {
    const r = op.verify(draft);
    if (!r.ok) return { ok: false, reason: r.reason };
  }
  return { ok: true, count: ops.length,
    apply: (d) => { for (const op of ops) op.apply(d); return { ok: true }; } };
}

// ── Block G: reject one generated item ────────────────────────────────────────
// The last round's put-backable entries: rejectable on a fresh proposal, applied on an edits
// round. Anything else — a question, nothing, a failure — offers no targets, and while a gate
// runs nothing is offered either. Matching is always against s.last, so a stale button can never
// fire: the entries it matched are gone with the round.
const rejectEntriesOf = s => (s && !s.busy && s.last && s.last.kind === "proposal" ? s.last.rejectable
  : s && !s.busy && s.last && s.last.kind === "edits" ? s.last.applied : null) || [];
const addedEntryFor = (entries, name) => (entries || []).find(e =>
  String((e && e.field) || "").toLowerCase() === `added ${String(name || "").toLowerCase()}`);
const fieldEntryFor = (entries, name, field) => {
  const n = String(name || "").toLowerCase();
  const keys = field === "knows"
    ? [`${n}.knows`, `characters.${n}.knows`, `${n}.learned`, `characters.${n}.learned`]
    : [`${n}.${field}`, `characters.${n}.${field}`];
  return (entries || []).find(e => keys.includes(String((e && e.field) || "").toLowerCase()));
};

/** Put back exactly one entry through the same verify-then-apply machinery as revertRound().
 *  Applied-shaped entries strip the snapshot the whole-round path verifies against, so the after
 *  value plays that role here — for an added member it is the normalized character, verified
 *  against the draft before anything is removed. Posts source "revert": no new route, no new
 *  host method. */
async function revertOne(entry) {
  const s = APP.scaffold;
  if (!s || s.busy || !s.storyDraft || !entry) return;
  const single = [{ field: String(entry.field || ""), before: entry.before, after: entry.after,
                    snapshot: entry.after }];
  const plan = revertPlan(single, s.storyDraft);
  if (!plan.ok) { APP.scaffoldError = `cannot put that back: ${plan.reason}`; APP.render(); return; }
  const patched = cloneJson(s.storyDraft);
  plan.apply(patched);
  await postScaffold("set", { story: patched, source: "revert" });
  // An imported member lives in the tray as well as the spec: leaving the tray entry would let
  // the next whole-gate regen add them straight back via the import contract.
  const m = /^added (.+)$/.exec(String(entry.field || ""));
  const imp = m && ((APP.scaffold.concept || {}).imported || [])
    .find(i => String(i.name || "").toLowerCase() === m[1].toLowerCase());
  if (imp && APP.scaffold && !APP.scaffold.busy && !APP.scaffoldError) {
    const ids = ((APP.scaffold.concept || {}).imported || []).map(i => i.libraryId)
      .filter(id => id !== imp.libraryId);
    await postScaffold("import", { importIds: ids });
  }
}

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
  const err = APP.scaffoldError ? errorLine(esc(APP.scaffoldError)) : "";

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

async function postScaffold(what, payload) {
  const j = await postJson(`/scaffold/${what}`, payload || {},
    msg => { APP.scaffoldError = msg; APP.render(); });
  if (!j) return null;
  if (j.active !== undefined) { APP.scaffoldError = ""; APP.scaffold = j; APP.render(); return j; }
  if (j.ok) { APP.scaffoldError = ""; APP.render(); return j; }        // abandon, and a clean accept
  APP.scaffoldError =
    j.kind === "unloadable"     ? `it does not load, so nothing was kept — ${j.error}`
    : j.kind === "needs_folder" ? ""                            // the folder step renders itself
    : reasonOr(j, "that did not go through");
  APP.render();
  return j;
}

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
