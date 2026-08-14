import { esc } from "./util.js";
import { APP } from "./state.js";

// ---- the shelf ------------------------------------------------------------
// Shown only while the session is parked waiting for a pick -- it is now a page of its own, not a
// panel stacked over whatever scene was already on screen, so there is no longer a finished scene
// for it to crowd out and nothing here to dismiss.
export const castChips = list => (list || []).map(c => {
  const bits = [];
  if (c.can?.length) bits.push(`<span class="yes">+${esc(c.can.join(", "))}</span>`);
  if (c.cannot?.length) bits.push(`<span class="no">no ${esc(c.cannot.join(", "))}</span>`);
  return `<span class="chip"><b>${esc(c.name)}</b>${bits.length ? " " + bits.join(" ") : ""}</span>`;
}).join("");

export function pickerHtml() {
  if (!APP.stories) return `<section class="picker"><h2>Choose a story</h2>
    <p class="sub">reading the shelf…</p></section>`;

  const cards = APP.stories.map(s => {
    // A story that does not load says so here, and cannot be chosen -- the same pre-flight the CLI
    // runs, so the card cannot disagree with what a run would do.
    const dead = !s.ok || !!APP.picked;
    const card = `<button class="card" data-dir="${esc(s.dir)}"${dead ? " disabled" : ""}>
      <div class="name">${esc(s.name)}</div>
      ${s.ok ? `<p class="q">${esc(s.scene?.question || "(no scene question)")}</p>
                <p class="pre">${esc(s.premise || "")}</p>
                <div class="row">${castChips(s.characters)}<span class="meta">~${s.scene?.length ?? "?"} words
                  · ${s.maxSteps ?? "?"} steps${s.scene?.pov ? " · pov " + esc(s.scene.pov) : ""}</span></div>`
              : `<div class="bad">does not load — ${esc(s.error || "unknown error")}</div>`}
      ${(s.warnings || []).map(w => `<div class="warn">⚠ ${esc(w)}</div>`).join("")}
    </button>`;
    return `<div class="cardwrap">${card}</div>`;
  }).join("");

  return `<section class="picker">
    <h2>Choose a story</h2>
    <p class="sub">${APP.picked ? "starting…" : "pick one to see what it's about"}</p>
    <div class="cards">${cards}
      <button class="card new" data-new="1"${APP.picked ? " disabled" : ""}>
        <div class="name">${APP.scaffold.active ? "continue new story…" : "new story…"}</div>
        <p class="q">${APP.scaffold.active ? `back to "${esc(APP.scaffold.idea || "")}"` : "describe an idea and have one built"}</p>
      </button>
    </div>
  </section>`;
}

export function wirePicker(page) {
  for (const b of page.querySelectorAll(".card[data-dir]"))
    b.addEventListener("click", () => { if (!APP.picked) { APP.confirmDir = b.dataset.dir; APP.confirmError = ""; APP.render(); } });
  for (const b of page.querySelectorAll(".card[data-new]"))
    b.addEventListener("click", () => {
      // Already going server-side (one ScaffoldSession, GUI-SPEC §5.1) -- this reopens the modal
      // rather than starting a second interview.
      if (APP.scaffold.active) APP.ivHidden = false; else APP.ideaOpen = true;
      APP.render();
    });
}
