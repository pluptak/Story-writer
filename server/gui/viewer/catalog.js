import { reasonOr } from "./util.js";
import { APP } from "./state.js";
import { catalogPageHtml } from "./catalog-view.js";

export { catalogPageHtml };

// Parse text fields into arrays: split on newlines/commas, trim, drop empties
function parseLines(text) {
  return (text || "").split("\n").map(s => s.trim()).filter(Boolean);
}

function parseCommaSeparated(text) {
  return (text || "").split(",").map(s => s.trim()).filter(Boolean);
}

/** The server's entry -> the form's draft: every list becomes the text a textarea holds.
 *  APP.catalog holds two different shapes:
 *  - `selected` is the server's entry record (arrays for tags, voice, skills, restrictions)
 *  - `draft` is what the form is editing (strings for all fields, since textareas hold strings)
 *  Keep them separate; the boundary functions convert between them. */
function toDraft(entry) {
  return {
    id: entry.id || "",
    name: entry.name || "",
    tags: (entry.tags || []).join(", "),
    portablePersona: entry.portablePersona || "",
    belief: entry.belief || "",
    impulse: entry.impulse || "",
    voice: (entry.voice || []).join("\n"),
    skills: (entry.skills || []).join("\n"),
    restrictions: (entry.restrictions || []).join("\n")
  };
}

/** The form's draft -> the entry the server takes: every text field becomes its list. */
function fromDraft(draft, id) {
  return {
    id: id,
    name: draft.name.trim(),
    tags: parseCommaSeparated(draft.tags),
    portablePersona: draft.portablePersona.trim(),
    belief: draft.belief.trim(),
    impulse: draft.impulse.trim(),
    voice: parseLines(draft.voice),
    skills: parseLines(draft.skills),
    restrictions: parseLines(draft.restrictions)
  };
}

