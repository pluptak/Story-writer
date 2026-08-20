import { esc } from "./util.js";
import { APP, storyName, hdraft, runningReason } from "./state.js";
import { wordsPovHtml } from "./story-page.js";

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

  // Screen 2: nothing open. The accept case gets here first -- the server pushes {active:false}
  // before it answers the POST -- and must not be offered a start button it would race.
  if (!APP.handoff.active && APP.handoffAccepting) {
    return `<section class="picker story">
      <h2>${esc(storyName(APP.handoffDir))}</h2>
      <div class="thinking"><i></i>writing story.json…</div>
    </section>`;
  }
  if (!APP.handoff.active) {
    // Every handoff action but abandon is 409 while a run is in flight -- the run is reading the
    // file the handoff would rewrite. Said here rather than round-tripping to find out.
    const busy = runningReason();
    return `<section class="picker story">
      <h2>${esc(storyName(APP.handoffDir))}</h2>
      <p class="sub">the architect reads the chapters already written and re-authors the cast for the next one</p>
      ${APP.handoffError ? `<div class="said bad">${esc(APP.handoffError)}</div>` : ""}
      <div class="btns" style="margin-top:18px">
        <button class="btn primary" id="h-start"${busy ? ` disabled title="${esc(busy)}"` : ""}>prepare the next chapter</button>
        <span class="spacer"></span>
        <button class="btn" id="h-back">back to the story</button>
      </div>
    </section>`;
  }

  // Screen 3: active handoff
  const s = APP.handoff;

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
      <div class="field"><label for="h-say">or ask for a change instead</label>
        <textarea id="h-say" ${s.busy ? "disabled" : ""} rows="2"
          placeholder="a smaller request than the opening round">${esc(hdraft.say)}</textarea></div>
      ${s.busy ? `<div class="thinking"><i></i>thinking about it…</div>` : ""}
      <div class="btns" style="margin-top:14px">
        <button class="btn primary" id="h-retry"${s.busy ? " disabled" : ""}>try again</button>
        <button class="btn" id="h-send"${s.busy ? " disabled" : ""}>send</button>
        <button class="btn" id="h-abandon">${APP.hAbandonArmed ? "abandon — sure?" : "abandon"}</button>
        <span class="spacer"></span>
        <button class="btn" id="h-back">back to the story</button>
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
    body.push(`<div class="cardwrap"><div class="scenerow">
      <div class="sc-q">${esc(sc.question || "(no scene question)")}</div>
      <div class="sc-meta">${sc.place ? esc(sc.place) + " · " : ""}${wordsPovHtml(sc)}${roster}</div>
    </div></div>`);
  } else {
    body.push(`<div class="divider"><span>proposed chapter ${s.chapter}</span></div>`);
    body.push(`<p class="hint">the architect has not added it yet</p>`);
  }

  // Last round results
  if (s.last?.kind === "edits") {
    body.push(`<div class="divider"><span>changes to review</span></div>`);
    if (s.last.applied.length) {
      body.push(s.last.applied.map(a => `<p class="hint">✓ ${esc(a)}</p>`).join(""));
    } else {
      body.push(`<p class="hint">nothing changed yet</p>`);
    }
    if (s.last.ignored.length) {
      body.push(`<div class="divider"><span>not applied</span></div>`);
      body.push(s.last.ignored.map(x => `<div class="said bad">✗ ${esc(x)}</div>`).join(""));
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
  if (s.spec?.characters) {
    for (const c of s.spec.characters) {
      body.push(`<div class="who">
        <div class="nm">${esc(c.name)}</div>
        ${c.goal ? `<div class="line"><span class="k">goal</span>${esc(c.goal)}</div>` : ""}
        ${c.knows ? `<div class="line"><span class="k">knows</span>${esc(c.knows)}</div>` : ""}
        ${c.restrictions?.length ? `<div class="line"><span class="k no">cannot</span>${esc(c.restrictions.join(", "))}</div>` : ""}
      </div>`);
    }
  }

  // Textarea
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

  return `<section class="picker story">
    ${body.join("")}
  </section>`;
}
