import { esc, tid } from "./util.js";
import { APP, LIVEV, READV } from "./state.js";
import { noteFocus } from "./nav.js";

/** A cast chip's 💬 shortcut: open one character's latest consultation in the run on screen.
 *  The button renders disabled while they have nothing to show, so reaching here with no
 *  consultation means the run moved on -- say so rather than opening nothing. */
function openCharacterConversation(name) {
  if (APP.view !== "live" && APP.view !== "read") return;
  const store = APP.view === "live" ? LIVEV : READV;
  const blocks = (store === READV ? READV.events : LIVEV.events) || [];
  const mine = blocks.filter(e => e.t === "consult"
    && String(e.character || "").toLowerCase() === String(name || "").toLowerCase());
  if (!mine.length) return;
  openConsultInspector(Number(mine[mine.length - 1].seq),
    { type: "chip", seq: Number(mine[mine.length - 1].seq), name });
  APP.render();
}
// ---- the consultation inspector -------------------------------------------
// A floating, modeless Character Behavior Inspector: one character's Writer ↔
// Character conversation as its primary view, with that character's standing across
// the whole run one step away.
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

/** Case-insensitive identity, the same funnel every engine comparison goes through. */
const sameWho = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

/** Every consult block addressed to one character, in run order — the whole run, not a filter. */
function consultsOf(blocks, who) {
  return (blocks || []).filter(b => b.kind === "consult" && sameWho(b.who, who));
}

/** Every group reaction one character answered, in run order. Each entry carries whether
 *  their volunteered deed was promoted: thought and speech are folded into the character's
 *  own history either way (fanout.ts), while an action joins it only through `[YOU ACTED]`
 *  on promotion — an un-taken impulse never becomes memory. */
function reactionsOf(blocks, who) {
  const out = [];
  for (const b of blocks || []) {
    if (b.kind !== "reaction") continue;
    const r = (b.reacted || []).find(x => sameWho(x.name, who));
    if (!r || (!r.thought && !r.speech && !r.action)) continue;
    const promoted = !!b.promoted && sameWho(b.promoted.character, who);
    out.push({ seq: b.seq, situation: b.situation || "", thought: r.thought || "",
               speech: r.speech || "", action: r.action || "", promoted });
  }
  return out;
}

/** One character's standing across the run on screen, in story words. */
function behaviorOf(blocks, who) {
  const consults = consultsOf(blocks, who);
  const attempts = consults.reduce((n, b) => n + (b.attempts || []).length, 0);
  const reasked = consults.filter(b => (b.attempts || []).length > 1).length;
  const askedBack = consults.filter(b => (b.attempts || []).some(a => (a.qa || []).length)).length;
  const flagged = consults.filter(b => (b.attempts || []).some(a => (a.flags || []).length)).length;
  const reactions = reactionsOf(blocks, who);
  const acted = reactions.filter(r => r.promoted && r.action).length;
  return { consults: consults.length, attempts, reasked, askedBack, flagged,
           reactions: reactions.length, acted };
}

