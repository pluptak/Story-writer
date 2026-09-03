import { $, esc, reasonOr, slugify, tid } from "./util.js";
import { APP, draft } from "./state.js";
import { go } from "./nav.js";
import { loadStories } from "./saved-runs.js";
import { loadVocab, loadLibrary, loadStyles } from "./catalog.js";

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

// The stepper's display names, one-line descriptions, and approve labels. The engine's stage
// strings never change -- CHECKLIST owns them -- so the author-facing vocabulary lives beside the
// gate keys. The descriptions are the old sidebar helper card's prose, given to the step they
// describe: the summary travels with the step instead of living in a card the step's reader has
// already scrolled past.
const GATE_LABELS = {
  story: "Concept", cast: "Cast", settings: "Voice",
  technical: "Technical", scene: "Scenes", world: "World",
};
const GATE_DESCS = {
  story: "title, premise, tension, facts.",
  cast: "who walks into scene 1.",
  settings: "the house style.",
  technical: "run settings and retry limits.",
  scene: "scene 1 in full; later ones as sketches.",
  world: "world events, and who remembers them.",
};
const APPROVE_LABELS = {
  story: "accept the concept", cast: "accept the cast", settings: "accept the voice",
  technical: "accept the run shape", scene: "accept the scene", world: "accept the world",
};

// ── the idea step (modal) ────────────────────────────────────────────────────

const modelField = () =>
  `<div class="field"><label for="f-model">built by</label>
    <select id="f-model">
      <option value=""${draft.model ? "" : " selected"}>defaults${
        APP.modelDefault ? " · " + esc(APP.modelDefault) : ""}</option>
      ${APP.modelIds.map(id => `<option value="${esc(id)}"${draft.model === id ? " selected" : ""}>${esc(id)}</option>`).join("")}
    </select></div>`;

const modeChoice = (value, title, blurb) => {
  const on = value === "oneshot" ? draft.mode === "oneshot" : draft.mode !== "oneshot";
  return `<label class="choice${on ? " selected" : ""}">
    <input type="radio" name="mode" value="${value}"${on ? " checked" : ""}>
    <b>${title}</b><span>${blurb}</span></label>`;
};

const FACET_LABELS = { genre: "Genre", dramaticMode: "Dramatic Mode", tone: "Tone" };

// The vocabulary is the tag catalog's, and only the catalog authors it: an off-vocabulary tag is
// something the route tolerates, not something this picker offers. Curated is the point -- free
// text here would be a second idea box.
function tagChipsHtml() {
  const vocab = APP.catalog.vocab || [];
  if (!vocab.length)
    return `<p class="hint">No tags in the catalog yet — <a href="#/catalog?kind=tags">add some</a> and they show up here.</p>`;
  const rows = Object.entries(FACET_LABELS).map(([facet, label]) => {
    const mine = vocab.filter(t => t.facet === facet);
    if (!mine.length) return "";
    const chips = mine.map(t =>
      `<button class="cat-chip${draft.tags.includes(t.label) ? " on" : ""}" data-tag-label="${esc(t.label)}" type="button">${esc(t.label)}</button>`).join("");
    return `<div class="cat-tags-group"><div class="cat-facet-heading">${label}</div>
      <div class="cat-tags-row">${chips}</div></div>`;
  }).join("");
  return `<div class="cat-tags-picker">${rows}</div>`;
}

const castSizeFieldHtml = () =>
  `<div class="field"><label for="f-cast-size">opening cast</label>
    <select id="f-cast-size">
      ${[[0, "let the architect decide"], [2, "2 characters"], [3, "3 characters"], [4, "4 characters"]]
        .map(([n, label]) => `<option value="${n}"${draft.castSize === n ? " selected" : ""}>${label}</option>`).join("")}
    </select></div>`;

const MAX_IMPORTS = 4;   // the cast stage's ceiling, mirrored from server/scaffold-routes.ts

// The catalog's characters, offered as a set to pick from. Picking one is not the same as the
// architect inventing one: the cast gate switches to a different prompt entirely, and the fields
// that travel with a character stop being the architect's to change.
function importPickerHtml() {
  const lib = APP.catalog.library || [];
  if (!lib.length)
    return `<p class="hint">No characters in the catalog yet — <a href="#/catalog">add some</a> and you can cast them here.</p>`;
  const chips = lib.map(c => {
    const on = draft.importIds.includes(c.id);
    const full = !on && draft.importIds.length >= MAX_IMPORTS;
    return `<button class="cat-chip${on ? " on" : ""}" data-import-id="${esc(c.id)}" type="button"${
      full ? " disabled" : ""} title="${esc(c.portablePersona || c.name)}">${esc(c.name)}</button>`;
  }).join("");
  return `<div class="cat-tags-row">${chips}</div>`;
}

