/**
 * STORY EDITOR — schema-aware editor for a story's story.json, server-validated.
 * Renders every editable field with appropriate controls, tracks dirty state,
 * debounces validation through /story/check, and saves through /story/save.
 */

import { esc, post, tid } from "./util.js";
import { APP, draft } from "./state.js";
import { go } from "./nav.js";

// Dirty-guard: warn before closing the tab / navigating away
addEventListener("beforeunload", e => {
  if (APP.editDirty) { e.preventDefault(); e.returnValue = ""; }
});

// ── helpers ────────────────────────────────────────────────────────────────

const fld = (id, label, value, type) =>
  `<div class="field${type === "half" ? " half" : type === "third" ? " third" : ""}">` +
  `<label for="${id}">${label}</label>` +
  (type === "model"
    ? `<input id="${id}" type="text" value="${esc(value ?? "")}" list="model-list"`
      + ` placeholder="model id — the datalist suggests what LM Studio has loaded">`
    : type === "textarea" || (value != null && value.length > 80)
    ? `<textarea id="${id}" rows="${type === "small" ? 3 : 5}">${esc(value ?? "")}</textarea>`
    : type === "number"
    ? `<input id="${id}" type="number" value="${esc(String(value ?? ""))}">`
    : type === "checkbox"
    ? `<input id="${id}" type="checkbox"${value ? " checked" : ""}>`
    : type === "select"
    ? value  /* pre-rendered html */
    : `<input id="${id}" type="text" value="${esc(value ?? "")}">`) +
  `</div>`;

const thinkSelect = (id, label, current) => {
  const opts = ["off", "low", "medium", "high", "default"].map(v =>
    `<option value="${v}"${v === current ? " selected" : ""}>${v}</option>`).join("");
  return `<div class="field"><label for="${id}">${label}</label><select id="${id}">${opts}</select></div>`;
};

/** Voice samples: one line of dialogue per line of the textarea; the schema caps them at three. */
const voiceFld = (i, voice) => {
  const lines = Array.isArray(voice) ? voice.join("\n") : "";
  return `<div class="field"><label for="char-${i}-voice">Voice (one sample per line, max 3)</label>` +
    `<textarea id="char-${i}-voice" rows="3">${esc(lines)}</textarea></div>`;
};

/** Deep clone an object by serialising it — Zod-parsed data is plain JSON anyway. */
function clone(o) { return JSON.parse(JSON.stringify(o)); }

function scaffoldStory(spec) {
  const story = clone(spec);
  story.characters = (story.characters || []).map(c => ({
    ...c,
    skills: (c.skills || []).map(s => typeof s === "string" ? s : [s.text, s.meaning].filter(Boolean).join(" :: ")),
  }));
  story.config = story.config || {};
  story.models = story.models || {};
  return story;
}

