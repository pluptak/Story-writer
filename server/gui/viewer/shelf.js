import { esc, tid } from "./util.js";
import { APP } from "./state.js";
import { charChip } from "./character-card.js";
import { hint, divider, pageTitle } from "./ui.js";
import { scaffoldLifecycle } from "./hud.js";

// ---- the shelf ------------------------------------------------------------
// The hub: reachable any time an engine is attached, including mid-run -- browsing is always
// allowed, only *starting* a run is refused, and that refusal lives on the story page now, not
// here. A card doesn't play a story, it opens one.
export const castChips = (list, dir) => (list || []).map(c => charChip(c, dir)).join("");

// ---- architect resume -------------------------------------------------------
// A live scaffold session is server state, so leaving it (shelf, catalog, story page)
// never loses progress — but returning to a bare "continue…" forces the author to
// reconstruct it. The resume panel derives everything below from the published
// snapshot: current and completed stages, unresolved decisions, the latest Blueprint,
// validation status, and the next action. No second state machine, no new fields.
// The blocking-count pattern mirrors interview.js FINDING_RULES' blocking bucket, which
// owns the canonical map — shelf.js only needs the count, and importing interview.js
// here would close a module cycle (nav.js -> saved-runs.js -> shelf.js).
const RESUME_GATES = ["story", "cast", "settings", "technical", "scene", "world"];
const RESUME_GATE_LABELS = { story: "direction", cast: "cast", settings: "voice",
  technical: "run shape", scene: "scene 1", world: "world events" };
const RESUME_BLOCKING_RE = /^(no title|no premise)|no characters at all|has no question|came back as text rather than an object/i;

const resumeComplete = s =>
  !!s.last && s.last.kind === "nothing" && /checklist is complete/.test(s.last.why || "");

function resumeHtml(s) {
  const spec = s.spec || {};
  const step = scaffoldLifecycle();
  const complete = resumeComplete(s);
  const gateIdx = RESUME_GATES.indexOf(s.gate || "story");
  const done = s.mode === "oneshot"
    ? ((complete || s.haveStory) ? ["proposal"] : [])
    : complete ? [...RESUME_GATES] : RESUME_GATES.slice(0, Math.max(0, gateIdx));
  const flags = s.problems || [];
  const blocking = flags.filter(p => RESUME_BLOCKING_RE.test(String(p))).length;
  const names = (spec.characters || []).map(c => c.name).filter(Boolean);
  const q1 = spec.scenes?.[0]?.question || spec.scene?.question || "";
  const short = t => { const v = String(t || "").trim(); return v.length > 140 ? v.slice(0, 140) + "…" : v; };
  // Unresolved, in the order the interview itself would demand them.
  const missing = s.mode === "oneshot" ? "" : {
    story: spec.title?.trim() || spec.premise?.trim() ? "" : "a title or premise",
    cast: names.length ? "" : "at least one character",
    settings: spec.writerStyle?.trim() ? "" : "the house style",
    technical: "",
    scene: q1.trim() ? "" : "scene 1's dramatic question",
    world: "",
  }[s.gate || "story"];
  const unresolved = s.pendingAsk ? `answer: “${short(s.pendingAsk)}”`
    : s.last?.kind === "blocked" ? "the cast gate's judgement — refine or overrule"
    : missing || "";
  const next = s.busy ? "the architect is working…"
    : s.pendingAsk ? "answer the architect's question →"
    : s.last?.kind === "blocked" ? "refine the cast — or approve again to overrule →"
    : (s.needsFolder || APP.folderOpen) ? "name the folder to write story.json →"
    : complete || (s.mode === "oneshot" && s.haveStory) ? "approve the blueprint →"
    : blocking ? `fix ${blocking} blocking flag${blocking === 1 ? "" : "s"} →`
    : s.mode === "oneshot" ? "continue to review →"
    : `accept the ${RESUME_GATE_LABELS[s.gate || "story"] || "stage"} & continue →`;
  const row = (k, v) => v
    ? `<div class="resume-row"><span>${k}</span><span>${esc(v)}</span></div>` : "";
  return `<div class="resume" data-tid="shelf.resume">`
    + row("now", `architect · ${step}`)
    + row("done", done.length ? done.map(g => RESUME_GATE_LABELS[g] || g).join(" · ") : "nothing approved yet")
    + row("unresolved", unresolved || "nothing outstanding")
    + row("blueprint", short(spec.title ? `${spec.title} — ${names.join(", ") || "no cast yet"}` : names.join(", ")) || "not yet proposed")
    + row("validation", flags.length ? `${flags.length} flag${flags.length === 1 ? "" : "s"}${blocking ? ` · ${blocking} blocking` : ""}` : "checks pass")
    + `<div class="resume-next">${esc(next)}</div></div>`;
}

export function pickerHtml() {
  if (!APP.stories) return `<section class="picker" data-tid="shelf.picker">`
    + pageTitle({ eyebrow: "shelf", title: "Choose a story", lede: "reading the shelf…" })
    + `</section>`;

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
    ${APP.scaffold.active ? resumeHtml(APP.scaffold) : ""}
  </button>`;

  const catalogCard = `<button ${tid("shelf.catalog-card")} class="card new" data-catalog="1"${APP.picked ? " disabled" : ""}>
    <div class="name">library of characters</div>
    <p class="q">reusable characters outside any story</p>
  </button>`;

  const dividerLine = cards
    ? divider("or pick an existing one")
    : hint(`no stories on the shelf yet — start one above`, { style: "text-align:center;margin:14px 0 0" });

  return `<section class="picker" data-tid="shelf.picker">
    ${pageTitle({ eyebrow: "shelf", title: "Choose a story",
      lede: APP.picked ? "starting…" : "pick one to see what it's about" })}
    ${newCard}
    ${catalogCard}
    ${dividerLine}
    <div class="cards">${cards}</div>
  </section>`;
}

/** `openStory` and `openCatalog` are injected (pages.js, which owns navigation) rather than imported
 *  -- shelf.js sits underneath nav.js in the module graph (nav.js -> saved-runs.js -> here, for castChips),
 *  so importing nav.js back from here would close a cycle. */
export function wirePicker(page, openStory, openNew = null, openCatalog = null) {
  for (const b of page.querySelectorAll(".card[data-dir]"))
    b.addEventListener("click", () => { if (!APP.picked) {
      APP.storyDir = b.dataset.dir; APP.storyModel = ""; APP.storyError = ""; APP.runError = ""; openStory();
    } });
  for (const b of page.querySelectorAll(".card[data-new]"))
    // Opens the scaffold page (`openNew`, injected -- importing nav.js here would close a module
    // cycle). One ScaffoldSession lives on the server (GUI-SPEC §5.1), so a session already running
    // is continued there rather than started again; the card relabels itself to say so.
    b.addEventListener("click", () => { if (openNew) openNew(); });
  for (const b of page.querySelectorAll(".card[data-catalog]"))
    // Opens the catalog page (`openCatalog`, injected).
    b.addEventListener("click", () => { if (openCatalog) openCatalog(); });
}
