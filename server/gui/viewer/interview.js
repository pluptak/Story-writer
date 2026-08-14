import { esc } from "./util.js";
import { APP, draft } from "./state.js";

// ---- the interview ------------------------------------------------------
const fld = (id, label, value, rows, disabled) =>
  `<div class="field"><label for="${id}">${label}</label>
    <textarea id="${id}" ${disabled ? "disabled" : ""} rows="${rows}"
              placeholder="">${esc(value)}</textarea></div>`;

const modelField = () =>
  `<div class="field"><label for="f-model">built by</label>
    <select id="f-model">
      <option value=""${draft.model ? "" : " selected"}>defaults${
        APP.modelDefault ? " · " + esc(APP.modelDefault) : ""}</option>
      ${APP.modelIds.map(id => `<option value="${esc(id)}"${draft.model === id ? " selected" : ""}>${esc(id)}</option>`).join("")}
    </select></div>`;

function castHtml(spec) {
  return spec.characters.map(c => {
    const can = c.skills.map(s => esc(s.text) + (s.meaning ? ` <span style="color:var(--faint)">— ${esc(s.meaning)}</span>` : "")).join(", ");
    return `<div class="who">
      <div class="nm">${esc(c.name)}</div>
      ${can ? `<div class="line"><span class="k yes">can also</span>${can}</div>` : ""}
      ${c.lacks.length ? `<div class="line"><span class="k no">cannot</span>${esc(c.lacks.join(", "))}</div>` : ""}
      ${c.knows ? `<div class="line"><span class="k">knows</span>${esc(c.knows)}</div>` : ""}
      <div class="persona${APP.personasFull ? "" : " clip"}">${esc(c.persona)}</div>
    </div>`;
  }).join("");
}

const lengthHtml = (spec, busy) =>
  `~<input type="number" id="f-length" class="lenbox" min="100" max="10000" step="50"
     ${busy ? "disabled" : ""} value="${esc(draft.length !== "" ? draft.length : spec.scene.length)}"> words`;

function proposalHtml(spec, busy) {
  const bits = [spec.scene.place, spec.scene.pov ? `pov ${spec.scene.pov}` : ""]
    .filter(Boolean).map(esc).join(" · ");
  return `<div class="proposal">
    <h3>${esc(spec.title || "(untitled)")}</h3>
    <div class="where">${bits}${bits ? " · " : ""}${lengthHtml(spec, busy)}</div>
    <p class="premise">${esc(spec.premise || "(no premise)")}</p>
    <p class="q"><b>the question this scene answers</b>${esc(spec.scene.question || "(none)")}</p>
    ${castHtml(spec)}
    ${spec.writerStyle && APP.personasFull
      ? `<div class="who"><div class="nm">house style</div><div class="persona">${esc(spec.writerStyle)}</div></div>` : ""}
  </div>`;
}

/** What the last round did, said plainly. Mirrors showRound() at the console. */
function lastHtml(last) {
  if (!last) return "";
  if (last.kind === "failed")  return `<div class="said bad">that round failed (${esc(last.error)}) — nothing changed</div>`;
  if (last.kind === "nothing") return `<div class="said bad">it didn't come back with a story — try saying who is in the scene and what is at stake</div>`;
  if (last.kind === "edits") {
    const changed = last.applied.length ? `changed: ${esc(last.applied.join(", "))}` : "it changed nothing";
    const ig = last.ignored.map(x => `<div class="said bad">ignored ${esc(x)}</div>`).join("");
    return `<div class="said good">${changed}</div>${ig}`;
  }
  if (last.kind === "proposal" && last.note) return `<div class="said">note: ${esc(last.note)}</div>`;
  return "";
}

