import { esc, modelOptionsHtml, tid } from "./util.js";
import { APP, storyName, hdraft, runningReason, handoffForPage } from "./state.js";
import { wordsPovHtml } from "./story-page.js";

// The architect default (defaults.json's models.architect) is repo-wide, not per-story, so it can
// name a model this story never asked for and that may not even be loaded -- the dropdown lets a
// round be started with a model actually known to work instead.
function handoffModelSelectHtml() {
  return `<select id="h-model" class="btn" title="model to prepare this chapter with">
    <option value=""${APP.handoffModel ? "" : " selected"}>architect default${APP.modelDefault ? " · " + esc(APP.modelDefault) : ""}</option>
    ${modelOptionsHtml(APP.modelIds, APP.handoffModel)}
  </select>`;
}

export function handoffPageHtml() {
  // Screen 4: no story chosen
  if (!APP.handoffDir) {
    return `<section class="picker story">
      <h2>nothing is being prepared</h2>
      <div class="btns" style="margin-top:18px">
        <button class="btn" id="h-back">back to the story</button>
      </div>
    </section>`;
  }

  // Screen 1: accepted
  if (APP.handoffDone) {
    const why = runningReason() || (!APP.session.picking ? "not ready to start a run right now" : "");
    return `<section class="picker story">
      <h2>${esc(storyName(APP.handoffDir))}</h2>
      <p class="sub">chapter ${APP.handoffDone.chapter} is prepared</p>
      ${(APP.handoffDone.warnings || []).map(w => `<div class="prob">⚠ ${esc(w)}</div>`).join("")}
      <div class="btns" style="margin-top:18px">
        <button class="btn primary" id="h-write"${why ? ` disabled title="${esc(why)}"` : ""}>write chapter ${APP.handoffDone.chapter}</button>
        <span class="spacer"></span>
        <button class="btn" id="h-back">back to the story</button>
      </div>
    </section>`;
  }

  // The active session, but only when it belongs to the story this page shows -- the server holds
  // one handoff at a time, and it may be open on a different story than the URL names.
  const s = handoffForPage();

  // Screen 2: nothing open. The accept case gets here first -- the server pushes {active:false}
  // before it answers the POST -- and must not be offered a start button it would race.
  if (!s.active && APP.handoffAccepting) {
    return `<section class="picker story">
      <h2>${esc(storyName(APP.handoffDir))}</h2>
      <div class="thinking"><i></i>writing story.json…</div>
    </section>`;
  }
  if (!s.active) {
    // Every handoff action but abandon is 409 while a run is in flight -- the run is reading the
    // file the handoff would rewrite. Said here rather than round-tripping to find out.
    const busy = runningReason();
    return `<section class="picker story">
      <h2>${esc(storyName(APP.handoffDir))}</h2>
      <p class="sub">the architect reads the chapters already written and re-authors the cast for the next one</p>
      ${APP.handoffError ? `<div class="said bad">${esc(APP.handoffError)}</div>` : ""}
      <div class="btns" style="margin-top:18px">
        <button class="btn primary" id="h-start"${busy ? ` disabled title="${esc(busy)}"` : ""}>prepare the next chapter</button>
        ${handoffModelSelectHtml()}
        <span class="spacer"></span>
        <button class="btn" id="h-back">back to the story</button>
      </div>
    </section>`;
  }

  // Screen 3: active handoff (`s` is set above, guarded to this page's story)

  // The optimistic state `startHandoff` sets has no spec -- every real frame carries one. Until the
  // first round lands there is no chapter number to name and nothing proposed to draw, and that wait
  // is the longest in the flow: the architect is reading every chapter written so far.
  if (!s.spec) {
    return `<section class="picker story">
      <h2>${esc(storyName(APP.handoffDir))}</h2>
      <p class="sub">the architect is reading the chapters already written</p>
      <div class="thinking"><i></i>thinking about it…</div>
      <div class="btns" style="margin-top:18px">
        <button class="btn" id="h-abandon">${APP.hAbandonArmed ? "abandon — sure?" : "abandon"}</button>
      </div>
    </section>`;
  }

  // A round that failed before anything was proposed leaves nothing to review, and the panels that
  // would normally fill the page ("the architect has not added it yet") describe the untouched story
  // rather than what just happened. The failure is the state. There is no propose route to call
  // twice, so "try again" reopens the session -- while `say` stays available, and is the lighter
  // request of the two: it does not resend the chapters.
  if (s.last?.kind === "failed" && !s.edited) {
    return `<section class="picker story">
      <h2>${esc(storyName(APP.handoffDir))}</h2>
      <p class="sub">preparing chapter ${s.chapter}${s.model ? " · " + esc(s.model) : ""}</p>
      <div class="said bad">that round failed (${esc(s.last.error)}) — nothing changed</div>
      ${APP.handoffError ? `<div class="said bad">${esc(APP.handoffError)}</div>` : ""}
      <div class="hbar">
        <div class="field"><label for="h-say">or ask for a change instead</label>
          <textarea id="h-say" ${s.busy ? "disabled" : ""} rows="2"
            placeholder="a smaller request than the opening round">${esc(hdraft.say)}</textarea></div>
        ${s.busy ? `<div class="thinking"><i></i>thinking about it…</div>` : ""}
        <div class="btns">
          <button class="btn primary" id="h-retry"${s.busy ? " disabled" : ""}>try again</button>
          <button class="btn" id="h-send"${s.busy ? " disabled" : ""}>send</button>
          <button class="btn" id="h-abandon">${APP.hAbandonArmed ? "abandon — sure?" : "abandon"}</button>
          <span class="spacer"></span>
          <button class="btn" id="h-back">back to the story</button>
        </div>
      </div>
    </section>`;
  }

  const body = [];

  body.push(`<h2>${esc(storyName(APP.handoffDir))}</h2>`);
  body.push(`<p class="sub">preparing chapter ${s.chapter}${s.model ? " · " + esc(s.model) : ""}</p>`);

  // Proposed scene
  const sc = s.spec?.scenes?.[s.chapter - 1];
  const roster = sc?.roster?.length ? " · " + esc(sc.roster.join(", ")) : "";
  if (sc) {
    body.push(`<div class="divider"><span>proposed chapter ${s.chapter}</span></div>`);
    body.push(`<div ${tid("handoff.proposed-chapter")} class="cardwrap"><div class="scenerow">
      <div class="sc-q">${esc(sc.question || "(no scene question)")}</div>
      <div class="sc-meta">${sc.place ? esc(sc.place) + " · " : ""}${wordsPovHtml(sc)}${roster}</div>
    </div></div>`);
  } else {
    body.push(`<div class="divider"><span>proposed chapter ${s.chapter}</span></div>`);
    body.push(`<p class="hint">the architect has not added it yet</p>`);
  }

  // Chapters already written, beside the one being prepared -- one /chapter fetch each for the word
  // count (handoff.js/loadHandoffChapters), so it arrives shortly after the round does.
  if (s.chapter > 1) {
    const hc = APP.handoffChapters;
    const ready = hc && hc.dir === APP.handoffDir && hc.chapter === s.chapter && !hc.loading;
    body.push(`<div class="divider"><span>chapters written</span></div>`);
    if (ready) {
      const rows = hc.items.map(it => `
        <div ${tid("handoff.chapter-row")} class="hchap" data-n="${it.n}"><span class="n">✓ ch ${it.n}</span>
          <span class="place">${it.place ? esc(it.place) : "—"}</span>
          <span class="w">${it.error ? "unreadable" : it.words + " words"}</span></div>`);
      rows.push(`
        <div ${tid("handoff.chapter-row")} class="hchap prep" data-n="${s.chapter}">
          <span class="n">· ch ${s.chapter}</span>
          <span class="place">${sc?.place ? esc(sc.place) + " — " : ""}being prepared</span>
          <span class="w">draft</span></div>`);
      body.push(`<div class="hchapters">${rows.join("")}</div>`);
    } else {
      body.push(`<div class="thinking"><i></i>counting words…</div>`);
    }
  }

  // Last round results
  if (s.last?.kind === "edits") {
    const changeValue = (value) => {
      if (value === undefined || value === null) return "∅";
      if (typeof value === "string") return JSON.stringify(value);
      if (Array.isArray(value)) {
        const items = value.slice(0, 4).map(changeValue);
        return `[${items.join(", ")}${value.length > 4 ? ", …" : ""}]`;
      }
      if (typeof value === "object") {
        const entries = Object.entries(value).slice(0, 4)
          .map(([key, item]) => `${key}: ${changeValue(item)}`);
        return `{${entries.join(", " )}${Object.keys(value).length > 4 ? ", …" : ""}}`;
      }
      return String(value);
    };
    body.push(`<div class="divider"><span>changes to review</span></div>`);
    if (s.last.applied.length) {
      body.push(`<div class="hchanges">` + s.last.applied.map(a => `
        <div ${tid("handoff.change-row")} class="hchange ok"><span class="hmark">✓</span>
          <div><code class="hfield">${esc(a.field)}</code>
            <div class="hdiff">${esc(changeValue(a.before))} <span class="arrow">→</span> ${esc(changeValue(a.after))}</div>
          </div>
        </div>`).join("") + `</div>`);
    } else {
      body.push(`<p class="hint">nothing changed yet</p>`);
    }
    if (s.last.ignored.length) {
      body.push(`<div class="divider"><span>not applied</span></div>`);
      body.push(`<div class="hchanges">` + s.last.ignored.map(x => `
        <div ${tid("handoff.change-row")} class="hchange no"><span class="hmark">✗</span><div>${esc(x)}</div></div>`).join("") + `</div>`);
    }
    if ((s.last.flags || []).length) {
      body.push(`<div class="divider"><span>continuity flags · advisory</span></div>`);
      body.push(`<div class="hchanges">` + (s.last.flags || []).map(x => `
        <div ${tid("handoff.change-row")} class="hchange flag"><span class="hmark">⚑</span><div>${esc(x)}</div></div>`).join("") + `</div>`);
    }
    if (s.last.note) {
      body.push(`<p class="sub">${esc(s.last.note)}</p>`);
    }
  }

  // Problems
  for (const p of (s.problems || [])) {
    body.push(`<div class="prob">⚠ ${esc(p)}</div>`);
  }

  // Failed or nothing
  if (s.last?.kind === "failed") {
    body.push(`<div class="said bad">that round failed (${esc(s.last.error)}) — nothing changed</div>`);
  }
  if (s.last?.kind === "nothing") {
    body.push(`<div class="said bad">it didn't come back with changes — try saying what should be different</div>`);
  }

  // Pending ask
  if (s.pendingAsk) {
    body.push(`<div class="asked"><span class="k">it needs to know</span>${esc(s.pendingAsk)}</div>`);
  }

  // Cast
  body.push(`<div class="divider"><span>cast</span></div>`);
  if (s.spec?.characters?.length) {
    body.push(`<div class="hcast">`);
    for (const c of s.spec.characters) {
      body.push(`<div ${tid("handoff.cast-row")} class="who" data-name="${esc(c.name)}">
        <div class="nm">${esc(c.name)}</div>
        ${c.goal ? `<div class="line"><span class="k">goal</span>${esc(c.goal)}</div>` : ""}
        ${c.knows ? `<div class="line"><span class="k">knows</span>${esc(c.knows)}</div>` : ""}
        ${c.belief ? `<div class="line"><span class="k">believes</span>${esc(c.belief)}</div>` : ""}
        ${c.impulse ? `<div class="line"><span class="k">impulse</span>${esc(c.impulse)}</div>` : ""}
        ${(c.voice || []).map(v => `<div class="line"><span class="k">says</span>“${esc(v)}”</div>`).join("")}
        ${c.restrictions?.length ? `<div class="line"><span class="k no">cannot</span>${esc(c.restrictions.join(", "))}</div>` : ""}
      </div>`);
    }
    body.push(`</div>`);
  }

  // The ask-for-change box and its buttons stick to the bottom of the window while the proposal
  // and cast scroll above -- the input stays put while the artifact being reviewed moves.
  body.push(`<div class="hbar">`);
  body.push(`<div class="field"><label for="h-say">ask for a change</label>
    <textarea id="h-say" ${s.busy ? "disabled" : ""} placeholder="e.g. Ivo should not know about the log yet.">${esc(hdraft.say)}</textarea></div>`);

  // Thinking
  if (s.busy) {
    body.push(`<div class="thinking"><i></i>thinking about it…</div>`);
  }

  // Error
  if (APP.handoffError) {
    body.push(`<div class="said bad">${esc(APP.handoffError)}</div>`);
  }

  // Buttons
  const unsent = !!hdraft.say.trim();
  const btnRow = [];
  btnRow.push(`<button class="btn${unsent && !s.busy ? " primary" : ""}" id="h-send"${s.busy ? " disabled" : ""}>send</button>`);
  btnRow.push(`<button class="btn" id="h-accept"${(s.busy || !s.edited) ? " disabled" : ""}${APP.hAcceptArmed ? " armed" : ""} title="${s.busy ? "thinking" : !s.edited ? "ask for a change first" : ""}">${APP.hAcceptArmed ? "accept — sure?" : "accept"}</button>`);
  btnRow.push(`<button class="btn" id="h-abandon"${APP.hAbandonArmed ? " armed" : ""}>abandon${APP.hAbandonArmed ? " — sure?" : ""}</button>`);
  btnRow.push(`<span class="spacer"></span>`);
  btnRow.push(`<button class="btn" id="h-back">back</button>`);
  body.push(`<div class="btns">${btnRow.join("")}</div>`);
  body.push(`</div>`);

  return `<section class="picker story">
    ${body.join("")}
  </section>`;
}
