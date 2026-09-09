import { esc, tid } from "./util.js";
import { APP, storyName } from "./state.js";
import { castCharacterSheet } from "./cast-sheet.js";
import { modal, closeButton } from "./ui.js";
import { wireModalClose } from "./wire.js";

// ---- the character card -----------------------------------------------------
// A pill (header cast, a shelf card, or a scene roster) opens this modal for the character it
// names, without leaving the page underneath -- prose and map stay where they were. The card
// reads scene-first: what matters to the chapter at hand (role, place, question, what the scene
// grants them), then the authored sheet (persona, knows, goal, belief, impulse, voice, skills,
// restrictions), labelled as saved in the story so scene state can never read as definition.
// On the live screen the authored half is the /cast sheet; elsewhere it is what the pill knew.

/** A clickable pill for one character, used by the header, the shelf cards and the scene
 *  rosters. A `<span role="button">`, not a `<button>`, so pills keep working inside any card
 *  without nesting real buttons. `scene` is the chapter number the pill was rendered for, when
 *  one is known -- it rides to the card as `data-char-scene`. */
export function charChip(c, dir, scene = null) {
  const can = c.skills || [];
  const cannot = c.restrictions || [];
  const reach = c.reach || [];
  const bits = [];
  if (can.length) bits.push(`<span class="yes">+${esc(can.join(", "))}</span>`);
  if (cannot.length) bits.push(`<span class="no">no ${esc(cannot.join(", "))}</span>`);
  if (reach.length) bits.push(`<span class="reach">⇢${esc(reach.join(", "))}</span>`);
  return `<span${tid("cast.chip")} class="chip" role="button" tabindex="0"
            data-char-name="${esc(c.name)}" data-char-dir="${esc(dir || "")}"
            data-char-can="${esc(can.join("|"))}" data-char-cannot="${esc(cannot.join("|"))}"
            data-char-reach="${esc(reach.join("|"))}"
            ${scene != null ? `data-char-scene="${scene}"` : ""}>
    <b>${esc(c.name)}</b>${bits.length ? " " + bits.join(" ") : ""}</span>`;
}

/** The chapter a card's scene number points at, read off the already-loaded shelf cards --
 *  no fetch, so the card never waits on one. Mirrors story-page.js's scenesOf without importing
 *  it (story-page -> shelf -> here would close a module cycle). Null when the pill named no
 *  scene, or the story isn't on the shelf anymore. */
function sceneContext(dir, n) {
  if (!dir || !Number.isFinite(n)) return null;
  const card = (APP.stories || []).find(s => s.dir === dir);
  if (!card) return null;
  const scenes = card.scenes?.length ? card.scenes.map((s, i) => ({ ...s, n: i + 1 }))
    : card.scene ? [{ ...card.scene, n: 1 }] : [];
  const scene = scenes.find(s => s.n === n) || (n === 1 ? scenes[0] : null);
  if (!scene) return null;
  return { story: storyName(dir) || card.name || dir, scene };
}

/** "In this scene": role, place, dramatic question, and what this scene grants them -- every one
 *  of them true only here. Reach entries are `name :: meaning`; the meaning rides as a tooltip
 *  so the grant reads in one line. */
function sceneSectionHtml(name, ctx) {
  const { story, scene } = ctx;
  const roster = scene.roster || [];
  const inScene = roster.some(r => (r || "").toLowerCase() === name.toLowerCase());
  const isPov = (scene.pov || "").toLowerCase() === name.toLowerCase();
  const mates = roster.filter(r => (r || "").toLowerCase() !== name.toLowerCase());
  const role = isPov ? `Telling this chapter — the point of view is ${name}.`
    : inScene ? `In this scene${mates.length ? " with " + mates.join(", ") : ""}.`
    : `${name} is not in this chapter's cast.`;
  const grants = Object.entries(scene.reach || {})
    .filter(([who]) => (who || "").toLowerCase() === name.toLowerCase())
    .flatMap(([, entries]) => Array.isArray(entries) ? entries : []);
  const grantTags = grants.map(e => {
    const i = String(e).indexOf("::");
    const rname = (i < 0 ? String(e) : String(e).slice(0, i)).trim();
    const meaning = i < 0 ? "" : String(e).slice(i + 2).trim();
    return `<span class="reach" title="${esc(`only here — granted by this scene${meaning ? `: ${meaning}` : ""}`)}">⇢ ${esc(rname)}</span>`;
  }).join(" ");
  return `<section data-tid="charcard.scene">`
    + `<p class="charcard-eyebrow">${esc(inScene || isPov ? `In this scene · Chapter ${scene.n}` : `Chapter ${scene.n}`)}${story ? ` · ${esc(story)}` : ""}</p>`
    + `<p class="charcard-role">${esc(role)}</p>`
    + (scene.place || scene.question
      ? `<div class="charcard-scene">${scene.place ? `<span>${esc(scene.place)}</span>` : ""}`
        + `${scene.question ? `<p>“${esc(scene.question)}”</p>` : ""}</div>` : "")
    + (grantTags ? `<div class="cast-tags">${grantTags}</div>`
      + `<p class="hint">Only in this scene — not part of who they are.</p>` : "")
    + `</section>`;
}

