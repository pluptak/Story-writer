import { esc, tid } from "./util.js";
import { APP, LIVEV, READV } from "./state.js";
import { noteFocus } from "./nav.js";

// ---- the consultation inspector -------------------------------------------
// A floating, modeless reading of one historical Writer ↔ Character consultation:
// Writer asked → character knew → character answered → accepted or set aside.
//
// It reads the same blocks events.js builds for the prose views, so the live run and a
// retained run show their own conversation with no second data model and no GUI-only copy:
// the open target is keyed {view, dir, id, seq} and resolves against that store's blocks on
// every paint. A run that is no longer on screen (another run opened, a fresh scene) drops
// the panel instead of showing a stale conversation.
//
// Deliberately NOT an author-to-character chat: there are no inputs here, nothing posts,
// and the tids live under `inspect.*` so a future `chat.*` surface cannot collide with them.

const storeFor = view => view === "read" ? READV : view === "live" ? LIVEV : null;

const keyFor = (view, store, seq) => view === "read"
  ? { view, dir: store.dir || "", id: store.id || "", seq }
  : { view, seq };

/** The open target's block in the store it belongs to -- null when the inspector is closed,
 *  on another view, or pointing at a run/seq that is not on screen. */
export function resolveInspected(blocks) {
  const k = APP.consultInspect;
  if (!k || (k.view !== "live" && k.view !== "read") || k.view !== APP.view) return null;
  const store = storeFor(k.view);
  if (!store) return null;
  if (k.view === "read" && (store.dir !== k.dir || store.id !== k.id)) return null;
  const block = (blocks || []).find(b => b.kind === "consult" && Number(b.seq) === Number(k.seq));
  if (!block) return null;
  return { block, store };
}

/** A `retry` verdict sets an attempt aside; the fixture logs' older `reject` reads the same. */
const setAsideVerdict = v => v === "retry" || v === "reject";

/** The consultation's standing, in story words: the engine always keeps the final answer (a
 *  spent budget and the chapter-wide ceiling both force-accept the last reply), so only the
 *  final attempt can be accepted and only a superseded one set aside. */
export function consultStatus(b) {
  const attempts = b.attempts || [];
  const fin = attempts[attempts.length - 1] || {};
  const setAside = attempts.slice(0, -1).filter(a => a.judge && setAsideVerdict(a.judge.verdict)).length;
  if (!fin.answer)
    return { key: "waiting", glyph: "⏳", label: "Waiting",
             line: `Waiting — the story pauses here until ${b.who} answers.` };
  const bits = [`✓ Accepted`];
  if (attempts.length > 1) bits.push(`after ${attempts.length} attempts`);
  if (b.capped) bits.push("re-ask limit reached");
  else if (fin.judge && setAsideVerdict(fin.judge.verdict)) bits.push("kept when the re-asks ran out");
  return { key: "accepted", glyph: "✓", label: "Accepted", line: bits.join(" · "),
           attempts: attempts.length, capped: !!b.capped, setAside,
           judgeNote: fin.judge?.note || "" };
}

/** One message bubble. `role` is `writer` or the character's name; the aria-label carries it so
 *  the two voices are told apart by more than their styling. */
function msgHtml(role, label, body, { tidName, n } = {}) {
  const cls = role === "writer" ? "msg-writer" : "msg-character";
  return `<div${tid(tidName || "inspect.message")} class="msg ${cls}" role="group"`
    + ` aria-label="${esc(label)}"${n != null ? ` data-n="${esc(n)}"` : ""}>`
    + `<span class="msg-who">${esc(label)}</span><div class="msg-body">${body}</div></div>`;
}

const paras = t => String(t).split(/\n{2,}/).map(p => `<p>${esc(p)}</p>`).join("");

function writerMsg(a, who, n) {
  const wants = a.wants ? ` <span class="wants">needs: ${esc(a.wants)}</span>` : "";
  return msgHtml("writer", "Writer", `${paras(a.situation || "")}${wants}`,
    { tidName: "inspect.writer-msg", n });
}