function behaviorLine(who, beh) {
  const bits = [`${beh.consults} consult${beh.consults === 1 ? "" : "s"}`];
  if (beh.reasked) bits.push(`reasked ×${beh.reasked}`);
  if (beh.askedBack) bits.push(`asked back ×${beh.askedBack}`);
  if (beh.flagged) bits.push(`flagged ×${beh.flagged}`);
  if (beh.reactions) bits.push(`${beh.reactions} reaction${beh.reactions === 1 ? "" : "s"}`
    + (beh.acted ? ` (${beh.acted} acted)` : ""));
  return `${who} across this run: ${bits.join(" · ")}`;
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

function headerHtml(b, store, st, blocks) {
  const start = (store.events || []).find(e => e.t === "scene_start");
  const chapter = start?.chapter ?? store.meta?.chapter ?? null;
  const question = store.meta?.question || "";
  const eyebrow = chapter != null ? `Consultation · Chapter ${esc(chapter)}` : "Consultation";
  // The character card (character-card.js) opens from a cast pill; bridge to it when one names
  // this character rather than duplicating its authored sheet here.
  const hasCard = [...document.querySelectorAll(".chip[data-char-name]")]
    .some(c => (c.dataset.charName || "").toLowerCase() === b.who.toLowerCase());
  // Whole-run stepping: the consults before and after this one addressed to the same character,
  // in run order. One character, one conversation continued across the scene.
  const sibs = consultsOf(blocks, b.who);
  const at = sibs.findIndex(x => Number(x.seq) === Number(b.seq));
  const prev = at > 0 ? sibs[at - 1] : null;
  const next = at >= 0 && at < sibs.length - 1 ? sibs[at + 1] : null;
  const pos = at >= 0 ? ` · ${at + 1} of ${sibs.length}` : "";
  const nav = sibs.length > 1
    ? `<div class="inav" role="group" aria-label="more consultations with ${esc(b.who)}">`
      + (prev ? `<button${tid("inspect.prev")} class="btn small" data-inspect-seq="${esc(prev.seq)}"`
        + ` title="previous consultation with ${esc(b.who)}" aria-label="previous consultation with ${esc(b.who)}">← prev</button>`
        : `<button${tid("inspect.prev")} class="btn small" disabled aria-disabled="true">← prev</button>`)
      + `<span class="ipos"${tid("inspect.pos")}>${esc(at + 1)} of ${esc(sibs.length)}</span>`
      + (next ? `<button${tid("inspect.next")} class="btn small" data-inspect-seq="${esc(next.seq)}"`
        + ` title="next consultation with ${esc(b.who)}" aria-label="next consultation with ${esc(b.who)}">next →</button>`
        : `<button${tid("inspect.next")} class="btn small" disabled aria-disabled="true">next →</button>`)
      + `</div>`
    : "";
  return `<p class="eyebrow">${eyebrow}</p>`
    + `<div class="ihead"><h2>${esc(b.who)} <span class="was">was consulted</span></h2>`
    + `<button${tid("inspect.close")} class="btn" title="close (Esc)" aria-label="close consultation inspector">×</button></div>`
    + (question ? `<p class="iquest">“${esc(question)}”</p>` : "")
    + `<p${tid("inspect.status")} class="istat is-${st.key}"><span aria-hidden="true">${esc(st.glyph)}</span> ${esc(st.line)}</p>`
    + `<p${tid("inspect.behavior")} class="ibehav">${esc(behaviorLine(b.who, behaviorOf(blocks, b.who)))}${esc(pos)}</p>`
    + nav
    + (hasCard ? `<div class="btns"><button${tid("inspect.charcard")} class="btn small" data-who="${esc(b.who)}">`
      + `about ${esc(b.who)} — character card</button></div>` : "");
}

/** One group reaction from a single character's side: the shared beat they answered,
 *  and what they gave. A promoted deed reads as acted; any other volunteered deed stayed
 *  an impulse — the page and the character's memory never disagree. */
function reactionMiniHtml(r, who) {
  const parts = [];
  if (r.speech) parts.push(`<div class="speech">“${esc(r.speech)}”</div>`);
  if (r.action) parts.push(r.promoted
    ? `<div class="action">acted: ${esc(r.action)}</div>`
    : `<div class="thought dim">impulse, not taken: ${esc(r.action)}</div>`);
  if (r.thought) parts.push(`<div class="thought">${esc(r.thought)}</div>`);
  return msgHtml("writer", "The group was asked", paras(r.situation || "(the shared beat)"),
      { tidName: "inspect.writer-msg" })
    + msgHtml(who, `${who} reacted`, parts.join("") || `<div class="thought">took the moment in</div>`,
      { tidName: "inspect.character-msg" });
}

/** The rest of this character's run, one disclosure down: their other consultations and
 *  every group reaction they answered. The open consultation above stays the primary view;
 *  this answers "what else did they do?" without leaving the panel. */
function runMoreHtml(b, blocks) {
  const others = consultsOf(blocks, b.who).filter(x => Number(x.seq) !== Number(b.seq));
  const reacts = reactionsOf(blocks, b.who);
  if (!others.length && !reacts.length) return "";
  const n = others.length + reacts.length;
  const consultRows = others.map(o => {
    const fin = (o.attempts || [])[(o.attempts || []).length - 1] || {};
    const text = String(fin.situation || fin.question || "").trim().replace(/\s+/g, " ");
    const snip = text.length > 90 ? text.slice(0, 90) + "…" : text || "(no exchange yet)";
    const st = consultStatus(o);
    const state = st.key === "waiting" ? "waiting" : st.attempts > 1 ? "reasked" : "decided";
    return `<button class="imorelink" data-inspect-seq="${esc(o.seq)}"${tid("inspect.jump")}>`
      + `<span class="k">consultation ${esc(o.seq)} · ${esc(state)}</span>`
      + `<span class="v">${esc(snip)}</span></button>`;
  }).join("");
  const reactRows = reacts.map(r =>
    `<section class="prev" aria-label="group reaction ${esc(r.seq)}">`
    + `<p class="charcard-eyebrow">Group reaction · ${r.promoted && r.action ? "deed acted" : "moment taken in"}</p>`
    + `${reactionMiniHtml(r, b.who)}</section>`).join("");
  const memoryNote = reacts.length
    ? `<p class="inote">What a reaction leaves in memory: what they felt and said, always;`
      + ` a volunteered deed only when the writer made it real.</p>` : "";
  return `<details${tid("inspect.run-more")} class="idis"><summary>▸ More from ${esc(b.who)} in this run (${n})</summary>`
    + `<div class="idis-body">${consultRows}${reactRows}${memoryNote}</div></details>`;
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
    + headerHtml(b, store, st, blocks)
    + `<div class="iconv" aria-label="conversation">`
    + (fin.answer || (fin.qa || []).length || fin.situation
      ? attemptHtml(b, fin, { final: true })
      : `<p class="inote">Nothing exchanged yet.</p>`)
    + `</div>`
    + contextHtml(b) + previousHtml(b) + runMoreHtml(b, blocks) + detailsHtml(b, store)
    + `</section>`;
}

export function openConsultInspector(seq, invoker) {
  if (APP.view !== "live" && APP.view !== "read") return;
  const store = storeFor(APP.view);
  APP.consultInspect = { ...keyFor(APP.view, store, Number(seq)), invoker: invoker || null };
  APP.consultFocusPending = true;
  noteFocus(Number(seq));
}

/** Close and hand focus back to whatever opened the panel: a timeline marker, an inline
 *  consult's inspect button, or a cast chip's chat shortcut. */
export function closeConsultInspector() {
  const inv = APP.consultInspect?.invoker;
  APP.consultInspect = null;
  APP.consultFocusPending = false;
  APP.consultFocusInside = false;
  APP.render();
  let el = null;
  if (inv?.type === "timeline") {
    el = document.querySelector(`[data-tid="timeline.marker"][data-seq="${inv.seq}"]`);
  } else if (inv?.type === "chip" && inv?.name) {
    el = [...document.querySelectorAll('[data-tid="cast.chat"]')]
      .find(b => String(b.dataset.chatFor || "").toLowerCase() === String(inv.name).toLowerCase()) ?? null;
  } else if (inv) {
    el = document.querySelector(`[data-tid="consult.inspect-btn"][data-seq="${inv.seq}"]`);
  }
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

/** Step the open panel to another consultation in the same run. The original invoker is
 *  kept, so closing still hands focus back to the event that opened the panel; the page's
 *  own focus tag follows, keeping panel and prose in sync and the URL addressable. */
export function stepInspector(seq) {
  if (!APP.consultInspect) return;
  APP.consultInspect = { ...APP.consultInspect, seq: Number(seq) };
  APP.consultFocusPending = true;
  noteFocus(Number(seq));
  APP.render();
}

export function wireConsultInspector(root) {
  const panel = root.querySelector('[data-tid="inspect.dialog"]');
  if (!panel) return;
  panel.querySelector('[data-tid="inspect.close"]')
    ?.addEventListener("click", () => closeConsultInspector());
  for (const btn of panel.querySelectorAll("[data-inspect-seq]")) {
    btn.addEventListener("click", () => stepInspector(Number(btn.dataset.inspectSeq)));
  }
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

// The chat shortcut sits beside its pill, not inside it -- so the pill's own capture-phase card
// handler never sees the click (closest("[data-char-name]") misses a sibling), and this bubble
// listener is the only one that fires. stopPropagation keeps it from reaching anything else.
document.addEventListener("click", e => {
  const btn = e.target instanceof Element ? e.target.closest("[data-chat-for]") : null;
  if (!btn || btn.disabled) return;
  e.stopPropagation();
  openCharacterConversation(btn.dataset.chatFor);
});