// The presets the author's tags speak to, first. Ranking is ALL this does with them: a tag is a
// steering word for the story gate and nothing else, and passing one into the settings prompt as
// well would give it a second, unarbitrated channel into the story. Every preset stays on offer.
function rankedStyles() {
  const chosen = new Set(draft.tags.map(t => t.toLowerCase()));
  const hits = e => (e.tags || []).filter(t => chosen.has(String(t).toLowerCase())).length;
  return (APP.catalog.styles || []).map((e, i) => ({ e, i, n: hits(e) }))
    .sort((a, b) => b.n - a.n || a.i - b.i).map(x => x.e);
}

// One voice, or none. Picking one narrows the settings gate to this story's own narration rules;
// picking none leaves it writing the whole house style, which is what it has always done.
function stylePickerHtml() {
  const styles = rankedStyles();
  if (!styles.length)
    return `<p class="hint">No styles in the catalog yet — <a href="#/catalog?kind=styles">add some</a> and you can pick one here.</p>`;
  const chips = styles.map(e =>
    `<button class="cat-chip${draft.styleId === e.id ? " on" : ""}" data-style-id="${esc(e.id)}" type="button"` +
    ` title="${esc(e.description || e.voice)}">${esc(e.name)}</button>`).join("");
  const picked = styles.find(e => e.id === draft.styleId);
  return `<div class="cat-tags-row">${chips}</div>` + (picked
    ? `<p class="hint">The architect is handed this voice and asked only what THIS cast and POV make impossible to narrate.</p>`
    : `<p class="hint">Pick none and the architect writes the house style itself.</p>`);
}

// The concept is staged-only: the one-shot walk has no story gate for tags to steer, no cast gate
// for a size to reach and no settings gate to hand a voice, so offering any of them there would be
// a control that does nothing. Callers make that call -- the modal by the chosen mode, the sidebar
// by whether any half still steers a gate ahead.
function conceptFieldsHtml() {
  return `<label class="field-label">the concept <span class="hint">optional — it steers the gates ahead</span></label>
    ${tagChipsHtml()}
    <label class="field-label">cast from the library <span class="hint">optional</span></label>
    ${importPickerHtml()}
    ${draft.importIds.length ? `<p class="hint">The imported cast is the opening cast, so its size is already chosen.</p>` : castSizeFieldHtml()}
    <label class="field-label">the voice <span class="hint">optional — a preset from your style catalog</span></label>
    ${stylePickerHtml()}`;
}

function ideaModalHtml() {
  const err = APP.scaffoldError ? `<div class="said bad">${esc(APP.scaffoldError)}</div>` : "";
  return `<div class="modal-backdrop" id="iv-backdrop" data-tid="scaffold.idea-modal" role="dialog" aria-modal="true" aria-label="new story">
    <section class="picker iv">
      <h2>Give the architect the rough idea</h2>
      <p class="sub">A situation, not a plot — it will find the pressure in it, and ask if it needs more.</p>
      <div class="field"><label for="f-idea">the idea</label>
        <textarea id="f-idea" rows="4" placeholder="${esc(IDEA_PLACEHOLDER)}">${esc(draft.idea)}</textarea></div>
      <label class="field-label">how it proposes</label>
      <div class="choice-grid">
        ${modeChoice("staged", "stage by stage",
            "The gated checklist: story → cast → settings → scene, an approval between each.")}
        ${modeChoice("oneshot", "the whole story at once",
            "One complete proposal, then conversational refinement.")}
      </div>
      ${draft.mode === "oneshot" ? "" : conceptFieldsHtml()}
      ${modelField()}
      ${err}
      <div class="btns"><button class="btn primary" id="iv-start">propose →</button>
        <button class="btn" id="iv-back">back to the shelf</button>
        <span class="hint">ctrl/⌘ + ↵</span></div>
    </section>
  </div>`;
}

// ── the proposal panel ────────────────────────────────────────────────────────