async function postCatalog(what, payload) {
  let j = null;
  try {
    const r = await fetch(`/catalog/${what}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {})
    });
    j = await r.json();
  } catch {
    APP.catalog.error = "the engine did not answer";
    APP.render();
    return null;
  }
  return j;
}

export async function loadCatalog() {
  APP.catalog.loading = true;
  APP.catalog.error = "";
  APP.catalog.entries = [];
  APP.catalog.selected = null;
  APP.catalog.draft = null;
  APP.render();

  let j = null;
  try {
    const r = await fetch("/catalog?kind=characters");
    j = await r.json();
  } catch {
    APP.catalog.loading = false;
    APP.catalog.error = "the engine did not answer";
    APP.render();
    return;
  }

  APP.catalog.loading = false;
  if (!j.ok) {
    APP.catalog.error = reasonOr(j, "could not load the catalog");
    APP.render();
    return;
  }

  APP.catalog.entries = j.entries || [];
  APP.render();
}

function clearDeleteTimer() {
  if (APP.catalog.deleteTimer) {
    clearTimeout(APP.catalog.deleteTimer);
    APP.catalog.deleteTimer = 0;
    APP.catalog.armedDelete = false;
  }
}

function armDelete() {
  if (!APP.catalog.armedDelete) {
    APP.catalog.armedDelete = true;
    APP.catalog.deleteTimer = setTimeout(() => {
      clearDeleteTimer();
      APP.render();
    }, 8000);
    APP.render();
    return;
  }

  // Second click within 8 seconds — confirm and delete
  clearDeleteTimer();
  confirmDelete();
}

async function confirmDelete() {
  if (!APP.catalog.selected) return;

  const j = await postCatalog("delete", { kind: "characters", id: APP.catalog.selected.id });
  if (!j || !j.ok) {
    APP.catalog.error = reasonOr(j, "could not delete the entry");
    APP.render();
    return;
  }

  // Remove from list and clear selection
  APP.catalog.entries = APP.catalog.entries.filter(e => e.id !== APP.catalog.selected.id);
  APP.catalog.selected = null;
  APP.catalog.draft = null;
  APP.catalog.error = "";
  APP.catalog.issues = [];
  APP.catalog.problems = [];
  APP.render();
}

async function selectEntry(entry) {
  // Dirty guard: if there are unsaved changes, confirm before discarding
  if (APP.catalog.draft && isDirty(APP.catalog.selected, APP.catalog.draft)) {
    if (!confirm("Discard unsaved changes?")) return;
  }

  clearDeleteTimer();
  APP.catalog.selected = entry;
  APP.catalog.draft = toDraft(entry);
  APP.catalog.issues = [];
  APP.catalog.problems = [];
  APP.render();
}

async function createNew() {
  // Dirty guard
  if (APP.catalog.draft && isDirty(APP.catalog.selected, APP.catalog.draft)) {
    if (!confirm("Discard unsaved changes?")) return;
  }

  clearDeleteTimer();
  APP.catalog.selected = null;
  APP.catalog.draft = {
    id: "",
    name: "",
    tags: "",
    portablePersona: "",
    belief: "",
    impulse: "",
    voice: "",
    skills: "",
    restrictions: ""
  };
  APP.catalog.issues = [];
  APP.catalog.problems = [];
  APP.render();
}

function isDirty(original, draft) {
  if (!draft) return false;
  if (!original) return !!Object.values(draft).some(v => v);

  // Compare like with like: convert original (entry shape) to draft shape before comparing
  const originalDraft = toDraft(original);
  return draft.name !== originalDraft.name ||
         draft.tags !== originalDraft.tags ||
         draft.portablePersona !== originalDraft.portablePersona ||
         draft.belief !== originalDraft.belief ||
         draft.impulse !== originalDraft.impulse ||
         draft.voice !== originalDraft.voice ||
         draft.skills !== originalDraft.skills ||
         draft.restrictions !== originalDraft.restrictions;
}

async function saveDraft() {
  const d = APP.catalog.draft;
  if (!d) return;

  try {
    // Clear issues at the start of each save attempt so the block reflects the current attempt
    APP.catalog.issues = [];
    APP.render();

    // For new entries, generate an id from the name and check for collisions with existing entries.
    // For existing entries, preserve the id — it is the identity the server upserts on, so editing
    // a saved character's name must NOT change its id, or the save silently becomes an insert.
    const isNew = !d.id;
    const entryId = isNew ? generateId(d.name, APP.catalog.entries.map(e => e.id)) : d.id;

    // Build entry from form, converting text areas to arrays via fromDraft
    const entry = fromDraft(d, entryId);

    // Save directly; /catalog/save already validates and returns issues on failure
    const saveJ = await postCatalog("save", { kind: "characters", entry });
    if (!saveJ) return;

    if (saveJ.ok === false) {
      APP.catalog.issues = saveJ.issues || [];
      APP.catalog.problems = [];
      APP.render();
      return;
    }

    // Success: update the list and selection
    APP.catalog.issues = [];
    APP.catalog.problems = saveJ.problems || [];

    const saved = saveJ.entry;
    const idx = APP.catalog.entries.findIndex(e => e.id === saved.id);
    if (idx >= 0) {
      APP.catalog.entries[idx] = saved;
    } else {
      APP.catalog.entries.push(saved);
    }

    // selected is the server's record; draft is what the form edits — keep their shapes separate
    APP.catalog.selected = saved;
    APP.catalog.draft = toDraft(saved);
    clearDeleteTimer();
    APP.render();
  } catch (error) {
    APP.catalog.error = error.message || "save failed";
    APP.render();
  }
}

/** Generate a slug from text: lowercase, non-alphanumerics to `-`, collapse repeats, trim.
 *  If it collides with an existing entry, append `-N` until unique. */
function generateId(text, existingIds) {
  const base = String(text || "").toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  let id = base || "entry";
  let n = 1;
  const used = new Set(existingIds);
  while (used.has(id)) {
    id = `${base}-${++n}`;
  }
  return id;
}

export function wireCatalog(page) {
  const on = (id, fn) => {
    const el = page.querySelector("#" + id);
    if (el) el.addEventListener("click", fn);
  };

  const onInput = (id, fn) => {
    const el = page.querySelector("#" + id);
    if (el) el.addEventListener("input", fn);
  };

  // Entry selection
  for (const row of page.querySelectorAll(".catalog-entry")) {
    row.addEventListener("click", () => {
      const id = row.getAttribute("data-cat-id");
      const entry = (APP.catalog.entries || []).find(e => e.id === id);
      if (entry) selectEntry(entry);
    });
  }

  // Form field updates
  onInput("cat-name", () => {
    if (APP.catalog.draft) APP.catalog.draft.name = page.querySelector("#cat-name").value;
  });
  onInput("cat-tags", () => {
    if (APP.catalog.draft) APP.catalog.draft.tags = page.querySelector("#cat-tags").value;
  });
  onInput("cat-persona", () => {
    if (APP.catalog.draft) APP.catalog.draft.portablePersona = page.querySelector("#cat-persona").value;
  });
  onInput("cat-belief", () => {
    if (APP.catalog.draft) APP.catalog.draft.belief = page.querySelector("#cat-belief").value;
  });
  onInput("cat-impulse", () => {
    if (APP.catalog.draft) APP.catalog.draft.impulse = page.querySelector("#cat-impulse").value;
  });
  onInput("cat-voice", () => {
    if (APP.catalog.draft) APP.catalog.draft.voice = page.querySelector("#cat-voice").value;
  });
  onInput("cat-skills", () => {
    if (APP.catalog.draft) APP.catalog.draft.skills = page.querySelector("#cat-skills").value;
  });
  onInput("cat-restrictions", () => {
    if (APP.catalog.draft) APP.catalog.draft.restrictions = page.querySelector("#cat-restrictions").value;
  });

  // Buttons
  on("cat-save", saveDraft);
  on("cat-delete", armDelete);
  on("cat-new", createNew);
  on("cat-retry", loadCatalog);
}
