import { esc, tid } from "./util.js";
import { APP } from "./state.js";
import { charChip } from "./character-card.js";

// ---- the shelf ------------------------------------------------------------
// The hub: reachable any time an engine is attached, including mid-run -- browsing is always
// allowed, only *starting* a run is refused, and that refusal now lives on the story page, not
// here. A card doesn't play a story, it opens one.
export const castChips = (list, dir) => (list || []).map(c => charChip(c, dir)).join("");

export function pickerHtml() {
  if (!APP.stories) return `<section class="picker"><h2>Choose a story</h2>
    <p class="sub">reading the shelf…</p></section>`;

  const cards = APP.stories.map(s => {
    // A story that does not load says so here, and cannot be chosen -- the same pre-flight the CLI
    // runs, so the card cannot disagree with what a run would do.
    const dead = !s.ok || !!APP.picked;
    const card = `<button ${tid("shelf.story-card")} class="card" data-dir="${esc(s.dir)}"${dead ? " disabled" : ""}>
      <div class="name">${esc(s.name)}</div>
      ${s.ok ? `<p class="q">${esc(s.scene?.question || "(no scene question)")}</p>
                <p class="pre"${s.premise ? ` title="${esc(s.premise)}"` : ""}>${esc(s.premise || "")}</p>
                <div class="row">${castChips(s.characters, s.dir)}<span class="meta">~${s.scene?.length ?? "?"} words
                  · ${s.maxSteps ?? "?"} steps${s.scene?.pov ? " · pov " + esc(s.scene.pov) : ""}</span></div>`
              : `<div class="bad">does not load — ${esc(s.error || "unknown error")}</div>`}
      ${(s.warnings || []).map(w => `<div class="warn">⚠ ${esc(w)}</div>`).join("")}
    </button>`;
    return `<div class="cardwrap">${card}</div>`;
  }).join("");

  const newCard = `<button ${tid("shelf.new-story-card")} class="card new top" data-new="1"${APP.picked ? " disabled" : ""}>
    <div class="name">${APP.scaffold.active ? "↩ continue new story…" : "＋ start a new story"}</div>
    <p class="q">${APP.scaffold.active ? `back to "${esc(APP.scaffold.idea || "")}"` : "describe an idea and have one built"}</p>
  </button>`;
  const divider = cards
    ? `<div class="divider"><span>or pick an existing one</span></div>`
    : `<p class="hint" style="text-align:center;margin:14px 0 0">no stories on the shelf yet — start one above</p>`;

  return `<section class="picker" data-tid="shelf.picker">
    <h2>Choose a story</h2>
    <p class="sub">${APP.picked ? "starting…" : "pick one to see what it's about"}</p>
    ${newCard}
    ${divider}
    <div class="cards">${cards}</div>
  </section>`;
}

/** `openStory` is injected (pages.js, which owns navigation) rather than imported here -- shelf.js
 *  sits underneath nav.js in the module graph (nav.js -> saved-runs.js -> here, for castChips), so
 *  importing nav.js back from here would close a cycle. */
export function wirePicker(page, openStory, openNew = null) {
  for (const b of page.querySelectorAll(".card[data-dir]"))
    b.addEventListener("click", () => { if (!APP.picked) {
      APP.storyDir = b.dataset.dir; APP.storyModel = ""; APP.storyError = ""; APP.runError = ""; openStory();
    } });
  for (const b of page.querySelectorAll(".card[data-new]"))
    // Opens the scaffold page (`openNew`, injected by the shelf -- importing nav.js here would close
    // a module cycle). One ScaffoldSession lives on the server (GUI-SPEC §5.1), so a session already
    // running is continued there rather than started again; the card relabels itself to say so.
    b.addEventListener("click", () => { if (openNew) openNew(); });
}
