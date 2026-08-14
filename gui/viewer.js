(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
  const fmtRun = r => {
    const when = new Date(r.mtimeMs).toLocaleString(undefined,
      { month:"short", day:"numeric", hour:"numeric", minute:"2-digit" });
    const status = r.stopped ? "stopped" : r.done ? "finished" : r.words != null ? "unfinished" : "no output";
    return [when, r.words != null ? `${r.words}w` : "", status].filter(Boolean).join(" · ");
  };

  let events = [];            // every RunEvent seen, in seq order
  // /events REPLAYS the whole run before it attaches, and EventSource reconnects on its own after
  // any blip. Without this the replay appends a second copy of the scene, and the page grows one
  // whole scene per reconnect — which reads as "the story will not close".
  let seen = new Set();
  let meta = null;            // from /run, when serving
  let composing = null;       // ephemeral: {who, secs, chars}
  let session = { running:false, stopping:false, where:"", picking:false, armed:false,
                  paused:false, pausing:false, model:null };  // the process, not the story
  let live = false;           // attached to a running engine, as opposed to reading a saved log
  let armed = 0;              // timer id: the stop button is waiting for its confirming second click
  let stories = null;         // story cards from /stories, while the session waits for a choice
  let picked = "";            // a choice already sent; keeps a double-click from being two picks
  let scaffold = { active:false };   // the interview, from /scaffold and its SSE frames
  let ideaOpen = false;       // "new story…" clicked; no interview on the server yet
  let ivHidden = false;       // the interview modal is closed WITHOUT abandoning it (F2) -- reopened
                               // by the same "new story…" card, which relabels itself while it is true
  let personasFull = false;
  let acceptArmed = 0;        // timer id: accepting over a complaint (or over unsent text) wants a second click
  let abandonArmed = 0;       // timer id: so does throwing the whole interview away
  let scaffoldError = "";     // the last refusal from /scaffold/*, said out loud in the modal
  // Re-render is whole, which would otherwise eat what you are typing mid-round. Drafts live out
  // here and are written back in; focus is read off the document as the render begins, rather than
  // tracked through focus/blur — removing a focused node does not reliably fire blur, and a click on
  // any button would clear a tracked value before the re-render it triggered.
  const draft = { idea:"", say:"", folder:"", model:"", length:"" };
  const FIELDS = /^f-(idea|say|folder|model|length)$/;
  let modelIds = [];          // what LM Studio has loaded; fetched once, used by both dropdowns
  let modelDefault = "";      // the model an interview would use if you chose nothing
  const open = new Set();     // which consults are expanded, by seq — survives re-render
  let expandAll = false;
  let wantReaderView = false; // a reader consult just arrived: scroll to it once it is rendered

  // ---- grouping -----------------------------------------------------------
  // Events are flat and in order; the page is not. A consult and everything it produced (questions
  // back, repairs, retries, the answer, the verdict) becomes ONE foldable block sitting where it
  // happened. A retry arrives as another `consult` with attempt > 1, so it joins the block it
  // belongs to rather than starting a new one.
  function build() {
    const blocks = []; let cur = null;
    for (const e of events) {
      switch (e.t) {
        case "scene_start": if (!meta) meta = { story:e.story, target:e.target, characters:(e.characters||[]).map(n=>({name:n,skills:[],lacks:[]})) }; break;
        case "draft":
          if (e.prose) { blocks.push({ kind:"prose", seq:e.seq, text:e.prose, salvaged:!!e.salvaged }); }
          break;
        case "consult": {
          if (!cur || e.attempt === 1) { cur = { kind:"consult", seq:e.seq, who:e.character, attempts:[] }; blocks.push(cur); }
          cur.attempts.push({ n:e.attempt, situation:e.situation, question:e.question, wants:e.wants, qa:[], flags:[] });
          break;
        }
        case "clarify":   last(cur)?.qa.push({ q:e.question, a:e.answer }); break;
        case "forced":    last(cur)?.flags.push("answered without the detail it asked for"); break;
        case "repair":    last(cur)?.flags.push("re-asked: " + e.why); break;
        case "skill_flag":last(cur)?.flags.push("used what it cannot do: " + (e.unknown||[]).join(", ")); break;
        case "answer":    if (last(cur)) last(cur).answer = e; break;
        case "judge":     if (last(cur)) last(cur).judge = e; break;
        case "accept":    if (cur) { cur.accepted = e; cur = null; } break;
        case "budget":    blocks.push({ kind:"note", seq:e.seq, text:`+${e.added} steps (budget now ${e.budget})` }); break;
        case "reader_ask": blocks.push({ kind:"reader", seq:e.seq, framing:e.framing, options:e.options||[], answer:null }); break;
        case "reader_answer": {
          const rb = [...blocks].reverse().find(b => b.kind === "reader" && b.answer === null);
          if (rb) rb.answer = e.answer;
          break;
        }
        case "bad_consult": blocks.push({ kind:"note", seq:e.seq, text:`consult to ${e.character} not sent — ${e.why}` }); break;
        case "model_changed": blocks.push({ kind:"note", seq:e.seq, text:`model switched to ${e.model}` }); break;
        case "scene_end": blocks.push({ kind:"end", seq:e.seq, ...e }); break;
      }
    }
    return blocks;
  }
  const last = c => c && c.attempts[c.attempts.length - 1];

  // ---- rendering ----------------------------------------------------------
  const paras = t => String(t).split(/\n{2,}/).map(p => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");

  function renderConsult(b) {
    const retried = b.attempts.length > 1;
    const flagged = b.attempts.some(a => a.flags.length);
    const asked   = b.attempts.some(a => a.qa.length);
    const isOpen  = expandAll || open.has(b.seq);
    const q = b.attempts[0]?.question || "";
    const tags = [
      asked   ? '<span class="tag asked">asked back</span>' : "",
      retried ? `<span class="tag retry">${b.attempts.length - 1} retry</span>` : "",
      flagged ? '<span class="tag flag">flagged</span>' : "",
    ].join("");

    const attempts = b.attempts.map((a, i) => {
      const ans = a.answer;
      return `<div class="attempt">
        <h4>${b.attempts.length > 1 ? `attempt ${a.n}${a.n > 1 ? " — fresh instance, no memory of the last" : ""}` : "asked"}</h4>
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
        ${a.judge ? `<div class="verdict ${a.judge.verdict}">${a.judge.verdict}${a.judge.note ? " — " + esc(a.judge.note) : ""}</div>` : ""}
      </div>`;
    }).join("");

    return `<details class="consult" data-seq="${b.seq}"${isOpen ? " open" : ""}>
      <summary><span class="who">${esc(b.who)}</span><span class="qs">${esc(q)}</span>${tags}</summary>
      <div class="body">${attempts}</div>
    </details>`;
  }

  function renderReader(b) {
    if (b.answer !== null) {
      return `<div class="reader answered">
        <div class="rlabel">you were asked</div>
        <div class="rframing">${esc(b.framing)}</div>
        <div class="rchosen">chose: <b>${esc(b.answer)}</b></div>
      </div>`;
    }
    const opts = b.options.map((o, i) =>
      `<button class="btn readerOpt" data-seq="${b.seq}" data-i="${i}">${esc(o)}</button>`).join("");
    return `<div class="reader pending" data-seq="${b.seq}">
      <div class="rlabel">the writer wants your call</div>
      <div class="rframing">${esc(b.framing)}</div>
      <div class="btns">${opts}</div>
      <div class="field"><textarea class="readerOwn" data-seq="${b.seq}" rows="2"
                placeholder="or write your own"></textarea></div>
      <div class="btns"><button class="btn primary readerSend" data-seq="${b.seq}">send</button></div>
    </div>`;
  }

  function wireReader(page) {
    for (const b of page.querySelectorAll(".readerOpt"))
      b.addEventListener("click", () => sendReaderAnswer(b.textContent));
    for (const b of page.querySelectorAll(".readerSend"))
      b.addEventListener("click", () => {
        const ta = page.querySelector(`.readerOwn[data-seq="${b.dataset.seq}"]`);
        const text = (ta?.value || "").trim();
        if (text) sendReaderAnswer(text);
      });
  }
  /** One answer. A second click is not a second choice — and the first one takes a moment to come
   *  back as an event, which is exactly the window in which it used to be clicked again. */
  let readerSending = false;
  async function sendReaderAnswer(answer) {
    if (readerSending) return;
    readerSending = true;
    for (const b of document.querySelectorAll(".reader.pending .btn")) b.disabled = true;
    const j = await post("/reader-answer", { answer });
    readerSending = false;
    if (!j || j.ok === false) render();          // put the buttons back; `post` has said why
  }

  // ---- the picker ---------------------------------------------------------
  // Shown while the session is parked waiting for a story, and rendered ABOVE the prose rather than
  // instead of it: a scene that has just finished must not be shoved off the page by the question of
  // what to write next.
  function pickerHtml() {
    if (!stories) return `<section class="picker"><h2>Choose a story</h2>
      <p class="sub">reading the shelf…</p></section>`;

    const cast = s => (s.characters || []).map(c => {
      const bits = [];
      if (c.can?.length) bits.push(`<span class="yes">+${esc(c.can.join(", "))}</span>`);
      if (c.cannot?.length) bits.push(`<span class="no">no ${esc(c.cannot.join(", "))}</span>`);
      return `<span class="chip"><b>${esc(c.name)}</b>${bits.length ? " " + bits.join(" ") : ""}</span>`;
    }).join("");

    const cards = stories.map(s => {
      // A story that does not load says so here, and cannot be chosen — the same pre-flight the CLI
      // runs, so the card cannot disagree with what a run would do.
      const dead = !s.ok || !!picked;
      const card = `<button class="card" data-dir="${esc(s.dir)}"${dead ? " disabled" : ""}>
        <div class="name">${esc(s.name)}</div>
        ${s.ok ? `<p class="q">${esc(s.scene?.question || "(no scene question)")}</p>
                  <p class="pre">${esc(s.premise || "")}</p>
                  <div class="row">${cast(s)}<span class="meta">~${s.scene?.length ?? "?"} words
                    · ${s.maxSteps ?? "?"} steps${s.scene?.pov ? " · pov " + esc(s.scene.pov) : ""}</span></div>`
                : `<div class="bad">does not load — ${esc(s.error || "unknown error")}</div>`}
        ${(s.warnings || []).map(w => `<div class="warn">⚠ ${esc(w)}</div>`).join("")}
      </button>`;
      // Retained runs sit BESIDE the card, not inside it -- a <button> cannot nest another button,
      // and each past run needs its own click target ("read", not "start a new run").
      const runs = (s.runs || []).length
        ? `<div class="runs">${s.runs.map(r => `<button class="btn runbtn" data-dir="${esc(s.dir)}"
             data-run="${esc(r.id)}">read · ${esc(fmtRun(r))}</button>`).join("")}</div>` : "";
      return `<div class="cardwrap">${card}${runs}</div>`;
    }).join("");

    // A finished scene stays on the page under the picker — §1's principle. But it has to be
    // dismissible, or the only way back to a clean shelf is a reload, and a reload brings it back.
    const clear = events.length
      ? ` · <a href="#" id="clear-scene" style="color:var(--accent)">clear the last scene</a>` : "";
    return `<section class="picker">
      <h2>Choose a story</h2>
      <p class="sub">${picked ? "starting…" : "the run begins as soon as you pick one"}${clear}</p>
      <div class="cards">${cards}
        <button class="card new" data-new="1"${picked ? " disabled" : ""}>
          <div class="name">${scaffold.active ? "continue new story…" : "new story…"}</div>
          <p class="q">${scaffold.active ? `back to "${esc(scaffold.idea || "")}"` : "describe an idea and have one built"}</p>
        </button>
      </div>
    </section>`;
  }

  async function choose(payload) {
    if (picked) return;                       // a double-click is one choice, not two
    picked = payload.new ? "new" : payload.dir;
    render();
    const j = await post("/select", payload);
    if (!j || j.ok === false) { picked = ""; render(); }   // `post` has already said why
  }

  function wirePicker(page) {
    for (const b of page.querySelectorAll(".card[data-dir]"))
      b.addEventListener("click", () => choose({ dir: b.dataset.dir }));
    for (const b of page.querySelectorAll(".card[data-new]"))
      b.addEventListener("click", () => {
        // Already going server-side (one ScaffoldSession, GUI-SPEC §6.1) -- this reopens the modal
        // rather than starting a second interview.
        if (scaffold.active) ivHidden = false; else ideaOpen = true;
        render();
      });
    const clear = page.querySelector("#clear-scene");
    if (clear) clear.addEventListener("click", e => {
      e.preventDefault();
      // The VIEW only. The run's log stays on disk and at /log.jsonl, because that is the record and
      // this is a reading pane.
      events = []; seen = new Set(); meta = null; composing = null; open.clear();
      $("cast").innerHTML = ""; $("question").textContent = ""; $("title").textContent = "story-writer";
      render();
    });
    for (const b of page.querySelectorAll(".runbtn"))
      b.addEventListener("click", async () => {
        const dir = b.dataset.dir, id = b.dataset.run;
        try {
          const r = await fetch(`/runs/log?dir=${encodeURIComponent(dir)}&id=${encodeURIComponent(id)}`);
          if (!r.ok) return;
          // Same view-only load as picking a saved file off disk (§7) -- the log on disk stays the
          // record, this only ever changes what the reading pane shows.
          setSrc(`${dir.replace(/^stories\//, "")} · saved run`, false);
          ingest(await r.text());
        } catch {}
      });
  }

  // ---- the interview ------------------------------------------------------
  // SPEC-S §4 in the browser. Conversation only: every change is a patch through the architect, the
  // same round the console sends, because both drive one ScaffoldSession. Nothing here decides
  // anything — it shows what the session decided and sends back what you said.
  const fld = (id, label, value, rows, disabled) =>
    `<div class="field"><label for="${id}">${label}</label>
      <textarea id="${id}" ${disabled ? "disabled" : ""} rows="${rows}"
                placeholder="">${esc(value)}</textarea></div>`;

  /**
   * Which model BUILDS the story — and, because the engine writes the same id into the new story's
   * `## Models`, which one will then write it. Before a story exists there is only one model in play
   * (SPEC-S §2), so this is one choice, not two.
   *
   * It sits on the idea screen only. The architect agent is built when the interview starts, and
   * swapping it mid-interview would mean a new agent with none of the history that "it kept the
   * parts I liked" rests on; while one is open, the model is reported, not offered.
   */
  const modelField = () =>
    `<div class="field"><label for="f-model">built by</label>
      <select id="f-model">
        <option value=""${draft.model ? "" : " selected"}>defaults${
          modelDefault ? " · " + esc(modelDefault) : ""}</option>
        ${modelIds.map(id => `<option value="${esc(id)}"${draft.model === id ? " selected" : ""}>${esc(id)}</option>`).join("")}
      </select></div>`;

  function castHtml(spec) {
    return spec.characters.map(c => {
      const can = c.skills.map(s => esc(s.text) + (s.meaning ? ` <span style="color:var(--faint)">— ${esc(s.meaning)}</span>` : "")).join(", ");
      return `<div class="who">
        <div class="nm">${esc(c.name)}</div>
        ${can ? `<div class="line"><span class="k yes">can also</span>${can}</div>` : ""}
        ${c.lacks.length ? `<div class="line"><span class="k no">cannot</span>${esc(c.lacks.join(", "))}</div>` : ""}
        ${c.knows ? `<div class="line"><span class="k">knows</span>${esc(c.knows)}</div>` : ""}
        <div class="persona${personasFull ? "" : " clip"}">${esc(c.persona)}</div>
      </div>`;
    }).join("");
  }

  /** How long the scene should be, as a number you can type over. The only field edited DIRECTLY
   *  rather than through the architect (GUI-SPEC §6.1): it is a dial, not a design decision, and
   *  spending a minute-long round on a word count is how you end up never changing it. `draft.length`
   *  holds what is being typed and is dropped once the engine answers, so a frame arriving mid-edit
   *  cannot yank the number back. */
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
      ${spec.writerStyle && personasFull
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
    const s = scaffold;
    const err = scaffoldError ? `<div class="said bad">${esc(scaffoldError)}</div>` : "";
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
      const acceptLabel = !acceptArmed ? "accept &amp; write it"
        : unsent ? "discard what you typed and write it"
        : `accept over ${flags} flag(s)`;
      row.push(`<button class="btn${unsent || !s.haveStory ? " primary" : ""}" id="iv-say">send</button>`);
      if (acceptable) row.push(`<button class="btn${unsent || acceptArmed ? "" : " primary"}${
        acceptArmed ? " armed" : ""}" id="iv-accept">${acceptLabel}</button>`);
    }
    if (s.spec) row.push(`<button class="btn" id="iv-full">${personasFull ? "shorter" : "personas in full"}</button>`);
    if (!busy) row.push(`<span class="hint">↵ send · ⇧↵ new line</span>`);
    row.push(`<span class="spacer"></span>`);
    row.push(`<button class="btn${abandonArmed ? " armed" : ""}" id="iv-abandon">${
      abandonArmed ? "abandon — sure?" : "abandon"}</button>`);
    body.push(`<div class="btns">${row.join("")}</div>`);

    return `<section class="picker iv">
      <div class="iv-head"><h2>${s.haveStory ? "Does this look right?" : "A new story"}</h2>
        <button class="btn" id="iv-hide" title="close — keeps the interview going, reopen from the shelf">×</button></div>
      <p class="sub">${esc(s.idea)}${s.model ? ` <span class="hint">· built by ${esc(s.model)}</span>` : ""}</p>
      ${body.join("")}
    </section>`;
  }

  
  async function postScaffold(what, payload) {
    let j = null;
    try {
      const r = await fetch(`/scaffold/${what}`, { method:"POST", headers:{ "Content-Type":"application/json" },
                                                   body: JSON.stringify(payload || {}) });
      j = await r.json();
    } catch { scaffoldError = "the engine did not answer"; render(); return null; }
    if (j && j.active !== undefined) { scaffoldError = ""; scaffold = j; render(); return j; }
    if (j && j.ok) { scaffoldError = ""; render(); return j; }        // abandon, and a clean accept
    scaffoldError =
      j && j.kind === "unloadable"   ? `written to ${j.dir}, but it does not load — ${j.error}`
      : j && j.kind === "needs_folder" ? ""                            // the folder question renders itself
      : (j && j.reason) || "that did not go through";
    render();
    return j;
  }

  const disarmAccept  = () => { clearTimeout(acceptArmed);  acceptArmed  = 0; render(); };
  const disarmAbandon = () => { clearTimeout(abandonArmed); abandonArmed = 0; render(); };

  /**
   * A change, sent. **The text stays in the draft until the round actually lands.** It used to be
   * cleared before the POST, so a 409 or a dropped connection lost what you had written with nothing
   * said about it — the same failure as accepting over an unsent change, arriving a different way.
   */
  async function sendSay() {
    const text = draft.say.trim();
    if (!text || scaffold.busy) return;
    const j = await postScaffold("say", { text });
    if (j && j.active !== undefined) { draft.say = ""; render(); }
  }

  async function startInterview() {
    const idea = draft.idea.trim();
    if (!idea) return;
    scaffoldError = "";
    scaffold = { active:true, busy:true, idea, problems:[], haveStory:false, model:draft.model };
    render();
    const j = await postScaffold("start", { idea, model: draft.model });
    // A refusal leaves the page holding an optimistic "busy" that nothing will ever clear — it has
    // to fall back to the idea box, with the idea still in it, or the modal hangs until a reload.
    if (!j || j.active === undefined) { scaffold = { active:false }; ideaOpen = true; render(); }
  }

  function wireInterview(page) {
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
      render();
    });
    // Enter sends. There was no keyboard path to "send" at all, which is exactly what made the
    // primary button — accept — read as the default for a box whose entire purpose is a change.
    onKey("f-say", e => { if (e.key === "Enter" && plain(e)) { e.preventDefault(); sendSay(); } });
    // The idea is a paragraph, not a line, so here Enter stays a newline and the modifier sends.
    onKey("f-idea", e => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); startInterview(); }
    });
    onKey("f-folder", e => { if (e.key === "Enter" && plain(e)) { e.preventDefault(); acceptIntoFolder(); } });
    on("iv-back", () => { ideaOpen = false; render(); });
    on("iv-hide", () => { ivHidden = true; render(); });
    on("iv-start", startInterview);
    on("iv-say", sendSay);
    on("iv-full", () => { personasFull = !personasFull; render(); });
    on("iv-abandon", () => {
      // Abandoning throws away every round of an interview at once, and nothing on the server keeps
      // a copy. It gets the same confirming second click accepting does.
      if (!abandonArmed) { abandonArmed = setTimeout(disarmAbandon, 4000); render(); return; }
      clearTimeout(abandonArmed); abandonArmed = 0;
      postScaffold("abandon", {}).then(() => {
        scaffold = { active:false }; ideaOpen = false; ivHidden = false; scaffoldError = "";
        draft.idea = draft.say = draft.folder = "";
        render();
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
      const flagged = !!(scaffold.problems && scaffold.problems.length);
      if ((unsent || flagged) && !acceptArmed) { acceptArmed = setTimeout(disarmAccept, 5000); render(); return; }
      clearTimeout(acceptArmed); acceptArmed = 0;
      postScaffold("accept", {});
    });
  }

  /** Accept into a named folder — the answer to `needs_folder`. A blank name is not an answer, so it
   *  does nothing rather than re-asking the same question. */
  function acceptIntoFolder() {
    const folder = draft.folder.trim();
    if (folder) postScaffold("accept", { folder });
  }

  /** Give focus back to whatever field had it when the render began, caret at the end — and failing
   *  that, put it where the typing goes. A modal that opens with focus still on the page behind it
   *  makes the keyboard useless until you click, which is half of why the buttons were doing the
   *  talking. */
  function restoreFocus(page, id) {
    if (id) {
      const el = page.querySelector("#" + id);
      if (el && !el.disabled) {
        el.focus();
        try { el.setSelectionRange(el.value.length, el.value.length); } catch {}
        return;
      }
    }
    // Document order, so the folder question — which renders above the say box — takes the caret
    // while it is open. It is the thing being asked.
    const first = page.querySelector(".iv #f-folder:not([disabled]), .iv textarea:not([disabled])");
    if (first) first.focus();
  }

  function render() {
    const blocks = build();
    const page = $("page");
    const active = document.activeElement;
    const keepFocus = active && FIELDS.test(active.id || "") ? active.id : "";
    // The picker sits at the top of the reading column, above whatever scene is already there (§1's
    // principle). The interview (F2) is a MODAL over either one, not a slot inside them, so closing
    // it without abandoning never costs the page underneath.
    const chrome = session.picking ? pickerHtml() : "";
    const modal = (scaffold.active || ideaOpen) && !ivHidden
      ? `<div class="modal-backdrop" id="iv-backdrop" role="dialog" aria-modal="true"
              aria-label="new story">${interviewHtml()}</div>` : "";
    if (!blocks.length) {
      // Opening a saved log lives HERE rather than in the topbar, where "load run" sat one button
      // from "stop run" reading like a run control and duplicating drag-drop. This is where someone
      // with nothing loaded is already looking.
      page.innerHTML = (chrome || `<div class="empty"><h2>Nothing loaded yet</h2>
        <p>Run the engine with <code>--serve</code> to watch a scene as it is written, or drop a
        saved <code>out/writing-log.jsonl</code> onto this page.</p>
        <div class="btns" style="justify-content:center"><button class="btn" id="open-log">open a saved log</button></div>
        </div>`) + modal;
      $("rail").innerHTML = "";
      const ol = page.querySelector("#open-log");
      if (ol) ol.addEventListener("click", () => $("file").click());
      wirePicker(page); wireInterview(page); wireModal(page); restoreFocus(page, keepFocus);
      setFoldable(false);
      return;
    }
    page.innerHTML = chrome + `<div class="prose">` + blocks.map(b => {
      if (b.kind === "prose") return `<div class="piece${b.salvaged ? " salvaged" : ""}">${
        b.salvaged ? `<div class="salvnote">recovered from a truncated draft</div>` : ""}${paras(b.text)}</div>`;
      if (b.kind === "consult") return renderConsult(b);
      if (b.kind === "reader") return renderReader(b);
      if (b.kind === "note") return `<div class="note">${esc(b.text)}</div>`;
      if (b.kind === "end") return `<div class="note end">${
        b.stopped ? "stopped by request" : b.done ? "scene finished" : "stopped early"}
        · ${b.words} words · ${b.steps} steps</div>`;
      return "";
    }).join("") + `</div>` + modal;

    for (const d of page.querySelectorAll("details.consult")) {
      d.addEventListener("toggle", () => {
        const s = Number(d.dataset.seq);
        d.open ? open.add(s) : open.delete(s);
      });
    }
    wirePicker(page); wireInterview(page); wireReader(page); wireModal(page); restoreFocus(page, keepFocus);
    setFoldable(blocks.some(b => b.kind === "consult"));
    renderRail(blocks);
  }

  /** A run whose drafts were all salvaged has no consults in it at all, and "expand all" over a page
   *  with nothing foldable looks like a broken button rather than an empty run. Say which it is. */
  function setFoldable(foldable) {
    $("expand").disabled = !foldable;
    $("expand").title = foldable ? "" : "nothing to expand — no consults in this run";
  }

  /** Backdrop click closes (hides) the modal, same as the × button — never abandons. */
  function wireModal(page) {
    const bd = page.querySelector("#iv-backdrop");
    if (bd) bd.addEventListener("click", e => { if (e.target === bd) { ivHidden = true; render(); } });
  }

  function renderRail(blocks) {
    const words = events.filter(e => e.t === "draft").reduce((n, e) => Math.max(n, e.words || 0), 0);
    const target = meta?.target || 0;
    const consults = blocks.filter(b => b.kind === "consult");
    const count = t => events.filter(e => e.t === t).length;
    const pct = target ? Math.min(100, Math.round(words / target * 100)) : 0;
    const stat = (k, v, cls) => `<div class="stat"><span>${k}</span><span class="n ${cls||""}">${v}</span></div>`;
    const flags = count("skill_flag"), retries = count("retry");
    $("rail").innerHTML = `
      <h3>progress</h3>
      <div class="bar"><i style="width:${pct}%"></i></div>
      ${stat("words", target ? `${words} / ${target}` : words)}
      ${stat("steps", count("draft"))}
      ${stat("consults", consults.length)}
      ${stat("asked back", count("clarify"))}
      ${stat("retries", retries, retries ? "warn" : "")}
      ${stat("skill flags", flags, flags ? "bad" : "")}
      ${composing ? `<div class="composing"><i></i><span class="who">${esc(composing.who)}</span>
         composing… ${composing.secs}s</div>` : ""}`;
  }

  function renderHeader() {
    if (!meta) return;
    $("title").textContent = (meta.story || "").replace(/^.*[\\/]/, "") || "story-writer";
    $("question").textContent = meta.question || "";
    $("cast").innerHTML = (meta.characters || []).map(c => {
      const bits = [];
      if (c.skills?.length) bits.push(`<span class="yes">+${c.skills.join(", ")}</span>`);
      if (c.lacks?.length)  bits.push(`<span class="no">no ${c.lacks.join(", ")}</span>`);
      return `<span class="chip"><b>${esc(c.name)}</b>${bits.length ? " " + bits.join(" ") : ""}</span>`;
    }).join("");
  }

  // ---- sources ------------------------------------------------------------
  const setSrc = (text, isLive) => { $("src").textContent = text; $("dot").className = "dot" + (isLive ? " live" : ""); };

  let noticeTimer = 0;
  function notify(text) {
    $("notice").textContent = text || "";
    clearTimeout(noticeTimer);
    if (text) noticeTimer = setTimeout(() => { $("notice").textContent = ""; }, 8000);
  }
  /** POST, and say why if the engine says no. Returns the parsed body, or null if it never answered. */
  async function post(path, body) {
    let j = null;
    try {
      const r = await fetch(path, body === undefined ? { method:"POST" }
        : { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
      j = await r.json();
    } catch { notify("the engine did not answer"); return null; }
    if (j && j.ok === false) notify(j.reason || "that did not go through"); else notify("");
    return j;
  }

  // ---- the session (live only) --------------------------------------------
  // Whether a scene is being written RIGHT NOW is a different question from what the events say: a
  // saved log and a run that stopped ten seconds ago contain exactly the same thing. So the engine
  // reports it separately, over `run_state` and `GET /run`, and it never reaches the log.
  function renderSession() {
    // The idle screen belongs to the picker; three permanently-disabled run controls on it are
    // furniture, not information. The model dropdown stays visible, because idle is exactly when it
    // picks the model the NEXT run will load with (§4.4).
    for (const id of ["stop", "consultMe", "pause"]) $(id).hidden = !live || !session.running;
    const b = $("stop");
    b.disabled = !session.running || session.stopping;
    b.classList.toggle("armed", !!armed);
    b.textContent = session.stopping ? "stopping…" : armed ? "confirm stop" : "stop run";
    $("where").textContent = session.where ? "· " + session.where : "";
    const cm = $("consultMe");
    cm.disabled = !session.running || session.stopping || session.armed;
    cm.textContent = session.armed ? "consulting…" : "consult me";
    const p = $("pause");
    p.disabled = !session.running || session.stopping;
    p.textContent = session.paused ? "resume" : session.pausing ? "pausing…" : "pause";
    // Enabled when idle (picks the model for the NEXT run) or actually paused (swaps the one
    // running) -- NOT while merely "pausing", since the loop has not reached the boundary yet and
    // the server would 400 the same change (GUI-SPEC §4.4).
    const ms = $("modelSelect");
    ms.disabled = session.running && !session.paused;
    if (document.activeElement !== ms) ms.value = session.model || "";
  }
  const disarm = () => { clearTimeout(armed); armed = 0; renderSession(); };

  /** The model ids LM Studio has loaded, fetched once and reused -- the dropdown that lets you pick
   *  one before a run starts, or swap it while paused (GUI-SPEC §4.4). */
  async function loadModels() {
    try {
      const j = await (await fetch("/models")).json();
      modelIds = j.ids || [];
      modelDefault = j.architect || "";
      const ms = $("modelSelect");
      const cur = ms.value;
      ms.innerHTML = '<option value="">story default</option>'
        + modelIds.map(id => `<option value="${esc(id)}">${esc(id)}</option>`).join("");
      ms.value = session.model || cur || "";
      // The interview's own dropdown is built from `modelIds` as part of a whole re-render, so it
      // has to be told the list arrived.
      if ((scaffold.active || ideaOpen) && !ivHidden) render();
    } catch {}
  }

  // Escape closes the interview modal the same way the backdrop and × do — hides, never abandons.
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && (scaffold.active || ideaOpen) && !ivHidden) { ivHidden = true; render(); }
  });

  /** Fetch the shelf when the session starts waiting on a choice, and drop it when it stops — the
   *  pre-flight behind it goes stale the moment a story is edited on disk. */
  async function loadStories() {
    if (!session.picking) { stories = null; picked = ""; return; }
    stories = null;
    try { stories = (await (await fetch("/stories")).json()).stories || []; }
    catch { stories = []; }
    render();
  }
  $("stop").onclick = async () => {
    if (!session.running || session.stopping) return;
    // Ending a scene part-written is deliberate, so it takes a second click — the same reason the
    // scaffolder makes you confirm an accept over an outstanding complaint.
    if (!armed) { armed = setTimeout(disarm, 4000); renderSession(); return; }
    clearTimeout(armed); armed = 0;
    session.stopping = true; renderSession();
    await post("/stop");
  };
  $("consultMe").onclick = async () => {
    if (!session.running || session.stopping || session.armed) return;
    await post("/consult-me");
  };
  $("pause").onclick = async () => {
    if (!session.running || session.stopping) return;
    await post(session.paused || session.pausing ? "/resume" : "/pause");
  };
  $("modelSelect").onchange = async () => {
    const ms = $("modelSelect");
    const model = ms.value;                 // "" == "story default", clears the override
    const j = await post("/model", { model });
    // A refused change has to come back off the dropdown too, or the page goes on claiming a model
    // the engine never took — a wrong id fails every call, so a silently-wrong label is expensive.
    if (!j || j.ok === false) ms.value = session.model || "";
  };

  function ingest(text) {
    events = text.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    seen = new Set(events.map(e => e.seq).filter(s => s !== undefined));
    renderHeader(); render();
  }

  async function tryHttp() {
    try {
      const r = await fetch("/run"); if (!r.ok) throw 0;
      const j = await r.json();
      if (j.run) { meta = j.run; renderHeader(); }
      session = { running: !!j.running, stopping: !!j.stopping, where: j.where || "", picking: !!j.picking, armed: !!j.armed,
                  paused: !!j.paused, pausing: !!j.pausing, model: j.model || null };
      loadModels();
      if (j.awaitingContinue) showPrompt(j.awaitingContinue);
      if (j.picking) loadStories();          // a reload while the session waits must not strand it
      // An interview may already be open — a reload in the middle of one must land back in it.
      try { scaffold = await (await fetch("/scaffold")).json(); } catch {}
      render();                              // a session with nothing written yet still has a page
      startSSE();
      return true;
    } catch { return false; }
  }

  function startSSE() {
    const es = new EventSource("/events");
    setSrc("live", true);
    live = true;                       // a session to control: renderSession decides which controls
    $("modelSelect").hidden = false;
    renderSession();
    let pending = null;
    es.onmessage = m => {
      let f; try { f = JSON.parse(m.data); } catch { return; }
      if (f.t === "composing") { composing = f; renderRail(build()); return; }
      if (f.t === "idle") { composing = null; renderRail(build()); return; }
      if (f.t === "continue_prompt") { showPrompt(f); return; }
      if (f.t === "run_state") {
        const was = session.picking;
        session = { running: !!f.running, stopping: !!f.stopping, where: f.where || "", picking: !!f.picking, armed: !!f.armed,
                    paused: !!f.paused, pausing: !!f.pausing, model: f.model || null };
        // The budget question can be answered somewhere else — the console, a second tab, or a stop
        // that clears it. Every frame carries whether it is still outstanding, so a prompt nobody is
        // waiting on comes down instead of sitting there with buttons that only 400.
        if (!f.awaitingContinue) $("prompt").classList.remove("on");
        if (!session.running) disarm();
        if (session.picking !== was) loadStories();
        renderSession();
        // Always, not only on the picking edge: a frame arrives at most a few times per run, and
        // rendering on every one costs nothing next to being one missed transition away from a page
        // with no way back to the shelf.
        render();
        return;
      }
      if (f.t === "scaffold") {
        // A round is a minute of model call; a reload or a second tab has to be able to catch up,
        // and the POST response only ever reaches whoever sent it.
        scaffold = f.state || { active:false };
        if (scaffold.active) ideaOpen = false;
        if (!scaffold.problems || !scaffold.problems.length) disarmAccept(); else render();
        return;
      }
      if (f.t === "run_reset") {
        // A new story in the same session. Replay only helps clients that connect after it; one
        // already attached has to be told, or the next scene renders glued onto the last one.
        events = []; seen = new Set(); meta = null; composing = null; open.clear();
        $("cast").innerHTML = ""; $("question").textContent = "";
        fetch("/run").then(r => r.json()).then(j => { if (j.run) { meta = j.run; renderHeader(); } }).catch(() => {});
        render();
        return;
      }
      // A replayed event is one we already have. `seq` is stamped once by publish(), so it is the
      // identity of the event in both the log and the stream.
      if (f.seq !== undefined) { if (seen.has(f.seq)) return; seen.add(f.seq); }
      events.push(f);
      // Re-render whole, debounced: a scene is a few dozen events, and rebuilding is far cheaper
      // than keeping incremental DOM state correct across retries and late-arriving verdicts.
      //
      // A TIMER, not requestAnimationFrame. rAF does not fire in a hidden or non-compositing tab, so
      // a run watched in a background tab stopped updating entirely — and because the handle latched
      // in `pending`, nothing rescheduled either. A scene is a few dozen events; frame alignment was
      // never worth that.
      if (f.t === "reader_ask") wantReaderView = true;
      if (!pending) pending = setTimeout(() => {
        pending = null;
        const nearBottom = window.scrollY + innerHeight > document.body.scrollHeight - 220;
        if (!meta) renderHeader();
        render();
        if (nearBottom) window.scrollTo(0, document.body.scrollHeight);
        // The run is now blocked on you. Reading further up the scene is the normal thing to be
        // doing when it arrives, and a question nobody scrolls to is a run that looks hung.
        if (wantReaderView) {
          wantReaderView = false;
          const q = document.querySelector(".reader.pending");
          if (q) q.scrollIntoView({ block:"center", behavior:"smooth" });
        }
      });
    };
    es.onerror = () => setSrc("live (reconnecting…)", false);
  }

  // ---- the out-of-budget prompt (live only) -------------------------------
  function showPrompt(p) {
    $("promptText").textContent = `${p.steps} steps used and the scene is not finished.`;
    $("promptN").value = p.suggested || 8;
    $("prompt").classList.add("on");
  }
  const answerPrompt = async n => {
    $("prompt").classList.remove("on");
    await post("/continue", { steps:n });
  };
  $("promptGo").onclick = () => answerPrompt(Math.max(0, parseInt($("promptN").value, 10) || 0));
  $("promptStop").onclick = () => answerPrompt(0);

  // ---- chrome -------------------------------------------------------------
  $("expand").onclick = () => {
    expandAll = !expandAll;
    $("expand").textContent = expandAll ? "collapse all" : "expand all";
    if (!expandAll) open.clear();
    render();
  };
  $("theme").onclick = () => {
    const cur = document.documentElement.getAttribute("data-theme");
    const dark = cur ? cur === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    // Kept, because a run is watched across reloads and reconnects, and having to re-pick the theme
    // on each one is a choice the page keeps forgetting. Restored before paint, up in the head.
    try { localStorage.setItem("sw-theme", next); } catch {}
  };
  $("file").onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    f.text().then(t => { setSrc(f.name, false); ingest(t); });
  };
  addEventListener("dragover", e => { e.preventDefault(); $("drop").classList.add("on"); });
  addEventListener("dragleave", e => { if (e.relatedTarget === null) $("drop").classList.remove("on"); });
  addEventListener("drop", e => {
    e.preventDefault(); $("drop").classList.remove("on");
    const f = e.dataTransfer.files[0]; if (!f) return;
    f.text().then(t => { setSrc(f.name, false); ingest(t); });
  });

  // ---- boot ---------------------------------------------------------------
  (async () => {
    const src = new URLSearchParams(location.search).get("src");
    if (src) {
      try { const r = await fetch(src); setSrc(src, false); ingest(await r.text()); return; } catch {}
    }
    if (location.protocol.startsWith("http")) {
      if (await tryHttp()) return;
      try { const r = await fetch("/log.jsonl"); if (r.ok) { setSrc("/log.jsonl", false); ingest(await r.text()); return; } } catch {}
    }
    render();
  })();
})();