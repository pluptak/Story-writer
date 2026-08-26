import { esc, tid } from "./util.js";
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
 *  `APP.chapter` carries its own dir: one run's agents must never render under another's.
 *  A response that lands after a newer call started is dropped -- otherwise run A's late
 *  answer would leave the panel stuck on "reading…" for run B, with nothing to re-fetch it. */
export async function loadAgentState(dir, id, state = APP) {
  const req = (state._agentsReq = (state._agentsReq || 0) + 1);
  state.agents = null; state.agentsError = "";
  state.transcript = null; state.transcriptError = ""; state.callOpen = -1;
  try {
    const r = await fetch(`/runs/llm?dir=${encodeURIComponent(dir)}&id=${encodeURIComponent(id)}`);
    const j = await r.json();
    if (req !== state._agentsReq) return;
    if (!r.ok || j.ok === false) { state.agentsError = j.reason || "could not read this run's transcripts"; return; }
    state.agents = { dir, id, logs: j.logs || [] };
  } catch { if (req === state._agentsReq) state.agentsError = "the engine did not answer"; }
}

/** One agent's transcript, on demand. Never fetched with the summaries: a writer transcript runs to
 *  a megabyte, and the panel exists to show you which agent is worth opening before you open it.
 *  The token makes rapid re-clicks last-write-wins; the agents check stops a slow failure from one
 *  run painting its error under another run's list. */
async function openTranscript(file, state) {
  const a = state.agents;
  if (!a) return;
  const req = (state._transcriptReq = (state._transcriptReq || 0) + 1);
  state.transcriptError = ""; state.callOpen = -1;
  try {
    const r = await fetch(`/runs/llm/file?dir=${encodeURIComponent(a.dir)}`
      + `&id=${encodeURIComponent(a.id)}&file=${encodeURIComponent(file)}`);
    const cur = state.agents;
    if (req !== state._transcriptReq || !cur || cur.dir !== a.dir || cur.id !== a.id) return;
    if (!r.ok) { state.transcript = null; state.transcriptError = "that transcript would not load"; APP.render(); return; }
    const calls = (await r.text()).trim().split("\n")
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    if (req !== state._transcriptReq) return;
    state.transcript = { dir: a.dir, id: a.id, file, calls };
  } catch {
    const cur = state.agents;
    if (req === state._transcriptReq && cur && cur.dir === a.dir && cur.id === a.id) {
      state.transcript = null; state.transcriptError = "the engine did not answer";
    }
  }
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
const openFile = state => {
  const t = state.transcript, a = state.agents;
  return t && a && t.dir === a.dir && t.id === a.id ? t.file : "";
};

function transcriptHtml(state) {
  const t = state.transcript;
  if (state.transcriptError) return `<div class="said bad">${esc(state.transcriptError)}</div>`;
  if (!t || openFile(state) !== t.file) return "";
  if (!t.calls.length) return `<p class="hint">that transcript is empty</p>`;
  return `<div class="divider"><span>${esc(t.file)}</span></div>
    <div class="calls">${t.calls.map((c, i) => {
      const n = (Array.isArray(c.prompt) ? c.prompt : []).length;
      const open = state.callOpen === i;
      return `<button ${tid("agents.call-btn")} class="btn callbtn${open ? " current" : ""}" data-call="${i}"
        >#${i + 1} · ${esc(clock(c.ts))} · ${n} msg${n === 1 ? "" : "s"} · ${abbrev(String(c.response ?? "").length)} chars</button>`;
    }).join("")}</div>
    ${state.callOpen >= 0 && t.calls[state.callOpen] ? callBodyHtml(t.calls[state.callOpen]) : ""}`;
}

/** The read tab's per-agent panel: what each agent cost this run, and a way into its transcript.
 *  Renders nothing at all until a run is loaded, so the empty read tab is unchanged. */
export function agentsPanelHtml(store = READV, state = APP) {
  if (!store.dir || !store.id) return "";
  const body =
    state.agentsError ? `<div class="said bad">${esc(state.agentsError)}</div>`
    : !state.agents || state.agents.dir !== store.dir || state.agents.id !== store.id ? `<p class="hint">reading…</p>`
    : !state.agents.logs.length ? `<p class="hint">this run logged no model calls</p>`
    : state.agents.logs.map(l => `<div ${tid("agents.row")} class="agentrow" data-file="${esc(l.file)}">
        <div class="ag-name">${esc(l.agent || l.file)}<span class="tag ${esc(l.role)}">${esc(l.role)}</span></div>
        <div class="ag-meta">${l.calls} call${l.calls === 1 ? "" : "s"} · ${abbrev(l.promptChars)} prompt · ${abbrev(l.responseChars)} response · ${esc((l.models || []).join(", "))}</div>
        <button ${tid("agents.open-btn")} class="btn agentopen" data-file="${esc(l.file)}"
          >${openFile(state) === l.file ? "reading" : "open"}</button>
      </div>`).join("");

  return `<section ${tid("agents.panel")} class="picker agents">
    <h2>Model calls</h2>
    <div class="cards">${body}</div>
    ${transcriptHtml(state)}
  </section>`;
}

export function wireAgents(page, state = APP) {
  for (const b of page.querySelectorAll(".agentopen"))
    b.addEventListener("click", () => openTranscript(b.dataset.file, state));
  for (const b of page.querySelectorAll(".callbtn"))
    b.addEventListener("click", () => {
      const i = Number(b.dataset.call);
      state.callOpen = state.callOpen === i ? -1 : i;
      APP.render();
    });
}