/** "About them": the persistent definition, labelled as saved in the story. The /cast sheet when
 *  there is one, else what the pill knew; the placeholder only when there is neither. */
function aboutSectionHtml(c, sheet) {
  const tags = (c.can.length || c.cannot.length)
    ? `<div class="cast-tags">${c.can.length ? `<span class="yes">can ${esc(c.can.join(", "))}</span>` : ""}`
      + `${c.can.length && c.cannot.length ? " " : ""}`
      + `${c.cannot.length ? `<span class="no">cannot ${esc(c.cannot.join(", "))}</span>` : ""}</div>` : "";
  const body = sheet?.fields
    ? `<div class="cast-body">${sheet.fields}</div>`
    : sheet?.note
      ? `<p class="cast-note${sheet.bad ? " bad" : ""}">${esc(sheet.note)}</p>` : "";
  return `<section class="charcard-about" data-tid="charcard.cast-summary">`
    + `<p class="charcard-eyebrow">About ${esc(c.name)} — saved in the story</p>`
    + `${body}${tags}`
    + ((!sheet?.fields && !body && !tags)
      ? `<p class="charmd-placeholder">the authored sheet is a live-screen thing — this card only
          shows what its pill knew.</p>` : "")
    + `</section>`;
}

export function characterCardModalHtml() {
  const c = APP.charCard;
  if (!c) return "";
  const sheet = castCharacterSheet(c.name);
  const ctx = sceneContext(c.dir, c.scene);
  return modal({
    id: "charcard-backdrop", dataTid: "charcard.modal", ariaLabel: c.name, extraClass: "charcard",
    body: `<div class="iv-head"><h2>${esc(c.name)}</h2>${closeButton("charcard-close")}</div>`
      + (ctx ? sceneSectionHtml(c.name, ctx) : "")
      + aboutSectionHtml(c, sheet),
  });
}

export function wireCharacterCard(root) {
  const close = () => { APP.charCard = null; APP.modalWant = ""; APP.render(); };
  wireModalClose(root, { backdropId: "charcard-backdrop", closeId: "charcard-close", onClose: close });
}

// `dir` is carried but never shown -- on the read page it is the run's absolute path, which means
// nothing to a reader. It is here because finding the character's markdown file needs it. `scene`
// is the chapter number the pill was rendered for, when one was known -- the card's scene section
// resolves against it, and it travels the `&modal=` deep link the same way the name does.
const charScene = el => {
  const n = Number(el.dataset.charScene);
  return Number.isFinite(n) ? n : null;
};
function openCharCard(el) {
  const split = s => (s ? s.split("|").filter(Boolean) : []);
  APP.charCard = {
    name: el.dataset.charName, dir: el.dataset.charDir,
    can: split(el.dataset.charCan), cannot: split(el.dataset.charCannot),
    reach: split(el.dataset.charReach), scene: charScene(el),
  };
  // Tag the URL so a reload (or pasted link) reopens the same card; render()'s closing syncHash
  // writes it. This module must not import nav.js -- nav -> saved-runs -> shelf -> here would close
  // a cycle -- and need not: pages.js syncs the hash after every render.
  APP.modalWant = `character-card:${el.dataset.charName}`;
  APP.render();
}

/** Deep links: `&modal=character-card:<name>` on any route reopens the card for that character once
 *  a chip naming them is on screen. Called from render() just before the modals paint, so a chip
 *  found in the previous frame's DOM paints the card in the same pass. An unresolvable want stays
 *  pending across renders (the chips may still be loading) and simply never fires. */
export function settleModalWant() {
  if (!APP.modalWant || APP.charCard) return;
  const i = APP.modalWant.indexOf(":");
  const kind = i < 0 ? APP.modalWant : APP.modalWant.slice(0, i);
  const name = i < 0 ? "" : APP.modalWant.slice(i + 1);
  if (kind !== "character-card" || !name) { APP.modalWant = ""; return; }
  const chip = [...document.querySelectorAll(".chip[data-char-name]")]
    .find(c => c.dataset.charName.toLowerCase() === name.toLowerCase());
  if (!chip) return;
  const split = s => (s ? s.split("|").filter(Boolean) : []);
  APP.charCard = {
    name: chip.dataset.charName, dir: chip.dataset.charDir,
    can: split(chip.dataset.charCan), cannot: split(chip.dataset.charCannot),
    reach: split(chip.dataset.charReach), scene: charScene(chip),
  };
  APP.modalWant = "";
}

// Capture phase, and it stops there: a shelf card's pill sits inside a card that is itself
// clickable (open the story), so the pill must keep that click from ever reaching it, not merely
// outrun it.
document.addEventListener("click", e => {
  const chip = e.target.closest("[data-char-name]");
  if (!chip) return;
  e.stopPropagation();
  openCharCard(chip);
}, true);

document.addEventListener("keydown", e => {
  if ((e.key === "Enter" || e.key === " ") && e.target instanceof Element && e.target.matches("[data-char-name]")) {
    e.preventDefault();
    openCharCard(e.target);
  }
  // Escape is NOT handled here: chrome.js owns it centrally and closes the topmost of ALL modal
  // backdrops (interview, character card, run-ended). A second handler here would close the char
  // card, then let chrome.js close whatever sat beneath it on the same keypress.
});
