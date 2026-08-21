import { esc, post, verdictText, reasonOr } from "./util.js";
import { APP, open } from "./state.js";

// ---- rendering ----------------------------------------------------------
export const paras = t => String(t).split(/\n{2,}/).map(p => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");

function renderConsult(b) {
  const retried = b.attempts.length > 1;
  const flagged = b.attempts.some(a => a.flags.length);
  const asked   = b.attempts.some(a => a.qa.length);
  const isOpen  = APP.expandAll || open.has(b.seq);
  const q = b.attempts[0]?.question || "";
  const tags = [
    asked   ? '<span class="tag asked">asked back</span>' : "",
    retried ? `<span class="tag retry">${b.attempts.length - 1} retry</span>` : "",
    flagged ? '<span class="tag flag">flagged</span>' : "",
  ].join("");

  const attempts = b.attempts.map((a, i) => {
    const ans = a.answer;
    return `<div class="attempt">
      <h4>${b.attempts.length > 1 ? `attempt ${esc(a.n)}${a.n > 1 ? " — fresh instance, no memory of the last" : ""}` : "asked"}</h4>
      <div class="kv dim"><span class="k">situation given</span><span class="v">${esc(a.situation)}</span></div>
      <div class="kv"><span class="k">question</span><span class="v">${esc(a.question)}</span></div>
      ${a.qa.map(x => `<div class="qa"><div class="ask">${esc(x.q)}</div><div class="ans">${esc(x.a)}</div></div>`).join("")}
      ${a.flags.map(f => `<div class="kv dim"><span class="k">note</span><span class="v">${esc(f)}</span></div>`).join("")}
      ${ans ? `<div class="ansblock">
          ${ans.speech ? `<div class="speech">“${esc(ans.speech)}”</div>` : ""}
          ${ans.action ? `<div class="action">${esc(ans.action)}</div>` : ""}
          ${ans.thought ? `<div class="thought">${esc(ans.thought)}</div>` : ""}
          ${ans.note ? `<div class="thought">note: ${esc(ans.note)}</div>` : ""}
          <div class="skills">${(ans.skills_used||[]).map(s =>
            (ans.unverified||[]).includes(s) ? `<span class="bad">${esc(s)}✗</span>` : esc(s)).join(" · ") || "no skills listed"}</div>
        </div>` : ""}
      ${a.judge ? `<div class="verdict ${esc(a.judge.verdict)}">${esc(a.judge.verdict)}${a.judge.note ? " — " + esc(a.judge.note) : ""}</div>` : ""}
    </div>`;
  }).join("");

  return `<details class="consult" data-seq="${esc(b.seq)}"${isOpen ? " open" : ""}>
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
    return `<div class="reader answered">
      <div class="rlabel">${b.answer !== null ? "you were asked" : "the writer asked — left unanswered in this run"}</div>
      <div class="rframing">${esc(b.framing)}</div>
      ${b.answer !== null ? `<div class="rchosen">chose: <b>${esc(b.answer)}</b></div>` : ""}
    </div>`;
  }
  const opts = b.options.map((o, i) =>
    `<button class="btn readerOpt" data-seq="${esc(b.seq)}" data-i="${i}">${esc(o)}</button>`).join("");
  const err = APP.readerError && APP.readerError.seq === b.seq
    ? `<div class="ctrl-err" style="margin-top:8px">${esc(APP.readerError.text)}</div>` : "";
  // The id matches FIELDS (state.js) so keepFocus carries caret across the re-render each frame causes.
  return `<div class="reader pending" data-seq="${esc(b.seq)}">
    <div class="rlabel">the writer wants your call</div>
    <div class="rframing">${esc(b.framing)}</div>
    <div class="btns">${opts}</div>
    <div class="field"><textarea class="readerOwn" id="r-say-${esc(b.seq)}" data-seq="${esc(b.seq)}" rows="2"
              placeholder="or write your own">${esc(ownDrafts.get(b.seq) || "")}</textarea></div>
    <div class="btns"><button class="btn primary readerSend" data-seq="${esc(b.seq)}">send</button></div>
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
 *  Each shows its thought; the one deed the writer promoted is marked acted, the rest stay impulses. */
function renderReaction(b) {
  const rows = b.reacted.map(r => {
    const promoted = b.promoted && b.promoted.character.toLowerCase() === r.name.toLowerCase();
    const act = r.action
      ? (promoted ? `<div class="action">acted: ${esc(r.action)}</div>`
                  : `<div class="thought dim">impulse, not taken: ${esc(r.action)}</div>`)
      : "";
    return `<div class="rxone"><div class="rxwho">${esc(r.name)}</div>
      <div class="thought">${esc(r.thought)}</div>${act}</div>`;
  }).join("");
  return `<div class="reaction" data-seq="${esc(b.seq)}">
    <div class="rxlabel">the others react</div>
    ${b.situation ? `<div class="kv dim"><span class="k">to</span><span class="v">${esc(b.situation)}</span></div>` : ""}
    ${rows}
  </div>`;
}

/** A block, rendered for whichever page is showing it. `interactive` gates the one thing that
 *  differs: a saved run's reader consult (if any) is a record, not a live question. */
export function renderBlock(b, interactive) {
  if (b.kind === "prose") return `<div class="piece${b.salvaged ? " salvaged" : ""}">${
    b.salvaged ? `<div class="salvnote">recovered from a truncated draft</div>` : ""}${paras(b.text)}</div>`;
  if (b.kind === "consult") return renderConsult(b);
  if (b.kind === "reaction") return renderReaction(b);
  if (b.kind === "reader") return renderReader(b, interactive);
  if (b.kind === "exit") return `<div class="note exit" data-seq="${esc(b.seq)}">${esc(b.character)} left the scene${
    b.pov ? " — the point of view; the chapter ends here" : ""}</div>`;
  if (b.kind === "note") return `<div class="note">${esc(b.text)}</div>`;
  if (b.kind === "end") return `<div class="note end">${verdictText(b)} · ${esc(b.words)} words · ${esc(b.steps)} steps</div>`;
  return "";
}
