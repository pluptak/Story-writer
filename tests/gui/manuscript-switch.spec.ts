/** Manuscript switching — Write, Story map and Manuscript keep the current
 *  story context: moving between them neither wipes the loaded chapters nor
 *  drops which story is open, and chapter jumps never leave the route. */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { arrive, cardFromStory, copyFixtureStory, expect, registerStory, test } from "./harness.ts";
import type { FixtureStory } from "./harness.ts";

async function setupTwoChapters() {
  const dir = await copyFixtureStory();
  await mkdir(join(dir, "chapters"));
  await writeFile(join(dir, "chapters", "1.md"),
    "# Chapter 1\n\nRiven checks the parcel twice before touching the service door.");
  await writeFile(join(dir, "chapters", "2.md"),
    "# Chapter 2\n\nMerritt counts the stairs twice before following Riven up.");
  registerStory(dir, async () => {
    const raw = JSON.parse(await readFile(join(dir, "story.json"), "utf8")) as FixtureStory;
    return { ...cardFromStory(dir, raw, "Switch story"), chapters: [1, 2] };
  });
  return dir;
}

test("story map and manuscript round-trip keeps the story context", async ({ page, served }) => {
  const dir = await setupTwoChapters();
  try {
    await arrive(page, served, "#/story?dir=" + encodeURIComponent(dir));

    await page.locator("#story-read-story").click();
    await expect(page.locator(".reader-chapter")).toHaveCount(2);
    await expect(page.getByTestId("reader.toc")).toBeVisible();
    await expect(page.getByTestId("reader.toc-link")).toHaveCount(2);
    await expect(page).toHaveURL(new RegExp("#\\/readstory\\?dir="));

    // A chapter jump scrolls; it must not become a route change that drops the story.
    await page.getByTestId("reader.toc-link").nth(1).click();
    await expect(page).toHaveURL(new RegExp("#\\/readstory\\?dir="));
    await expect(page.locator("#reader-ch-2")).toContainText("counts the stairs twice");

    // Back to authoring lands on the same story map…
    await page.locator("#reader-back").click();
    await expect(page).toHaveURL(new RegExp("#\\/story\\?dir="));
    await expect(page.locator("#page")).toContainText("Switch story");

    // …and the manuscript is still there on return, no context lost.
    await page.locator("#story-read-story").click();
    await expect(page.locator(".reader-chapter")).toHaveCount(2);
    await expect(page.locator("#reader-ch-1")).toContainText("checks the parcel twice");
    await expect(page.getByTestId("reader.tech-details")).toBeVisible();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("manuscript survives a trip to Write and back", async ({ page, served }) => {
  const dir = await setupTwoChapters();
  try {
    await arrive(page, served, "#/readstory?dir=" + encodeURIComponent(dir));
    await expect(page.locator(".reader-chapter")).toHaveCount(2);

    // The obvious way back to authoring: Continue writing goes to Write…
    await page.locator("#reader-write").click();
    await expect(page).toHaveURL(new RegExp("#\\/live$"));
    await expect(page.getByTestId("live.empty")).toBeVisible();

    // …and Manuscript returns to the same loaded chapters, not an empty view.
    await page.locator("#nav-readstory").click();
    await expect(page).toHaveURL(new RegExp("#\\/readstory\\?dir="));
    await expect(page.locator(".reader-chapter")).toHaveCount(2);
    await expect(page.locator("#reader-ch-2")).toContainText("counts the stairs twice");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
