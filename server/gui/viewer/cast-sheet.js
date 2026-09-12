import { esc } from "./util.js";
import { APP, LIVEV } from "./state.js";

// ---- the authored character sheet ------------------------------------------
// The full authored cast a live run works from -- origin, persona, knows, goal, belief, impulse, voice,
// skills, restrictions, and (each labelled with its scene) reach and presence -- fetched from /cast,
// keyed by story dir, and rendered into the character card a cast pill opens. Authored data shown to
// the human; it never travels back to any agent. Reach and presence stay per scene, never merged
// into a character's skills. Live-screen only: elsewhere the card shows just what its pill knew.

/** Fetch the cast for one story into APP.cast. Guarded by APP.cast.dir + .loading so the render
 *  loop that kicks it (every frame on the live screen) cannot start a second fetch for the same
 *  story. Calls APP.render() on completion so an open card fills in as the answer lands. */
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
    ? { dir, characters: j.characters || [], scenes: j.scenes || [], loading: false, error: "" }
    : { dir, characters: [], scenes: [], loading: false, error: j.error || "could not load cast" };
  APP.render();
}

/** Kick the fetch the first frame the live screen has a story, so the card is already full when a
 *  pill is clicked. Idempotent: a fetch for this dir -- in flight or landed -- is left alone, the
 *  same rule the old rail panel's render-loop kick used. */
export function ensureLiveCast() {
  if (!APP.live || APP.view !== "live") return;
  const dir = LIVEV.meta?.story;
  if (!dir) return;
  if (APP.cast && APP.cast.dir === dir) return; // loading or loaded for this story
  loadCast(dir);
}

/** The authored half of the character card: null when this card has no sheet to show (not the live
 *  screen, or the run's story is unknown, or the character is not in the fetched cast -- the card
 *  then falls back to what its pill knew), otherwise { note, bad } for a loading/failed fetch or
 *  { fields } with the full summary HTML. */
export function castCharacterSheet(name) {
  if (!APP.live || APP.view !== "live") return null;
  const dir = LIVEV.meta?.story;
  if (!dir) return null;
  if (!APP.cast || APP.cast.dir !== dir || APP.cast.loading)
    return { note: "loading the authored sheet…" };
  if (APP.cast.error) return { note: "could not load cast — showing what the pill knows", bad: true };

  const c = APP.cast.characters.find(k => (k.name || "").toLowerCase() === name.toLowerCase());
  if (!c) return null;

  const field = (label, val) => val && val.trim()
    ? `<div class="cast-field"><span>${label}</span><p>${esc(val)}</p></div>` : "";
  // Reach arrives per scene and stays per scene (I4): each tag names the scene that granted it, so
  // it can never read as an intrinsic skill.
  const reachByChar = {};
  for (const sc of (APP.cast.scenes || []))
    for (const [who, entries] of Object.entries(sc.reach || {}))
      (reachByChar[who.toLowerCase()] = reachByChar[who.toLowerCase()] || [])
        .push(...(Array.isArray(entries) ? entries : []).map(e => ({ n: sc.n, e })));
  // Presence arrives per scene and stays per scene (I4), grouped the same way: each tag names the
  // scene it positions the character in, so it can never read as intrinsic. A character with no
  // entry in a scene's presence is "here" -- the unmarked default -- and renders no chip.
  const presenceByChar = {};
  for (const sc of (APP.cast.scenes || []))
    for (const [who, raw] of Object.entries(sc.presence || {}))
      (presenceByChar[who.toLowerCase()] = presenceByChar[who.toLowerCase()] || [])
        .push({ n: sc.n, raw: String(raw ?? "") });
  const skills = (c.skills || []).map(s =>
    `<span class="yes" title="${esc(s.meaning || "")}">+${esc(s.text)}</span>`).join(" ");
  const restr = (c.restrictions || []).map(r =>
    `<span class="no" title="cannot ${esc(r)}">no ${esc(r)}</span>`).join(" ");
  const reach = (reachByChar[c.name.toLowerCase()] || []).map(({ n, e }) => {
    const i = e.indexOf("::");
    const rname = (i < 0 ? e : e.slice(0, i)).trim();
    const meaning = i < 0 ? "" : e.slice(i + 2).trim();
    return `<span class="reach" title="${esc(`scene ${n} — available only through where they are standing here${meaning ? `: ${meaning}` : ""}`)}">⇢ ${esc(rname)} · scene ${n}</span>`;
  }).join(" ");
  // A position, not a grant: the mode (remote/partial) labels the chip and the via rides in the
  // tooltip, the way a reach meaning does -- and the muted .presence style keeps it from reading
  // as a capability.
  const presence = (presenceByChar[c.name.toLowerCase()] || []).map(({ n, raw }) => {
    const i = raw.indexOf("::");
    const mode = (i < 0 ? raw : raw.slice(0, i)).trim();
    const via = i < 0 ? "" : raw.slice(i + 2).trim();
    if (!mode) return "";
    return `<span class="presence" title="${esc(`scene ${n} — ${mode}${via ? ` via ${via}` : ""}`)}">◌ ${esc(mode)} · scene ${n}</span>`;
  }).join(" ");
  const tags = skills || restr || reach || presence
    ? `<div class="cast-tags">${skills}${skills && restr ? " " : ""}${restr}${(skills || restr) && (reach || presence) ? " " : ""}${reach}${reach && presence ? " " : ""}${presence}</div>` : "";
  const voice = (c.voice || []).map(v => `<p class="cast-voice">“${esc(v)}”</p>`).join("");
  const fields = [
    field("origin", c.origin),
    field("persona", c.persona),
    field("knows", c.knows),
    field("goal", c.goal),
    field("belief", c.belief),
    field("impulse", c.impulse),
    voice,
    tags,
  ].filter(Boolean).join("");
  return fields ? { fields } : null;
}