function characterMsg(a, who, n) {
  const ans = a.answer || {};
  const parts = [];
  if (ans.speech) parts.push(`<div class="speech">“${esc(ans.speech)}”</div>`);
  if (ans.action) parts.push(`<div class="action">${esc(ans.action)}</div>`);
  if (ans.thought) parts.push(`<div class="thought">${esc(ans.thought)}</div>`);
  if (ans.note) parts.push(`<div class="thought">note: ${esc(ans.note)}</div>`);
  if (!parts.length && ans.note == null) return "";
  const body = parts.length ? parts.join("")
    : `<div class="thought">${esc(String(ans.note || "did not answer").trim() || "did not answer")}</div>`;
  return msgHtml(who, who, body, { tidName: "inspect.character-msg", n });
}

/** The clarification trail inside one attempt: the character asked for a fact, the author
 *  answered -- two voices, same bubble language as the rest of the exchange. */
function clarifyMsgs(a, who) {
  return (a.qa || []).map(x =>
    msgHtml(who, `${who} asked for a fact`, paras(x.q), { tidName: "inspect.character-msg" })
    + msgHtml("writer", "Writer answered", paras(x.a), { tidName: "inspect.writer-msg" })).join("");
}

function flagNotes(a) {
  return (a.flags || []).map(f => `<p class="inote">${esc(f)}</p>`).join("");
}

/** One attempt's full Writer ↔ Character exchange, in the order it happened. */
function attemptHtml(b, a, { final }) {
  const judge = a.judge && (a.judge.verdict || a.judge.note)
    ? `<p class="inote">judged ${esc(a.judge.verdict || "")}`
      + `${a.judge.note ? ` — ${esc(a.judge.note)}` : ""}</p>` : "";
  const setAside = !final && a.judge && setAsideVerdict(a.judge.verdict)
    ? `<p class="iset">⊘ Set aside — the Writer asked again, and this answer did not reach the page.</p>` : "";
  return writerMsg(a, b.who, a.n) + clarifyMsgs(a, b.who) + characterMsg(a, b.who, a.n)
    + flagNotes(a) + setAside + (final ? "" : judge);
}

/** What the character was actually given for the kept answer: the final attempt's situation,
 *  the shape asked for, and the facts the author supplied mid-consult. A fresh instance
 *  answers every retry (agent.fork()), so earlier attempts' clarifications do NOT travel --
 *  each attempt's exchange carries its own, above. */
function contextHtml(b) {
  const attempts = b.attempts || [];
  const fin = attempts[attempts.length - 1] || {};
  const sent = [
    fin.situation ? `<div class="kv"><span class="k">The situation, as sent</span>`
      + `<span class="v">${esc(fin.situation)}</span></div>` : "",
    fin.wants ? `<div class="kv"><span class="k">What the Writer needed</span>`
      + `<span class="v">${esc(fin.wants)}</span></div>` : "",
    (fin.qa || []).map(x => `<div class="kv"><span class="k">Fact supplied mid-consult</span>`
      + `<span class="v">${esc(x.q)} — ${esc(x.a)}</span></div>`).join(""),
  ].filter(Boolean).join("");
  const snap = definitionHtml(fin.ctx);
  const missing = !fin.ctx
    ? `<p class="inote">The run record keeps what the Writer sent. It does not include a snapshot of `
      + `${esc(b.who)} — persona, skills and limits — so there is nothing more to show here.</p>` : "";
  return `<details${tid("inspect.context")} class="idis"><summary>Character context</summary>`
    + `<div class="idis-body">${sent}${snap}${missing}</div></details>`;
}

/** A persisted character-context snapshot, rendered only when the run record carries one.
 *  Every field is optional: a snapshot from any engine revision shows what it has. */
function definitionHtml(ctx) {
  if (ctx == null) return "";
  const list = v => (Array.isArray(v) ? v : []).map(s =>
    typeof s === "string" ? s : [s?.name, s?.meaning].filter(Boolean).join(" — ")).filter(Boolean);
  const field = (label, val) => val ? `<div class="kv"><span class="k">${esc(label)}</span>`
    + `<span class="v">${esc(val)}</span></div>` : "";
  const bullets = (label, items) => items.length ? `<div class="kv"><span class="k">${esc(label)}</span>`
    + `<span class="v">${items.map(esc).join("; ")}</span></div>` : "";
  const voice = list(ctx.voice).map(v => `<p class="cast-voice">“${esc(v)}”</p>`).join("");
  const body = field("Persona", ctx.persona) + field("Where they are", ctx.place)
    + field("What they know coming in", ctx.knows) + field("What they want", ctx.goal)
    + field("What they believe", ctx.belief) + field("How they act under pressure", ctx.impulse)
    + bullets("Skills", list(ctx.skills)) + bullets("Limits", list(ctx.restrictions ?? ctx.limits)) + voice;
  if (!body) return "";
  return `<div${tid("inspect.context-definition")} class="cdef">`
    + `<p class="charcard-eyebrow">As the character was set up for this consultation</p>${body}</div>`;
}

