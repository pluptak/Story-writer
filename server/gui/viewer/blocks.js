import { esc, post, verdictText, reasonOr, tid } from "./util.js";
import { APP, open } from "./state.js";

// The glyph prefixing each non-critical note pill — a quick tone read before the tooltip.
const NOTE_ICON = { warn:"⚑", bad:"◯", info:"+" };

// ---- rendering ----------------------------------------------------------
export const paras = t => String(t).split(/\n{2,}/).map(p => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");

function renderConsult(b) {
  const retried = b.attempts.length > 1;
  const flagged = b.attempts.some(a => a.flags.length);
  const asked   = b.attempts.some(a => a.qa.length);
  const isOpen  = APP.expandAll || open.has(b.seq);
  // An open beat sends no question, so the situation is the ask and the header shows that.
  const q = b.attempts[0]?.question || b.attempts[0]?.situation || "";
  const tags = [
    asked   ? '<span class="tag asked" data-tid="consult.tag">asked back</span>' : "",
    retried ? `<span class="tag retry" data-tid="consult.tag">${b.attempts.length - 1} retry</span>` : "",
    flagged ? '<span class="tag flag" data-tid="consult.flag">flagged</span>' : "",
  ].join("");

  const attempts = b.attempts.map((a, i) => {
    const ans = a.answer;
    return `<div class="attempt" data-tid="consult.attempt" data-n="${esc(a.n)}">
      <h4>${b.attempts.length > 1 ? `attempt ${esc(a.n)}${a.n > 1 ? " — fresh instance, no memory of the last" : ""}` : "asked"}</h4>
      <div class="kv dim" data-tid="consult.situation"><span class="k">situation given</span><span class="v">${esc(a.situation)}</span></div>
      ${a.question ? `<div class="kv" data-tid="consult.question"><span class="k">question</span><span class="v">${esc(a.question)}</span></div>` : ""}
      ${a.qa.map(x => `<div class="qa" data-tid="consult.qa"><div class="ask">${esc(x.q)}</div><div class="ans">${esc(x.a)}</div></div>`).join("")}
      ${a.flags.map(f => `<div class="kv dim" data-tid="consult.flag"><span class="k">note</span><span class="v">${esc(f)}</span></div>`).join("")}
      ${ans ? `<div class="ansblock" data-tid="consult.answer">
          ${ans.speech ? `<div class="speech">“${esc(ans.speech)}”</div>` : ""}
          ${ans.action ? `<div class="action">${esc(ans.action)}</div>` : ""}
          ${ans.thought ? `<div class="thought">${esc(ans.thought)}</div>` : ""}
          ${ans.note ? `<div class="thought">note: ${esc(ans.note)}</div>` : ""}
        </div>` : ""}
      ${a.judge ? `<div${tid("consult.verdict")} class="verdict ${esc(a.judge.verdict)}">${esc(a.judge.verdict)}${a.judge.note ? " — " + esc(a.judge.note) : ""}</div>` : ""}
    </div>`;
  }).join("");

  return `<details ${tid("prose.consult")} class="consult" data-seq="${esc(b.seq)}"${isOpen ? " open" : ""}>
    <summary><span class="who">${esc(b.who)}</span><span class="qs">${esc(q)}</span>${tags}</summary>
    <div class="body">${attempts}</div>
  </details>`;
}

/** What you have half-typed into a pending reader's own-answer box, keyed by seq. The page rebuilds
 *  whole on every SSE frame, so without this the box empties under you mid-sentence -- every other
 *  input surface got the draft treatment (state.js's hdraft/draft); this is that, local to here. */
const ownDrafts = new Map();
/** Run reset = a new scene with its own seq numbering; stale drafts must never resurface. */
export const clearReaderDrafts = () => ownDrafts.clear();

/** `interactive` is false for a reader consult read off a saved run -- there is no live loop on the
 *  other end of `/reader-answer` for it to reach, so it renders as a fact about how the run went
 *  rather than as a question with working buttons. */
function renderReader(b, interactive) {
  if (b.answer !== null || !interactive) {
    ownDrafts.delete(b.seq);
    return `<div ${tid("prose.reader")} class="reader answered" data-seq="${esc(b.seq)}">
      <div class="rlabel">${b.answer !== null ? "you were asked" : "the writer asked — left unanswered in this run"}</div>
      <div class="rframing">${esc(b.framing)}</div>
      ${b.answer !== null ? `<div class="rchosen">chose: <b>${esc(b.answer)}</b></div>` : ""}
    </div>`;
  }
  const opts = b.options.map((o, i) =>
    `<button ${tid("reader.opt")} class="btn readerOpt" data-seq="${esc(b.seq)}" data-i="${i}">${esc(o)}</button>`).join("");
  const err = APP.readerError && APP.readerError.seq === b.seq
    ? `<div class="ctrl-err" style="margin-top:8px">${esc(APP.readerError.text)}</div>` : "";
  // The id matches FIELDS (state.js) so keepFocus carries caret across the re-render each frame causes.
  return `<div ${tid("prose.reader")} class="reader pending" data-seq="${esc(b.seq)}">
    <div class="rlabel">the writer wants your call</div>
    <div class="rframing">${esc(b.framing)}</div>
    <div class="btns">${opts}</div>
    <div class="field"><textarea ${tid("reader.own-input")} class="readerOwn" id="r-say-${esc(b.seq)}" data-seq="${esc(b.seq)}" rows="2"
              placeholder="or write your own">${esc(ownDrafts.get(b.seq) || "")}</textarea></div>
    <div class="btns"><button ${tid("reader.send-btn")} class="btn primary readerSend" data-seq="${esc(b.seq)}">send</button></div>
    ${err}
  </div>`;
}

export function wireReader(page) {
  for (const ta of page.querySelectorAll(".readerOwn"))
    ta.addEventListener("input", () => ownDrafts.set(Number(ta.dataset.seq), ta.value));
  for (const b of page.querySelectorAll(".readerOpt"))
    b.addEventListener("click", () => sendReaderAnswer(Number(b.dataset.seq), b.textContent));
  for (const b of page.querySelectorAll(".readerSend"))
    b.addEventListener("click", () => {
      const ta = page.querySelector(`.readerOwn[data-seq="${b.dataset.seq}"]`);
      const text = (ta?.value || "").trim();
      if (text) sendReaderAnswer(Number(b.dataset.seq), text);
    });
}
/** One answer. A second click is not a second choice — and the first one takes a moment to come
 *  back as an event, which is exactly the window in which it used to be clicked again. */
let readerSending = false;
async function sendReaderAnswer(seq, answer) {
  if (readerSending) return;
  readerSending = true;
  APP.readerError = null;
  for (const b of document.querySelectorAll(".reader.pending .btn")) b.disabled = true;
  const j = await post("/reader-answer", { answer }, false);
  readerSending = false;
  if (!j || j.ok === false) { APP.readerError = { seq, text: reasonOr(j, "that did not go through") }; APP.render(); }
}

/** One group reaction: a shared beat several present-but-not-acting characters answered at once.
 *  Each shows its thought and any line they actually gave; the one deed the writer promoted is
 *  marked acted, the rest stay impulses. */
function renderReaction(b) {
  const rows = b.reacted.map(r => {
    const promoted = b.promoted && b.promoted.character.toLowerCase() === r.name.toLowerCase();
    const act = r.action
      ? (promoted ? `<div class="action">acted: ${esc(r.action)}</div>`
                  : `<div class="thought dim">impulse, not taken: ${esc(r.action)}</div>`)
      : "";
    const said = r.speech ? `<div class="speech">says: ${esc(r.speech)}</div>` : "";
    return `<div class="rxone" data-tid="reaction.one" data-who="${esc(r.name)}"><div class="rxwho">${esc(r.name)}</div>
      <div class="thought">${esc(r.thought)}</div>${said}${act}</div>`;
  }).join("");
  return `<div ${tid("prose.reaction")} class="reaction" data-seq="${esc(b.seq)}">
    <div class="rxlabel">the others react</div>
    ${b.situation ? `<div class="kv dim"><span class="k">to</span><span class="v">${esc(b.situation)}</span></div>` : ""}
    ${rows}
  </div>`;
}

/** A block, rendered for whichever page is showing it. `interactive` gates the one thing that
 *  differs: a saved run's reader consult (if any) is a record, not a live question. */
export function renderBlock(b, interactive) {
  if (b.kind === "prose") return `<div${tid("prose.piece")} class="piece${b.salvaged ? " salvaged" : ""}">${
    b.salvaged ? `<div class="salvnote">recovered from a truncated draft</div>` : ""}${paras(b.text)}</div>`;
  if (b.kind === "consult") return renderConsult(b);
  if (b.kind === "reaction") return renderReaction(b);
  if (b.kind === "reader") return renderReader(b, interactive);
  if (b.kind === "exit") return `<div ${tid("prose.exit")} class="note exit" data-seq="${esc(b.seq)}">${esc(b.character)} left the scene${
    b.pov ? " — the point of view; the chapter ends here" : ""}</div>`;
  if (b.kind === "note") {
    // Critical notes (an answer never reached the page, a forced close) must stay as visible
    // text; so does everything when the owner expands all (locator/debug). Otherwise collapse to a
    // tooltip pill so the serif column keeps flowing.
    if (b.critical || APP.expandAll)
      return `<div ${tid("prose.note")} class="note tone-${b.tone}">${esc(b.text)}</div>`;
    return `<button ${tid("prose.note-pill")} type="button" class="npill tone-${b.tone}"
              title="${esc(b.text)}" aria-label="${esc(b.text)}">${NOTE_ICON[b.tone] || ""} ${esc(b.label)}</button>`;
  }
  if (b.kind === "end") return `<div ${tid("prose.end")} class="note end">${verdictText(b)} · ${esc(b.words)} words · ${esc(b.steps)} steps</div>`;
  return "";
}

/** Render a run's blocks, collapsing runs of non-critical notes into one pill row so the prose
 *  reads as a continuous column. Critical notes (and the expand-all view) render as their own
 *  footnotes; everything else becomes hover/click-tooltip pills inside a `.note-pills` flex row.
 *  Consults, reactions, reader consults and the end marker pass through untouched. */
export function renderBlocks(blocks, interactive) {
  const html = [];
  let run = [];
  const flush = () => {
    if (run.length) {
      html.push(`<div class="note-pills" data-tid="prose.note-pills">${run.map(b => renderBlock(b, interactive)).join("")}</div>`);
      run = [];
    }
  };
  for (const b of blocks) {
    if (b.kind === "note" && !b.critical && !APP.expandAll) { run.push(b); continue; }
    flush();
    html.push(renderBlock(b, interactive));
  }
  flush();
  return html.join("");
}
