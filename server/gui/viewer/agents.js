import { esc } from "./util.js";
import { APP, READV } from "./state.js";

/** Volumes are wildly lopsided -- one real chapter logged 57 writer calls and ~1.07M prompt
 *  characters against ~7 calls per character -- so counts are abbreviated rather than shown raw. */
const abbrev = n =>
  n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n);

const clock = ts => {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? String(ts ?? "") : d.toLocaleTimeString();
};

/** Fetch the loaded run's per-agent transcript summaries. Keyed by dir+id, the same reason
 *  `APP.chapter` carries its own dir: one run's agents must never render under another's. */
export async function loadAgents(dir, id) {
  APP.agents = null; APP.agentsError = "";
  APP.transcript = null; APP.transcriptError = ""; APP.callOpen = -1;
  try {
    const r = await fetch(`/runs/llm?dir=${encodeURIComponent(dir)}&id=${encodeURIComponent(id)}`);
    const j = await r.json();
    if (!r.ok || j.ok === false) { APP.agentsError = j.reason || "could not read this run's transcripts"; return; }
    APP.agents = { dir, id, logs: j.logs || [] };
  } catch { APP.agentsError = "the engine did not answer"; }
}

/** One agent's transcript, on demand. Never fetched with the summaries: a writer transcript runs to
 *  a megabyte, and the panel exists to show you which agent is worth opening before you open it. */
async function openTranscript(file) {
  const a = APP.agents;
  if (!a) return;
  APP.transcriptError = ""; APP.callOpen = -1;
  try {
    const r = await fetch(`/runs/llm/file?dir=${encodeURIComponent(a.dir)}`
      + `&id=${encodeURIComponent(a.id)}&file=${encodeURIComponent(file)}`);
    if (!r.ok) { APP.transcript = null; APP.transcriptError = "that transcript would not load"; APP.render(); return; }
    const calls = (await r.text()).trim().split("\n")
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    APP.transcript = { dir: a.dir, id: a.id, file, calls };
  } catch { APP.transcript = null; APP.transcriptError = "the engine did not answer"; }
  APP.render();
}

function callBodyHtml(c) {
  const msgs = (Array.isArray(c.prompt) ? c.prompt : [])
    .map(m => `<div class="msg"><span class="msg-role">${esc(m?.role ?? "")}</span>${esc(m?.content ?? "")}</div>`)
    .join("");
  return `<div class="callbody">${msgs}
    <div class="msg reply"><span class="msg-role">response</span>${esc(c.response ?? "")}</div>
  </div>`;
}

/** Which transcript is open, or "" -- a transcript left over from another run counts as none, so the
 *  row's label and the body below it cannot disagree about what is being read. */
const openFile = () => {
  const t = APP.transcript, a = APP.agents;
  return t && a && t.dir === a.dir && t.id === a.id ? t.file : "";
};

function transcriptHtml() {
  const t = APP.transcript;
  if (APP.transcriptError) return `<div class="said bad">${esc(APP.transcriptError)}</div>`;
  if (!t || openFile() !== t.file) return "";
  if (!t.calls.length) return `<p class="hint">that transcript is empty</p>`;
  return `<div class="divider"><span>${esc(t.file)}</span></div>
    <div class="calls">${t.calls.map((c, i) => {
      const n = (Array.isArray(c.prompt) ? c.prompt : []).length;
      const open = APP.callOpen === i;
      return `<button class="btn callbtn${open ? " current" : ""}" data-call="${i}"
        >#${i + 1} · ${esc(clock(c.ts))} · ${n} msg${n === 1 ? "" : "s"} · ${abbrev(String(c.response ?? "").length)} chars</button>`;
    }).join("")}</div>
    ${APP.callOpen >= 0 && t.calls[APP.callOpen] ? callBodyHtml(t.calls[APP.callOpen]) : ""}`;
}

/** The read tab's per-agent panel: what each agent cost this run, and a way into its transcript.
 *  Renders nothing at all until a run is loaded, so the empty read tab is unchanged. */
export function agentsPanelHtml() {
  if (!READV.dir || !READV.id) return "";
  const body =
    APP.agentsError ? `<div class="said bad">${esc(APP.agentsError)}</div>`
    : !APP.agents || APP.agents.dir !== READV.dir || APP.agents.id !== READV.id ? `<p class="hint">reading…</p>`
    : !APP.agents.logs.length ? `<p class="hint">this run logged no model calls</p>`
    : APP.agents.logs.map(l => `<div class="agentrow">
        <div class="ag-name">${esc(l.agent || l.file)}<span class="tag ${esc(l.role)}">${esc(l.role)}</span></div>
        <div class="ag-meta">${l.calls} call${l.calls === 1 ? "" : "s"} · ${abbrev(l.promptChars)} prompt · ${abbrev(l.responseChars)} response · ${esc((l.models || []).join(", "))}</div>
        <button class="btn agentopen" data-file="${esc(l.file)}"
          >${openFile() === l.file ? "reading" : "open"}</button>
      </div>`).join("");

  return `<section class="picker agents">
    <h2>Model calls</h2>
    <div class="cards">${body}</div>
    ${transcriptHtml()}
  </section>`;
}

export function wireAgents(page) {
  for (const b of page.querySelectorAll(".agentopen"))
    b.addEventListener("click", () => openTranscript(b.dataset.file));
  for (const b of page.querySelectorAll(".callbtn"))
    b.addEventListener("click", () => {
      const i = Number(b.dataset.call);
      APP.callOpen = APP.callOpen === i ? -1 : i;
      APP.render();
    });
}
