import { reasonOr, postJson, parseLines, parseCommaSeparated, armConfirm, slugify } from "./util.js";
import { APP, CATALOG_KINDS } from "./state.js";
import { syncHash } from "./nav.js";
import { catalogPageHtml } from "./catalog-view.js";
import { openLibraryPicker } from "./library-picker.js";
import { on, onInput } from "./wire.js";

export { catalogPageHtml };

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
  return postJson(`/catalog/${what}`, payload || {},
    msg => { APP.catalog.error = msg; APP.render(); });
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
  refreshUsage();
  APP.render();
  syncHash();
}

/** What the other catalogs reference, for the list's "used by" lines and the tag page's derived
 *  STORY/STYLE grouping and styles-associated line. Derived server-side over all kinds at once; a
 *  failure leaves the last known usage rather than erroring the page — counts are decoration, the
 *  entries are the data. */
export async function refreshUsage() {
  try {
    const r = await fetch("/catalog/usage");
    const j = await r.json();
    if (j.ok) APP.catalog.usage = j.usage;
  } catch { /* keep what was there */ }
}

// "Loaded" is tracked apart from "non-empty" because an EMPTY catalog is a real answer, and the
// loaders that keyed on `.length` re-fetched forever when they got one: every load ends in a
// render, every render re-runs the wiring that starts the load. A catalog nobody has authored yet
// -- characters and styles both, on a new install -- span the page instead of settling.

/** One lazy "load once on first need" fetcher, filling an APP.catalog slot from /catalog?kind=….
 *  A load that failed marks itself loaded anyway -- it shows its error and waits to be
 *  invalidated, rather than being retried by the very render it just caused. `.invalidate()`
 *  drops the cache after a write to that kind, so pickers fed from it reflect the edit. */
function makeLazyLoader({ path, slot, label }) {
  let loading = false, loaded = false;
  const load = async () => {
    if (loaded || loading) return;   // already here, or already on its way

    loading = true;
    try {
      const r = await fetch(path);
      const j = await r.json();
      if (j.ok) {
        APP.catalog[slot] = j.entries || [];
      } else {
        APP.catalog.error = reasonOr(j, `could not load ${label}`);
      }
      APP.render();
      syncHash();
    } catch (err) {
      APP.catalog.error = `${label} did not load: ` + (err.message || "network error");
      APP.render();
      syncHash();
    } finally {
      loading = false; loaded = true;
    }
  };
  load.invalidate = () => { APP.catalog[slot] = []; loading = false; loaded = false; };
  return load;
}

/** Load the tag vocabulary once, on first need */
export const loadVocab = makeLazyLoader({ path: "/catalog?kind=tags", slot: "vocab", label: "tag vocabulary" });

/** Load the style presets once, on first need */
export const loadStyles = makeLazyLoader({ path: "/catalog?kind=styles", slot: "styles", label: "style presets" });

/** Load the character library once, on first need */
export const loadLibrary = makeLazyLoader({ path: "/catalog?kind=characters", slot: "library", label: "character library" });

/** Drop the cached tag vocabulary after a write to it, so the character form's picker reflects the
 *  edit. Without this the picker keeps showing a deleted tag as an ordinary selected chip, and the
 *  off-vocabulary notice -- the whole point of that state -- never appears. */
const invalidateVocab = loadVocab.invalidate;

/** Drop the cached character library after a write to it, so the scaffold's import picker reflects
 *  the edit. Without this a deleted character can still be selected in the tray. */
const invalidateLibrary = loadLibrary.invalidate;

/** Drop the cached style presets after a write to one, so the scaffold's voice picker reflects the
 *  edit -- and so a preset whose voice was rewritten is offered with the new one. */
const invalidateStyles = loadStyles.invalidate;

function clearDeleteTimer() {
  if (APP.catalog.deleteTimer) {
    clearTimeout(APP.catalog.deleteTimer);
    APP.catalog.deleteTimer = 0;
    APP.catalog.armedDelete = false;
  }
}

