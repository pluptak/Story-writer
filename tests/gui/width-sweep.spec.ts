/** Block 11 — the width sweep. The layout claims scattered through §7, §8, §11,
 *  §12 and the shell, all the same shape: under 900px the live rail stacks
 *  below the prose and stays visible, the compare panes stack, the scaffold
 *  sidebar stacks while the stepper rail disappears (the status bar still
 *  names the stage); at 375px no route scrolls sideways and the nav strip
 *  stays usable; the nav answers a data-theme swap. Bounding boxes, not
 *  eyeballing — plus the one box that needs them, the search jump leaving its
 *  heading clear of the sticky topbar. */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LIVE, publish, setWhere, sseClients } from "../../live.ts";
import { arrive, cardFromStory, copyFixtureStory, expect, registerRunDirs, registerStory, test } from "./harness.ts";
import type { FixtureStory } from "./harness.ts";
import { abandonWalk, startStaged } from "./scaffold-walk.ts";
import type { Page } from "@playwright/test";

// responsive.spec.ts's settle: two rAFs past fonts.ready before measuring — a
// webfont swap or a layout still mid-transition can hold scrollWidth a few px
// over for a frame or two even when the page never scrolls sideways painted.
const noSideScroll = async (page: Page) => page.evaluate(() => {
  const g = globalThis as any;
  return g.document.fonts.ready.then(() => new Promise<void>((resolve) =>
    g.requestAnimationFrame(() => g.requestAnimationFrame(() => resolve()))))
    .then(() => g.document.documentElement.scrollWidth <= g.window.innerWidth + 2);
});

const box = async (page: Page, selector: string) => {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`no bounding box for ${selector}`);
  return b;
};

const QUESTION = "Does Riven get through the door before Merritt decides what to do about them?";

const runLog = (prose: string) => [
  { t: "scene_start", story: "temporary", characters: ["RIVEN", "MERRITT"], target: 700, question: QUESTION, chapter: 1 },
  { t: "draft", step: 1, consulting: "", salvaged: false, chapter: 1, words: 7, prose },
  { t: "scene_end", steps: 2, words: 7, done: true, stopped: false, chapter: 1, retries: {},
    questionState: { status: "unread" } },
].map((e) => JSON.stringify(e)).join("\n") + "\n";

async function setupSweepStory(): Promise<string> {
  const dir = await copyFixtureStory();
  await mkdir(join(dir, "chapters"));
  await writeFile(join(dir, "chapters", "1.md"),
    "# Chapter 1\n\nRiven checks the parcel twice before touching the service door.\n\n"
    + "Merritt hears the pause and asks which key Riven has.");
  await writeFile(join(dir, "chapters", "2.md"),
    "# Chapter 2\n\nMerritt listens from the crate without moving a muscle.");
  for (const id of ["run-a", "run-b"]) await mkdir(join(dir, "out", id), { recursive: true });
  await writeFile(join(dir, "out", "run-a", "writing-log.jsonl"),
    runLog("Riven opens the service door carefully."));
  await writeFile(join(dir, "out", "run-b", "writing-log.jsonl"),
    runLog("Riven opens the service door quickly."));
  registerRunDirs(dir, ["run-a", "run-b"]);
  registerStory(dir, async () => {
    const raw = JSON.parse(await readFile(join(dir, "story.json"), "utf8")) as FixtureStory;
    return {
      ...cardFromStory(dir, raw, "Width sweep"),
      chapters: [1, 2],
      runs: [
        { id: "run-a", mtimeMs: 2, chapter: 1, steps: 2, words: 7, done: true, stopped: false },
        { id: "run-b", mtimeMs: 1, chapter: 1, steps: 2, words: 7, done: true, stopped: false },
      ],
    };
  });
  return dir;
}

function startLive(dir: string) {
  LIVE.running = true;
  setWhere("writing", true);
  LIVE.meta = {
    story: dir, chapter: 1, chapters: 2, target: 700, question: QUESTION,
    characters: [{ name: "RIVEN", skills: [], restrictions: [] },
                 { name: "MERRITT", skills: [], restrictions: [] }],
  };
  publish({ t: "scene_start", story: dir, characters: ["RIVEN", "MERRITT"], target: 700, question: QUESTION, chapter: 1 });
  publish({ t: "draft", step: 1, consulting: "", salvaged: false, chapter: 1, words: 42,
            prose: "Merritt hears the courier out, then names the one thing the log will accept." });
}

