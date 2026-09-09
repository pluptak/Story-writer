import { esc, basename, tid, scrollToEl } from "./util.js";
import { APP, READER, storyName } from "./state.js";
import { go, syncHash } from "./nav.js";
import { paras } from "./blocks.js";
import { button, errorLine, thinking, divider, pageTitle } from "./ui.js";

// ---- the manuscript ------------------------------------------------------
// Reading mode, not a run inspector: accepted chapter prose only, chapter by
// chapter. It never renders consult/note/run blocks (only paras() of the
// saved chapter files), carries no run controls and no SSE. Technical run
// detail stays one explicit step away, behind the "About this manuscript"
// disclosure and the Story map's runs. Reached at `#/readstory?dir=...`.

async function fetchChapters(dir, numbers) {
  const results = [];
  for (const n of numbers) {
    try {
      const r = await fetch(`/chapter?dir=${encodeURIComponent(dir)}&n=${n}`);
      if (!r.ok) results.push({ n, text: "", error: "This chapter could not be opened." });
      else results.push({ n, text: await r.text(), error: "" });
    } catch {
      results.push({ n, text: "", error: "This chapter could not be opened." });
    }
  }
  return results;
}

/** `READER.dir` is re-checked after every await: one chapter per request means a slow story is a
 *  wide window, and a second story opened inside it must not get the first one's prose under its
 *  title. The later call has already overwritten READER.dir, so the earlier one bows out. */
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

/** The way back to authoring, up front where a reader finds it without
 *  scrolling: Story map first (the full context — scenes, runs, next
 *  chapter), Write alongside it. One `#reader-back` only — a second element
 *  sharing the id would break strict locators. */
function returnBarHtml() {
  return `<div class="reader-return" data-tid="reader.return">`
    + `${button({ label: "← Story map", id: "reader-back", tidName: "reader.to-story" })}`
    + `${button({ label: "Continue writing →", id: "reader-write", tidName: "reader.to-write" })}`
    + `</div>`;
}

/** Chapter navigation that never touches the route: the app owns
 *  location.hash (`#/readstory?dir=`), so TOC jumps scroll like search hits
 *  do instead of linking to `#reader-ch-N` and losing the story. */
function tocHtml(chapters) {
  const links = chapters.map(ch =>
    `<button class="reader-toc-link" data-tid="reader.toc-link" data-ch="${ch.n}">Chapter ${ch.n}</button>`
  ).join("");
  return `<nav class="reader-toc" data-tid="reader.toc" aria-label="Chapters">${links}</nav>`;
}

/** The explicit secondary action for technical detail. Collapsed, below the
 *  prose: what this view is, and where the run-level record (saved runs,
 *  drafts, consults, model calls) lives — on the Story map. */
function techDetailsHtml(count) {
  return `<details class="reader-tech" data-tid="reader.tech-details">`
    + `<summary>About this manuscript</summary>`
    + `<p class="hint">Accepted prose only — ${count} ${count === 1 ? "chapter" : "chapters"}. `
    + `Drafts, consults and model calls stay with the story's history.</p>`
    + `<div class="btns">${button({ label: "Open Story map for runs & detail", id: "reader-tech-story", tidName: "reader.tech-story" })}</div>`
    + `</details>`;
}

