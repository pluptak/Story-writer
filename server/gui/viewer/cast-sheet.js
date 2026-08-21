import { esc } from "./util.js";
import { APP, LIVEV } from "./state.js";

// ---- the live character sheet --------------------------------------------
// A read-only panel in the live rail showing the authored cast the current run is working from --
// persona, knows, goal, skills and restrictions. It is already-authored data shown to the human;
// it never travels back to any agent. Fetched from /cast, keyed by story dir.

/** Fetch the cast for one story into APP.cast. Guarded by APP.cast.dir + .loading so the render loop
 *  that kicks it (castSheetHtml, called every frame) cannot start a second fetch for the same story. */
export async function loadCast(dir) {
  APP.cast = { dir, characters: [], loading: true, error: "" };
  let j;
  try {
    j = await (await fetch(`/cast?dir=${encodeURIComponent(dir)}`)).json();
  } catch {
    if (APP.cast?.dir === dir) { APP.cast = { dir, characters: [], loading: false, error: "could not load cast" }; APP.render(); }
    return;
  }
  if (APP.cast?.dir !== dir) return;            // a newer story's run took over mid-fetch
  APP.cast = j.ok
    ? { dir, characters: j.characters || [], loading: false, error: "" }
    : { dir, characters: [], loading: false, error: j.error || "could not load cast" };
  APP.render();
}

/** The rail panel. Live screen only. Lazily triggers the fetch the first time it is asked for a
 *  story, then renders once APP.cast holds that story's cast. */
export function castSheetHtml() {
  if (!APP.live || APP.view !== "live") return "";
  const dir = LIVEV.meta?.story;
  if (!dir) return "";

  if (!APP.cast || APP.cast.dir !== dir) {
    if (!(APP.cast && APP.cast.loading && APP.cast.dir === dir)) loadCast(dir);
    return `<section class="cast-sheet"><h3>cast</h3><p class="cast-note">loading…</p></section>`;
  }
  if (APP.cast.loading) return `<section class="cast-sheet"><h3>cast</h3><p class="cast-note">loading…</p></section>`;
  if (APP.cast.error) return `<section class="cast-sheet"><h3>cast</h3><p class="cast-note bad">${esc(APP.cast.error)}</p></section>`;

  // Filter the full authored cast to the names the live scene reports. (Today scene_start reports
  // the whole cast, so this is a no-op; it tightens automatically if that ever narrows to a roster.)
  const names = new Set((LIVEV.meta?.characters || []).map(c => c.name.toLowerCase()));
  const roster = APP.cast.characters.filter(c => !names.size || names.has(c.name.toLowerCase()));
  if (!roster.length) return "";

  const field = (label, val) => val && val.trim()
    ? `<div class="cast-field"><span>${label}</span><p>${esc(val)}</p></div>` : "";
  const cards = roster.map(c => {
    const skills = (c.skills || []).map(s =>
      `<span class="yes" title="${esc(s.meaning || "")}">+${esc(s.text)}</span>`).join(" ");
    const restr = (c.restrictions || []).map(r => `<span class="no">no ${esc(r)}</span>`).join(" ");
    const tags = skills || restr ? `<div class="cast-tags">${skills}${skills && restr ? " " : ""}${restr}</div>` : "";
    return `<div class="cast-card">
      <div class="cast-name">${esc(c.name)}</div>
      ${field("persona", c.persona)}
      ${field("knows", c.knows)}
      ${field("goal", c.goal)}
      ${tags}
    </div>`;
  }).join("");
  return `<section class="cast-sheet"><h3>cast</h3>${cards}</section>`;
}