function castHtml(spec) {
  // Reach is scene-scoped, so it is shown per character but labelled with the scene that grants it
  // -- never as an intrinsic skill.
  const reachOf = name => (spec.scenes?.[0]?.reach || {})[name]
    || Object.entries(spec.scene?.reach || {}).find(([k]) => k === name)?.[1] || [];
  return `<div class="cast">${spec.characters.map(c => {
    const tag = (t, cls = "") => `<span class="tag${cls}">${t}</span>`;
    const skills = c.skills.map(s => esc(s.text) + (s.meaning ? ` :: ${esc(s.meaning)}` : "")).join(", ");
    const reach = reachOf(c.name);
    return `<div class="person" data-tid="scaffold.person" data-name="${esc(c.name)}">
      <div class="person-top"><span class="person-name">${esc(c.name)}</span></div>
      ${c.persona ? `<p>${esc(c.persona)}</p>` : ""}
      ${c.knows ? tag(`knows: ${esc(c.knows)}`) : ""}
      ${c.goal ? tag(`goal: ${esc(c.goal)}`) : ""}
      ${c.belief ? tag(`belief: ${esc(c.belief)}`) : ""}
      ${c.impulse ? tag(`impulse: ${esc(c.impulse)}`) : ""}
      ${(c.voice || []).map(v => tag(`voice: “${esc(v)}”`)).join("")}
      ${skills ? tag(`skills: ${skills}`) : ""}
      ${(Array.isArray(reach) ? reach : []).map(r =>
        tag(`reach · scene 1: ${esc(r)}`, " reach")).join("")}
      ${c.restrictions.map(r => tag(`restriction: ${esc(r)}`, " warn")).join("")}
      ${c.maxRetries !== undefined ? tag(`retry limit: ${esc(c.maxRetries)}`) : ""}
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
    ${sc.question ? `<div class="question"><span class="label">dramatic question</span>${esc(sc.question)}</div>` : ""}
  </div>`;
}

function factsHtml(spec) {
  const facts = spec.facts || [];
  if (!facts.length) return "";
  return `<div class="facts">${facts.map(f =>
    `<div class="fact"><strong>fact</strong><span>${esc(f)}</span></div>`).join("")}</div>`;
}

function technicalHtml(spec) {
  const config = spec.config || {};
  const value = v => typeof v === "object" && v !== null
    ? Object.entries(v).map(([k, x]) => `${k}: ${x}`).join(" · ")
    : String(v);
  const rows = Object.entries(config).map(([key, val]) =>
    `<div class="fact"><strong>${esc(key)}</strong><span>${esc(value(val))}</span></div>`).join("");
  if (!rows) return "";
  return `<div class="technical"><span class="label">run settings</span><div class="facts">${rows}</div></div>`;
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
      <p class="scene-meta">world event ${i + 1} · chapter ${esc(b.chapter)} · fires at ${esc(b.at)} of the target</p>
      <div class="facts">
        <div class="fact"><strong>held</strong><span>${esc(b.hold)}</span></div>
        <div class="fact"><strong>fired</strong><span>${esc(b.fired)}</span></div>
        ${mem.map(([who, m]) => `<div class="fact"><strong>${esc(who)} remembers</strong><span>${esc(m)}</span></div>`).join("")}
      </div>
    </div>`;
  }).join("");
}

function gateReached(s, gate) {
  if (!s.gate) return true;
  return GATES.indexOf(s.gate) >= GATES.indexOf(gate);
}

function stageSection(name, body, current) {
  if (!body) return "";
  return `<div class="stage-section${current ? " current" : ""}" data-tid="scaffold.stage-section" data-stage="${esc(name)}">
    <span class="label">${current ? "current stage · " : ""}${esc(name)}</span>${body}
  </div>`;
}

/** The stage tag that labels what the draft is showing. The gate recital is gone -- the stepper in
 *  the left rail owns the checklist position now, so the head keeps only the walk's name. */
function draftLabel(s) {
  return "draft so far";
}

function proposalHtml(s) {
  const spec = s.spec;
  const story = [
    spec.premise ? `<p class="stage-copy">${esc(spec.premise)}</p>` : "",
    s.tension ? `<div class="question"><span class="label">load-bearing tension</span>${esc(s.tension)}</div>` : "",
    factsHtml(spec),
  ].join("");
  const cast = spec.characters.length ? castHtml(spec) : "";
  const settings = spec.writerStyle && gateReached(s, "settings")
    ? `<p class="stage-copy">${esc(spec.writerStyle)}</p>` : "";
  const technical = gateReached(s, "technical") ? technicalHtml(spec) : "";
  let scene = sceneHtml(spec);
  // Later scenes are provisional question sketches -- the handoff re-authors them, so they render
  // as questions and nothing else.
  const sketches = (spec.scenes || []).slice(1).filter(sc => sc.question);
  if (sketches.length) scene += `<div style="margin-top:14px"><span class="label">later scenes · provisional</span>${
    sketches.map(sc => `<div class="question" style="margin-top:6px">${esc(sc.question)}</div>`).join("")}</div>`;

  // An empty ledger is the commonest correct answer, so the open world gate says so out loud
  // rather than rendering as a blank section the author cannot tell apart from a stage that failed.
  const world = !gateReached(s, "world") ? ""
    : timelineHtml(spec) || (s.gate === "world"
      ? `<p class="stage-copy">No world events — the pressure in this story runs between the people in it.</p>` : "");
  const content = { story, cast, settings, technical, scene, world };
  const order = s.gate && GATES.includes(s.gate)
    ? [s.gate, ...GATES.filter(g => g !== s.gate)]
    : GATES;
  const bits = order.map(g => stageSection(g, content[g], g === s.gate)).filter(Boolean);
  for (const p of (s.problems || [])) bits.push(`<div class="prob">⚠ ${esc(p)}</div>`);
  return `<section class="card" data-tid="scaffold.proposal-card">
    <div class="card-head">
      <div><span class="label">${esc(draftLabel(s))}</span><h3>${esc(spec.title || "(untitled)")}</h3></div>
      <span class="label">${s.gate && GATES.indexOf(s.gate) === GATES.length - 1 ? "ready" : "proposal"}</span>
    </div>
    <div class="card-body">${bits.join("")}</div>
  </section>`;
}