export function readerPageHtml() {
  if (!READER.dir) {
    return `<section class="picker">
      ${pageTitle({ eyebrow: "Manuscript", title: "Read a story", lede: "open a story from the shelf and choose “read story”" })}
      <div class="btns mt-lg">${button({ label: "back to shelf", id: "reader-back" })}</div>
    </section>`;
  }
  const name = storyName(READER.dir) || basename(READER.dir);
  if (READER.loading) {
    return `<section class="picker reader-view">
      ${pageTitle({ eyebrow: "Manuscript", title: name })}
      ${thinking("loading chapters…", { tag: "p" })}
      <div class="btns mt-lg">${button({ label: "back", id: "reader-back" })}</div>
    </section>`;
  }
  if (READER.error) {
    return `<section class="picker reader-view">
      ${pageTitle({ eyebrow: "Manuscript", title: name })}
      ${errorLine(esc(READER.error))}
      <div class="btns mt-lg">${button({ label: "back", id: "reader-back" })}</div>
    </section>`;
  }
  const count = READER.chapters.length;
  const body = [pageTitle({ eyebrow: "Manuscript", title: name,
    lede: `${count} ${count === 1 ? "chapter" : "chapters"}` })];
  body.push(returnBarHtml());
  if (count > 1) body.push(tocHtml(READER.chapters));
  body.push(`<div class="reader-search">
    <input type="text" id="reader-q" placeholder="Search this story" value="${esc(READER.query || "")}"
      aria-label="Search this story" autocomplete="off" spellcheck="false">
  </div>
  <div id="reader-results">${resultsHtml()}</div>`);
  for (const ch of READER.chapters) {
    body.push(`<div class="reader-chapter" id="reader-ch-${ch.n}">
      ${divider(`chapter ${ch.n}`)}
      ${ch.error ? errorLine(esc(ch.error)) : `<div class="prose">${paras(ch.text)}</div>`}
    </div>`);
  }
  body.push(techDetailsHtml(count));
  return `<section class="picker reader-view">${body.join("")}</section>`;
}

// ---- search over the loaded prose ----------------------------------------
// Runs entirely over READER.chapters, already in memory -- a keystroke never fetches, and switching
// stories (which resets chapters and query in loadReader) cannot show stale hits.

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
  const items = hits.map(m => `<button ${tid("reader.hit")} class="reader-hit" data-ch="${m.n}">
      <span class="hit-ch">ch ${m.n}</span>
      <span class="hit-line">${snippetHtml(m.line, q)}</span>
    </button>`).join("");
  return `<p class="reader-count">${hits.length} match${hits.length === 1 ? "" : "es"}</p>
    <div class="reader-hits">${items}</div>`;
}

/** Back to authoring without losing the manuscript: READER keeps its dir
 *  and chapters (dir-keyed, so another story's load still replaces them),
 *  so Manuscript ↔ Story map ↔ Write is a round trip, not a reload. */
function backToStory() {
  const dir = READER.dir;
  if (dir) { APP.storyDir = dir; go("story"); } else go("shelf");
}

export function wireReaderPage(page) {
  const back = page.querySelector("#reader-back");
  if (back) back.addEventListener("click", backToStory);
  const tech = page.querySelector("#reader-tech-story");
  if (tech) tech.addEventListener("click", backToStory);
  const write = page.querySelector("#reader-write");
  if (write) write.addEventListener("click", () => go("live"));

  const results = page.querySelector("#reader-results");
  // A hit — or a TOC entry — jumps to its chapter's heading. The whole story is one scrolling
  // page, so this is a scroll, not a route change -- #/readstory?dir= stays put.
  const wireHits = () => {
    for (const b of page.querySelectorAll(".reader-hit"))
      b.addEventListener("click", () => {
        scrollToEl(page.querySelector(`#reader-ch-${b.dataset.ch}`));
      });
  };
  wireHits();
  for (const b of page.querySelectorAll(".reader-toc-link"))
    b.addEventListener("click", () => {
      scrollToEl(page.querySelector(`#reader-ch-${b.dataset.ch}`));
    });

  // Repaint only the results list on a keystroke -- a full render would rebuild every chapter's
  // prose and drop focus out of the box mid-word.
  const q = page.querySelector("#reader-q");
  if (q && results) q.addEventListener("input", () => {
    READER.query = q.value;
    results.innerHTML = resultsHtml();
    wireHits();
  });
  // Escape empties the box; Enter jumps to the first hit -- both finish a search without the mouse,
  // the same keyboard flow the hit buttons give once you tab to them.
  if (q && results) q.addEventListener("keydown", e => {
    if (e.key === "Escape" && q.value) {
      q.value = ""; READER.query = ""; results.innerHTML = ""; e.stopPropagation();
    } else if (e.key === "Enter") {
      e.preventDefault(); results.querySelector(".reader-hit")?.click();
    }
  });
}