/** Rejected attempts, collapsed: the kept answer dominates, the superseded exchange waits one
 *  disclosure down for the "why did the final answer differ?" question. */
function previousHtml(b) {
  const attempts = (b.attempts || []).slice(0, -1);
  if (!attempts.length) return "";
  const n = attempts.length;
  return `<details${tid("inspect.prev-attempts")} class="idis"><summary>▸ ${n} previous attempt${n > 1 ? "s" : ""}</summary>`
    + `<div class="idis-body">${attempts.map(a =>
      `<section class="prev" aria-label="previous attempt ${esc(a.n)}">`
      + `<p class="charcard-eyebrow">Attempt ${esc(a.n)} — a fresh instance, no memory of it kept</p>`
      + `${attemptHtml(b, a, { final: false })}</section>`).join("")}</div></details>`;
}

/** Tertiary engine record: the decision as the Writer logged it (the character is only ever
 *  shown the situation -- prompts/consult.ts withholds the question), the judges' notes, and
 *  where this consultation sits. No model names or token counts: the run record carries none. */
function detailsHtml(b, store) {
  const attempts = b.attempts || [];
  const fin = attempts[attempts.length - 1] || {};
  const run = store === LIVEV ? "the live run" : `run ${READV.id || "on screen"}`;
  const judges = attempts.map(a => a.judge && (a.judge.verdict || a.judge.note)
    ? `<div class="kv"><span class="k">Attempt ${esc(a.n)} judged</span>`
      + `<span class="v">${esc(a.judge.verdict || "")}${a.judge.note ? ` — ${esc(a.judge.note)}` : ""}</span></div>`
    : "").join("");
  return `<details${tid("inspect.details")} class="idis"><summary>Details</summary><div class="idis-body">`
    + (fin.question ? `<div class="kv"><span class="k">The decision, on the Writer's record</span>`
      + `<span class="v">${esc(fin.question)}</span></div>`
      + `<p class="inote">The character was shown the situation above, not this wording.</p>` : "")
    + judges
    + (b.capped ? `<p class="inote">The re-ask limit was reached, so this answer stood.</p>` : "")
    + `<p class="inote">Consultation ${esc(b.seq)} · ${esc(run)}</p>`
    + `</div></details>`;
}

function headerHtml(b, store, st) {
  const start = (store.events || []).find(e => e.t === "scene_start");
  const chapter = start?.chapter ?? store.meta?.chapter ?? null;
  const question = store.meta?.question || "";
  const eyebrow = chapter != null ? `Consultation · Chapter ${esc(chapter)}` : "Consultation";
  // The character card (character-card.js) opens from a cast pill; bridge to it when one names
  // this character rather than duplicating its authored sheet here.
  const hasCard = [...document.querySelectorAll(".chip[data-char-name]")]
    .some(c => (c.dataset.charName || "").toLowerCase() === b.who.toLowerCase());
  return `<p class="eyebrow">${eyebrow}</p>`
    + `<div class="ihead"><h2>${esc(b.who)} <span class="was">was consulted</span></h2>`
    + `<button${tid("inspect.close")} class="btn" title="close (Esc)" aria-label="close consultation inspector">×</button></div>`
    + (question ? `<p class="iquest">“${esc(question)}”</p>` : "")
    + `<p${tid("inspect.status")} class="istat is-${st.key}"><span aria-hidden="true">${esc(st.glyph)}</span> ${esc(st.line)}</p>`
    + (hasCard ? `<div class="btns"><button${tid("inspect.charcard")} class="btn small" data-who="${esc(b.who)}">`
      + `about ${esc(b.who)} — character card</button></div>` : "");
}

