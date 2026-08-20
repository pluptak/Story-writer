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
  READER.loading = true; READER.error = ""; READER.dir = dir; READER.chapters = [];
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
  for (const ch of READER.chapters) {
    body.push(`<div class="reader-chapter">
      <div class="divider"><span>chapter ${ch.n}</span></div>
      ${ch.error ? `<div class="said bad">${esc(ch.error)}</div>` : `<div class="prose">${paras(ch.text)}</div>`}
    </div>`);
  }
  body.push(`<div class="btns" style="margin-top:18px"><button class="btn" id="reader-back">back</button></div>`);
  return `<section class="picker reader-view">${body.join("")}</section>`;
}

export function wireReaderPage(page) {
  const back = page.querySelector("#reader-back");
  if (back) back.addEventListener("click", () => {
    const dir = READER.dir;
    READER.dir = ""; READER.chapters = []; READER.error = "";
    if (dir) { APP.storyDir = dir; go("story"); } else go("shelf");
  });
}
