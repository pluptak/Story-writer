import { esc, wireBackdropClose } from "./util.js";
import { APP } from "./state.js";

// ---- the character card -----------------------------------------------------
// A pill (header cast, a shelf card, or the story page) opens this modal for the character it
// names. It currently shows only what the pill itself already knew (can/cannot); reading the
// character's own markdown file is engine work for a later block.

/** A clickable pill for one character, used by the header, the shelf cards and the story page. It
 *  is a `<span role="button">`, not a `<button>`, because the shelf's cast row sits inside a card
 *  that is itself a `<button>` -- nesting real buttons breaks the outer one. */
export function charChip(c, dir) {
  const can = c.skills || [];
  const cannot = c.restrictions || [];
  const bits = [];
  if (can.length) bits.push(`<span class="yes">+${esc(can.join(", "))}</span>`);
  if (cannot.length) bits.push(`<span class="no">no ${esc(cannot.join(", "))}</span>`);
  return `<span class="chip" role="button" tabindex="0"
            data-char-name="${esc(c.name)}" data-char-dir="${esc(dir || "")}"
            data-char-can="${esc(can.join("|"))}" data-char-cannot="${esc(cannot.join("|"))}">
    <b>${esc(c.name)}</b>${bits.length ? " " + bits.join(" ") : ""}</span>`;
}

export function characterCardModalHtml() {
  const c = APP.charCard;
  if (!c) return "";
  return `<div class="modal-backdrop" id="charcard-backdrop" role="dialog" aria-modal="true"
               aria-label="${esc(c.name)}">
    <section class="picker iv charcard">
      <div class="iv-head"><h2>${esc(c.name)}</h2>
        <button class="btn" id="charcard-close" title="close" aria-label="close">×</button></div>
      ${(c.can.length || c.cannot.length) ? `<div class="row">
        ${c.can.length ? `<span class="yes">can also ${esc(c.can.join(", "))}</span>` : ""}
        ${c.cannot.length ? `<span class="no">cannot ${esc(c.cannot.join(", "))}</span>` : ""}</div>` : ""}
      <p class="charmd-placeholder">the character sheet itself isn't wired up yet — this modal only
        shows what its pill already knew.</p>
    </section>
  </div>`;
}

export function wireCharacterCard(root) {
  const close = () => { APP.charCard = null; APP.render(); };
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
  };
  APP.render();
}

// Capture phase, and it stops there: a shelf card's pill sits inside a card that is itself
// clickable (open the story), so the pill has to keep that click from ever reaching it rather than
// merely outrunning it.
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
  } else if (e.key === "Escape") {
    // Topmost first -- the character card can be opened on top of the run-ended modal (its own pill
    // is right there in the header), and one Escape should only ever close what is actually on top.
    if (APP.charCard) { APP.charCard = null; APP.render(); }
    else if (APP.runEnded) { APP.runEnded = null; APP.render(); }
  }
});