function interviewHtml() {
  const s = APP.scaffold;
  const err = APP.scaffoldError ? `<div class="said bad">${esc(APP.scaffoldError)}</div>` : "";
  // Not started: just the idea box.
  if (!s.active) {
    return `<section class="picker iv">
      <h2>A new story</h2>
      <p class="sub">as much or as little as you like — it will ask if it needs more</p>
      ${fld("f-idea", "the idea", draft.idea, 4, false)}
      ${modelField()}
      ${err}
      <div class="btns"><button class="btn primary" id="iv-start">propose a story</button>
        <button class="btn" id="iv-back">back to the shelf</button>
        <span class="hint">ctrl/⌘ + ↵</span></div>
    </section>`;
  }

  const busy = !!s.busy;
  const answering = !!s.pendingAsk;
  const body = [];

  if (s.spec) body.push(proposalHtml(s.spec, busy));
  body.push(lastHtml(s.last));
  for (const p of (s.problems || [])) body.push(`<div class="prob">⚠ ${esc(p)}</div>`);
  if (answering) body.push(`<div class="asked"><span class="k">it needs to know</span>${esc(s.pendingAsk)}</div>`);
  body.push(err);

  if (busy) body.push(`<div class="thinking"><i></i>thinking about it…</div>`);

  if (s.needsFolder && !busy) {
    body.push(`<div class="asked"><span class="k">where should it go</span>${esc(s.needsFolder)}</div>
      <div class="field"><label for="f-folder">folder name</label>
        <input type="text" id="f-folder" value="${esc(draft.folder)}"></div>
      <div class="btns"><button class="btn primary" id="iv-folder">write it there</button>
        <span class="hint">↵</span></div>`);
  }
  const row = [];
  if (!busy) {
    // Unsent text is the whole reason the row is ordered this way: accepting writes the story from
    // the SPEC, so anything still sitting in this box is thrown away by it.
    const unsent = !!draft.say.trim();
    const flags = (s.problems || []).length;
    body.push(fld("f-say", answering ? "your answer" : s.haveStory ? "what should change?" : "say more about it",
                  draft.say, 3, false));
    // The folder question owns acceptance while it is open — "write it there" IS the accept.
    const acceptable = s.haveStory && !s.needsFolder;
    const acceptLabel = !APP.acceptArmed ? "accept &amp; write it"
      : unsent ? "discard what you typed and write it"
      : `accept over ${flags} flag(s)`;
    row.push(`<button class="btn${unsent || !s.haveStory ? " primary" : ""}" id="iv-say">send</button>`);
    if (acceptable) row.push(`<button class="btn${unsent || APP.acceptArmed ? "" : " primary"}${
      APP.acceptArmed ? " armed" : ""}" id="iv-accept">${acceptLabel}</button>`);
  }
  if (s.spec) row.push(`<button class="btn" id="iv-full">${APP.personasFull ? "shorter" : "personas in full"}</button>`);
  if (!busy) row.push(`<span class="hint">↵ send · ⇧↵ new line</span>`);
  row.push(`<span class="spacer"></span>`);
  row.push(`<button class="btn${APP.abandonArmed ? " armed" : ""}" id="iv-abandon">${
    APP.abandonArmed ? "abandon — sure?" : "abandon"}</button>`);
  body.push(`<div class="btns">${row.join("")}</div>`);

  return `<section class="picker iv">
    <div class="iv-head"><h2>${s.haveStory ? "Does this look right?" : "A new story"}</h2>
      <button class="btn" id="iv-hide" title="close — keeps the interview going, reopen from the shelf">×</button></div>
    <p class="sub">${esc(s.idea)}${s.model ? ` <span class="hint">· built by ${esc(s.model)}</span>` : ""}</p>
    ${body.join("")}
  </section>`;
}

export function interviewModalHtml() {
  return (APP.scaffold.active || APP.ideaOpen) && !APP.ivHidden
    ? `<div class="modal-backdrop" id="iv-backdrop" role="dialog" aria-modal="true"
            aria-label="new story">${interviewHtml()}</div>` : "";
}

async function postScaffold(what, payload) {
  let j = null;
  try {
    const r = await fetch(`/scaffold/${what}`, { method:"POST", headers:{ "Content-Type":"application/json" },
                                                 body: JSON.stringify(payload || {}) });
    j = await r.json();
  } catch { APP.scaffoldError = "the engine did not answer"; APP.render(); return null; }
  if (j && j.active !== undefined) { APP.scaffoldError = ""; APP.scaffold = j; APP.render(); return j; }
  if (j && j.ok) { APP.scaffoldError = ""; APP.render(); return j; }        // abandon, and a clean accept
  APP.scaffoldError =
    j && j.kind === "unloadable"   ? `written to ${j.dir}, but it does not load — ${j.error}`
    : j && j.kind === "needs_folder" ? ""                            // the folder question renders itself
    : (j && j.reason) || "that did not go through";
  APP.render();
  return j;
}

/** Also called from `sse.js`: a `scaffold` SSE frame that arrives with no problems left disarms the
 *  accept-over-a-complaint confirmation the same way clicking through it would. */
export const disarmAccept  = () => { clearTimeout(APP.acceptArmed);  APP.acceptArmed  = 0; APP.render(); };
const disarmAbandon = () => { clearTimeout(APP.abandonArmed); APP.abandonArmed = 0; APP.render(); };

/**
 * A change, sent. **The text stays in the draft until the round actually lands.** It used to be
 * cleared before the POST, so a 409 or a dropped connection lost what you had written with nothing
 * said about it — the same failure as accepting over an unsent change, arriving a different way.
 */
