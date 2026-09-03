import { reasonOr } from "./util.js";
import { APP, CATALOG_KINDS } from "./state.js";
import { syncHash } from "./nav.js";
import { catalogPageHtml } from "./catalog-view.js";
import { openLibraryPicker } from "./library-picker.js";

export { catalogPageHtml };

// Parse text fields into arrays: split on newlines/commas, trim, drop empties
function parseLines(text) {
  return (text || "").split("\n").map(s => s.trim()).filter(Boolean);
}

function parseCommaSeparated(text) {
  return (text || "").split(",").map(s => s.trim()).filter(Boolean);
}

/** The server's entry -> the form's draft: every list becomes the text a textarea holds.
 *  APP.catalog holds different shapes per kind:
 *  - `selected` is the server's entry record (arrays for tags, voice, skills, restrictions)
 *  - `draft` is what the form is editing (strings for all fields, since textareas hold strings)
 *  Keep them separate; the boundary functions convert between them.
 *  For tags: entry is {id, version, facet, label}, draft is {id, facet, label}
 *  For styles: entry is {id, version, name, description, tags, voice}, draft is {id, name, description, tags, voice}
 *  For skills: entry is {id, version, name, meaning, tags}, draft is {id, name, meaning, tags} */
function toDraft(entry, kind) {
  if (kind === "tags") {
    return {
      id: entry.id || "",
      facet: entry.facet || "",
      label: entry.label || ""
    };
  }
  if (kind === "styles") {
    return {
      id: entry.id || "",
      name: entry.name || "",
      description: entry.description || "",
      tags: (entry.tags || []).join(", "),
      voice: entry.voice || ""
    };
  }
  if (kind === "skills") {
    return {
      id: entry.id || "",
      name: entry.name || "",
      meaning: entry.meaning || "",
      tags: (entry.tags || []).join(", ")
    };
  }
  // characters
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
function fromDraft(draft, id, kind) {
  if (kind === "tags") {
    return {
      id: id,
      facet: draft.facet.trim(),
      label: draft.label.trim()
    };
  }
  if (kind === "styles") {
    return {
      id: id,
      name: draft.name.trim(),
      description: draft.description.trim(),
      tags: parseCommaSeparated(draft.tags),
      // A style's voice is one block of prose, not a list. The character's `voice` is samples and
      // splits into lines; sharing that conversion here is what made the schema reject a style.
      voice: draft.voice.trim()
    };
  }
  if (kind === "skills") {
    return {
      id: id,
      name: draft.name.trim(),
      // A skill's meaning is one block of prose like a style's voice. Never use parseLines here.
      meaning: draft.meaning.trim(),
      tags: parseCommaSeparated(draft.tags)
    };
  }
  // characters
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

export async function loadCatalog(kind) {
  // Default to current kind if not specified
  const targetKind = kind || APP.catalog.kind;

  // Dirty guard: if there are unsaved changes, confirm before switching
  if (APP.catalog.draft && isDirty(APP.catalog.selected, APP.catalog.draft, APP.catalog.kind)) {
    if (!confirm("Discard unsaved changes?")) return;
  }

  APP.catalog.loading = true;
  APP.catalog.error = "";
  APP.catalog.kind = targetKind;
  APP.catalog.entries = [];
  APP.catalog.selected = null;
  APP.catalog.draft = null;
  APP.catalog.issues = [];
  APP.catalog.problems = [];
  APP.catalog.armedDelete = false;
  APP.render();

  let j = null;
  try {
    const r = await fetch(`/catalog?kind=${encodeURIComponent(targetKind)}`);
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
    syncHash();
    return;
  }

  APP.catalog.entries = j.entries || [];
  APP.catalog.loaded = true;
  APP.render();
  syncHash();
}

let vocabLoading = false;
let libraryLoading = false;

/** Drop the cached tag vocabulary after a write to it, so the character form's picker reflects the
 *  edit. Without this the picker keeps showing a deleted tag as an ordinary selected chip, and the
 *  off-vocabulary notice -- the whole point of that state -- never appears. */
function invalidateVocab() {
  APP.catalog.vocab = [];
  vocabLoading = false;
}

/** Drop the cached character library after a write to it, so the scaffold's import picker reflects
 *  the edit. Without this a deleted character can still be selected in the tray. */
function invalidateLibrary() {
  APP.catalog.library = [];
  libraryLoading = false;
}

/** Load the tag vocabulary once, on first need */
export async function loadVocab() {
  if (APP.catalog.vocab.length > 0) return; // Already loaded
  if (vocabLoading) return; // Already in flight

  vocabLoading = true;
  try {
    const r = await fetch("/catalog?kind=tags");
    const j = await r.json();
    if (j.ok) {
      APP.catalog.vocab = j.entries || [];
      APP.render();
      syncHash();
    } else {
      APP.catalog.error = reasonOr(j, "could not load tag vocabulary");
      APP.render();
      syncHash();
    }
  } catch (err) {
    APP.catalog.error = "tag vocabulary did not load: " + (err.message || "network error");
    APP.render();
    syncHash();
  } finally {
    vocabLoading = false;
  }
}

/** Load the character library once, on first need */
export async function loadLibrary() {
  if (APP.catalog.library.length > 0) return; // Already loaded
  if (libraryLoading) return; // Already in flight

  libraryLoading = true;
  try {
    const r = await fetch("/catalog?kind=characters");
    const j = await r.json();
    if (j.ok) {
      APP.catalog.library = j.entries || [];
      APP.render();
      syncHash();
    } else {
      APP.catalog.error = reasonOr(j, "could not load character library");
      APP.render();
      syncHash();
    }
  } catch (err) {
    APP.catalog.error = "character library did not load: " + (err.message || "network error");
    APP.render();
    syncHash();
  } finally {
    libraryLoading = false;
  }
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

  const j = await postCatalog("delete", { kind: APP.catalog.kind, id: APP.catalog.selected.id });
  if (!j || !j.ok) {
    APP.catalog.error = reasonOr(j, "could not delete the entry");
    APP.render();
    return;
  }

  if (APP.catalog.kind === "tags") invalidateVocab();
  if (APP.catalog.kind === "characters") invalidateLibrary();

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
  if (APP.catalog.draft && isDirty(APP.catalog.selected, APP.catalog.draft, APP.catalog.kind)) {
    if (!confirm("Discard unsaved changes?")) return;
  }

  clearDeleteTimer();
  APP.catalog.selected = entry;
  APP.catalog.draft = toDraft(entry, APP.catalog.kind);
  APP.catalog.issues = [];
  APP.catalog.problems = [];
  const usesTags = k => k !== "tags";
  if (usesTags(APP.catalog.kind)) {
    loadVocab(); // Load tag vocab for the character/style/skill form's picker
  }
  APP.render();
}

async function createNew() {
  // Dirty guard
  if (APP.catalog.draft && isDirty(APP.catalog.selected, APP.catalog.draft, APP.catalog.kind)) {
    if (!confirm("Discard unsaved changes?")) return;
  }

  clearDeleteTimer();
  APP.catalog.selected = null;
  if (APP.catalog.kind === "tags") {
    APP.catalog.draft = {
      id: "",
      facet: "",
      label: ""
    };
  } else if (APP.catalog.kind === "styles") {
    APP.catalog.draft = {
      id: "",
      name: "",
      description: "",
      tags: "",
      voice: ""
    };
  } else if (APP.catalog.kind === "skills") {
    APP.catalog.draft = {
      id: "",
      name: "",
      meaning: "",
      tags: ""
    };
  } else {
    // characters
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
  }
  APP.catalog.issues = [];
  APP.catalog.problems = [];
  const usesTags = k => k !== "tags";
  if (usesTags(APP.catalog.kind)) {
    loadVocab();
  }
  APP.render();
}

function isDirty(original, draft, kind) {
  if (!draft) return false;
  if (!original) return !!Object.values(draft).some(v => v);

  // Compare like with like: convert original (entry shape) to draft shape before comparing
  const originalDraft = toDraft(original, kind);
  if (kind === "tags") {
    return draft.facet !== originalDraft.facet ||
           draft.label !== originalDraft.label;
  }
  if (kind === "styles") {
    return draft.name !== originalDraft.name ||
           draft.description !== originalDraft.description ||
           draft.tags !== originalDraft.tags ||
           draft.voice !== originalDraft.voice;
  }
  if (kind === "skills") {
    return draft.name !== originalDraft.name ||
           draft.meaning !== originalDraft.meaning ||
           draft.tags !== originalDraft.tags;
  }
  // characters
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

    // For new entries, generate an id from the appropriate fields.
    // For existing entries, preserve the id — it is the identity the server upserts on, so editing
    // a saved entry's name/label must NOT change its id, or the save silently becomes an insert.
    const isNew = !d.id;
    let entryId;
    if (isNew) {
      // Tags combine facet and label; every other kind uses the name
      if (APP.catalog.kind === "tags") {
        entryId = generateId(d.facet, d.label, APP.catalog.entries.map(e => e.id));
      } else {
        entryId = generateId(d.name, null, APP.catalog.entries.map(e => e.id));
      }
    } else {
      entryId = d.id;
    }

    // Build entry from form, converting text areas to arrays via fromDraft
    const entry = fromDraft(d, entryId, APP.catalog.kind);

    // Save directly; /catalog/save already validates and returns issues on failure
    const saveJ = await postCatalog("save", { kind: APP.catalog.kind, entry });
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
    if (APP.catalog.kind === "tags") invalidateVocab();
    if (APP.catalog.kind === "characters") invalidateLibrary();
    APP.catalog.selected = saved;
    APP.catalog.draft = toDraft(saved, APP.catalog.kind);
    clearDeleteTimer();
    APP.render();
  } catch (error) {
    APP.catalog.error = error.message || "save failed";
    APP.render();
  }
}

/** Generate a slug from text: lowercase, non-alphanumerics to `-`, collapse repeats, trim.
 *  If it collides with an existing entry, append `-N` until unique.
 *  For tags, facet and label are combined. */
function generateId(facetOrText, labelOrNull, existingIds) {
  let text;
  if (labelOrNull !== null && labelOrNull !== undefined) {
    // Tag: combine facet and label
    text = `${facetOrText}-${labelOrNull}`;
  } else {
    // Character: just the name
    text = facetOrText;
  }

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

  // Kind switcher
  for (const kind of CATALOG_KINDS) {
    on(`cat-kind-${kind}`, () => loadCatalog(kind));
  }

  // Entry selection
  for (const row of page.querySelectorAll(".catalog-entry")) {
    row.addEventListener("click", () => {
      const id = row.getAttribute("data-cat-id");
      const entry = (APP.catalog.entries || []).find(e => e.id === id);
      if (entry) selectEntry(entry);
    });
  }

  // Character form field updates
  onInput("cat-name", () => {
    if (APP.catalog.draft) APP.catalog.draft.name = page.querySelector("#cat-name").value;
  });
  onInput("cat-tags-input", () => {
    if (APP.catalog.draft) APP.catalog.draft.tags = page.querySelector("#cat-tags-input").value;
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

  // Tag form field updates
  onInput("cat-facet", () => {
    if (APP.catalog.draft) APP.catalog.draft.facet = page.querySelector("#cat-facet").value;
  });
  onInput("cat-label", () => {
    if (APP.catalog.draft) APP.catalog.draft.label = page.querySelector("#cat-label").value;
  });

  // Style form field updates
  onInput("cat-desc", () => {
    if (APP.catalog.draft) APP.catalog.draft.description = page.querySelector("#cat-desc").value;
  });
  onInput("cat-style-voice", () => {
    if (APP.catalog.draft) APP.catalog.draft.voice = page.querySelector("#cat-style-voice").value;
  });

  // Skill form field updates
  onInput("cat-meaning", () => {
    if (APP.catalog.draft) APP.catalog.draft.meaning = page.querySelector("#cat-meaning").value;
  });

  // Skills library picker (character form)
  on("cat-skills-pick", () => {
    // The bible is the source of canonical skills; a bespoke one is still typed in the field. So the
    // picker owns only the lines that name a bible entry -- the rest are carried through untouched,
    // and deselecting a bible skill removes just that line.

    // Read current textarea value and get names of each line
    const skillsText = APP.catalog.draft?.skills || "";
    const currentLines = parseLines(skillsText);
    const currentNames = currentLines.map(line => {
      const idx = line.indexOf("::");
      return idx >= 0 ? line.substring(0, idx).trim() : line;
    });

    // Open picker with current names as preselection
    openLibraryPicker({
      kind: "skills",
      title: "Skill Bible",
      hint: "Select skills to add — type bespoke skills directly in the field",
      preselect: currentNames,
      done: entries => {
        // Simplest correct approach: keep lines that are NOT in the chosen entries, then append
        // chosen entries as name :: meaning. This preserves bespoke lines and dedupes.
        const chosenNames = new Set(entries.map(e => e.name.toLowerCase()));
        const kept = currentLines.filter(line => {
          const name = line.indexOf("::") >= 0 ? line.substring(0, line.indexOf("::")).trim() : line;
          return !chosenNames.has(name.toLowerCase());
        });
        const chosenLines = entries.map(e => `${e.name} :: ${e.meaning}`);
        APP.catalog.draft.skills = kept.concat(chosenLines).join("\n");
        // Picker's done path already called APP.render()
      }
    });
  });

  // Tag chip picker (character form)
  for (const chip of page.querySelectorAll(".cat-chip[data-tag-label]")) {
    chip.addEventListener("click", () => {
      if (!APP.catalog.draft) return;
      const label = chip.getAttribute("data-tag-label");
      if (!label) return;

      const tags = parseCommaSeparated(APP.catalog.draft.tags);
      const idx = tags.findIndex(t => t === label);
      if (idx >= 0) {
        tags.splice(idx, 1);
      } else {
        tags.push(label);
      }
      APP.catalog.draft.tags = tags.join(", ");
      APP.render();
    });
  }

  // Buttons
  on("cat-save", saveDraft);
  on("cat-delete", armDelete);
  on("cat-new", createNew);
  on("cat-retry", loadCatalog);
}