function armDelete() {
  // The timer is armConfirm's flag; `armedDelete` rides along because the button's label reads it.
  return armConfirm({
    get: () => APP.catalog.deleteTimer,
    set: v => { APP.catalog.deleteTimer = v; APP.catalog.armedDelete = !!v; APP.render(); },
    ms: 8000,
    action: confirmDelete,
  });
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
  if (APP.catalog.kind === "styles") invalidateStyles();

  // Remove from list and clear selection
  APP.catalog.entries = APP.catalog.entries.filter(e => e.id !== APP.catalog.selected.id);
  APP.catalog.selected = null;
  APP.catalog.draft = null;
  APP.catalog.error = "";
  APP.catalog.issues = [];
  APP.catalog.problems = [];
  refreshUsage();
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
  if (APP.catalog.kind === "styles") invalidateStyles();
    APP.catalog.selected = saved;
    APP.catalog.draft = toDraft(saved, APP.catalog.kind);
    clearDeleteTimer();
    refreshUsage();
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

  const base = slugify(text, Infinity);
  let id = base || "entry";
  let n = 1;
  const used = new Set(existingIds);
  while (used.has(id)) {
    id = `${base}-${++n}`;
  }
  return id;
}

export function wireCatalog(page) {
  // Kind switcher
  for (const kind of CATALOG_KINDS) {
    on(page, `cat-kind-${kind}`, () => loadCatalog(kind));
  }

  // Entry selection
  for (const row of page.querySelectorAll(".catalog-entry")) {
    row.addEventListener("click", () => {
      const id = row.getAttribute("data-cat-id");
      const entry = (APP.catalog.entries || []).find(e => e.id === id);
      if (entry) selectEntry(entry);
    });
  }

  // Form field updates -- each field writes its value straight into the draft
  onInput(page, "cat-name", el => { if (APP.catalog.draft) APP.catalog.draft.name = el.value; });
  onInput(page, "cat-tags-input", el => { if (APP.catalog.draft) APP.catalog.draft.tags = el.value; });
  onInput(page, "cat-persona", el => { if (APP.catalog.draft) APP.catalog.draft.portablePersona = el.value; });
  onInput(page, "cat-belief", el => { if (APP.catalog.draft) APP.catalog.draft.belief = el.value; });
  onInput(page, "cat-impulse", el => { if (APP.catalog.draft) APP.catalog.draft.impulse = el.value; });
  onInput(page, "cat-voice", el => { if (APP.catalog.draft) APP.catalog.draft.voice = el.value; });
  onInput(page, "cat-skills", el => { if (APP.catalog.draft) APP.catalog.draft.skills = el.value; });
  onInput(page, "cat-restrictions", el => { if (APP.catalog.draft) APP.catalog.draft.restrictions = el.value; });
  onInput(page, "cat-facet", el => { if (APP.catalog.draft) APP.catalog.draft.facet = el.value; });
  onInput(page, "cat-label", el => { if (APP.catalog.draft) APP.catalog.draft.label = el.value; });
  onInput(page, "cat-desc", el => { if (APP.catalog.draft) APP.catalog.draft.description = el.value; });
  onInput(page, "cat-style-voice", el => { if (APP.catalog.draft) APP.catalog.draft.voice = el.value; });
  onInput(page, "cat-meaning", el => { if (APP.catalog.draft) APP.catalog.draft.meaning = el.value; });

  // Skills library picker (character form)
  on(page, "cat-skills-pick", () => {
    // The bible is the source of canonical skills; a bespoke one is still typed in the field. So the
    // picker owns only the lines that name a bible entry -- the rest are carried through untouched,
    // and deselecting a bible skill removes just that line.

    // A line's name is the part before `::` -- the authored form is `name :: meaning`.
    const nameOf = line => {
      const i = line.indexOf("::");
      return (i >= 0 ? line.slice(0, i) : line).trim().toLowerCase();
    };
    const currentLines = parseLines(APP.catalog.draft?.skills || "");

    openLibraryPicker({
      kind: "skills",
      title: "Skill Bible",
      hint: "A skill the bible does not carry is still typed straight into the field.",
      preselect: currentLines.map(nameOf),
      done: (chosen, offered) => {
        if (!APP.catalog.draft) return;      // the form went away while the overlay was open
        // Split on what the bible OFFERED, not on what was chosen. A line the bible does not know
        // is bespoke and survives untouched; a line it does know belongs to the picker, so
        // deselecting one removes it instead of leaving it standing.
        const known = new Set(offered.map(e => (e.name || "").trim().toLowerCase()));
        const bespoke = currentLines.filter(line => !known.has(nameOf(line)));
        const picked = chosen.map(e => `${e.name} :: ${e.meaning}`);
        APP.catalog.draft.skills = bespoke.concat(picked).join("\n");
        // The picker's done path renders.
      },
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
  on(page, "cat-save", saveDraft);
  on(page, "cat-delete", armDelete);
  on(page, "cat-new", createNew);
  on(page, "cat-retry", loadCatalog);
}
