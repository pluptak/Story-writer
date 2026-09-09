import { esc, tid } from "./util.js";
import { APP } from "./state.js";
import { charChip } from "./character-card.js";
import { button, hint, divider, pageTitle, storyNote } from "./ui.js";
import { scaffoldLifecycle } from "./hud.js";

// ---- the shelf ------------------------------------------------------------
// The writer's project library: one card per story, ordered for decisions --
// title, premise, where the story stands, how far along it is, when it was
// last touched, who is in it, and only the warnings the author can act on.
// A card doesn't play a story, it opens one: browsing is always allowed,
// even mid-run -- only *starting* a run is refused, and that refusal lives
// on the story page, not here.
export const castChips = (list, dir, scene = null, chat = null) =>
  (list || []).map(c => charChip(c, dir, scene, chat)).join("");

// Mirrors story-page.js's scenesOf/nextChapterOf without importing them:
// story-page.js already imports shelf.js (castChips), so importing it back
// would close a module cycle.
const scenesOf = card =>
  card.scenes?.length ? card.scenes.map((s, i) => ({ ...s, n: i + 1 }))
  : card.scene ? [{ ...card.scene, n: 1 }] : [];
const nextChapterOf = chapters => Math.max(0, ...chapters) + 1;

// Provider-environment warnings (model availability, context windows, model
// switching) are decided at run time on the story page, where the model is
// chosen -- on the shelf they would bury every card in setup chatter. What
// stays is what the author can fix in the story itself, via Edit: scene and
// character problems. Exported: the story page reuses the same split, showing
// the environment half collapsed instead of dropping it.
const ENV_WARNING_RE = /model check skipped|not available in|tokens of context|distinct models across/i;
export const isEnvWarning = w => ENV_WARNING_RE.test(String(w || ""));
const actionableWarnings = s => (s.warnings || []).filter(w => !isEnvWarning(w));

/** Newest saved run first (the card's runs already arrive newest-first), as
 *  plain reading words: "today", "yesterday", "N days ago", else the date. */
