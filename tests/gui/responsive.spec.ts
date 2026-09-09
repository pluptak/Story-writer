/** Narrow-screen contract: prose stays primary, decisions and run controls stay reachable,
 *  navigation stays usable, and the page never scrolls sideways. Widths bracket the 900px
 *  breakpoint the layout already pivots on (stacked rail + nav strip below it, grid beside it).
 *  Technical metadata (volumes, engine details) is already disclosure-gated; these tests pin
 *  the geometry that keeps it that way. */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LIVE, publish, setWhere, sseClients } from "../../live.ts";
import {
  arrive, cardFromStory, copyFixtureStory, expect, registerRunDirs, registerStory, test,
} from "./harness.ts";
import type { FixtureStory } from "./harness.ts";
import { llmLog, writingLog } from "./run-log.ts";

const noSideScroll = async (page) =>
  await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

async function setupStory(): Promise<string> {
  const dir = await copyFixtureStory();
  await mkdir(join(dir, "chapters"));
  await writeFile(join(dir, "chapters", "1.md"),
    "# Chapter 1\n\nRiven checks the parcel twice before touching the service door.\n\n"
    + "Merritt hears the pause and asks which key Riven has.");
  await mkdir(join(dir, "out", "run-a", "llm"), { recursive: true });
  await writeFile(join(dir, "out", "run-a", "writing-log.jsonl"),
    writingLog({ characters: ["RIVEN", "MERRITT"], consults: [{ who: "MERRITT", attempts: 1 }] }));
  await writeFile(join(dir, "out", "run-a", "llm", "merritt.jsonl"),
    llmLog("MERRITT", "google/extremely-long-model-id-for-overflow-probing-1234567890", 3));
  registerRunDirs(dir, ["run-a"]);
  registerStory(dir, async () => {
    const raw = JSON.parse(await readFile(join(dir, "story.json"), "utf8")) as FixtureStory;
    return {
      ...cardFromStory(dir, raw, "Responsive contract"),
      chapters: [1],
      runs: [{ id: "run-a", mtimeMs: 2, chapter: 1, steps: 1, words: 40, done: true, stopped: false }],
    };
  });
  return dir;
}

function startLive() {
  LIVE.running = true;
  setWhere("writing", true);
  publish({ t: "scene_start", story: "tests/fixtures/doorway", characters: ["RIVEN", "MERRITT"], target: 700, chapter: 1 });
  publish({ t: "draft", step: 1, consulting: "", salvaged: false, chapter: 1, words: 42,
            prose: "Merritt hears the courier out, then names the one thing the log will accept." });
}

test("shelf, story, live and manuscript never scroll sideways at 390 and 768", async ({ page, served }) => {
  const dir = await setupStory();
  try {
    await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
    startLive();
    await expect(page.getByTestId("live.prose-card")).toBeVisible();
    await page.waitForTimeout(500);

    const views: Array<[string, string]> = [
      ["#/shelf", "#page"],
      ["#/story?dir=" + encodeURIComponent(dir), '[data-tid="story.map-status"]'],
      ["#/live", '[data-tid="live.prose-card"]'],
      ["#/readstory?dir=" + encodeURIComponent(dir), "#reader-ch-1"],
    ];
    for (const width of [390, 768]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [hash, ready] of views) {
        await arrive(page, served, hash);
        await expect(page.locator(ready)).toBeVisible();
        await page.waitForTimeout(300);
        expect(await noSideScroll(page)).toBe(true);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a saved run with long model ids never scrolls sideways at 390", async ({ page, served }) => {
  const dir = await setupStory();
  try {
    await page.setViewportSize({ width: 390, height: 900 });
    await arrive(page, served, "#/story?dir=" + encodeURIComponent(dir));
    await page.locator('[data-tid="story.run-btn"][data-run="run-a"]').click();
    await expect(page.getByTestId("agents.panel")).toBeVisible();
    await page.waitForTimeout(300);
    expect(await noSideScroll(page)).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("narrow live keeps decisions, run controls and navigation reachable", async ({ page, served }) => {
  const dir = await setupStory();
  try {
    // Load the manuscript first, then let the run-start edge pull the viewer to live
    // with no reload in between -- arrive() is a fresh document load and would wipe READER.
    await arrive(page, served, "#/readstory?dir=" + encodeURIComponent(dir));
    await expect(page.locator("#reader-ch-1")).toContainText("parcel twice");
    await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
    startLive();
    await expect(page.getByTestId("live.prose-card")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 900 });
    // The sticky topbar compresses (subtitle hides -- the srcbar carries it).
    await expect(page.locator(".brand .q")).toBeHidden();

    // Prose primary and on screen; the run's controls survive the stacking.
    await expect(page.getByTestId("prose.piece")).toContainText("courier");
    await page.locator("#stop").scrollIntoViewIfNeeded();
    await expect(page.locator("#stop")).toBeVisible();
    await expect(page.locator("#consultMe")).toBeVisible();
    // The nav strip's current item works from inside the overflow: this click
    // auto-scrolls the strip, lands on the manuscript, and proves the strip usable.
    await page.locator("#nav-readstory").click();
    await expect(page.locator("#reader-ch-1")).toBeVisible({ timeout: 15000 });
    expect(await noSideScroll(page)).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