// ── the stepper (staged) ──────────────────────────────────────────────────────

/** One row per gate, in the left rail -- done, open, or ahead. It is the checklist, the draft
 *  label's gate recital, and the sidebar's gate summary collapsed into the one place that is
 *  always visible, so the position question has one answer instead of three. */
function stepperHtml(s) {
  if (!GATES.includes(s.gate)) return "";
  const cur = GATES.indexOf(s.gate);
  return `<div class="checklist" aria-label="checklist position" data-tid="scaffold.checklist">${GATES.map((g, i) =>
    `<span${tid("scaffold.gate")} class="gate${i < cur ? " done" : i === cur ? " open" : ""}" data-gate="${g}"><i>${i < cur ? "✓" : i + 1}</i><span class="gate-copy"><b>${GATE_LABELS[g]}</b><small>${GATE_DESCS[g]}</small></span></span>`
  ).join("")}</div>`;
}

// ── the round narration ───────────────────────────────────────────────────────

/** What the last round did, said plainly. Mirrors showRound() at the console. */
function lastHtml(last) {
  if (!last) return "";
  const at = last.stage ? `<span class="hint">[${esc(last.stage)}] </span>` : "";
  if (last.kind === "failed")  return `<div class="said bad">${at}that round failed (${esc(last.error)}) — nothing changed</div>`;
  if (last.kind === "nothing") {
    if (/review the draft and accept/.test(last.why))
      return `<div class="said good">${at}checklist complete — review the draft, then accept</div>`;
    if (/has not landed/.test(last.why))
      return `<div class="said bad">${at}this stage has nothing yet — ${esc(last.why)}</div>`;
    return `<div class="said bad">${at}it didn't come back with anything — ${esc(last.why || "try saying who is in the scene and what is at stake")}</div>`;
  }
  // A blocked gate is not a failure and not an empty round: the stage landed, and a judge says it
  // is not yet worth advancing past. It is the author's to overrule, so it reads as a judgement.
  if (last.kind === "blocked")
    return `<div class="round-note"><span class="label">the cast gate</span><p>${esc(last.why)}</p>`
      + `<p class="hint">refine the cast, or approve again to overrule this.</p></div>`;
  if (last.kind === "edits") {
    const changed = last.applied.length ? `changed: ${esc(last.applied.join(", "))}` : "it changed nothing";
    const ig = last.ignored.map(x => `<div class="said bad">ignored ${esc(x)}</div>`).join("");
    const note = last.note ? `<div class="round-note"><span class="label">architect note</span><p>${esc(last.note)}</p></div>` : "";
    return `${note}<div class="said good">${at}${changed}</div>${ig}`;
  }
  if (last.kind === "proposal")
    return last.note ? `<div class="round-note"><span class="label">architect note</span><p>${esc(last.note)}</p></div>` : "";
  return "";
}

/** The conversation card: last round's outcome, the checklist, and the composer — or, while a
 *  question stands, the question and an answer box with the approve button withheld. */
function roundHtml(s) {
  const busy = !!s.busy;
  const answering = !!s.pendingAsk;
  const parts = [];

  if (answering) {
    parts.push(`<div class="round-question"><span class="label">the architect's question</span><p>${esc(s.pendingAsk)}</p></div>`);
  } else {
    parts.push(lastHtml(s.last));
  }

  if (!busy) {
    const label = answering ? "your answer" : s.haveDraft ? "what should change?" : "say more about it";
    parts.push(`<label class="field-label" for="f-say">${label}</label>
      <textarea id="f-say" rows="3">${esc(draft.say)}</textarea>`);
  }

  const foot = [];
  const busyDot = `<span class="thinking${busy ? " show" : ""}"><i></i>the architect is thinking…</span>`;
  if (!busy) {
    foot.push(`<span class="hint">↵ send · ⇧↵ new line</span>`);
    foot.push(busyDot);
    if (answering) {
      foot.push(`<button class="btn primary" id="iv-say">send answer →</button>`);
    } else {
      const unsent = !!draft.say.trim();
      foot.push(`<button class="btn${unsent ? " primary" : ""}" id="iv-say">send</button>`);
      // approve passes the open gate; hidden at the last gate and while a question stands. Once a
      // gate came back blocked, the same button overrules it and says so. The label names the gate
      // being passed -- "accept the cast" -- because "approve" stopped saying what the click does.
      if (s.gate && GATES.indexOf(s.gate) < GATES.length - 1)
        foot.push(APP.approveArmed
          ? `<button class="btn danger" id="iv-approve">approve anyway →</button>`
          : `<button class="btn${unsent ? "" : " primary"}" id="iv-approve">${APPROVE_LABELS[s.gate]} &amp; continue →</button>`);
    }
  } else {
    foot.push(`<span class="hint">↵ send · ⇧↵ new line</span>`);
    foot.push(busyDot);
  }

  const headline = answering ? "Answer the architect" : "Refine or approve";
  const tag = answering ? "question" + (s.gate ? ` · [${s.gate}]` : "")
                        : s.last?.kind === "proposal" ? "proposal" : "round";
  return `<section class="card" data-tid="scaffold.round-card">
    <div class="card-head">
      <div><span class="label">architect</span><h3>${headline}</h3></div>
      <span class="label">${esc(tag)}</span>
    </div>
    <div class="card-body">
      ${parts.join("")}
      <div class="composer-foot">${foot.join("")}</div>
    </div>
  </section>`;
}