/** The panel HTML for the open target, or "" when nothing is inspectable. A stale key (run
 *  changed underneath) clears itself rather than rendering another run's conversation. */
export function consultInspectorHtml(blocks) {
  const found = resolveInspected(blocks);
  if (!found) {
    if (APP.consultInspect) APP.consultInspect = null;
    return "";
  }
  const { block: b, store } = found;
  const st = consultStatus(b);
  const attempts = b.attempts || [];
  const fin = attempts[attempts.length - 1] || {};
  return `<section${tid("inspect.dialog")} class="inspect-panel" role="dialog" aria-modal="false"`
    + ` aria-label="consultation with ${esc(b.who)}" data-seq="${esc(b.seq)}">`
    + headerHtml(b, store, st)
    + `<div class="iconv" aria-label="conversation">`
    + (fin.answer || (fin.qa || []).length || fin.situation
      ? attemptHtml(b, fin, { final: true })
      : `<p class="inote">Nothing exchanged yet.</p>`)
    + `</div>`
    + contextHtml(b) + previousHtml(b) + detailsHtml(b, store)
    + `</section>`;
}

export function openConsultInspector(seq, invoker) {
  if (APP.view !== "live" && APP.view !== "read") return;
  const store = storeFor(APP.view);
  APP.consultInspect = { ...keyFor(APP.view, store, Number(seq)), invoker: invoker || null };
  APP.consultFocusPending = true;
  noteFocus(Number(seq));
}

/** Close and hand focus back to the consultation event that opened the panel. */
export function closeConsultInspector() {
  const inv = APP.consultInspect?.invoker;
  APP.consultInspect = null;
  APP.consultFocusPending = false;
  APP.consultFocusInside = false;
  APP.render();
  const sel = inv?.type === "timeline"
    ? `[data-tid="timeline.marker"][data-seq="${inv.seq}"]`
    : inv ? `[data-tid="consult.inspect-btn"][data-seq="${inv.seq}"]` : "";
  const el = sel ? document.querySelector(sel) : null;
  if (el instanceof HTMLElement) { try { el.focus(); } catch { /* keep focus where it is */ } }
}

/** A `&inspect=` deep link names a consultation the way `&block=` does; resolve it once the run
 *  it belongs to is on screen, and scroll to it like any other focus jump. */
export function settleInspectWant(blocks, view, store) {
  if (APP.inspectWant == null) return;
  const b = (blocks || []).find(x => x.kind === "consult" && Number(x.seq) === Number(APP.inspectWant));
  if (!b) return;
  APP.consultInspect = { ...keyFor(view, store, b.seq), invoker: null };
  APP.inspectWant = null;
  noteFocus(b.seq);
}

export function wireConsultInspector(root) {
  const panel = root.querySelector('[data-tid="inspect.dialog"]');
  if (!panel) return;
  panel.querySelector('[data-tid="inspect.close"]')
    ?.addEventListener("click", () => closeConsultInspector());
  panel.querySelector('[data-tid="inspect.charcard"]')
    ?.addEventListener("click", e => {
      const name = (e.currentTarget.dataset.who || "").toLowerCase();
      const chip = [...document.querySelectorAll(".chip[data-char-name]")]
        .find(c => (c.dataset.charName || "").toLowerCase() === name);
      if (chip instanceof HTMLElement) chip.click();
    });
  panel.addEventListener("focusin", () => { APP.consultFocusInside = true; });
  panel.addEventListener("focusout", () => { APP.consultFocusInside = false; });
  const close = panel.querySelector('[data-tid="inspect.close"]');
  if (APP.consultFocusPending) {
    APP.consultFocusPending = false;
    if (close instanceof HTMLElement) { try { close.focus(); } catch { /* keep focus where it is */ } }
  } else if (APP.consultFocusInside && document.activeElement === document.body
             && close instanceof HTMLElement) {
    try { close.focus(); } catch { /* keep focus where it is */ }
  }
}

/** The inline entry point inside each consult block. */
export function wireConsultInspectButtons(page) {
  for (const btn of page.querySelectorAll('[data-tid="consult.inspect-btn"]')) {
    btn.addEventListener("click", () => {
      openConsultInspector(Number(btn.dataset.seq), { type: "block", seq: Number(btn.dataset.seq) });
      APP.render();
    });
  }
}
