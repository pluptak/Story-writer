import { esc, post, fmtRun, modelOptionsHtml, reasonOr } from "./util.js";
import { APP, READV } from "./state.js";
import { castChips } from "./shelf.js";
import { loadRun } from "./saved-runs.js";
import { go } from "./nav.js";

// ---- the story page ----------------------------------------------------------
// One story, a full page rather than a modal (`#/story?dir=...`, so a reload or a bookmark lands
// back on it) -- this is where the play confirmation used to live, now with room for what it is
// scaffolded to grow into: a scene list (below) and, later, a story editor. Reached only by clicking
// a shelf card; "back to shelf" is the only way out, same as before.

/** A story has exactly one scene today -- one `## Scene` block in story.md, and the engine has no
 *  notion of a second (STORY-FORMAT.md: a second `## Scene` would silently overwrite the first).
 *  Drawing it as a one-item list is the seam: when the format grows a scene list, this function and
 *  the engine change together and the page already knows how to draw N of them. */
export const scenesOf = card => card.scene ? [{ ...card.scene, n: 1 }] : [];

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

function sceneRowHtml(scene, canWrite, why) {
  return `<div class="cardwrap"><div class="scenerow">
    <div class="sc-q">${esc(scene.question || "(no scene question)")}</div>
    <div class="sc-meta">${scene.place ? esc(scene.place) + " · " : ""}~${scene.length ?? "?"} words${scene.pov ? " · pov " + esc(scene.pov) : ""}</div>
    <button class="btn primary" id="story-write"${canWrite ? "" : " disabled"} title="${esc(why)}">write a new run</button>
  </div></div>`;
}

function runsListHtml(s) {
  if (!s.runs?.length) return `<p class="hint">no retained runs yet</p>`;
  return `<div class="runs">${s.runs.map(r => {
    const current = READV.dir === s.dir && READV.id === r.id;
    return `<button class="btn runbtn${current ? " current" : ""}" data-run="${esc(r.id)}"
         >${current ? "reading · " : "read · "}${esc(fmtRun(r))}</button>`;
  }).join("")}</div>`;
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
  const why = APP.session.running ? "a scene is being written — stop it first"
            : !APP.session.picking ? "not ready to start a run right now"
            : APP.picked ? "starting…" : "";
  const canWrite = !why;

  return `<section class="picker story">
    <h2>${esc(s.name)}</h2>
    <p class="premise">${esc(s.premise || "")}</p>
    <div class="row">${castChips(s.characters, s.dir)}</div>

    <div class="row" style="margin-top:12px"><span class="hint">model</span>${modelSelectHtml(s)}</div>
    ${APP.storyError ? `<div class="said bad">${esc(APP.storyError)}</div>` : ""}
    ${(s.warnings || []).map(w => `<div class="prob">⚠ ${esc(w)}</div>`).join("")}

    <div class="divider"><span>scenes</span></div>
    <div class="cards">${scenesOf(s).map(sc => sceneRowHtml(sc, canWrite, why)).join("")}</div>

    <div class="divider"><span>previous runs</span></div>
    ${runsListHtml(s)}

    <div class="btns" style="margin-top:18px">
      <button class="btn" id="story-edit" disabled title="not built yet">edit story</button>
      <span class="spacer"></span>
      <button class="btn" id="story-back">back to shelf</button>
    </div>
  </section>`;
}

export function wireStoryPage(page) {
  const back = page.querySelector("#story-back");
  if (back) back.addEventListener("click", () => { APP.storyDir = ""; go("shelf"); });

  const model = page.querySelector("#story-model");
  if (model) model.addEventListener("change", () => { APP.storyModel = model.value; });

  const write = page.querySelector("#story-write");
  if (write) write.addEventListener("click", () => playChosen(APP.storyDir, APP.storyModel));

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
async function playChosen(dir, model) {
  if (APP.picked) return;
  const mj = await post("/model", { model }, false);
  if (!mj || mj.ok === false) { APP.storyError = reasonOr(mj, "could not set that model"); APP.render(); return; }
  await choose({ dir });
}

async function choose(payload) {
  if (APP.picked) return;                       // a double-click is one choice, not two
  APP.picked = payload.dir;
  APP.storyError = "";
  APP.render();
  const j = await post("/select", payload, false);
  if (!j || j.ok === false) { APP.picked = ""; APP.storyError = reasonOr(j, "that did not go through"); APP.render(); return; }
  go("live");
}
