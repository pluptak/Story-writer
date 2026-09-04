import { esc, post, fmtRun, modelOptionsHtml, reasonOr, tid } from "./util.js";
import { APP, READV, runningReason } from "./state.js";
import { castChips } from "./shelf.js";
import { loadRun, loadStories } from "./saved-runs.js";
import { loadReader } from "./reader.js";
import { go } from "./nav.js";
import { prepareComparison, loadComparisonRuns } from "./compare.js";
import { paras } from "./blocks.js";
import { button, hint } from "./ui.js";

// ---- the story page ----------------------------------------------------------
// One story, a full page rather than a modal (`#/story?dir=...`, so a reload or bookmark lands back
// on it) -- this grew out of the play confirmation, with room for what it was scaffolded to become:
// a scene list (below) and a story editor. Reached only by clicking a shelf card; "back to shelf"
// is the only way out, same as before.

let chapterReq = 0;

/** The story's scenes, numbered -- scene N is chapter N, written or not (`card.chapters` says which
 *  exist on disk). `scene` is the legacy singular the shelf still reads. */
export const scenesOf = card =>
  card.scenes?.length ? card.scenes.map((s, i) => ({ ...s, n: i + 1 }))
  : card.scene ? [{ ...card.scene, n: 1 }] : [];

// The story's own default is preselected only once the server actually offers it (available,
// not necessarily resident) -- picking an
// unloaded model would just fail the run, so there is nothing to gain by defaulting to it.
function modelSelectHtml(s) {
  const def = s.defaultModel || "";
  const available = def && APP.modelIds.includes(def);
  const chosen = APP.storyModel || (available ? def : "");
  return `<select id="story-model" ${tid("story.model-select")} class="btn" title="model to play this story with">
    <option value=""${chosen ? "" : " selected"}>story default${def ? " · " + esc(def) : ""}</option>
    ${modelOptionsHtml(APP.modelIds, chosen)}
  </select>`;
}

/** The chapter after the last one written -- 1 when nothing is written yet. Shared by the scene
 *  list (which chapter gets the "next" tag) and the handoff row (which chapter it would prepare). */
export const nextChapterOf = chapters => Math.max(0, ...chapters) + 1;

/** "~700 words" plus an optional "pov X" suffix -- the length/pov formatting a scene card needs,
 *  shared with the handoff's proposed-chapter card (handoff-view.js). */
export const wordsPovHtml = scene => `~${scene.length ?? "?"} words${scene.pov ? " · pov " + esc(scene.pov) : ""}`;

/** `discardable` is set by the caller for the last authored scene when it is unwritten and not the
 *  only one -- the one an accepted-but-never-written chapter leaves behind (see nextChapterOf). */
