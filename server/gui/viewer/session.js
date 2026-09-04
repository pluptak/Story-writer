import { $, post, notify, modelOptionsHtml } from "./util.js";
import { APP } from "./state.js";

/** Every session control shares one inline slot -- cleared at the start of each new attempt so a
 *  stale refusal from a different button doesn't linger, set again only if this one also fails. */
async function postSession(path, body) {
  notify("", "sessionNotice");
  return post(path, body, "sessionNotice");
}

// ---- the session (live only) --------------------------------------------
export function renderSession() {
  const onLive = APP.view === "live";
  const hidden = !onLive || !APP.live;
  if (hidden && !$("sessionbar").hidden) notify("", "sessionNotice");   // don't carry a stale refusal into the next run
  $("sessionbar").hidden = hidden;
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
  if (document.activeElement !== ms) setModelSelect(ms);
}

/** Assign the select only a value its options actually contain -- assigning a model the fresh
 *  /models list no longer has leaves selectedIndex at -1, rendering a blank control rather than
 *  falling back to "story default". */
const setModelSelect = ms => {
  const want = APP.session.model || "";
  ms.value = want && [...ms.options].some(o => o.value === want) ? want : "";
};
export const disarm = () => { clearTimeout(APP.armed); APP.armed = 0; renderSession(); };

export async function loadModels() {
  try {
    const j = await (await fetch("/models")).json();
    APP.modelIds = j.ids || [];
    APP.modelDefault = j.architect || "";
    const ms = $("modelSelect");
    const cur = ms.value;
    ms.innerHTML = '<option value="">story default</option>' + modelOptionsHtml(APP.modelIds);
    const want = APP.session.model || cur || "";
    ms.value = want && [...ms.options].some(o => o.value === want) ? want : "";
    if (APP.view === "scaffold") APP.render();   // the idea modal's model select just gained options
  } catch {}
}

/** Schema-derived editor defaults, thinking levels and caps -- fetched once at boot. APP.editorConfig
 *  starts with a literal matching today's schema defaults (state.js), so the editor renders sensibly
 *  even in the brief window before this resolves; this replaces it wholesale so drift in
 *  story-schema.ts's own defaults reaches the form without anyone hand-copying a number. */
export async function loadEditorConfig() {
  try {
    const j = await (await fetch("/story/edit-config")).json();
    if (j && j.defaults) {
      APP.editorConfig = j;
      if (APP.view === "edit") APP.render();
    }
  } catch {}
}

/** The catalog's own schema-derived shape (tag facets, voice-sample cap) -- fetched once at boot,
 *  same reasoning as loadEditorConfig above. */
export async function loadCatalogConfig() {
  try {
    const j = await (await fetch("/catalog/config")).json();
    if (j && j.tagFacets) {
      APP.catalogConfig = j;
      if (APP.view === "catalog" || APP.view === "scaffold") APP.render();
    }
  } catch {}
}

$("stop").onclick = async () => {
  if (!APP.session.running || APP.session.stopping) return;
  if (!APP.armed) { APP.armed = setTimeout(disarm, 4000); renderSession(); return; }
  clearTimeout(APP.armed); APP.armed = 0;
  APP.session.stopping = true; renderSession();
  await postSession("/stop");
};
$("consultMe").onclick = async () => {
  if (!APP.session.running || APP.session.stopping || APP.session.armed) return;
  await postSession("/consult-me");
};
$("pause").onclick = async () => {
  if (!APP.session.running || APP.session.stopping) return;
  await postSession(APP.session.paused || APP.session.pausing ? "/resume" : "/pause");
};
$("interactive").onclick = async () => {
  APP.session.interactive = !APP.session.interactive;
  renderSession();
  await postSession("/interactive", { on: APP.session.interactive });
};
$("modelSelect").onchange = async () => {
  const ms = $("modelSelect");
  const model = ms.value;                 // "" == "story default", clears the override
  const j = await postSession("/model", { model });
  if (!j || j.ok === false) ms.value = APP.session.model || "";
};
