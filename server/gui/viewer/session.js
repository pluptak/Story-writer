import { $, esc, post } from "./util.js";
import { APP } from "./state.js";

// ---- the session (live only) --------------------------------------------
// Whether a scene is being written RIGHT NOW is a different question from what the events say: a
// saved log and a run that stopped ten seconds ago contain exactly the same thing. So the engine
// reports it separately, over `run_state` and `GET /run`, and it never reaches the log.
export function renderSession() {
  const onLive = APP.view === "live";
  // The idle screen belongs to the picker; three permanently-disabled run controls on it are
  // furniture, not information. They are also session controls, so they never show on the read
  // page either -- on a page about a finished run they would read as if they act on it.
  for (const id of ["stop", "consultMe", "pause"]) $(id).hidden = !onLive || !APP.live || !APP.session.running;
  $("interactive").hidden = !onLive || !APP.live;
  const b = $("stop");
  b.disabled = !APP.session.running || APP.session.stopping;
  b.classList.toggle("armed", !!APP.armed);
  b.textContent = APP.session.stopping ? "stopping…" : APP.armed ? "confirm stop" : "stop run";
  $("where").textContent = (onLive && APP.session.where) ? "· " + APP.session.where : "";
  const iv = $("interactive");
  iv.classList.toggle("off", !APP.session.interactive);
  iv.textContent = APP.session.interactive ? "interactive" : "hands off";
  const cm = $("consultMe");
  cm.disabled = !APP.session.running || APP.session.stopping || APP.session.armed || !APP.session.interactive;
  cm.textContent = APP.session.armed ? "consulting…" : "consult me";
  const p = $("pause");
  p.disabled = !APP.session.running || APP.session.stopping;
  p.textContent = APP.session.paused ? "resume" : APP.session.pausing ? "pausing…" : "pause";
  // Enabled when idle (picks the model for the NEXT run) or actually paused (swaps the one
  // running) -- NOT while merely "pausing", since the loop has not reached the boundary yet and
  // the server would 400 the same change (GUI-SPEC §4.4).
  const ms = $("modelSelect");
  ms.hidden = !onLive || !APP.live;
  ms.disabled = APP.session.running && !APP.session.paused;
  if (document.activeElement !== ms) ms.value = APP.session.model || "";
}
/** Also called from `sse.js`: a `run_state` frame that reports the run has stopped disarms the
 *  stop button's confirming second click the same way clicking through it would. */
export const disarm = () => { clearTimeout(APP.armed); APP.armed = 0; renderSession(); };

/** The model ids LM Studio has loaded, fetched once and reused -- the dropdown that lets you pick
 *  one before a run starts, or swap it while paused (GUI-SPEC §4.4). */
export async function loadModels() {
  try {
    const j = await (await fetch("/models")).json();
    APP.modelIds = j.ids || [];
    APP.modelDefault = j.architect || "";
    const ms = $("modelSelect");
    const cur = ms.value;
    ms.innerHTML = '<option value="">story default</option>'
      + APP.modelIds.map(id => `<option value="${esc(id)}">${esc(id)}</option>`).join("");
    ms.value = APP.session.model || cur || "";
    // The interview's own dropdown is built from `modelIds` as part of a whole re-render, so it
    // has to be told the list arrived.
    if ((APP.scaffold.active || APP.ideaOpen) && !APP.ivHidden) APP.render();
  } catch {}
}

$("stop").onclick = async () => {
  if (!APP.session.running || APP.session.stopping) return;
  // Ending a scene part-written is deliberate, so it takes a second click — the same reason the
  // scaffolder makes you confirm an accept over an outstanding complaint.
  if (!APP.armed) { APP.armed = setTimeout(disarm, 4000); renderSession(); return; }
  clearTimeout(APP.armed); APP.armed = 0;
  APP.session.stopping = true; renderSession();
  await post("/stop");
};
$("consultMe").onclick = async () => {
  if (!APP.session.running || APP.session.stopping || APP.session.armed) return;
  await post("/consult-me");
};
$("pause").onclick = async () => {
  if (!APP.session.running || APP.session.stopping) return;
  await post(APP.session.paused || APP.session.pausing ? "/resume" : "/pause");
};
$("interactive").onclick = async () => {
  // Optimistic: the toggle has no gate to refuse it (unlike stop/pause/model), so the button
  // reflects the click immediately rather than waiting on the round trip.
  APP.session.interactive = !APP.session.interactive;
  renderSession();
  await post("/interactive", { on: APP.session.interactive });
};
$("modelSelect").onchange = async () => {
  const ms = $("modelSelect");
  const model = ms.value;                 // "" == "story default", clears the override
  const j = await post("/model", { model });
  // A refused change has to come back off the dropdown too, or the page goes on claiming a model
  // the engine never took — a wrong id fails every call, so a silently-wrong label is expensive.
  if (!j || j.ok === false) ms.value = APP.session.model || "";
};