async function sendSay() {
  const text = draft.say.trim();
  if (!text || APP.scaffold.busy) return;
  const j = await postScaffold("say", { text });
  if (j && j.active !== undefined) { draft.say = ""; APP.render(); }
}

async function startInterview() {
  const idea = draft.idea.trim();
  if (!idea) return;
  APP.scaffoldError = "";
  APP.scaffold = { active:true, busy:true, idea, problems:[], haveStory:false, model:draft.model };
  APP.render();
  const j = await postScaffold("start", { idea, model: draft.model });
  // A refusal leaves the page holding an optimistic "busy" that nothing will ever clear — it has
  // to fall back to the idea box, with the idea still in it, or the modal hangs until a reload.
  if (!j || j.active === undefined) { APP.scaffold = { active:false }; APP.ideaOpen = true; APP.render(); }
}

export function wireInterview(page) {
  const on = (id, fn) => { const el = page.querySelector("#" + id); if (el) el.addEventListener("click", fn); };
  const onKey = (id, fn) => { const el = page.querySelector("#" + id); if (el) el.addEventListener("keydown", fn); };
  const plain = e => !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing;
  // Keep what is being typed across the re-renders that SSE frames cause.
  for (const [id, key] of [["f-idea","idea"], ["f-say","say"], ["f-folder","folder"], ["f-length","length"]]) {
    const el = page.querySelector("#" + id);
    if (el) el.addEventListener("input", () => { draft[key] = el.value; });
  }
  const model = page.querySelector("#f-model");
  if (model) model.addEventListener("change", () => { draft.model = model.value; });
  const len = page.querySelector("#f-length");
  if (len) len.addEventListener("change", async () => {
    const j = await postScaffold("set", { field:"scene.length", value:Math.round(Number(len.value)) });
    if (j && j.active !== undefined) draft.length = "";
    APP.render();
  });
  // Enter sends. There was no keyboard path to "send" at all, which is exactly what made the
  // primary button — accept — read as the default for a box whose entire purpose is a change.
  onKey("f-say", e => { if (e.key === "Enter" && plain(e)) { e.preventDefault(); sendSay(); } });
  // The idea is a paragraph, not a line, so here Enter stays a newline and the modifier sends.
  onKey("f-idea", e => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); startInterview(); }
  });
  onKey("f-folder", e => { if (e.key === "Enter" && plain(e)) { e.preventDefault(); acceptIntoFolder(); } });
  on("iv-back", () => { APP.ideaOpen = false; APP.render(); });
  on("iv-hide", () => { APP.ivHidden = true; APP.render(); });
  on("iv-start", startInterview);
  on("iv-say", sendSay);
  on("iv-full", () => { APP.personasFull = !APP.personasFull; APP.render(); });
  on("iv-abandon", () => {
    // Abandoning throws away every round of an interview at once, and nothing on the server keeps
    // a copy. It gets the same confirming second click accepting does.
    if (!APP.abandonArmed) { APP.abandonArmed = setTimeout(disarmAbandon, 4000); APP.render(); return; }
    clearTimeout(APP.abandonArmed); APP.abandonArmed = 0;
    postScaffold("abandon", {}).then(() => {
      APP.scaffold = { active:false }; APP.ideaOpen = false; APP.ivHidden = false; APP.scaffoldError = "";
      draft.idea = draft.say = draft.folder = "";
      APP.render();
    });
  });
  on("iv-folder", acceptIntoFolder);
  on("iv-accept", () => {
    // Two things make accepting deliberate rather than the button that happens to be nearest.
    // UNSENT TEXT: the story is written from the spec, so whatever is still in the box would be
    // silently thrown away. A COMPLAINT: allowed to accept over — they are judgements about the
    // design, not errors — but it takes a second click, as it takes a second keypress at the
    // console.
    const unsent = !!draft.say.trim();
    const flagged = !!(APP.scaffold.problems && APP.scaffold.problems.length);
    if ((unsent || flagged) && !APP.acceptArmed) { APP.acceptArmed = setTimeout(disarmAccept, 5000); APP.render(); return; }
    clearTimeout(APP.acceptArmed); APP.acceptArmed = 0;
    postScaffold("accept", {});
  });
}

/** Accept into a named folder — the answer to `needs_folder`. A blank name is not an answer, so it
 *  does nothing rather than re-asking the same question. */
function acceptIntoFolder() {
  const folder = draft.folder.trim();
  if (folder) postScaffold("accept", { folder });
}

// Escape closes the interview modal the same way the backdrop and × do — hides, never abandons.
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && (APP.scaffold.active || APP.ideaOpen) && !APP.ivHidden) { APP.ivHidden = true; APP.render(); }
});
