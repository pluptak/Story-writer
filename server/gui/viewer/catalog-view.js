import { esc, tid } from "./util.js";
import { APP } from "./state.js";

/** Per-kind metadata: labels, empty-state text, and button wording.
 *  This is the single source of truth for kind-specific UI strings and form structures.
 *  Every call site reads from this table rather than checking `kind ===` inline. */
const kindFacts = {
  characters: {
    pageTitle: "Character Catalog",
    pageSubtitle: "Build a library of reusable character templates",
    createLabel: "create character",
    newLabel: "character",
    emptyMsg: "No characters yet. Create one to get started — it will be available to use in any story.",
  },
  tags: {
    pageTitle: "Tag Vocabulary",
    pageSubtitle: "Define a controlled vocabulary of story descriptors",
    createLabel: "create tag",
    newLabel: "tag",
    emptyMsg: "No tags yet. Create some to organize your characters — genres, dramatic modes, tones.",
  },
  styles: {
    pageTitle: "Style Catalog",
    pageSubtitle: "Build a library of reusable writer voices",
    createLabel: "create style",
    newLabel: "style",
    emptyMsg: "No styles yet. Create one to get started — it will be available to use in any story.",
  },
};

export function catalogPageHtml() {
  const cat = APP.catalog;
  const facts = kindFacts[cat.kind] || kindFacts.characters;
  const pageTitle = facts.pageTitle;
  const pageSubtitle = facts.pageSubtitle;

  // State 1: Loading
  if (cat.loading) {
    return `<section class="picker story">
      <h2>${pageTitle}</h2>
      <div class="thinking"><i></i>loading…</div>
    </section>`;
  }

  // State 3: Load failed
  if (cat.error) {
    return `<section class="picker story">
      <h2>${pageTitle}</h2>
      <div class="said bad">${esc(cat.error)}</div>
      <div class="btns">
        <button class="btn primary" id="cat-retry">try again</button>
      </div>
    </section>`;
  }

  // State 2: Empty catalog (no entries AND no draft being edited)
  if (!cat.entries.length && !cat.draft) {
    return `<section class="picker story">
      <h2>${pageTitle}</h2>
      <div class="tabs">
        <button class="tab${cat.kind === "characters" ? " current" : ""}" id="cat-kind-characters">Characters</button>
        <button class="tab${cat.kind === "tags" ? " current" : ""}" id="cat-kind-tags">Tags</button>
        <button class="tab${cat.kind === "styles" ? " current" : ""}" id="cat-kind-styles">Styles</button>
      </div>
      <p class="sub">${pageSubtitle}</p>
      <p class="cat-empty-msg">${facts.emptyMsg}</p>
      <div class="btns">
        <button class="btn primary" id="cat-new">${facts.createLabel}</button>
      </div>
    </section>`;
  }

  // Layout: list on left, form on right
  const body = [];

  // Tabs at the top
  body.push(`<div class="tabs">
    <button class="tab${cat.kind === "characters" ? " current" : ""}" id="cat-kind-characters">Characters</button>
    <button class="tab${cat.kind === "tags" ? " current" : ""}" id="cat-kind-tags">Tags</button>
    <button class="tab${cat.kind === "styles" ? " current" : ""}" id="cat-kind-styles">Styles</button>
  </div>`);

  body.push(`<div class="cat-layout">
    <div class="cat-list-panel">`);

  // Entry list — three-way dispatch based on kind
  if (cat.kind === "characters") {
    // Character entries: name + tags + version
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
  } else if (cat.kind === "tags") {
    // Tag entries: grouped by facet, label + version
    const byFacet = { genre: [], dramaticMode: [], tone: [] };
    for (const entry of cat.entries) {
      if (Object.prototype.hasOwnProperty.call(byFacet, entry.facet)) {
        byFacet[entry.facet].push(entry);
      }
    }

    const facetLabels = { genre: "Genre", dramaticMode: "Dramatic Mode", tone: "Tone" };
    for (const [facet, entries] of Object.entries(byFacet)) {
      if (entries.length > 0) {
        body.push(`<div class="cat-tags-group">
          <div class="cat-facet-heading">${facetLabels[facet]}</div>`);
        for (const entry of entries) {
          const isSelected = cat.selected?.id === entry.id;
          body.push(`
            <div ${tid("catalog.entry-row")} data-cat-id="${esc(entry.id)}"
                 class="catalog-entry${isSelected ? " selected" : ""}">
              <div class="cat-name">${esc(entry.label || "(unnamed)")}</div>
              <div class="cat-version">v${entry.version}</div>
            </div>
          `);
        }
        body.push(`</div>`);
      }
    }
  } else if (cat.kind === "styles") {
    // Style entries: name + description + version
    for (const entry of cat.entries) {
      const isSelected = cat.selected?.id === entry.id;
      body.push(`
        <div ${tid("catalog.entry-row")} data-cat-id="${esc(entry.id)}"
             class="catalog-entry${isSelected ? " selected" : ""}">
          <div class="cat-name">${esc(entry.name || "(unnamed)")}</div>
          ${entry.description ? `<div class="cat-desc">${esc(entry.description)}</div>` : ""}
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
      <button class="btn primary" id="cat-new">${facts.createLabel}</button>
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

    if (cat.kind === "characters") {
      // Character form: name, tags, persona, belief, impulse, voice, skills, restrictions
      body.push(`<div class="field">
        <label for="cat-name">Name</label>
        <input id="cat-name" type="text" value="${esc(d.name || "")}" placeholder="Character name">
      </div>`);

      // Tags picker using vocabulary
      body.push(`<div class="field">
        <label>Tags</label>
        <div class="cat-tags-picker">`);

      // Group vocabulary by facet
      const byFacet = { genre: [], dramaticMode: [], tone: [] };
      for (const tag of (cat.vocab || [])) {
        if (Object.prototype.hasOwnProperty.call(byFacet, tag.facet)) {
          byFacet[tag.facet].push(tag);
        }
      }

      const currentTags = new Set((d.tags || "").split(",").map(t => t.trim()).filter(Boolean));
      const facetLabels = { genre: "Genre", dramaticMode: "Dramatic Mode", tone: "Tone" };

      for (const [facet, tags] of Object.entries(byFacet)) {
        if (tags.length > 0) {
          body.push(`<div class="cat-tags-group">
            <div class="cat-facet-heading">${facetLabels[facet]}</div>
            <div class="cat-tags-row">`);
          for (const tag of tags) {
            const isSelected = currentTags.has(tag.label);
            body.push(`<button class="cat-chip${isSelected ? " on" : ""}"
                         data-tag-label="${esc(tag.label)}"
                         type="button">${esc(tag.label)}</button>`);
          }
          body.push(`</div></div>`);
        }
      }

      // Off-vocabulary tags (not in the vocabulary but in the draft)
      const vocabLabels = new Set(cat.vocab.map(t => t.label));
      const offVocab = Array.from(currentTags).filter(t => !vocabLabels.has(t));
      if (offVocab.length > 0) {
        body.push(`<div class="cat-tags-group cat-tags-offvocab">
          <div class="cat-facet-heading">Off-vocabulary</div>
          <div class="cat-tags-row">`);
        for (const label of offVocab) {
          body.push(`<button class="cat-chip on off-vocab"
                       data-tag-label="${esc(label)}"
                       type="button" title="This tag is not in the vocabulary">${esc(label)}</button>`);
        }
        body.push(`</div>
          <p class="cat-tags-notice">These tags are not in the vocabulary. They will be kept when you save.</p>
        </div>`);
      }

      body.push(`</div></div>`);

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
    } else if (cat.kind === "tags") {
      // Tag form: facet, label
      body.push(`<div class="field">
        <label for="cat-facet">Facet</label>
        <select id="cat-facet" class="btn">
          <option value="">Select a facet…</option>
          <option value="genre"${d.facet === "genre" ? " selected" : ""}>Genre</option>
          <option value="dramaticMode"${d.facet === "dramaticMode" ? " selected" : ""}>Dramatic Mode</option>
          <option value="tone"${d.facet === "tone" ? " selected" : ""}>Tone</option>
        </select>
      </div>`);

      body.push(`<div class="field">
        <label for="cat-label">Label</label>
        <input id="cat-label" type="text" value="${esc(d.label || "")}" placeholder="e.g. Science Fiction, Comedy, Melancholic">
      </div>`);
    } else if (cat.kind === "styles") {
      // Style form: name, description, tags, voice
      body.push(`<div class="field">
        <label for="cat-name">Name</label>
        <input id="cat-name" type="text" value="${esc(d.name || "")}" placeholder="Style name">
      </div>`);

      body.push(`<div class="field">
        <label for="cat-desc">Description</label>
        <input id="cat-desc" type="text" value="${esc(d.description || "")}" placeholder="One-line description for picking between presets">
      </div>`);

      // Tags picker for styles (same as characters)
      body.push(`<div class="field">
        <label>Tags</label>
        <div class="cat-tags-picker">`);

      // Group vocabulary by facet
      const byFacet = { genre: [], dramaticMode: [], tone: [] };
      for (const tag of (cat.vocab || [])) {
        if (Object.prototype.hasOwnProperty.call(byFacet, tag.facet)) {
          byFacet[tag.facet].push(tag);
        }
      }

      const currentTags = new Set((d.tags || "").split(",").map(t => t.trim()).filter(Boolean));
      const facetLabels = { genre: "Genre", dramaticMode: "Dramatic Mode", tone: "Tone" };

      for (const [facet, tags] of Object.entries(byFacet)) {
        if (tags.length > 0) {
          body.push(`<div class="cat-tags-group">
            <div class="cat-facet-heading">${facetLabels[facet]}</div>
            <div class="cat-tags-row">`);
          for (const tag of tags) {
            const isSelected = currentTags.has(tag.label);
            body.push(`<button class="cat-chip${isSelected ? " on" : ""}"
                         data-tag-label="${esc(tag.label)}"
                         type="button">${esc(tag.label)}</button>`);
          }
          body.push(`</div></div>`);
        }
      }

      // Off-vocabulary tags
      const vocabLabels = new Set(cat.vocab.map(t => t.label));
      const offVocab = Array.from(currentTags).filter(t => !vocabLabels.has(t));
      if (offVocab.length > 0) {
        body.push(`<div class="cat-tags-group cat-tags-offvocab">
          <div class="cat-facet-heading">Off-vocabulary</div>
          <div class="cat-tags-row">`);
        for (const label of offVocab) {
          body.push(`<button class="cat-chip on off-vocab"
                       data-tag-label="${esc(label)}"
                       type="button" title="This tag is not in the vocabulary">${esc(label)}</button>`);
        }
        body.push(`</div>
          <p class="cat-tags-notice">These tags are not in the vocabulary. They will be kept when you save.</p>
        </div>`);
      }

      body.push(`</div></div>`);

      body.push(`<div class="field">
        <label for="cat-style-voice">Voice</label>
        <textarea id="cat-style-voice" placeholder="The reusable half of a writer's house style: person, tense, dialogue handling, vocabulary, what to leave out">${esc(d.voice || "")}</textarea>
      </div>`);
    }

    // Buttons
    body.push(`<div class="btns cat-btns">`);
    body.push(`<button class="btn primary" id="cat-save">save</button>`);
    // Only show delete button for existing entries
    if (!isNew) {
      body.push(`<button class="btn" id="cat-delete"${cat.armedDelete ? " armed" : ""}>${cat.armedDelete ? "delete — sure?" : "delete"}</button>`);
    }
    body.push(`<span class="spacer"></span>`);
    body.push(`<button class="btn" id="cat-new">new ${facts.newLabel}</button>`);
    body.push(`</div>`);
    body.push(`</div>`);
  }

  body.push(`</div>`);
  body.push(`</div>`);

  return `<section class="picker story">
    <h2>${pageTitle}</h2>
    ${body.join("")}
  </section>`;
}
