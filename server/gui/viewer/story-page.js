import { esc, post, fmtRun, modelOptionsHtml, reasonOr } from "./util.js";
import { APP, READV, runningReason } from "./state.js";
import { castChips } from "./shelf.js";
import { loadRun } from "./saved-runs.js";
import { go } from "./nav.js";
import { paras } from "./blocks.js";

// ---- the story page ----------------------------------------------------------
// One story, a full page rather than a modal (`#/story?dir=...`, so a reload or a bookmark lands
// back on it) -- this is where the play confirmation used to live, now with room for what it is
// scaffolded to grow into: a scene list (below) and, later, a story editor. Reached only by clicking
// a shelf card; "back to shelf" is the only way out, same as before.

/** The story's scenes, numbered -- scene N is chapter N, written or not (`card.chapters` is which
 *  ones exist on disk). `scene` is the legacy singular the shelf still reads. */
export const scenesOf = card =>
  card.scenes?.length ? card.scenes.map((s, i) => ({ ...s, n: i + 1 }))
  : card.scene ? [{ ...card.scene, n: 1 }] : [];

// The story's own default is preselected only once it is actually loaded in LM Studio -- picking an
// unloaded model would just fail the run, so there is nothing to gain by defaulting to it.
function modelSelectHtml(s) {
  const def = s.defaultModel || "";
  const available = def && APP.modelIds.includes(def);
  const chosen = APP.storyModel || (available ? def : "");
  return `<select id="story-model" class="btn" title="model to play this story with">
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

function sceneRowHtml(scene, chapters, canWrite, why) {
  const written = chapters.includes(scene.n);
  const open = APP.chapter?.dir === APP.storyDir && APP.chapter.n === scene.n;
  const next = !written && scene.n === nextChapterOf(chapters);
  const tag = written ? `<span class="tag written">written</span>`
            : next ? `<span class="tag next">next</span>` : "";
  return `<div class="cardwrap"><div class="scenerow">
    <div class="sc-q">${esc(scene.question || "(no scene question)")}${tag}</div>
    <div class="sc-meta">chapter ${scene.n}${scene.place ? " · " + esc(scene.place) : ""} · ${wordsPovHtml(scene)}</div>
    <button class="btn${next ? " primary" : ""} scenewrite" data-chapter="${scene.n}"${canWrite ? "" : " disabled"} title="${esc(why)}">${written ? "rewrite" : "write"} chapter ${scene.n}</button>
    ${written ? `<button class="btn chapterread" data-chapter="${scene.n}">${open ? "close" : "read"}</button>` : ""}
    ${open ? `<div class="prose" style="margin-top:12px">${paras(APP.chapter.text)}</div>` : ""}
    ${open && APP.chapterError ? `<div class="said bad">${esc(APP.chapterError)}</div>` : ""}
  </div></div>`;
}

/** Runs filed under the chapter they wrote, ascending to match the scene list above, newest first
 *  inside each group. A run retained from before chapter numbers were logged has none and lands in
 *  its own group at the end. One group is not a grouping, so a single-chapter story still renders
 *  the flat list it always did. */
function runsListHtml(s) {
  if (!s.runs?.length) return `<p class="hint">no retained runs yet</p>`;
  const btn = r => {
    const current = READV.dir === s.dir && READV.id === r.id;
    return `<button class="btn runbtn${current ? " current" : ""}" data-run="${esc(r.id)}"
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
      <button class="btn" id="story-handoff"${why ? ` disabled title="${esc(why)}"` : ""}
        >${mine ? "continue preparing" : "prepare"} chapter ${n}</button>
      <span class="hint">the architect re-authors the cast from the chapters already written</span>
    </div>`;
}

export function storyPageHtml() {
  if (!APP.storyDir) return "";
  if (!APP.stories) return `<section class="picker"><h2>…</h2><p class="sub">reading the shelf…</p></section>`;
  const s = (APP.stories || []).find(x => x.dir === APP.storyDir);
  if (!s) return `<section class="picker"><h2>Not found</h2>
    <p class="sub">this story is no longer on the shelf.</p>
    <div class="btns" style="margin-top:14px"><button class="btn" id="story-back">back to shelf</button></div>
  </section>`;

  if (!s.ok) return `<section class="picker story">
    <h2>${esc(s.name)}</h2>
    <div class="said bad">does not load — ${esc(s.error || "unknown error")}</div>
    ${(s.warnings || []).map(w => `<div class="prob">⚠ ${esc(w)}</div>`).join("")}
    <div class="btns" style="margin-top:14px"><button class="btn" id="story-back">back to shelf</button></div>
  </section>`;

  // The client-side mirror of what /select and /model would refuse anyway (server.ts, run-control-
  // routes.ts) -- said here so the button explains itself instead of round-tripping to find out.
  const why = runningReason()
            || (!APP.session.picking ? "not ready to start a run right now"
              : APP.picked ? "starting…" : "");
  const canWrite = !why;

  return `<section class="picker story">
    <h2>${esc(s.name)}</h2>
    <p class="premise">${esc(s.premise || "")}</p>
    <div class="row">${castChips(s.characters, s.dir)}</div>

    <div class="row" style="margin-top:12px"><span class="hint">model</span>${modelSelectHtml(s)}</div>
    ${APP.storyError ? `<div class="said bad">${esc(APP.storyError)}</div>` : ""}
    ${APP.runError ? `<div class="said bad">${esc(APP.runError)}</div>` : ""}
    ${(s.warnings || []).map(w => `<div class="prob">⚠ ${esc(w)}</div>`).join("")}

    <div class="divider"><span>scenes</span></div>
    <div class="cards">${scenesOf(s).map(sc => sceneRowHtml(sc, s.chapters || [], canWrite, why)).join("")}</div>

    ${handoffRowHtml(s)}

    <div class="divider"><span>previous runs</span></div>
    ${runsListHtml(s)}

    <div class="btns" style="margin-top:18px">
      <button class="btn" id="story-edit">edit story</button>
      <span class="spacer"></span>
      <button class="btn" id="story-back">back to shelf</button>
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

  for (const b of page.querySelectorAll(".chapterread"))
    b.addEventListener("click", async () => {
      const n = Number(b.dataset.chapter), dir = APP.storyDir;
      if (APP.chapter?.dir === dir && APP.chapter.n === n) {
        APP.chapter = null; APP.chapterError = ""; APP.render(); return;
      }
      APP.chapterError = "";
      try {
        const r = await fetch(`/chapter?dir=${encodeURIComponent(dir)}&n=${n}`);
        if (!r.ok) throw 0;
        APP.chapter = { dir, n, text: await r.text() };
      } catch { APP.chapter = { dir, n, text: "" }; APP.chapterError = "that chapter would not load"; }
      APP.render();
    });

  const handoff = page.querySelector("#story-handoff");
  if (handoff) handoff.addEventListener("click", () => { APP.handoffDir = APP.storyDir; go("handoff"); });

  const edit = page.querySelector("#story-edit");
  if (edit) edit.addEventListener("click", () => { APP.editDir = APP.storyDir; go("edit"); });

  for (const b of page.querySelectorAll(".runbtn"))
    b.addEventListener("click", async () => {
      b.disabled = true;
      const ok = await loadRun(APP.storyDir, b.dataset.run);
      if (!ok) { APP.storyError = "could not load that run"; APP.render(); return; }
      APP.storyError = "";
      go("read");
    });
}

/** Play needs the model set before /select, not after -- a fresh run reads `LIVE.modelOverride`
 *  the moment it loads the story. Sent unconditionally (even blank) so a leftover override from a
 *  previous story's run never silently rides along into this one. */
async function playChosen(dir, model, chapter) {
  if (APP.picked) return;
  const mj = await post("/model", { model }, false);
  if (!mj || mj.ok === false) { APP.storyError = reasonOr(mj, "could not set that model"); APP.render(); return; }
  await choose({ dir, chapter });
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
