/** Reader mode — accepted chapter prose is loaded through the real /chapter route, searched in the
 * browser, and returned to the story page without leaving stale reader state behind. */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { arrive, cardFromStory, copyFixtureStory, expect, registerStory, test } from "./harness.ts";
import type { FixtureStory } from "./harness.ts";

test("the reader loads chapter prose, searches it, and returns to the story", async ({ page, served }) => {
  const dir = await copyFixtureStory();
  try {
    await mkdir(join(dir, "chapters"));
    await writeFile(join(dir, "chapters", "1.md"),
      "# Chapter 1\n\nRiven checks the parcel twice before touching the service door.\n\n"
      + "Merritt hears the pause and asks which key Riven has.");
    registerStory(dir, async () => {
      const raw = JSON.parse(await readFile(join(dir, "story.json"), "utf8")) as FixtureStory;
      return { ...cardFromStory(dir, raw, "Doorway reader"), chapters: [1] };
    });

    await arrive(page, served, "#/readstory?dir=" + encodeURIComponent(dir));

    await expect(page.locator(".reader-chapter")).toHaveCount(1);
    await expect(page.locator("#reader-ch-1")).toContainText("Riven checks the parcel twice");
    await expect(page).toHaveURL(new RegExp("readstory\\?dir=" + encodeURIComponent(dir).replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")));

    const search = page.locator("#reader-q");
    await search.fill("which key");
    await expect(page.getByTestId("reader.hit")).toHaveCount(1);
    await expect(page.getByTestId("reader.hit")).toContainText("which key");

    await search.fill("not in this chapter");
    await expect(page.locator(".reader-noresult")).toContainText("no matches");

    await search.fill("Riven");
    await page.getByTestId("reader.hit").first().press("Enter");
    await expect(page).toHaveURL(new RegExp("#\\/readstory\\?dir="));

    await page.locator("#reader-back").click();
    await expect(page).toHaveURL(new RegExp("#\\/story\\?dir="));
    await expect(page.locator("#page")).toContainText("Doorway reader");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
