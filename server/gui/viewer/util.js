// DOM/network primitives with no app-state dependency of their own.
export const $ = id => document.getElementById(id);
export const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
export const fmtRun = r => {
  const when = new Date(r.mtimeMs).toLocaleString(undefined,
    { month:"short", day:"numeric", hour:"numeric", minute:"2-digit" });
  const status = r.stopped ? "stopped" : r.done ? "finished" : r.words != null ? "unfinished" : "no output";
  return [when, r.words != null ? `${r.words}w` : "", status].filter(Boolean).join(" · ");
};

let noticeTimer = 0;
export function notify(text) {
  $("notice").textContent = text || "";
  clearTimeout(noticeTimer);
  if (text) noticeTimer = setTimeout(() => { $("notice").textContent = ""; }, 8000);
}

/** POST, and say why if the engine says no. Returns the parsed body, or null if it never answered. */
export async function post(path, body) {
  let j = null;
  try {
    const r = await fetch(path, body === undefined ? { method:"POST" }
      : { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
    j = await r.json();
  } catch { notify("the engine did not answer"); return null; }
  if (j && j.ok === false) notify(j.reason || "that did not go through"); else notify("");
  return j;
}
