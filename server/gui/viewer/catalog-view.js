import { esc, tid } from "./util.js";
import { APP } from "./state.js";

export function catalogPageHtml() {
  const cat = APP.catalog;

  // State 1: Loading
  if (cat.loading) {
    return `<section class="picker story">
      <h2>Character Catalog</h2>
      <div class="thinking"><i></i>loading…</div>
    </section>`;
  }

  // State 3: Load failed
  if (cat.error) {
    return `<section class="picker story">
      <h2>Character Catalog</h2>
      <div class="said bad">${esc(cat.error)}</div>
      <div class="btns">
        <button class="btn primary" id="cat-retry">try again</button>
      </div>
    </section>`;
  }

  // State 2: Empty catalog (no entries AND no draft being edited)
  if (!cat.entries.length && !cat.draft) {
    return `<section class="picker story">
      <h2>Character Catalog</h2>
      <p class="sub">Build a library of reusable character templates</p>
      <p class="cat-empty-msg">No characters yet. Create one to get started — it will be available to use in any story.</p>
      <div class="btns">
        <button class="btn primary" id="cat-new">create character</button>
      </div>
    </section>`;
  }

  // Layout: list on left, form on right
  const body = [];
  body.push(`<div class="cat-layout">
    <div class="cat-list-panel">`);

  // Entry list
  if (cat.entries.length) {
    for (const entry of cat.entries) {
      const isSelected = cat.selected?.id === entry.id;
      const tagsStr = (entry.tags || []).join(", ");
      body.push(`
        <div ${tid("catalog.entry-row")} data-cat-id="${esc(entry.id)}"
             class="catalog-entry${isSelected ? " selected" : ""}">
          <div class="cat-name">${esc(entry.name || "(unnamed)")}</div>
          ${tagsStr ? `<div class="cat-tags">${esc(tagsStr)}</div>` : ""}
          <div class="cat-version">v${entry.version}</div>
        </div>
      `);
    }
  }
  body.push(`</div>`);

  // Form area
  body.push(`<div class="cat-form-panel">`);

  if (!cat.draft) {
    // State 4: List with entries but no draft (no form open)
    body.push(`<div class="iv cat-placeholder">
      <p>Select an entry to edit, or create a new one</p>
      <button class="btn primary" id="cat-new">create character</button>
    </div>`);
  } else {
    // State 5: Editing an entry (or State 6: Delete armed)
    const d = cat.draft;
    const isNew = !cat.selected;

    body.push(`<div class="iv cat-form">`);

    // Issues block (validation failures)
    if (cat.issues.length) {
      body.push(`<div class="cat-block">`);
      body.push(`<div class="cat-block-label cat-bad">Issues</div>`);
      for (const issue of cat.issues) {
        body.push(`<div class="said bad">${esc(issue)}</div>`);
      }
      body.push(`</div>`);
    }

    // Problems block (warnings)
    if (cat.problems.length) {
      body.push(`<div class="cat-block">`);
      body.push(`<div class="cat-block-label cat-warn">Notices</div>`);
      for (const prob of cat.problems) {
        body.push(`<div class="prob">${esc(prob)}</div>`);
      }
      body.push(`</div>`);
    }

    // Form fields
    body.push(`<div class="field">
      <label for="cat-name">Name</label>
      <input id="cat-name" type="text" value="${esc(d.name || "")}" placeholder="Character name">
    </div>`);

    body.push(`<div class="field">
      <label for="cat-tags">Tags (comma-separated)</label>
      <input id="cat-tags" type="text" value="${esc(d.tags || "")}" placeholder="e.g. heroic, mentor, mysterious">
    </div>`);

    body.push(`<div class="field">
      <label for="cat-persona">Portable Persona</label>
      <textarea id="cat-persona" placeholder="Brief character description that travels between stories">${esc(d.portablePersona || "")}</textarea>
    </div>`);

    body.push(`<div class="field">
      <label for="cat-belief">Belief</label>
      <textarea id="cat-belief" placeholder="What this character believes to be true">${esc(d.belief || "")}</textarea>
    </div>`);

    body.push(`<div class="field">
      <label for="cat-impulse">Impulse</label>
      <textarea id="cat-impulse" placeholder="What this character wants to do">${esc(d.impulse || "")}</textarea>
    </div>`);

    body.push(`<div class="field">
      <label for="cat-voice">Voice Samples (one per line, max 3)</label>
      <textarea id="cat-voice" placeholder="Example lines of dialogue, one per line">${esc(d.voice || "")}</textarea>
    </div>`);

    body.push(`<div class="field">
      <label for="cat-skills">Skills (name :: meaning, one per line)</label>
      <textarea id="cat-skills" placeholder="e.g. leadership :: can inspire others to act">${esc(d.skills || "")}</textarea>
    </div>`);

    body.push(`<div class="field">
      <label for="cat-restrictions">Restrictions (one per line)</label>
      <textarea id="cat-restrictions" placeholder="e.g. cannot lie, cannot abandon allies">${esc(d.restrictions || "")}</textarea>
    </div>`);

    // Buttons
    body.push(`<div class="btns cat-btns">`);
    body.push(`<button class="btn primary" id="cat-save">save</button>`);
    // Only show delete button for existing entries
    if (!isNew) {
      body.push(`<button class="btn" id="cat-delete"${cat.armedDelete ? " armed" : ""}>${cat.armedDelete ? "delete — sure?" : "delete"}</button>`);
    }
    body.push(`<span class="spacer"></span>`);
    body.push(`<button class="btn" id="cat-new">new character</button>`);
    body.push(`</div>`);
    body.push(`</div>`);
  }

  body.push(`</div>`);
  body.push(`</div>`);

  return `<section class="picker story">
    <h2>Character Catalog</h2>
    ${body.join("")}
  </section>`;
}
