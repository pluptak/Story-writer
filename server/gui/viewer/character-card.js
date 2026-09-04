import { esc, wireBackdropClose, tid } from "./util.js";
import { APP } from "./state.js";
import { castCharacterSheet } from "./cast-sheet.js";
import { modal, closeButton } from "./ui.js";

// ---- the character card -----------------------------------------------------
// A pill (header cast, a shelf card, or the story page) opens this modal for the character it
// names. It always shows what the pill itself knew (can/cannot/reach); on the live screen the
// authored sheet fetched from /cast rides under it -- persona, knows, goal, belief, impulse, voice
// and the per-scene reach the pill cannot name. Elsewhere the pill's own row is all there is.

/** A clickable pill for one character, used by the header, the shelf cards and the story page. A
 *  `<span role="button">`, not a `<button>`, because the shelf's cast row sits inside a card that
 *  is itself a `<button>` -- nesting real buttons breaks the outer one. */
export function charChip(c, dir) {
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
            data-char-reach="${esc(reach.join("|"))}">
    <b>${esc(c.name)}</b>${bits.length ? " " + bits.join(" ") : ""}</span>`;
}

export function characterCardModalHtml() {
  const c = APP.charCard;
  if (!c) return "";
  const sheet = castCharacterSheet(c.name);
  const body = sheet?.fields
    ? `<div class="cast-body" data-tid="charcard.cast-summary">${sheet.fields}</div>`
    : sheet?.note
      ? `<p class="cast-note${sheet.bad ? " bad" : ""}">${esc(sheet.note)}</p>`
      : `<p class="charmd-placeholder">the authored sheet is a live-screen thing — this card only
          shows what its pill knew.</p>`;
  return modal({
    id: "charcard-backdrop", dataTid: "charcard.modal", ariaLabel: c.name, extraClass: "charcard",
    body: `<div class="iv-head"><h2>${esc(c.name)}</h2>${closeButton("charcard-close")}</div>
      ${(c.can.length || c.cannot.length || c.reach.length) ? `<div class="row">
        ${c.can.length ? `<span class="yes">can also ${esc(c.can.join(", "))}</span>` : ""}
        ${c.reach.length ? `<span class="reach" title="granted by the scene they are standing in, not intrinsic">reach ${esc(c.reach.join(", "))}</span>` : ""}
        ${c.cannot.length ? `<span class="no">cannot ${esc(c.cannot.join(", "))}</span>` : ""}</div>` : ""}
      ${body}`,
  });
}

export function wireCharacterCard(root) {
  const close = () => { APP.charCard = null; APP.modalWant = ""; APP.render(); };
  wireBackdropClose(root, "charcard-backdrop", close);
  const btn = root.querySelector("#charcard-close");
  if (btn) btn.addEventListener("click", close);
}

// `dir` is carried but never shown -- on the read page it is the run's absolute path, which means
// nothing to a reader. It is here because finding the character's markdown file needs it.
function openCharCard(el) {
  const split = s => (s ? s.split("|").filter(Boolean) : []);
  APP.charCard = {
    name: el.dataset.charName, dir: el.dataset.charDir,
    can: split(el.dataset.charCan), cannot: split(el.dataset.charCannot),
    reach: split(el.dataset.charReach),
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
    reach: split(chip.dataset.charReach),
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
