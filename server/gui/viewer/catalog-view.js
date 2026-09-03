import { esc, tid } from "./util.js";
import { APP, CATALOG_KINDS } from "./state.js";

/** Per-kind metadata: labels, empty-state text, and button wording.
 *  This is the single source of truth for kind-specific UI strings and form structures.
 *  Every call site reads from this table rather than checking `kind ===` inline. */
const kindFacts = {
  characters: {
    tabLabel: "Characters",
    pageTitle: "Character Catalog",
    pageSubtitle: "Build a library of reusable character templates",
    createLabel: "create character",
    newLabel: "character",
    emptyMsg: "No characters yet. Create one to get started — it will be available to use in any story.",
  },
  tags: {
    tabLabel: "Tags",
    pageTitle: "Tag Vocabulary",
    pageSubtitle: "Define a controlled vocabulary of story descriptors",
    createLabel: "create tag",
    newLabel: "tag",
    emptyMsg: "No tags yet. Create some to organize your characters — genres, dramatic modes, tones.",
  },
  styles: {
    tabLabel: "Styles",
    pageTitle: "Style Catalog",
    pageSubtitle: "Build a library of reusable writer voices",
    createLabel: "create style",
    newLabel: "style",
    emptyMsg: "No styles yet. Create one to get started — it will be available to use in any story.",
  },
  skills: {
    tabLabel: "Skills",
    pageTitle: "Skill Bible",
    pageSubtitle: "The special skills a story can draw on by name",
    createLabel: "create skill",
    newLabel: "skill",
    emptyMsg: "No skills yet. Create one to get started — it will be available for characters to use in any story.",
  },
};

/** Build the catalog kind tabs from CATALOG_KINDS. */
function tabsHtml() {
  return `<div class="tabs">
    ${CATALOG_KINDS.map(kind => {
      const facts = kindFacts[kind];
      const isCurrent = APP.catalog.kind === kind ? " current" : "";
      return `<button class="tab${isCurrent}" id="cat-kind-${kind}">${esc(facts.tabLabel)}</button>`;
    }).join("")}
  </div>`;
}

/** The "used by" line a list row and a detail pane share. Derived from /catalog/usage — observed,
 *  never authored, so it says what actually references the entry and nothing about intent. */
const folded = s => String(s ?? "").trim().toLowerCase();
function tagUsageHtml(label) {
  const u = APP.catalog.usage?.tags?.[folded(label)];
  if (!u) return "";
  const parts = [];
  if (u.characters) parts.push(`${u.characters} character${u.characters === 1 ? "" : "s"}`);
  if (u.styles.length) parts.push(`${u.styles.length} style${u.styles.length === 1 ? "" : "s"}`);
  if (u.skills) parts.push(`${u.skills} skill${u.skills === 1 ? "" : "s"}`);
  return parts.length ? `<div class="cat-usage">used by ${parts.join(" · ")}</div>` : "";
}
function skillUsageHtml(name) {
  const u = APP.catalog.usage?.skills || {};
  const n = u[folded(name)] ?? 0;
  return n ? `<div class="cat-usage">used by ${n} character${n === 1 ? "" : "s"}</div>` : "";
}
/** Whether any style carries the label — the whole of the derived STYLE cut. */
const tagIsStyle = label => (APP.catalog.usage?.tags?.[folded(label)]?.styles?.length ?? 0) > 0;
/** The style names that carry the label, for the tag editor's "commonly associated" line. */
const tagStyles = label => APP.catalog.usage?.tags?.[folded(label)]?.styles ?? [];