/** Check whether two story objects differ structurally. */
function deepEq(a, b) {
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

/** Debounced check against the server. The token makes the newest request win: two checks in
 *  flight can answer out of order, and a stale failure would otherwise disable Save (or a stale
 *  success clear issues a newer check had flagged) until the next keystroke. */
let checkReq = 0;
function scheduleCheck() {
  if (APP.editCheckTimer) clearTimeout(APP.editCheckTimer);
  APP.editCheckTimer = setTimeout(doCheck, 400);
}

async function doCheck() {
  const req = ++checkReq;
  const j = await post("/story/check", { story: APP.editDraft }, false);
  if (!j || req !== checkReq) return;
  if (j.ok === false) {
    APP.editIssues = j.issues || [];
  } else {
    APP.editIssues = [];
    APP.editWarnings = j.warnings || [];
  }
  if (APP.editNew && APP.editDraft) {
    const synced = await post("/scaffold/set", { story: APP.editDraft }, false);
    if (synced?.active !== undefined) APP.scaffold = synced;
  }
  APP.render();
}

// ── HTML ────────────────────────────────────────────────────────────────────

/** Format issues for an inline hint. */
function issuesHtml(path) {
  const mine = APP.editIssues.filter(i => i.path === path || i.path.startsWith(path + "."));
  if (!mine.length) return "";
  return mine.map(i => `<div class="prob">${esc(i.message)}</div>`).join("");
}

function envWarningsHtml() {
  if (!APP.editWarnings?.length) return "";
  return APP.editWarnings.map(w => `<div class="prob">${esc(w)}</div>`).join("");
}

function errorBannerHtml() {
  if (!APP.editError) return "";
  return `<div class="said bad" style="margin-bottom:12px">${esc(APP.editError)}</div>`;
}

function unsavedBannerHtml() {
  if (!APP.editDirty) return "";
  return `<div class="prob" style="margin-bottom:12px">⚠ unsaved changes</div>`;
}

function sceneRowsHtml() {
  const s = APP.editDraft;
  if (!s?.scenes) return "";
  return s.scenes.map((sc, i) => {
    const n = i + 1;
    const roster = Array.isArray(sc.roster) ? sc.roster.join(", ") : "";
    return `<div class="editor-scene" data-tid="edit.scene-row" data-scene="${n}">
      <h4>Scene ${n}</h4>
      ${fld(`scene-${n}-place`, "Place", sc.place, "half")}
      ${fld(`scene-${n}-question`, "Question", sc.question, "textarea")}
      <div class="editor-row">
        ${fld(`scene-${n}-pov`, "POV", sc.pov, "half")}
        ${fld(`scene-${n}-length`, "Length (words)", sc.length ?? 700, "half")}
      </div>
      ${fld(`scene-${n}-roster`, "Roster (comma-separated)", roster)}
      <div class="editor-row">
        ${fld(`scene-${n}-writerModel`, "Writer model (optional)", sc.writerModel ?? "", "half")}
        ${thinkSelect(`scene-${n}-writerThink`, "Writer thinking", sc.writerThink ?? "default")}
      </div>
      ${issuesHtml(`scenes.${i}`)}
    </div>`;
  }).join("");
}

function characterCardsHtml() {
  const s = APP.editDraft;
  if (!s?.characters) return "";
  return s.characters.map((c, i) => {
    const skills = Array.isArray(c.skills) ? c.skills.join(", ") : "";
    const restrictions = Array.isArray(c.restrictions) ? c.restrictions.join(", ") : "";
    return `<div class="editor-char" data-tid="edit.char-card" data-char="${i}">
      <h4>${esc(c.name)}</h4>
      <div class="editor-row">
        ${fld(`char-${i}-name`, "Name", c.name, "half")}
        ${fld(`char-${i}-model`, "Model", c.model, "half")}
      </div>
      ${fld(`char-${i}-persona`, "Persona", c.persona, "textarea")}
      <div class="editor-row">
        ${fld(`char-${i}-knows`, "Knows", c.knows, "half")}
        ${fld(`char-${i}-goal`, "Goal", c.goal, "half")}
      </div>
      <div class="editor-row">
        ${fld(`char-${i}-belief`, "Belief (may be false)", c.belief ?? "", "half")}
        ${fld(`char-${i}-impulse`, 'Impulse ("when X → Y")', c.impulse ?? "", "half")}
      </div>
      ${voiceFld(i, c.voice)}
      <div class="editor-row">
        ${fld(`char-${i}-skills`, "Skills (comma-separated)", skills, "half")}
        ${fld(`char-${i}-restrictions`, "Restrictions (comma-separated)", restrictions, "half")}
      </div>
      ${fld(`char-${i}-maxRetries`, "Max retries (optional)", c.maxRetries ?? "", "half")}
      ${issuesHtml(`characters.${i}`)}
    </div>`;
  }).join("");
}

function configHtml() {
  const c = APP.editDraft?.config || {};
  return `<details class="editor-section" data-tid="edit.section"><summary>Config</summary>
    <div class="editor-row">
      ${fld("config-retries", "Retries", c.retries ?? 2, "third")}
      ${fld("config-clarifications", "Clarifications", c.clarifications ?? 2, "third")}
      ${fld("config-maxSteps", "Max steps", c.maxSteps ?? 24, "third")}
    </div>
    <div class="editor-row">
      ${fld("config-maxProseWords", "Max prose words", c.maxProseWords ?? 140, "third")}
      ${fld("config-requestTimeout", "Request timeout (s)", c.requestTimeout ?? 120, "third")}
      ${fld("config-attempts", "Attempts", c.attempts ?? 3, "third")}
    </div>
    <div class="editor-row">
      ${fld("config-maxTokens", "Max tokens", c.maxTokens ?? 2000, "third")}
      ${fld("config-maxCharacterRetries", "Max character retries", c.maxCharacterRetries ?? "", "third")}
      ${fld("config-stream", "Stream", c.stream ?? true, "checkbox")}
      ${fld("config-debug", "Debug", c.debug ?? false, "checkbox")}
    </div>
    ${thinkSelect("config-thinking-writer", "Writer thinking", c.thinking?.writer ?? "low")}
    ${thinkSelect("config-thinking-character", "Character thinking", c.thinking?.character ?? "low")}
    ${thinkSelect("config-thinking-summary", "Summary thinking", c.thinking?.summary ?? "low")}
    ${issuesHtml("config")}
  </details>`;
}

function modelsHtml() {
  const m = APP.editDraft?.models || {};
  const def = m.default || "";
  const modelOpts = `<datalist id="model-list">${(APP.modelIds || []).map(id => `<option value="${esc(id)}">`).join("")}</datalist>`;
  return `<details class="editor-section" data-tid="edit.section"><summary>Models</summary>
    <div class="editor-row">
      ${fld("models-default", "Default", def, "model")}
      ${fld("models-writer", "Writer (optional)", m.writer ?? "", "model")}
    </div>
    ${fld("models-summary", "Summary (optional)", m.summary ?? "", "model")}
    ${modelOpts}
    ${issuesHtml("models")}
  </details>`;
}

function suggestResultHtml() {
  if (!APP.editSuggestResult) return "";
  const r = APP.editSuggestResult;
  if (!r.ok) return `<div class="said bad">${esc(r.error || "something went wrong")}</div>`;
  if (r.kind === "question") return `<div class="asked">The architect asks: <em>${esc(r.ask)}</em></div>`;
  if (r.kind === "edits") {
    const parts = [];
    if (r.applied.length) parts.push(`<div class="said good">Suggested changes: ${r.applied.map(a => `<strong>${esc(a.field)}</strong>`).join(", ")}</div>`);
    if (r.ignored.length) parts.push(`<div class="said bad">Could not apply: ${r.ignored.map(i => esc(i)).join(", ")}</div>`);
    if (r.problems.length) parts.push(`<div class="prob">${r.problems.map(p => esc(p)).join("; ")}</div>`);
    if (r.note) parts.push(`<p class="hint">${esc(r.note)}</p>`);
    parts.push(`<p class="hint" style="margin-top:6px">Review the changes above and edit the fields manually.</p>`);
    return parts.join("");
  }
  return "";
}

function editToolbarHtml() {
  const canSave = APP.editDirty && !APP.editIssues.length && !APP.editSaving;
  const saving = APP.editSaving ? "thinking" : "";
  const action = APP.editNew
    ? `<button class="btn primary" id="edit-scaffold-accept"${(!APP.editIssues.length && !APP.editSaving) ? "" : " disabled"}>confirm and write</button>`
    : `<button class="btn primary" id="edit-save"${canSave ? "" : " disabled"}${saving ? ` title="${saving}"` : ""}>${APP.editSaving ? "saving…" : "save"}</button>`;
  return `<div class="btns" style="margin-top:16px">
    ${action}
    <button class="btn" id="edit-revert"${APP.editDirty ? "" : " disabled"}>revert</button>
    <span class="spacer"></span>
    <button class="btn" id="edit-back">${APP.editNew ? "back to interview" : "back to story"}</button>
  </div>`;
}

/** Fetch the story and load it into the editor store. `editLoading` is what keeps this from
 *  running away: wireStoryEditor() starts the load and runs on EVERY render, so without a flag
 *  saying one is already in flight, the render this schedules would start another. */
export async function loadEditor(dir) {
  APP.editFor = dir;           // claimed up front: renders while the fetch is in flight must not re-trigger
  APP.editError = "";
  APP.editIssues = [];
  APP.editWarnings = [];
  APP.editStory = null;
  APP.editDraft = null;
  APP.editDirty = false;
  APP.editLoading = true;

  let r, j;
  try {
    r = await fetch(`/story/edit?dir=${encodeURIComponent(dir)}`);
    j = await r.json();
  } catch {
    APP.editLoading = false;
    APP.editError = "could not load story";
    APP.render();
    return;
  }
  APP.editLoading = false;
  if (!j.ok) {
    // `error` is a story that would not parse; `reason` is the route refusing outright
    // ("cannot edit while a run is in flight") -- both have to reach the page.
    APP.editError = j.error || j.reason || "could not load story";
    APP.editRaw = j.raw || null;
    APP.render();
    return;
  }
  const loaded = j.story;
  // Ensure all sub-objects exist (Zod defaults aren't in the response)
  if (!loaded.config) loaded.config = {};
  if (!loaded.config.thinking) loaded.config.thinking = {};
  if (!loaded.models) loaded.models = {};
  APP.editStory = clone(loaded);
  APP.editDraft = clone(loaded);
  APP.editWarnings = j.warnings || [];
  APP.editDirty = false;
  APP.render();
}

export function storyEditHtml() {
  if (APP.editError && !APP.editDraft) {
    return `<section class="picker story">
      <h2>Edit story</h2>
      ${errorBannerHtml()}
      ${APP.editRaw ? `<div class="said bad" style="margin-bottom:12px">The file could not be parsed — here is the raw content:</div>
        <pre style="white-space:pre-wrap;font-size:13px">${esc(JSON.stringify(APP.editRaw, null, 2))}</pre>` : ""}
      <div class="btns" style="margin-top:14px"><button class="btn" id="edit-back">back to story</button></div>
    </section>`;
  }

  if (!APP.editDir && !APP.editNew) {
    return `<section class="picker story"><h2>Edit story</h2>
      <p class="hint">No story chosen — open one from the shelf and edit it from there.</p>
      <div class="btns" style="margin-top:14px"><button class="btn" id="edit-back">back to story</button></div>
    </section>`;
  }

  if (!APP.editDraft) {
    // A new-story draft with no scaffold behind it -- a reloaded or bookmarked #/edit?new=1 after
    // the interview is gone -- will never resolve: there is nothing on the server to load. Say so
    // and offer a way out, rather than a back-button-less "loading…" that hangs forever.
    if (APP.editNew && !APP.scaffold?.spec) {
      return `<section class="picker story"><h2>New story</h2>
        <p class="hint">This draft is no longer available — start a new one from the shelf.</p>
        <div class="btns" style="margin-top:14px"><button class="btn" id="edit-loading-back">back to the shelf</button></div>
      </section>`;
    }
    const name = APP.editNew ? "New story" : APP.stories?.find(s => s.dir === APP.editDir)?.name || APP.editDir;
    return `<section class="picker story"><h2>Edit ${esc(name)}</h2>
      <p class="thinking"><i></i>loading…</p></section>`;
  }

  const s = APP.editDraft;
  const facts = Array.isArray(s.facts) ? s.facts.join("\n") : "";
  const title = APP.editNew ? "new story draft" : esc(APP.stories?.find(x => x.dir === APP.editDir)?.name || APP.editDir || "");
  const suggestOpen = APP.editSuggestOpen ? "" : " hidden";

  return `<section class="picker story"><div class="editor">
    <h2 style="margin-bottom:4px">${APP.editNew ? "Review new story" : "Edit story"}</h2>
    <p class="hint" style="margin-bottom:16px">${title}</p>
    ${unsavedBannerHtml()}
    ${errorBannerHtml()}
    ${envWarningsHtml()}

    <details class="editor-section" data-tid="edit.section" open><summary>Metadata</summary>
      ${fld("edit-title", "Title", s.title)}
      ${fld("edit-premise", "Premise", s.premise, "textarea")}
      ${fld("edit-writerStyle", "Writer style", s.writerStyle, "textarea")}
      ${issuesHtml("title")}${issuesHtml("premise")}${issuesHtml("writerStyle")}
    </details>

    <details class="editor-section" data-tid="edit.section" open><summary>Scenes</summary>
      ${sceneRowsHtml()}
      ${issuesHtml("scenes")}
    </details>

    <details class="editor-section" data-tid="edit.section" open><summary>Characters</summary>
      ${characterCardsHtml()}
      ${issuesHtml("characters")}
    </details>

    <details class="editor-section" data-tid="edit.section"><summary>Story facts</summary>
      ${fld("edit-facts", "One fact per line", facts, "textarea")}
    </details>

    ${configHtml()}
    ${modelsHtml()}

    <details class="editor-section" data-tid="edit.section"${APP.editSuggestOpen ? " open" : ""}><summary>Ask the architect</summary>
      <div id="edit-suggest-panel" class="${suggestOpen.trim()}">
        <p class="hint" style="margin-bottom:8px">Tell the architect what to change. It will propose edits that you can review and apply.</p>
        <textarea id="edit-suggest-text" rows="3" placeholder="e.g. Make Aster more reluctant to admit the truth…">${esc(APP.editSuggestText || "")}</textarea>
        <div class="btns" style="margin-top:6px">
          <button class="btn" id="edit-suggest-btn"${APP.editSuggestBusy ? " disabled" : ""}>${APP.editSuggestBusy ? "thinking…" : "suggest"}</button>
        </div>
        ${suggestResultHtml()}
      </div>
    </details>

    ${editToolbarHtml()}
  </div></section>`;
}

// ── WIRING ──────────────────────────────────────────────────────────────────

function setDirty() {
  APP.editDirty = !deepEq(APP.editStory, APP.editDraft);
}

function applyField(id, value) {
  // Map element IDs to editDraft paths. "edit-facts" is deliberately absent: it needs line
  // splitting into an array, handled by its own branch below -- a map entry here would shadow it.
  const map = {
    "edit-title": "title",
    "edit-premise": "premise",
    "edit-writerStyle": "writerStyle",
    "models-default": "models.default",
    "models-writer": "models.writer",
    "models-summary": "models.summary",
    "config-retries": "config.retries",
    "config-clarifications": "config.clarifications",
    "config-maxSteps": "config.maxSteps",
    "config-maxProseWords": "config.maxProseWords",
    "config-requestTimeout": "config.requestTimeout",
    "config-attempts": "config.attempts",
    "config-maxTokens": "config.maxTokens",
    "config-maxCharacterRetries": "config.maxCharacterRetries",
    "config-stream": "config.stream",
    "config-debug": "config.debug",
    "config-thinking-writer": "config.thinking.writer",
    "config-thinking-character": "config.thinking.character",
    "config-thinking-summary": "config.thinking.summary",
  };

  // Scene fields: scene-{n}-{field}
  const sceneMatch = id.match(/^scene-(\d+)-(.+)$/);
  if (sceneMatch) {
    const idx = Number(sceneMatch[1]) - 1;
    const field = sceneMatch[2];
    if (field === "roster") {
      APP.editDraft.scenes[idx].roster = value ? value.split(",").map(s => s.trim()).filter(Boolean) : [];
    } else if (field === "length") {
      APP.editDraft.scenes[idx].length = value === "" ? 700 : Math.max(1, Number(value));
    } else if (field === "writerModel") {
      APP.editDraft.scenes[idx].writerModel = value || undefined;
    } else if (field === "writerThink") {
      APP.editDraft.scenes[idx].writerThink = value === "default" ? undefined : value;
    } else {
      APP.editDraft.scenes[idx][field] = value;
    }
    setDirty(); scheduleCheck(); return;
  }

  // Character fields: char-{idx}-{field}
  const charMatch = id.match(/^char-(\d+)-(.+)$/);
  if (charMatch) {
    const idx = Number(charMatch[1]);
    const field = charMatch[2];
    if (field === "skills") {
      APP.editDraft.characters[idx].skills = value ? value.split(",").map(s => s.trim()).filter(Boolean) : [];
    } else if (field === "restrictions") {
      APP.editDraft.characters[idx].restrictions = value ? value.split(",").map(s => s.trim()).filter(Boolean) : [];
    } else if (field === "voice") {
      APP.editDraft.characters[idx].voice = value.split("\n").map(s => s.trim()).filter(Boolean).slice(0, 3);
    } else if (field === "maxRetries") {
      APP.editDraft.characters[idx].maxRetries = value === "" ? undefined : Number(value);
    } else {
      APP.editDraft.characters[idx][field] = value;
    }
    setDirty(); scheduleCheck(); return;
  }

  // Mapped fields
  if (map[id]) {
    const parts = map[id].split(".");
    let obj = APP.editDraft;
    for (let i = 0; i < parts.length - 1; i++) {
      if (obj[parts[i]] == null) obj[parts[i]] = {};
      obj = obj[parts[i]];
    }
    const key = parts[parts.length - 1];
    if (key === "stream" || key === "debug") {
      obj[key] = value;
    } else if (key === "maxCharacterRetries") {
      obj[key] = value === "" ? undefined : Number(value);
    } else {
      obj[key] = value;
    }
    setDirty(); scheduleCheck(); return;
  }

  // facts as text → array
  if (id === "edit-facts") {
    APP.editDraft.facts = value.split("\n").map(s => s.trim()).filter(Boolean);
    setDirty(); scheduleCheck();
  }
}

export function wireStoryEditor(page) {
  // Back button -- mutates nothing before go(): the dirty guard in nav.js owns the confirm, and
  // clearing editDirty here (as this used to) silently discarded unsaved changes with one click.
  // A scaffold draft ("edit in full") has no story on disk to go back to -- it returns to the
  // scaffold page, which still holds the in-memory session.
  const back = page.querySelector("#edit-back");
  if (back) back.addEventListener("click", () => go(APP.editNew ? "scaffold" : "story"));
  // The dead-end escape for a new-story draft with nothing behind it -- there is no "story" to go
  // back to, so it lands on the shelf.
  const loadingBack = page.querySelector("#edit-loading-back");
  if (loadingBack) loadingBack.addEventListener("click", () => go("shelf"));

  // All inputs write to draft
  const inputs = page.querySelectorAll("input, textarea, select");
  for (const el of inputs) {
    const id = el.id;
    if (!id) continue;
    el.addEventListener("input", () => {
      const val = el.type === "checkbox" ? el.checked : el.type === "number" ? (el.value === "" ? "" : Number(el.value)) : el.value;
      applyField(id, val);
    });
    el.addEventListener("change", () => {
      const val = el.type === "checkbox" ? el.checked : el.type === "number" ? (el.value === "" ? "" : Number(el.value)) : el.value;
      applyField(id, val);
    });
  }

  // Save button
  const save = page.querySelector("#edit-save");
  if (save) save.addEventListener("click", async () => {
    if (APP.editSaving) return;
    APP.editSaving = true;
    APP.render();
    const j = await post("/story/save", { dir: APP.editDir, story: APP.editDraft }, false);
    APP.editSaving = false;
    if (j?.ok === true) {
      APP.editStory = clone(APP.editDraft);
      APP.editDirty = false;
      APP.editError = "";
      APP.editIssues = [];
      // Refetch stories to update shelf cards
      try { const r = await fetch("/stories"); APP.stories = (await r.json()).stories; } catch {}
    } else {
      APP.editError = j?.reason || "save failed";
    }
    APP.render();
  });

  const scaffoldAccept = page.querySelector("#edit-scaffold-accept");
  if (scaffoldAccept) scaffoldAccept.addEventListener("click", async () => {
    if (APP.editSaving || APP.editIssues.length) return;
    const folder = prompt("Folder name for this story", APP.editDraft.title || "");
    if (folder === null) return;
    APP.editSaving = true; APP.render();
    const j = await post("/scaffold/accept", { folder: folder.trim() }, false);
    APP.editSaving = false;
    if (!j?.ok) APP.editError = j?.reason || "could not write the story";
    else {
      APP.editDirty = false;
      APP.editNew = false;
      APP.editDir = j.dir || "";
      APP.editFor = ""; APP.editStory = null; APP.editDraft = null;
      go("shelf");
    }
    APP.render();
  });

  // Revert button
  const revert = page.querySelector("#edit-revert");
  if (revert) revert.addEventListener("click", () => {
    if (!confirm("Discard all unsaved changes?")) return;
    APP.editDraft = clone(APP.editStory);
    APP.editDirty = false;
    APP.editError = "";
    APP.editIssues = [];
    APP.editSuggestResult = null;
    APP.render();
  });

  // Architect suggestion
  const suggestBtn = page.querySelector("#edit-suggest-btn");
  const suggestText = page.querySelector("#edit-suggest-text");
  if (suggestText) suggestText.addEventListener("input", () => { APP.editSuggestText = suggestText.value; });
  if (suggestBtn) suggestBtn.addEventListener("click", async () => {
    const text = APP.editSuggestText || "";
    if (!text.trim()) return;
    APP.editSuggestBusy = true;
    APP.editSuggestResult = null;
    APP.editSuggestOpen = true;
    APP.render();
    const j = await post("/story/suggest", { spec: APP.editDraft, text }, false);
    APP.editSuggestBusy = false;
    APP.editSuggestResult = j || { ok: false, error: "no answer" };
    APP.render();
  });

  // Start loading if not already loaded for THIS story — never while one is already in flight.
  // Keyed by editFor, not editStory: a draft left over from another story must trigger a fresh
  // load here, never render as if it were this story's. No editError clause: a refusal that
  // belonged to another story must not block this one -- loadEditor clears it.
  if (APP.editNew && APP.scaffold?.spec && APP.editFor !== "__scaffold__") {
    const loaded = scaffoldStory(APP.scaffold.spec);
    APP.editFor = "__scaffold__";
    APP.editStory = clone(loaded);
    APP.editDraft = clone(loaded);
    APP.editWarnings = APP.scaffold.problems || [];
    APP.editIssues = [];
  } else if (APP.editFor !== APP.editDir && !APP.editLoading && APP.editDir) {
    loadEditor(APP.editDir);
  }
}
