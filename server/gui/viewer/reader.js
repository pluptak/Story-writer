import { esc, basename } from "./util.js";
import { APP, READER, storyName } from "./state.js";
import { go, syncHash } from "./nav.js";
import { paras } from "./blocks.js";

// ---- the story reader ----------------------------------------------------
// A read-only view of a story's accepted prose, chapter by chapter. No SSE,
// no run controls. Reached at `#/readstory?dir=...`.

async function fetchChapters(dir, numbers) {
  const results = [];
  for (const n of numbers) {
    try {
      const r = await fetch(`/chapter?dir=${encodeURIComponent(dir)}&n=${n}`);
      if (!r.ok) results.push({ n, text: "", error: "could not load" });
      else results.push({ n, text: await r.text(), error: "" });
    } catch {
      results.push({ n, text: "", error: "could not load" });
    }
  }
  return results;
}

/** `READER.dir` is checked again after every await: one chapter per request means a slow story is a
 *  wide window, and a second story opened inside it must not have the first one's prose land under
 *  its title. The later call has already overwritten `READER.dir`, so the earlier one bows out. */
export async function loadReader(dir) {
  READER.loading = true; READER.error = ""; READER.dir = dir; READER.chapters = []; READER.query = "";
  syncHash();   // go() ran before READER.dir was set, so the hash has no ?dir= on it yet
  APP.render();

  let chapters;
  const card = (APP.stories || []).find(s => s.dir === dir);
  if (card) {
    chapters = (card.chapters || []).slice().sort((a, b) => a - b);
  } else {
    try {
      const j = await (await fetch("/stories")).json();
      const found = (j.stories || []).find(s => s.dir === dir);
      chapters = found ? (found.chapters || []).slice().sort((a, b) => a - b) : [];
    } catch { chapters = []; }
  }
  if (READER.dir !== dir) return;
  if (!chapters.length) { READER.error = "no chapters written yet"; READER.loading = false; APP.render(); return; }

  const fetched = await fetchChapters(dir, chapters);
  if (READER.dir !== dir) return;
  READER.chapters = fetched;
  READER.loading = false;
  APP.render();
}

export function readerPageHtml() {
  if (!READER.dir) {
    return `<section class="picker">
      <h2>Read a story</h2>
      <p class="sub">open a story from the shelf and choose "read story"</p>
      <div class="btns" style="margin-top:18px"><button class="btn" id="reader-back">back to shelf</button></div>
    </section>`;
  }
  const name = storyName(READER.dir) || basename(READER.dir);
  if (READER.loading) {
    return `<section class="picker reader-view">
      <h2>${esc(name)}</h2>
      <p class="thinking"><i></i>loading chapters…</p>
      <div class="btns" style="margin-top:18px"><button class="btn" id="reader-back">back</button></div>
    </section>`;
  }
  if (READER.error) {
    return `<section class="picker reader-view">
      <h2>${esc(name)}</h2>
      <div class="said bad">${esc(READER.error)}</div>
      <div class="btns" style="margin-top:18px"><button class="btn" id="reader-back">back</button></div>
    </section>`;
  }
  const body = [`<h2>${esc(name)}</h2>`];
  body.push(`<div class="reader-search">
    <input type="text" id="reader-q" placeholder="search this story" value="${esc(READER.query || "")}"
      aria-label="search this story" autocomplete="off" spellcheck="false">
  </div>
  <div id="reader-results">${resultsHtml()}</div>`);
  for (const ch of READER.chapters) {
    body.push(`<div class="reader-chapter" id="reader-ch-${ch.n}">
      <div class="divider"><span>chapter ${ch.n}</span></div>
      ${ch.error ? `<div class="said bad">${esc(ch.error)}</div>` : `<div class="prose">${paras(ch.text)}</div>`}
    </div>`);
  }
  body.push(`<div class="btns" style="margin-top:18px"><button class="btn" id="reader-back">back</button></div>`);
  return `<section class="picker reader-view">${body.join("")}</section>`;
}

// ---- search over the loaded prose ----------------------------------------
// Runs entirely over READER.chapters, already in memory -- so a keystroke never fetches, and
// switching stories (which resets chapters and query in loadReader) cannot show stale hits.

/** One entry per line of prose that contains the query, in chapter then document order. */
function searchMatches(query) {
  const q = query.trim().toLowerCase();
  const out = [];
  if (!q) return out;
  for (const ch of READER.chapters) {
    if (ch.error || !ch.text) continue;
    for (const line of ch.text.split("\n")) {
      if (line.toLowerCase().includes(q)) out.push({ n: ch.n, line });
    }
  }
  return out;
}

/** A ~50-char window either side of the first hit in `line`, every occurrence within it marked. */
function snippetHtml(line, query) {
  const q = query.trim();
  const lc = line.toLowerCase(), qlc = q.toLowerCase();
  const first = lc.indexOf(qlc);
  const start = Math.max(0, first - 50), end = Math.min(line.length, first + q.length + 50);
  const slice = line.slice(start, end), slc = slice.toLowerCase();
  let out = "", i = 0;
  for (let j = slc.indexOf(qlc); j !== -1; j = slc.indexOf(qlc, i)) {
    out += esc(slice.slice(i, j)) + `<mark>${esc(slice.slice(j, j + q.length))}</mark>`;
    i = j + q.length;
  }
  out += esc(slice.slice(i));
  return (start > 0 ? "…" : "") + out + (end < line.length ? "…" : "");
}

function resultsHtml() {
  const q = (READER.query || "").trim();
  if (!q) return "";
  const hits = searchMatches(q);
  if (!hits.length) return `<p class="reader-noresult">no matches for "${esc(q)}"</p>`;
  const items = hits.map(m => `<button class="reader-hit" data-ch="${m.n}">
      <span class="hit-ch">ch ${m.n}</span>
      <span class="hit-line">${snippetHtml(m.line, q)}</span>
    </button>`).join("");
  return `<p class="reader-count">${hits.length} match${hits.length === 1 ? "" : "es"}</p>
    <div class="reader-hits">${items}</div>`;
}

export function wireReaderPage(page) {
  const back = page.querySelector("#reader-back");
  if (back) back.addEventListener("click", () => {
    const dir = READER.dir;
    READER.dir = ""; READER.chapters = []; READER.error = ""; READER.query = "";
    if (dir) { APP.storyDir = dir; go("story"); } else go("shelf");
  });

  const results = page.querySelector("#reader-results");
  // A hit jumps to its chapter's heading. The whole story is one scrolling page, so this is a
  // scroll, not a route change -- #/readstory?dir= stays put.
  const wireHits = () => {
    for (const b of page.querySelectorAll(".reader-hit"))
      b.addEventListener("click", () => {
        page.querySelector(`#reader-ch-${b.dataset.ch}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
  };
  wireHits();

  // Repaint only the results list on a keystroke -- a full render would rebuild every chapter's
  // prose and drop focus out of the box mid-word.
  const q = page.querySelector("#reader-q");
  if (q && results) q.addEventListener("input", () => {
    READER.query = q.value;
    results.innerHTML = resultsHtml();
    wireHits();
  });
  // Escape empties the box; Enter jumps to the first hit -- both let a search finish without the
  // mouse, the same keyboard flow the hit buttons already give once you tab to them.
  if (q && results) q.addEventListener("keydown", e => {
    if (e.key === "Escape" && q.value) {
      q.value = ""; READER.query = ""; results.innerHTML = ""; e.stopPropagation();
    } else if (e.key === "Enter") {
      e.preventDefault(); results.querySelector(".reader-hit")?.click();
    }
  });
}