/** Build the tag picker HTML for characters, styles, and skills. */
function tagPickerHtml(cat, d) {
  // Group vocabulary by facet
  const byFacet = { genre: [], dramaticMode: [], tone: [] };
  for (const tag of (cat.vocab || [])) {
    if (Object.prototype.hasOwnProperty.call(byFacet, tag.facet)) {
      byFacet[tag.facet].push(tag);
    }
  }

  const currentTags = new Set((d.tags || "").split(",").map(t => t.trim()).filter(Boolean));
  const facetLabels = { genre: "Genre", dramaticMode: "Dramatic Mode", tone: "Tone" };

  let html = `<div class="cat-tags-picker">`;

  for (const [facet, tags] of Object.entries(byFacet)) {
    if (tags.length > 0) {
      html += `<div class="cat-tags-group">
        <div class="cat-facet-heading">${facetLabels[facet]}</div>
        <div class="cat-tags-row">`;
      for (const tag of tags) {
        const isSelected = currentTags.has(tag.label);
        html += `<button class="cat-chip${isSelected ? " on" : ""}"
                   data-tag-label="${esc(tag.label)}"
                   type="button">${esc(tag.label)}</button>`;
      }
      html += `</div></div>`;
    }
  }

  // Off-vocabulary tags (not in the vocabulary but in the draft)
  const vocabLabels = new Set(cat.vocab.map(t => t.label));
  const offVocab = Array.from(currentTags).filter(t => !vocabLabels.has(t));
  if (offVocab.length > 0) {
    html += `<div class="cat-tags-group cat-tags-offvocab">
      <div class="cat-facet-heading">Off-vocabulary</div>
      <div class="cat-tags-row">`;
    for (const label of offVocab) {
      html += `<button class="cat-chip on off-vocab"
                 data-tag-label="${esc(label)}"
                 type="button" title="This tag is not in the vocabulary">${esc(label)}</button>`;
    }
    html += `</div>
      <p class="cat-tags-notice">These tags are not in the vocabulary. They will be kept when you save.</p>
    </div>`;
  }

  html += `</div>`;
  return html;
}

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
      ${tabsHtml()}
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
  body.push(tabsHtml());

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
    // The tags list is grouped by the derived cut, not the authored facet: a tag is STYLE when
    // some style carries it and STORY when none does — observed from the catalogs, so the editor
    // gains no checkbox and the grouping moves the moment a style picks the tag up. The facet
    // each tag was authored under rides along on the row.
    const groups = { story: [], style: [] };
    for (const entry of cat.entries) groups[tagIsStyle(entry.label) ? "style" : "story"].push(entry);
    const groupHead = (name, entries) => {
      if (!entries.length) return "";
      const rows = entries.map(entry => {
        const isSelected = cat.selected?.id === entry.id;
        return `
          <div ${tid("catalog.entry-row")} data-cat-id="${esc(entry.id)}"
               class="catalog-entry${isSelected ? " selected" : ""}">
            <div class="cat-name">${esc(entry.label || "(unnamed)")}<span class="cat-facet"> · ${esc(entry.facet)}</span></div>
            ${tagUsageHtml(entry.label)}
            <div class="cat-version">v${entry.version}</div>
          </div>
        `;
      }).join("");
      return `<div class="cat-tags-group">
        <div class="cat-facet-heading">${name}</div>${rows}</div>`;
    };
    body.push(groupHead("STORY", groups.story));
    body.push(groupHead("STYLE", groups.style));
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
  } else if (cat.kind === "skills") {
    // Skill entries: name + meaning + who uses them
    for (const entry of cat.entries) {
      const isSelected = cat.selected?.id === entry.id;
      body.push(`
        <div ${tid("catalog.entry-row")} data-cat-id="${esc(entry.id)}"
             class="catalog-entry${isSelected ? " selected" : ""}">
          <div class="cat-name">${esc(entry.name || "(unnamed)")}</div>
          ${entry.meaning ? `<div class="cat-desc">${esc(entry.meaning)}</div>` : ""}
          ${skillUsageHtml(entry.name)}
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
        ${tagPickerHtml(cat, d)}
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
        <button class="btn pickopen" id="cat-skills-pick" ${tid("catalog.skills-pick")}>search skill bible…</button>
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

      // Observed association, not authored: the styles that carry this tag today. It is derived
      // from the style catalog, so it updates when a style's tags change and needs no field here.
      const stylesFor = tagStyles(d.label);
      if (stylesFor.length)
        body.push(`<div class="field"><label>Styles commonly associated</label>
          <div class="cat-tags-row">${stylesFor.map(s => `<span class="cat-chip on">${esc(s)}</span>`).join("")}</div></div>`);
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
        ${tagPickerHtml(cat, d)}
      </div>`);

      body.push(`<div class="field">
        <label for="cat-style-voice">Voice</label>
        <textarea id="cat-style-voice" placeholder="The reusable half of a writer's house style: person, tense, dialogue handling, vocabulary, what to leave out">${esc(d.voice || "")}</textarea>
      </div>`);
    } else if (cat.kind === "skills") {
      // Skill form: name, meaning, tags
      body.push(`<div class="field">
        <label for="cat-name">Name</label>
        <input id="cat-name" type="text" value="${esc(d.name || "")}" placeholder="The canonical spelling a story writes">
      </div>`);

      body.push(`<div class="field">
        <label for="cat-meaning">Meaning</label>
        <textarea id="cat-meaning" placeholder="What the skill lets a character do">${esc(d.meaning || "")}</textarea>
      </div>`);

      body.push(`<div class="field"><label>Usage</label>${skillUsageHtml(d.name)
        || `<p class="hint">no character carries it yet</p>`}</div>`);

      // Tags picker for skills
      body.push(`<div class="field">
        <label>Tags</label>
        ${tagPickerHtml(cat, d)}
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