/** The accept step -- opened by the sidebar's accept button, or forced open by a needs_folder
 *  answer. Owns acceptance while it is open -- "write story.json →" IS the accept. */
function folderHtml(s) {
  // The folder is the story's identity on disk, and two stories built from one premise land on the
  // same title and so the same slug. accept() refuses a taken folder, but only after the click --
  // say it here, while the name is still being typed.
  return `<section class="card" data-tid="scaffold.folder-card">
    <div class="card-head">
      <div><span class="label">accept</span><h3>Name the story folder</h3></div>
      ${s.needsFolder ? `<span class="label">needs_folder</span>` : ""}
    </div>
    <div class="card-body">
      <p>${esc(s.needsFolder || "Name where this story lands — nothing is written until you accept.")}</p>
      <label class="field-label" for="f-folder">story folder</label>
      <input type="text" id="f-folder" value="${esc(draft.folder)}">
      <div id="iv-folder-note">${folderNoteHtml()}</div>
      <div class="composer-foot">
        <span class="hint">nothing is written until this answers</span>
        <span class="thinking${s.busy ? " show" : ""}"><i></i>writing &amp; preflighting…</span>
        ${!s.needsFolder && APP.folderOpen ? `<button class="btn" id="iv-folder-back">&larr; keep editing</button>` : ""}
        <button class="btn primary" id="iv-folder"${folderTaken() ? " disabled" : ""}>write story.json →</button>
      </div>
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
  if (!slug) return `<div class="prob">that gives no usable folder name.</div>`;
  if (folderTaken()) return `<div class="prob">stories/${esc(slug)} already exists — pick another name.</div>`;
  return slug !== draft.folder.trim() ? `<div class="hint">this lands in <b>stories/${esc(slug)}</b></div>` : "";
}

// ── the sidebar ────────────────────────────────────────────────────────────────

function sidebarHtml(s) {
  const walk = s.mode === "oneshot" ? "one-shot" : "staged";
  const stat = (k, v) => `<div class="stat"><span>${k}</span><strong>${esc(v)}</strong></div>`;
  const c = s.concept || {};
  // "spent" is the honest word for it: the stage that reads this half has produced its content, so
  // nothing ahead will read it again. Revising it after that changes a string nobody looks at.
  const stats = [stat("walk", walk)];
  if (s.mode !== "oneshot") {
    stats.push(stat("open gate", s.pendingAsk ? `${s.gate} (asked)` : s.gate || "—"));
    if (c.tags && c.tags.length)
      stats.push(stat("tags", c.tags.join(", ") + (c.tagsSteer ? "" : " · spent")));
    if (c.castSize) stats.push(stat("opening cast", c.castSize + (c.castSizeSteers ? "" : " · spent")));
    if (c.imported && c.imported.length)
      stats.push(stat("cast from library", c.imported.map(i => i.name).join(", ")
        + (c.importsSteer ? "" : " · placed")));
    if (c.styleName) stats.push(stat("voice", c.styleName + (c.styleSteers ? "" : " · spent")));
  }
  stats.push(stat("on disk", s.needsFolder ? "pending accept" : "nothing yet"));

  const actions = [];
  const acceptable = s.haveStory && !s.needsFolder && !APP.folderOpen && !s.busy;
  if (s.haveStory && !s.needsFolder)
    actions.push(`<button class="btn" id="iv-edit">edit in full →</button>`);
  if (acceptable) {
    const unsent = !!draft.say.trim();
    const flags = (s.problems || []).length;
    const label = !APP.acceptArmed ? "accept &amp; choose folder"
      : unsent ? "discard what you typed and write it"
      : `accept over ${flags} flag(s)`;
    actions.push(`<button class="btn primary${APP.acceptArmed ? " armed" : ""}" id="iv-accept">${label}</button>`);
  }
  actions.push(`<button class="btn danger${APP.abandonArmed ? " armed" : ""}" id="iv-abandon">${
    APP.abandonArmed ? "abandon — sure?" : "abandon"}</button>`);

  const conceptWarning = c.unknownTags && c.unknownTags.length
    ? `<div class="prob">not in the tag catalog: ${esc(c.unknownTags.join(", "))} — sent to the architect anyway</div>`
    : "";

  const importsWarning = c.missingImports && c.missingImports.length
    ? `<div class="prob">no longer in the catalog: ${esc(c.missingImports.join(", "))} — these were dropped from the cast</div>`
    : "";

  const styleWarning = c.missingStyle
    ? `<div class="prob">the style "${esc(c.missingStyle)}" is no longer in the catalog — the architect writes the house style itself</div>`
    : "";

  // Revising is offered only while some half still reaches a prompt ahead. Once both are spent the
  // control disappears rather than going quietly inert -- an editor that cannot change the run is
  // worse than no editor, because it looks like it can.
  const conceptLive = s.mode !== "oneshot" && (c.tagsSteer || c.castSizeSteers || c.importsSteer || c.styleSteers);
  const conceptEditor = !conceptLive ? "" : APP.conceptOpen
    ? `<div data-tid="scaffold.concept-editor">${conceptFieldsHtml()}
        <div class="side-actions">
          <button class="btn primary" id="iv-concept-save">save concept</button>
          <button class="btn" id="iv-concept-cancel">cancel</button></div></div>`
    : `<div class="side-actions"><button class="btn" id="iv-concept-edit">revise concept</button></div>`;

  // The tension is the sentence, not the fact of one: it is what the cast was authored against, and
  // "coined" said it exists without letting the author read it. Shown as its text, here, it is also
  // what the story editor still has no view of -- that half stays open.
  const tensionShape = s.tension
    ? `<div class="side-tension"><span class="label">load-bearing tension</span>
        <p class="side-copy">${esc(s.tension)}</p></div>`
    : "";

  // The staged helper card is gone: every gate's summary is its stepper row's description now, read
  // beside the step instead of listed in a card. The one-shot walk has no steps, so its principle
  // stays.
  const helper = s.mode === "oneshot"
    ? `<div class="side-card card"><h3>principle</h3>
        <p class="side-copy">The architect proposes; you accept. Nothing writes itself until you name a folder.</p></div>`
    : "";

  // A bespoke skill is the architect telling you this cast needed a capability the bible does not
  // have. Promoting it is a write to the author's own catalog, so it is the author's click and not
  // a side effect of accepting the story.
  const candidates = s.bibleCandidates || [];
  const bibleCard = !candidates.length ? "" : `
    <div class="side-card card" data-tid="scaffold.bible-candidates">
      <h3>new skills</h3>
      <p class="side-copy">Invented for this cast, and not in your skill bible. Promote one and the
        next story can reuse it by name instead of inventing it again.</p>
      ${candidates.map(c => `<div class="stat"><span>${esc(c.name)}</span>
          <strong>${esc(c.heldBy.join(", "))}</strong></div>
        <p class="side-copy">${esc(c.meaning)}</p>
        <div class="side-actions"><button class="btn" data-promote="${esc(c.name)}">promote to bible</button></div>`).join("")}
    </div>`;

  return `<aside data-tid="scaffold.sidebar">
    <div class="side-card card" data-tid="scaffold.state-card">
      <h3>scaffold state</h3>
      ${stats.join("")}
      ${tensionShape}
      ${conceptWarning}
      ${importsWarning}
      ${styleWarning}
      ${conceptEditor}
      <div class="side-actions">${actions.join("")}</div>
    </div>
    ${bibleCard}
    ${helper}
  </aside>`;
}

// ── page assembly ─────────────────────────────────────────────────────────────

function activePageHtml(s) {
  const folderStep = !!(s.needsFolder || APP.folderOpen);
  const workspace = [];
  if (s.spec) workspace.push(proposalHtml(s));
  workspace.push(folderStep ? folderHtml(s) : roundHtml(s));
  const err = APP.scaffoldError && !folderStep ? `<div class="said bad">${esc(APP.scaffoldError)}</div>` : "";

  const statusText = s.busy ? "the architect is working…"
    : s.pendingAsk ? "a question pins this gate until you answer it"
    : folderStep ? "name the folder — nothing is written until you do"
    : "ready · nothing is on disk until you accept";
  const spacer = (s.mode === "oneshot" ? "one-shot walk" : `gate: ${s.gate || "—"}`)
    + (s.model ? ` · built by ${esc(s.model)}` : "");
  const headline = s.pendingAsk ? "The architect has a question"
    : s.haveDraft ? "Does this look right?" : "Your story is taking shape";
  // The stepper rides along only when there are steps to show; a one-shot walk keeps the two-panel
  // shell it always had.
  const gated = s.mode !== "oneshot";

  return `
    <div class="sc-head">
      <p class="eyebrow">scaffold · ${s.mode === "oneshot" ? "one-shot" : "staged"}</p>
      <h2>${headline}</h2>
      <p class="lede">${esc(s.idea || "")}</p>
    </div>
    <div class="statusbar">
      <span class="status-dot${s.busy || folderStep ? " busy" : ""}"></span>
      <span>${statusText}</span>
      <span class="spacer">${spacer}</span>
    </div>
    <div class="shell${gated ? " gated" : ""}">
      ${gated ? `<aside class="stepper-rail">${stepperHtml(s)}</aside>` : ""}
      <div class="workspace">${err}${workspace.join("")}</div>
      ${sidebarHtml(s)}
    </div>`;
}

/** The whole page. An accept in flight shows a writing state rather than falling back to the idea
 *  modal in the window between the {active:false} SSE frame and the run starting. */
function scaffoldPageHtml() {
  const s = APP.scaffold;
  if (APP.scaffoldAccepting) {
    return `<div class="scpage"><div class="shell"><div class="workspace"><section class="card">
      <div class="card-body"><p class="thinking show"><i></i>writing story.json and preflighting…</p></div>
    </section></div></div></div>`;
  }
  if (!s.active) {
    return `<div class="scpage">
      <div class="sc-head"><p class="eyebrow">scaffold interview</p>
        <h2>Nothing proposed yet</h2>
        <p class="lede">Describe an idea below. The editor stays empty until the first proposal lands.</p></div>
      ${ideaModalHtml()}
    </div>`;
  }
  return `<div class="scpage">${activePageHtml(s)}</div>`;
}

// The render entry point. `pages.js` calls these two.
export function scaffoldHtml() { return scaffoldPageHtml(); }

// ── posting & wiring ──────────────────────────────────────────────────────────

async function postScaffold(what, payload) {
  let j = null;
  try {
    const r = await fetch(`/scaffold/${what}`, { method:"POST", headers:{ "Content-Type":"application/json" },
                                                 body: JSON.stringify(payload || {}) });
    j = await r.json();
  } catch { APP.scaffoldError = "the engine did not answer"; APP.render(); return null; }
  if (j && j.active !== undefined) { APP.scaffoldError = ""; APP.scaffold = j; APP.render(); return j; }
  if (j && j.ok) { APP.scaffoldError = ""; APP.render(); return j; }        // abandon, and a clean accept
  APP.scaffoldError =
    j && j.kind === "unloadable"     ? `it does not load, so nothing was kept — ${j.error}`
    : j && j.kind === "needs_folder" ? ""                            // the folder step renders itself
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
const disarmAbandon = () => { clearTimeout(APP.abandonArmed); APP.abandonArmed = 0; APP.render(); };

/** A change, sent. The text stays in the draft until the round actually lands, so a 409 or dropped
 *  connection doesn't lose what you had written with nothing said about it. */
async function sendSay() {
  const text = draft.say.trim();
  if (!text || APP.scaffold.busy) return;
  const j = await postScaffold("say", { text });
  if (j && j.active !== undefined) { draft.say = ""; APP.render(); }
}

async function startInterview() {
  const idea = draft.idea.trim();
  if (!idea || APP.scaffold.busy) return;
  const mode = draft.mode === "oneshot" ? "oneshot" : "staged";
  APP.scaffoldError = "";
  APP.folderOpen = false;
  APP.scaffold = { active:true, busy:true, idea, problems:[], haveStory:false, model:draft.model,
                   mode, gate: mode === "staged" ? "story" : null };
  APP.render();
  const concept = mode === "oneshot" ? {}
    : { tags: draft.tags, castSize: draft.castSize, importIds: draft.importIds, styleId: draft.styleId };
  const j = await postScaffold("start", { idea, model: draft.model, mode, ...concept });
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
  // Open the folder step; "write story.json →" owns the actual accept and the run it starts. The
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
  if (j && j.ok) { draft.idea = draft.say = draft.folder = ""; APP.scaffoldAccepting = false; APP.folderOpen = false; go("live"); }
  // A refusal is usually needs_folder, which forces the step open without going through
  // acceptStory() -- so the taken-folder check needs the story list fetched here too.
  else { APP.scaffoldAccepting = false; APP.render(); loadStories(); }
}

export function wireScaffold(page) {
  const on = (id, fn) => { const el = page.querySelector("#" + id); if (el) el.addEventListener("click", fn); };
  const onKey = (id, fn) => { const el = page.querySelector("#" + id); if (el) el.addEventListener("keydown", fn); };
  const plain = e => !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing;

  // Keep what is being typed across the re-renders SSE frames cause.
  for (const [id, key] of [["f-idea","idea"], ["f-say","say"], ["f-folder","folder"]]) {
    const el = page.querySelector("#" + id);
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

  // Both pickers are fed from the catalog, fetched once each; each loader re-renders when it lands,
  // so a picker fills itself in rather than staying empty on a cold first open. The trigger is the
  // CONTAINER that always renders -- the modal, or the sidebar's concept editor -- never the picker
  // markup itself, which only exists once the data it needs has already arrived.
  if (page.querySelector("#iv-backdrop") || page.querySelector('[data-tid="scaffold.concept-editor"]')) {
    loadVocab();
    loadLibrary();
    loadStyles();
  }

  // The character library is fetched once for the import picker.

  for (const chip of page.querySelectorAll(".cat-chip[data-tag-label]"))
    chip.addEventListener("click", () => {
      const label = chip.getAttribute("data-tag-label");
      const at = draft.tags.indexOf(label);
      if (at >= 0) draft.tags.splice(at, 1); else draft.tags.push(label);
      APP.render();
    });

  for (const chip of page.querySelectorAll(".cat-chip[data-import-id]"))
    chip.addEventListener("click", () => {
      const id = chip.getAttribute("data-import-id");
      const at = draft.importIds.indexOf(id);
      if (at >= 0) draft.importIds.splice(at, 1);
      else if (draft.importIds.length < MAX_IMPORTS) draft.importIds.push(id);
      APP.render();
    });
  // One at a time, and clicking the chosen one clears it: "no preset" is a real answer, not the
  // absence of one, and it is what the settings gate did before this existed.
  for (const chip of page.querySelectorAll(".cat-chip[data-style-id]"))
    chip.addEventListener("click", () => {
      const id = chip.getAttribute("data-style-id");
      draft.styleId = draft.styleId === id ? "" : id;
      APP.render();
    });

  const cast = page.querySelector("#f-cast-size");
  if (cast) cast.addEventListener("change", () => { draft.castSize = Number(cast.value) || 0; });

  for (const b of page.querySelectorAll("[data-promote]"))
    b.addEventListener("click", () => postScaffold("promote", { name: b.getAttribute("data-promote") }));

  // Enter sends; the idea box is a paragraph, so there the modifier sends and Enter is a newline.
  onKey("f-say", e => { if (e.key === "Enter" && plain(e)) { e.preventDefault(); sendSay(); } });
  onKey("f-idea", e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); startInterview(); } });
  onKey("f-folder", e => { if (e.key === "Enter" && plain(e)) { e.preventDefault(); acceptIntoFolder(); } });

  on("iv-back", () => go("shelf"));
  on("iv-start", startInterview);
  on("iv-say", sendSay);
  on("iv-approve", async () => {
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
  on("iv-edit", () => {
    // The optional full editor for the same in-memory draft -- it syncs back through /scaffold/set.
    APP.editNew = true; APP.editDir = "";
    go("edit");
  });
  on("iv-abandon", () => {
    // Abandoning throws away the whole interview; nothing on the server keeps a copy, so it gets
    // a confirming second click.
    if (!APP.abandonArmed) { APP.abandonArmed = setTimeout(disarmAbandon, 4000); APP.render(); return; }
    clearTimeout(APP.abandonArmed); APP.abandonArmed = 0;
    postScaffold("abandon", {}).then(() => {
      APP.scaffold = { active:false }; APP.scaffoldError = ""; APP.folderOpen = false;
      draft.idea = draft.say = draft.folder = "";
      draft.tags = [];
      draft.castSize = 0;
      draft.importIds = [];
      draft.styleId = "";
      go("shelf");
    });
  });
  // Opening seeds the modal's draft from the session, not the other way round: the session is the
  // truth, and after a reload the draft is empty while the concept is not.
  on("iv-concept-edit", () => {
    const c = APP.scaffold.concept || {};
    draft.tags = [...(c.tags || [])];
    draft.castSize = c.castSize || 0;
    draft.importIds = (c.imported || []).map(i => i.libraryId);
    draft.styleId = c.styleId || "";
    APP.conceptOpen = true; APP.render();
  });
  on("iv-concept-cancel", () => { APP.conceptOpen = false; APP.render(); });
  on("iv-concept-save", async () => {
    await postScaffold("concept", { tags: draft.tags, castSize: draft.castSize, styleId: draft.styleId });
    await postScaffold("import", { importIds: draft.importIds });
    APP.conceptOpen = false; APP.render();
  });

  on("iv-folder", acceptIntoFolder);
  on("iv-folder-back", () => {
    // Only the locally-opened step can be dismissed -- a needs_folder demand stays until answered.
    APP.folderOpen = false; APP.render();
  });
  on("iv-accept", acceptStory);
}
