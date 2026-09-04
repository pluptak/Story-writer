/** Story-page interactions not covered by the write-path tests: opening a written chapter inline and
 * presenting retained runs grouped by the chapter they wrote. */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { arrive, cardFromStory, copyFixtureStory, expect, registerStory, test } from "./harness.ts";
import type { FixtureStory } from "./harness.ts";

test("the story page opens and closes a written chapter inline", async ({ page, served }) => {
  const dir = await copyFixtureStory();
  try {
    await mkdir(join(dir, "chapters"));
    await writeFile(join(dir, "chapters", "1.md"),
      "# Chapter 1\n\nThe corridor keeps its silence while Riven waits at the door.");
    registerStory(dir, async () => {
      const raw = JSON.parse(await readFile(join(dir, "story.json"), "utf8")) as FixtureStory;
      return { ...cardFromStory(dir, raw, "Inline chapter"), chapters: [1] };
    });

    await arrive(page, served, "#/story?dir=" + encodeURIComponent(dir));
    const scene = page.locator('[data-tid="story.scene-row"][data-chapter="1"]');
    const read = scene.getByTestId("story.read-btn");
    await expect(read).toHaveText("read");

    await read.click();
    await expect(scene.locator(".prose")).toContainText("The corridor keeps its silence");
    await expect(read).toHaveText("close");

    await read.click();
    await expect(scene.locator(".prose")).toHaveCount(0);
    await expect(read).toHaveText("read");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the story page groups retained runs by chapter and keeps compare available", async ({ page, served }) => {
  const dir = await copyFixtureStory();
  try {
    registerStory(dir, async () => {
      const raw = JSON.parse(await readFile(join(dir, "story.json"), "utf8")) as FixtureStory;
      const card = cardFromStory(dir, raw, "Grouped runs");
      return {
        ...card,
        runs: [
          { id: "run-new", mtimeMs: 3, chapter: 2, steps: 3, words: 90, done: true, stopped: false },
          { id: "run-old", mtimeMs: 2, chapter: 1, steps: 2, words: 70, done: true, stopped: false },
          { id: "run-legacy", mtimeMs: 1, steps: 1, words: 30, done: false, stopped: false },
        ],
      };
    });

    await arrive(page, served, "#/story?dir=" + encodeURIComponent(dir));
    await expect(page.getByTestId("story.compare-btn")).toBeVisible();
    const groups = page.locator(".rungroup");
    await expect(groups).toHaveCount(3);
    await expect(groups.nth(0)).toContainText("chapter 1");
    await expect(groups.nth(1)).toContainText("chapter 2");
    await expect(groups.nth(2)).toContainText("unattributed");
    await expect(page.locator('[data-tid="story.run-btn"]')).toHaveCount(3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