function timeAgo(mtimeMs) {
  const days = Math.floor((Date.now() - mtimeMs) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(mtimeMs).toLocaleDateString();
}

/** Where the story stands, in one line: the chapter that would be written
 *  next against the chapters planned, with its place when the plan names
 *  one. Falls back to bare counts when the plan carries no scenes. */
function statusHtml(s) {
  const scenes = scenesOf(s);
  const written = (s.chapters || []).length;
  if (!scenes.length) {
    return written
      ? `<div class="shelf-status" data-tid="shelf.status">${written} ${written === 1 ? "chapter" : "chapters"} written</div>`
      : "";
  }
  const total = scenes.length;
  if (written >= total) {
    return `<div class="shelf-status" data-tid="shelf.status">Complete · ${written} of ${total} chapters</div>`
      + `<div class="bar" role="progressbar" aria-label="${written} of ${total} chapters written">`
      + `<i style="width:100%"></i></div>`;
  }
  const next = scenes.find(sc => sc.n === nextChapterOf(s.chapters || [])) || scenes[written];
  const where = next?.place ? ` · ${esc(next.place)}` : "";
  const lead = written === 0 ? "Ready to begin" : `Chapter ${next?.n ?? written + 1} of ${total}`;
  return `<div class="shelf-status" data-tid="shelf.status">${esc(lead)}${where}</div>`
    + (next?.question ? `<p class="q">Next: ${esc(next.question)}</p>` : "")
    + `<div class="bar" role="progressbar" aria-label="${written} of ${total} chapters written">`
    + `<i style="width:${Math.round(written / total * 100)}%"></i></div>`;
}

/** When the story was last touched, off the newest saved run -- the only
 *  activity signal the card carries. Chapters without a saved run (pruned
 *  logs) and untouched stories say so plainly instead of showing a date. */
function activityHtml(s) {
  const latest = (s.runs || [])[0]?.mtimeMs;
  const text = latest ? `Last run ${timeAgo(latest)}`
    : (s.chapters || []).length ? "Chapters written · no history yet"
    : "Not started yet";
  return `<div class="shelf-meta" data-tid="shelf.activity">${esc(text)}</div>`;
}

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
const RESUME_GATE_LABELS = { story: "direction", cast: "cast", settings: "style",
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
    : complete || (s.mode === "oneshot" && s.haveStory) ? "approve the Blueprint →"
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
    const dis = dead ? " disabled" : "";
    const actionable = actionableWarnings(s);
    const canRead = s.ok && (s.chapters || []).length > 0;
    const actions = s.ok
      ? `<div class="shelf-actions">`
        + `${button({ label: APP.picked ? "starting…" : "Continue writing →", tidName: "shelf.continue",
            variant: "primary", disabled: !!APP.picked, extraClass: "shelf-open" })}`
        + (canRead ? `${button({ label: "Read", tidName: "shelf.read", extraClass: "shelf-read" })}` : "")
        + `${button({ label: "Edit", tidName: "shelf.edit", extraClass: "shelf-edit" })}`
        + `</div>`
      : "";
    // The heading opens the story map -- the same destination as Continue
    // writing, which is that page: the one explicit primary plus a clickable
    // title, never two buttons to the same place.
    const card = `<article ${tid("shelf.story-card")} class="card shelf-card" data-dir="${esc(s.dir)}">
      <button class="shelf-title" data-open${dis}><span class="name">${esc(s.title || s.name)}</span></button>
      ${s.ok ? `${s.premise ? `<p class="pre" title="${esc(s.premise)}">${esc(s.premise)}</p>` : ""}
                ${statusHtml(s)}
                ${activityHtml(s)}
                <div class="row">${castChips(s.characters, s.dir)}</div>`
              : storyNote({ meaning: "This story can't be loaded, so nothing can be written from it.",
                  detail: esc(s.error || "unknown error") })}
      ${actionable.map(w => `<div class="warn">⚠ ${esc(w)}</div>`).join("")}
      ${actions}
    </article>`;
    return `<div class="cardwrap" data-dir="${esc(s.dir)}">${card}</div>`;
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
    ? divider("your stories")
    : hint(`no stories on the shelf yet — start one above`, { style: "text-align:center;margin:14px 0 0" });

  return `<section class="picker" data-tid="shelf.picker">
    ${pageTitle({ eyebrow: "library", title: "My stories",
      lede: APP.picked ? "starting…" : "pick one up where you left off" })}
    ${newCard}
    ${catalogCard}
    ${dividerLine}
    <div class="cards">${cards}</div>
  </section>`;
}

/** `openStory`/`openCatalog`/`openRead`/`openEdit` are injected (pages.js, which owns navigation)
 *  rather than imported -- shelf.js sits underneath nav.js in the module graph
 *  (nav.js -> saved-runs.js -> here, for castChips), so importing nav.js or reader.js back from
 *  here would close a cycle. */
export function wirePicker(page, openStory, openNew = null, openCatalog = null, openRead = null, openEdit = null) {
  const dirOf = b => b.closest(".cardwrap")?.dataset.dir || "";
  const open = dir => { if (!APP.picked && dir) {
    APP.storyDir = dir; APP.storyModel = ""; APP.storyError = ""; APP.runError = ""; openStory();
  } };
  // The title and the Continue button both open the story map -- the title
  // carries data-open, the Continue button its shelf-open class (ui.js's
  // button() kit names no data attributes).
  for (const b of page.querySelectorAll("[data-open], .shelf-open"))
    b.addEventListener("click", () => open(dirOf(b)));
  for (const b of page.querySelectorAll(".shelf-read"))
    b.addEventListener("click", () => { const dir = dirOf(b); if (dir && openRead) openRead(dir); });
  for (const b of page.querySelectorAll(".shelf-edit"))
    b.addEventListener("click", () => { const dir = dirOf(b); if (dir && openEdit) openEdit(dir); });
  for (const b of page.querySelectorAll(".card[data-new]"))
    // Opens the scaffold page (`openNew`, injected -- importing nav.js here would close a module
    // cycle). One ScaffoldSession lives on the server (GUI-SPEC §5.1), so a session already running
    // is continued there rather than started again; the card relabels itself to say so.
    b.addEventListener("click", () => { if (openNew) openNew(); });
  for (const b of page.querySelectorAll(".card[data-catalog]"))
    // Opens the catalog page (`openCatalog`, injected).
    b.addEventListener("click", () => { if (openCatalog) openCatalog(); });
}
