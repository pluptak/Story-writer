import { reasonOr } from "./util.js";
import { APP, hdraft, handoffForPage } from "./state.js";
import { choose } from "./story-page.js";
import { go } from "./nav.js";
import { handoffPageHtml } from "./handoff-view.js";

export { handoffPageHtml };

async function postHandoff(what, payload) {
  let j = null;
  try {
    const r = await fetch(`/next-chapter/${what}`, { method:"POST", headers:{ "Content-Type":"application/json" },
                                                     body: JSON.stringify(payload || {}) });
    j = await r.json();
  } catch { APP.handoffError = "the engine did not answer"; APP.render(); return null; }
  if (j && j.active !== undefined) { APP.handoffError = ""; APP.handoff = j; APP.render(); return j; }
  if (j && j.ok) { APP.handoffError = ""; APP.render(); return j; }
  APP.handoffError =
    j && j.kind === "unloadable" ? `the rewritten story.json does not load — ${j.error}; the previous one was put back`
    : j && j.kind === "nothing"  ? "nothing has changed yet — ask for a change first"
    : reasonOr(j, "that did not go through");
  APP.render();
  return j;
}

/** The "chapters written" list beside the proposed chapter needs a word count per chapter, one
 *  fetch each. They never change within a handoff session -- accepting rewrites story.json, not the
 *  prose already on disk -- so this runs once per (dir, prepared-chapter) and caches the result.
 *  Chapter numbers come from the story card, filtered to those below the one being prepared, so a
 *  gap in the written chapters does not turn into a 404. */
async function loadHandoffChapters(dir, chapter, spec) {
  APP.handoffChapters = { dir, chapter, loading: true, items: [] };
  APP.render();
  const card = (APP.stories || []).find(s => s.dir === dir);
  const numbers = (card?.chapters || []).filter(n => n < chapter).sort((a, b) => a - b);
  const items = [];
  for (const n of numbers) {
    const place = spec?.scenes?.[n - 1]?.place || "";
    try {
      const r = await fetch(`/chapter?dir=${encodeURIComponent(dir)}&n=${n}`);
      if (!r.ok) items.push({ n, place, words: null, error: true });
      else items.push({ n, place, words: (((await r.text()).match(/\S+/g)) || []).length, error: false });
    } catch {
      items.push({ n, place, words: null, error: true });
    }
    // A later dir/chapter started while this awaited -- bow out, like reader.js does.
    if (APP.handoffChapters?.dir !== dir || APP.handoffChapters?.chapter !== chapter) return;
  }
  APP.handoffChapters = { dir, chapter, loading: false, items };
  APP.render();
}

const disarm = key => { clearTimeout(APP[key]); APP[key] = 0; APP.render(); };

/** First click arms a confirming second click within `ms`; the second click disarms and runs
 *  `action`. Shared by accept and abandon, which both rewrite or discard something undoable. */
function armTwice(key, ms, action) {
  if (!APP[key]) { APP[key] = setTimeout(() => disarm(key), ms); APP.render(); return; }
  clearTimeout(APP[key]); APP[key] = 0;
  action();
}

/** The first round is a live model call reading every chapter written so far, so the page has to
 *  show it is busy before the POST rather than after it. */
async function startHandoff() {
  APP.handoffError = "";
  APP.handoff = { active:true, busy:true, dir: APP.handoffDir, chapter:0, problems:[] };
  APP.render();
  const j = await postHandoff("start", { dir: APP.handoffDir, model: APP.handoffModel });
  // A refusal leaves an optimistic "busy" that nothing will ever clear -- fall back to the start
  // screen, with the refusal already in handoffError, or the page hangs until a reload.
  if (!j || j.active === undefined) { APP.handoff = { active:false }; APP.render(); }
}

/** The text stays in the draft until the round actually lands, so a 409 or a dropped connection
 *  does not silently lose what you wrote. */
async function sendHSay() {
  const text = hdraft.say.trim();
  if (!text || APP.handoff.busy) return;
  const j = await postHandoff("say", { text });
  if (j && j.active !== undefined) { hdraft.say = ""; APP.render(); }
}

/** The server drops its session on a successful accept and pushes `{active:false}`, so the prepared
 *  chapter is remembered here or it disappears the moment it succeeds. */
async function acceptHandoff() {
  APP.handoffAccepting = true;
  const j = await postHandoff("accept", {});
  APP.handoffAccepting = false;
  if (!j || !j.ok || j.kind !== "written") { APP.render(); return; }
  APP.handoffDone = { dir: APP.handoffDir, chapter: j.chapter, warnings: j.warnings || [] };
  APP.handoff = { active:false };
  disarm("hAcceptArmed"); disarm("hAbandonArmed");
}

async function abandonHandoff() {
  await postHandoff("abandon", {});
  APP.handoff = { active:false }; APP.handoffDone = null; APP.handoffError = "";
  go("story");
}

/** There is no route that re-runs the opening round, so retrying is a fresh session on the same
 *  story. Nothing is lost: a failed first round changed nothing to keep. */
async function retryHandoff() {
  await postHandoff("abandon", {});
  APP.handoff = { active:false }; APP.handoffError = "";
  await startHandoff();
}

/** Starting the prepared chapter is `/select`, which only answers while the session is parked at
 *  the picker. On success `choose` navigates to the run; a refusal has to be said here, since the
 *  handoff page does not show `storyError`. */
async function writePrepared() {
  const done = APP.handoffDone;
  if (!done) return;
  await choose({ dir: done.dir, chapter: done.chapter });
  if (APP.picked) { APP.handoffDone = null; return; }
  APP.handoffError = APP.storyError || "that did not go through";
  APP.render();
}

export function wireHandoff(page) {
  // The word counts for the "chapters written" list load lazily, once the round has a spec and so a
  // chapter number to prepare. wireHandoff re-runs on every render; the dir+chapter key stops that
  // from restarting the fetch, and loadHandoffChapters sets the key before its first await.
  const s = handoffForPage();
  if (s.active && s.spec && s.chapter > 1 &&
      (APP.handoffChapters?.dir !== APP.handoffDir || APP.handoffChapters?.chapter !== s.chapter)) {
    loadHandoffChapters(APP.handoffDir, s.chapter, s.spec);
  }

  const on = (id, fn) => { const el = page.querySelector("#" + id); if (el) el.addEventListener("click", fn); };
  const onKey = (id, fn) => { const el = page.querySelector("#" + id); if (el) el.addEventListener("keydown", fn); };
  const plain = e => !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing;

  const say = page.querySelector("#h-say");
  if (say) say.addEventListener("input", () => { hdraft.say = say.value; });
  onKey("h-say", e => { if (e.key === "Enter" && plain(e)) { e.preventDefault(); sendHSay(); } });

  const model = page.querySelector("#h-model");
  if (model) model.addEventListener("change", () => { APP.handoffModel = model.value; });

  on("h-start", startHandoff);
  on("h-retry", retryHandoff);
  on("h-send", sendHSay);
  on("h-back", () => { APP.storyDir = APP.handoffDir; go("story"); });
  on("h-write", writePrepared);

  // Accepting rewrites the story.json a working story is already running on. The engine puts the
  // old file back if the result does not load, but a result that DOES load is not undoable, so it
  // takes the same confirming second click the interview's accept does.
  on("h-accept", () => armTwice("hAcceptArmed", 5000, acceptHandoff));
  on("h-abandon", () => armTwice("hAbandonArmed", 4000, abandonHandoff));
}