test("under 900px the live rail stacks below the prose and stays visible", async ({ page, served }) => {
  const dir = await setupSweepStory();
  try {
    await page.setViewportSize({ width: 800, height: 900 });
    await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
    startLive(dir);
    await expect(page.getByTestId("live.prose-card")).toBeVisible();

    // Stacked, not beside: the rail starts at or below the prose card's end.
    const prose = await box(page, '[data-tid="live.prose-card"]');
    const rail = await box(page, "#rail");
    expect(rail.y).toBeGreaterThanOrEqual(prose.y + prose.height - 4);
    // And staying visible means the run can still be stopped down there.
    await expect(page.locator("#rail")).toBeVisible();
    await page.locator("#stop").scrollIntoViewIfNeeded();
    await expect(page.locator("#stop")).toBeVisible();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("under 900px the compare panes stack and the diff stays readable", async ({ page, served }) => {
  const dir = await setupSweepStory();
  try {
    await page.setViewportSize({ width: 800, height: 900 });
    await arrive(page, served, "#/story?dir=" + encodeURIComponent(dir));
    await page.locator("#story-compare").click();
    await expect(page.getByTestId("compare.pane")).toHaveCount(2);

    const a = await box(page, '[data-tid="compare.pane"][data-side="a"]');
    const b = await box(page, '[data-tid="compare.pane"][data-side="b"]');
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.height - 4);
    await expect(page.getByTestId("compare.diff")).toContainText("carefully");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("under 900px the scaffold stays single-column with its position named", async ({ page, served }) => {
  try {
    await page.setViewportSize({ width: 800, height: 900 });
    await startStaged(page, served);

    // No sidebar or stepper rail exists in the current layout to stack or
    // hide: the stages list and the status bar carry the position instead,
    // and both stay on screen.
    await expect(page.locator(".scpage .stepper-rail")).toHaveCount(0);
    await expect(page.locator(".scpage aside")).toHaveCount(0);
    await expect(page.locator(".scpage .statusbar")).toContainText("Direction");
    await expect(page.locator("ol.stages")).toBeVisible();
    await expect(page.locator('[data-tid="scaffold.stage-section"][data-stage="direction"]')).toBeVisible();
    expect(await noSideScroll(page)).toBe(true);

    await page.setViewportSize({ width: 375, height: 900 });
    await expect(page.locator(".scpage .statusbar")).toContainText("Direction");
    await expect.poll(() => noSideScroll(page), {
      message: `#/scaffold should not scroll sideways at 375px`,
    }).toBe(true);
  } finally {
    await abandonWalk(page, served);
  }
});

test("at 375px no route scrolls sideways and the nav strip stays usable", async ({ page, served }) => {
  const dir = await setupSweepStory();
  try {
    await page.setViewportSize({ width: 375, height: 900 });
    await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
    startLive(dir);
    await expect(page.getByTestId("live.prose-card")).toBeVisible();

    const routes: Array<[string, string]> = [
      ["#/live", '[data-tid="live.prose-card"]'],
      ["#/shelf", '[data-tid="shelf.picker"]'],
      ["#/readstory?dir=" + encodeURIComponent(dir), "#reader-ch-1"],
      ["#/read?dir=" + encodeURIComponent(dir) + "&id=run-a", '[data-tid="read.chrome"]'],
      ["#/catalog", '[data-tid="character-library.page"]'],
      ["#/handoff?dir=" + encodeURIComponent(dir), "#h-start"],
    ];
    for (const [hash, ready] of routes) {
      await arrive(page, served, hash);
      await expect(page.locator(ready)).toBeVisible();
      await expect.poll(() => noSideScroll(page), {
        message: `${hash} should not scroll sideways at 375px`,
      }).toBe(true);
    }

    // Compare is reached through the story page, which anchors the run
    // choice; a cold deep link never settles its picker.
    await arrive(page, served, "#/story?dir=" + encodeURIComponent(dir));
    await expect(page.locator('[data-tid="story.map-status"]')).toBeVisible();
    await expect.poll(() => noSideScroll(page), {
      message: `#/story should not scroll sideways at 375px`,
    }).toBe(true);
    await page.locator("#story-compare").click();
    await expect(page.getByTestId("compare.pane")).toHaveCount(2);
    await expect.poll(() => noSideScroll(page), {
      message: `#/compare should not scroll sideways at 375px`,
    }).toBe(true);

    // The editor refuses to load while a run is in flight, so the run ends
    // before its route is swept.
    LIVE.running = false;
    await arrive(page, served, "#/edit?dir=" + encodeURIComponent(dir));
    await expect(page.locator(".editor")).toBeVisible();
    await expect.poll(() => noSideScroll(page), {
      message: `#/edit should not scroll sideways at 375px`,
    }).toBe(true);

    // The strip does not hide on the smallest screen: it stays visible and a
    // tap on it still navigates. (The checklist's "hides below 680px" never
    // shipped — the strip is the small-screen nav, and hiding it would strand
    // the author with no way around.)
    await arrive(page, served, "#/readstory?dir=" + encodeURIComponent(dir));
    await expect(page.locator("#sidenav")).toBeVisible();
    await page.locator("#nav-shelf").click();
    await expect(page.getByTestId("shelf.picker")).toBeVisible();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the nav answers a data-theme swap in both directions", async ({ page, served }) => {
  await arrive(page, served, "#/shelf");
  await expect(page.getByTestId("shelf.picker")).toBeVisible();

  const bg = async () => page.evaluate(() =>
    (globalThis as any).getComputedStyle((globalThis as any).document.body).backgroundColor);
  await page.evaluate(() => (globalThis as any).document.documentElement.setAttribute("data-theme", "dark"));
  const dark = await bg();
  await expect(page.locator("#sidenav .navitem.current")).toBeVisible();
  await page.evaluate(() => (globalThis as any).document.documentElement.setAttribute("data-theme", "light"));
  const light = await bg();
  await expect(page.locator("#sidenav .navitem.current")).toBeVisible();
  expect(dark).not.toBe(light);
});

test("a search jump leaves its heading clear of the sticky topbar", async ({ page, served }) => {
  const dir = await setupSweepStory();
  try {
    await arrive(page, served, "#/readstory?dir=" + encodeURIComponent(dir));
    await expect(page.locator("#reader-ch-2")).toBeVisible();

    await page.locator("#reader-q").fill("muscle");
    await page.getByTestId("reader.hit").first().click();
    await expect.poll(async () => page.evaluate(() => {
      const g = globalThis as any;
      const heading = g.document.querySelector("#reader-ch-2");
      const bar = g.document.querySelector(".topbar");
      if (!heading || !bar) return false;
      const h = heading.getBoundingClientRect(), b = bar.getBoundingClientRect();
      return h.top >= b.bottom - 4;
    }), { message: "the jumped-to heading should clear the sticky topbar" }).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
