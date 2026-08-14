import { $, esc, post } from "./util.js";
import { APP } from "./state.js";

// ---- the session (live only) --------------------------------------------
export function renderSession() {
  const onLive = APP.view === "live";
 $("sessionbar").hidden = !onLive || !APP.live;
  for (const id of ["stop", "consultMe", "pause"]) $(id).hidden = !APP.session.running;
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
  const ms = $("modelSelect");
  ms.disabled = APP.session.running && !APP.session.paused;
  if (document.activeElement !== ms) ms.value = APP.session.model || "";
}
export const disarm = () => { clearTimeout(APP.armed); APP.armed = 0; renderSession(); };

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
 if ((APP.scaffold.active || APP.ideaOpen) && !APP.ivHidden) APP.render();
  } catch {}
}

$("stop").onclick = async () => {
  if (!APP.session.running || APP.session.stopping) return;
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
  APP.session.interactive = !APP.session.interactive;
  renderSession();
  await post("/interactive", { on: APP.session.interactive });
};
$("modelSelect").onchange = async () => {
  const ms = $("modelSelect");
  const model = ms.value;                 // "" == "story default", clears the override
  const j = await post("/model", { model });
  if (!j || j.ok === false) ms.value = APP.session.model || "";
};