function sceneRowHtml(scene, chapters, canWrite, why, discardable, beats) {
  const written = chapters.includes(scene.n);
  const open = APP.chapter?.dir === APP.storyDir && APP.chapter.n === scene.n;
  const next = !written && scene.n === nextChapterOf(chapters);
  const tag = written ? `<span class="tag written">written</span>`
            : next ? `<span class="tag next">next</span>` : "";
  const runWhy = runningReason();   // discard is blocked by a run in flight, not by picking-readiness
  const detail = sceneDetailHtml(scene, beats || []);
  return `<div class="cardwrap"><div class="scenerow" data-tid="story.scene-row" data-chapter="${scene.n}">
    <div class="sc-q">${esc(scene.question || "(no scene question)")}${tag}</div>
    <div class="sc-meta">chapter ${scene.n}${scene.place ? " · " + esc(scene.place) : ""} · ${wordsPovHtml(scene)}</div>
    ${detail}
    <button ${tid("story.write-btn")} class="btn${next ? " primary" : ""} scenewrite" data-chapter="${scene.n}"${canWrite ? "" : " disabled"} title="${esc(why)}">${written ? "rewrite" : "write"} chapter ${scene.n}</button>
    ${written ? `<button ${tid("story.read-btn")} class="btn chapterread" data-chapter="${scene.n}">${open ? "close" : "read"}</button>` : ""}
    ${discardable ? `<button ${tid("story.discard-btn")} class="btn danger scenediscard" data-chapter="${scene.n}"${runWhy ? " disabled" : ""} title="${esc(runWhy || "remove this unwritten chapter's scene from the story")}">discard chapter ${scene.n}</button>` : ""}
    ${open ? `<div class="prose" style="margin-top:12px">${paras(APP.chapter.text)}</div>` : ""}
    ${open && APP.chapterError ? `<div class="said bad">${esc(APP.chapterError)}</div>` : ""}
  </div></div>`;
}

/** The scene's own detail: who is here, the reach the scene grants, and any world beat aimed at this
 *  chapter, rendered as the percentage of the scene it fires at. The beat's HOLD only -- its
 *  memories are the interview's to judge and a run's to hide inside a character; a map the author
 *  browses casually is deliberately not a third place to read them. Voided beats still show -- they
 *  were authored -- but read as struck from the plan. */
function sceneDetailHtml(scene, beats) {
  const roster = (scene.roster || []).length
    ? `<div class="mapfield"><span>who is here</span>
        <div class="mapchips">${scene.roster.map(n => `<span class="mchip">${esc(n)}</span>`).join("")}</div></div>`
    : "";
  const reachRows = Object.entries(scene.reach || {}).filter(([, g]) => (g || []).length);
  const reach = reachRows.length
    ? `<div class="mapfield"><span>reach here</span>
        <div class="mapchips">${reachRows.map(([who, grants]) => (grants || []).map(g => {
          const at = g.indexOf("::");
          const thing = (at >= 0 ? g.slice(0, at) : g).trim();
          const meaning = at >= 0 ? g.slice(at + 2).trim() : "";
          return `<span class="mchip"${meaning ? ` title="${esc(meaning)}"` : ""}>${esc(who)} · ${esc(thing)}${meaning ? ` — ${esc(meaning)}` : ""}</span>`;
        }).join("")).join("")}</div></div>`
    : "";
  const mine = beats.filter(b => b.chapter === scene.n);
  const beatRows = mine.length
    ? `<div class="mapfield"><span>world events</span>
        <div class="mapbeats">${mine.map(b => `<div class="mapbeat${b.state === "void" ? " voided" : ""}">
          <span class="when">world event · ${b.state === "void" ? "voided · " : ""}${Math.round((Number(b.at) || 0) * 100)}% through the scene</span>
          <span class="hold">${esc(b.hold)}</span>
        </div>`).join("")}</div></div>`
    : "";
  const body = roster + reach + beatRows;
  return body ? `<div class="map-extra">${body}</div>` : "";
}

/** Runs filed under the chapter they wrote, ascending to match the scene list above, newest first
 *  inside each group. A run retained from before chapter numbers were logged has none and lands in
 *  its own group at the end. One group is no grouping, so a single-chapter story keeps the flat
 *  list it always had. */
function runsListHtml(s) {
  if (!s.runs?.length) return hint(`no retained runs yet`);
  const btn = r => {
    const current = READV.dir === s.dir && READV.id === r.id;
    return `<button ${tid("story.run-btn")} class="btn runbtn${current ? " current" : ""}" data-run="${esc(r.id)}"
         >${current ? "reading · " : "read · "}${esc(fmtRun(r))}</button>`;
  };
  const groups = new Map();
  for (const r of s.runs) {
    const k = typeof r.chapter === "number" ? r.chapter : Infinity;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const keys = [...groups.keys()].sort((a, b) => a - b);
  if (keys.length === 1) return `<div class="runs">${s.runs.map(btn).join("")}</div>`;
  return keys.map(k => `<div class="rungroup">
      <span class="hint">${k === Infinity ? "unattributed" : `chapter ${k}`}</span>
      <div class="runs">${groups.get(k).map(btn).join("")}</div>
    </div>`).join("");
}

/** The handoff prepares the chapter after the last one written, so a story with nothing written has
 *  nothing for it to read and the engine refuses. */
function handoffRowHtml(s) {
  if (!s.chapters?.length) return "";
  const mine = APP.handoff.active && APP.handoff.dir === s.dir;
  const n = mine ? APP.handoff.chapter : nextChapterOf(s.chapters);
  const why = runningReason();
  return `<div class="divider"><span>next chapter</span></div>
    <div class="row">
      ${button({ label: `${mine ? "continue preparing" : "prepare"} chapter ${n}`, id: "story-handoff", tidName: "story.handoff-btn", disabled: !!why, title: why })}
      <span class="hint">the architect re-authors the cast from the chapters already written</span>
    </div>`;
}

export function storyPageHtml() {
  if (!APP.storyDir) return "";
  if (!APP.stories) return `<section class="picker"><h2>…</h2><p class="sub">reading the shelf…</p></section>`;
  const s = (APP.stories || []).find(x => x.dir === APP.storyDir);
  if (!s) return `<section class="picker"><h2>Not found</h2>
    <p class="sub">this story is no longer on the shelf.</p>
    <div class="btns" style="margin-top:14px">${button({ label: "back to shelf", id: "story-back" })}</div>
  </section>`;

  if (!s.ok) return `<section class="picker story">
    <h2>${esc(s.name)}</h2>
    <div class="said bad">does not load — ${esc(s.error || "unknown error")}</div>
    ${(s.warnings || []).map(w => `<div class="prob">⚠ ${esc(w)}</div>`).join("")}
    <div class="btns" style="margin-top:14px">${button({ label: "back to shelf", id: "story-back" })}</div>
  </section>`;

  // The client-side mirror of what /select and /model would refuse anyway (server.ts, run-control-
  // routes.ts) -- said here so the button explains itself instead of round-tripping.
  const why = runningReason()
            || (!APP.session.picking ? "not ready to start a run right now"
              : APP.picked ? "starting…" : "");
  const canWrite = !why;

  return `<section class="picker story">
    <h2>${esc(s.name)}</h2>
    <p class="premise">${esc(s.premise || "")}</p>
    <div class="row">${castChips(s.characters, s.dir)}</div>
    ${s.writerStyle ? `<div class="row" style="margin-top:8px"><span class="hint">voice</span><span class="premise">${esc(s.writerStyle)}</span></div>` : ""}

    <div class="row" style="margin-top:12px"><span class="hint">model</span>${modelSelectHtml(s)}</div>
    ${APP.storyError ? `<div class="said bad">${esc(APP.storyError)}</div>` : ""}
    ${APP.runError ? `<div class="said bad">${esc(APP.runError)}</div>` : ""}
    ${(s.warnings || []).map(w => `<div class="prob">⚠ ${esc(w)}</div>`).join("")}

    <div class="divider"><span>scenes</span></div>
    <div class="cards">${scenesOf(s).map((sc, i, arr) =>
      sceneRowHtml(sc, s.chapters || [], canWrite, why,
        i === arr.length - 1 && arr.length > 1 && !(s.chapters || []).includes(sc.n),
        s.timeline || [])).join("")}</div>

    ${handoffRowHtml(s)}

    <div class="divider"><span>previous runs</span></div>
    ${runsListHtml(s)}

    <div class="btns" style="margin-top:18px">
      ${button({ label: "edit story", id: "story-edit", tidName: "story.edit-btn" })}
      ${(s.chapters?.length) ? button({ label: "read story", id: "story-read-story", tidName: "story.read-story-btn" }) : ""}
      ${(s.runs?.length >= 2) ? button({ label: "compare runs", id: "story-compare", tidName: "story.compare-btn" }) : ""}
      <span class="spacer"></span>
      ${button({ label: "back to shelf", id: "story-back", tidName: "story.back-btn" })}
    </div>
  </section>`;
}

export function wireStoryPage(page) {
  const back = page.querySelector("#story-back");
  if (back) back.addEventListener("click", () => { APP.storyDir = ""; APP.chapter = null; go("shelf"); });

  const model = page.querySelector("#story-model");
  if (model) model.addEventListener("change", () => { APP.storyModel = model.value; });

  for (const b of page.querySelectorAll(".scenewrite"))
    b.addEventListener("click", () => playChosen(APP.storyDir, APP.storyModel, Number(b.dataset.chapter)));

  for (const b of page.querySelectorAll(".scenediscard"))
    b.addEventListener("click", () => discardChapter(APP.storyDir, Number(b.dataset.chapter)));

  // A slow earlier read must never overwrite a faster later click's chapter -- last click wins.
  // Module-level: wireStoryPage re-runs on every render, so a closure-scoped token would reset
  // under a fetch still in flight and let the stale response through.
  for (const b of page.querySelectorAll(".chapterread"))
    b.addEventListener("click", async () => {
      const n = Number(b.dataset.chapter), dir = APP.storyDir;
      const req = ++chapterReq;
      if (APP.chapter?.dir === dir && APP.chapter.n === n) {
        APP.chapter = null; APP.chapterError = ""; APP.render(); return;
      }
      APP.chapterError = "";
      try {
        const r = await fetch(`/chapter?dir=${encodeURIComponent(dir)}&n=${n}`);
        if (req !== chapterReq) return;
        if (!r.ok) throw 0;
        APP.chapter = { dir, n, text: await r.text() };
      } catch {
        if (req !== chapterReq) return;
        APP.chapter = { dir, n, text: "" }; APP.chapterError = "that chapter would not load";
      }
      APP.render();
    });

  const handoff = page.querySelector("#story-handoff");
  if (handoff) handoff.addEventListener("click", () => {
    APP.handoffDir = APP.storyDir;
    // Preselect the story's own model over the architect default -- it's the one already known to
    // load, whereas the architect default (defaults.json, story-independent) may not be.
    const def = (APP.stories || []).find(s => s.dir === APP.storyDir)?.defaultModel || "";
    APP.handoffModel = (def && APP.modelIds.includes(def)) ? def : "";
    go("handoff");
  });

  const edit = page.querySelector("#story-edit");
  if (edit) edit.addEventListener("click", () => { APP.editDir = APP.storyDir; go("edit"); });

  const readStory = page.querySelector("#story-read-story");
  if (readStory) readStory.addEventListener("click", () => {
    go("readstory"); loadReader(APP.storyDir);
  });

  const compare = page.querySelector("#story-compare");
  if (compare) compare.addEventListener("click", () => {
    prepareComparison(APP.storyDir);
    go("compare");
    loadComparisonRuns();
  });

  for (const b of page.querySelectorAll(".runbtn"))
    b.addEventListener("click", async () => {
      b.disabled = true;
      const ok = await loadRun(APP.storyDir, b.dataset.run);
      // null = superseded by a newer click; that click owns the read tab, so say and do nothing
      if (ok === false) { APP.storyError = "could not load that run"; APP.render(); return; }
      if (ok) { APP.storyError = ""; go("read"); }
    });
}

/** Play needs the model set before /select, not after -- a fresh run reads `LIVE.modelOverride` the
 *  moment it loads the story. Sent unconditionally (even blank) so a leftover override from a
 *  previous story's run never silently rides along into this one. */
async function playChosen(dir, model, chapter) {
  // A deliberate rerun: confirm an overwrite or a skip ahead before asking the server to allow it,
  // and send `replace` only for the deviation actually confirmed. Sending it on every run would put
  // the whole durability guard in the browser, resting on a story list that can be stale -- the one
  // case that would overwrite a chapter with no dialog shown. The handoff's start button does not
  // go through here -- it sends no replace, and is refused if its prepared chapter somehow collides
  // with what is on disk.
  const replace = authorizeChapterRun(chapter);
  if (replace === null) return;
  if (APP.picked) return;
  const mj = await post("/model", { model }, false);
  if (!mj || mj.ok === false) { APP.storyError = reasonOr(mj, "could not set that model"); APP.render(); return; }
  await choose({ dir, chapter, replace });
}

/** The two confirms behind a deliberate rerun: rewriting a written chapter, or skipping past an
 *  unwritten one. `null` means the owner said no; `true` means they confirmed a deviation and the
 *  server may allow it; `false` means there was nothing to confirm, and the server's own guard stays
 *  in force -- which catches a story list this page read before the chapter existed. */
function authorizeChapterRun(n) {
  const s = (APP.stories || []).find(x => x.dir === APP.storyDir);
  const written = s?.chapters || [];
  if (written.includes(n))
    return confirm(`Rewrite chapter ${n}? The new run replaces the chapter file on disk.`) ? true : null;
  if (n > 1 && !written.includes(n - 1))
    return confirm(`Chapter ${n - 1} has never been written. Skip ahead to chapter ${n} anyway?`) ? true : null;
  return false;
}

/** Remove an accepted-but-unwritten chapter's scene from story.json. Only offered for the last
 *  scene while unwritten (sceneRowHtml), and the server re-checks all of that -- nothing written is
 *  touched, so a re-prepare puts the chapter back. */
async function discardChapter(dir, n) {
  if (!confirm(`Discard chapter ${n}? Its scene is removed from the story. Nothing already written is affected, and you can prepare the chapter again.`)) return;
  APP.storyError = "";
  const j = await post("/story/discard", { dir, n }, false);
  if (!j || j.ok === false) { APP.storyError = reasonOr(j, "could not discard that chapter"); APP.render(); return; }
  if (APP.chapter?.dir === dir && APP.chapter.n === n) APP.chapter = null;   // a discarded scene has nothing to keep open
  await loadStories();
  APP.render();
}

export async function choose(payload) {
  if (APP.picked) return;                       // a double-click is one choice, not two
  APP.picked = payload.dir;
  APP.storyError = ""; APP.runError = "";
  APP.render();
  const j = await post("/select", payload, false);
  if (!j || j.ok === false) { APP.picked = ""; APP.storyError = reasonOr(j, "that did not go through"); APP.render(); return; }
  go("live");
}
