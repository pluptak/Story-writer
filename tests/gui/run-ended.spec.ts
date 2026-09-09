/** Run completion — the viewer keeps the completed live scene visible and offers an explicit
 * choice instead of silently returning to the shelf. */
import { LIVE, publish, sseClients, setWhere } from "../../live.ts";
import { expect, test } from "./harness.ts";

test("a completed live run opens its modal and stay here dismisses it", async ({ page }) => {
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);

  LIVE.running = true;
  setWhere("writing", true);
  publish({
    t: "scene_start", story: "tests/fixtures/doorway", characters: ["RIVEN", "MERRITT"],
    target: 700, chapter: 1,
  });
  publish({
    t: "scene_end", steps: 4, words: 138, done: true, stopped: false, chapter: 1, retries: {},
  });
  setWhere("idle", false);

  const modal = page.getByTestId("runended.modal");
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("scene finished");
  await expect(modal).toContainText("138 words");
  await expect(modal).toContainText("4 steps");

  await page.locator("#runended-stay").click();
  await expect(modal).toHaveCount(0);
  await expect(page).toHaveURL(/#\/live$/);
});

test("a completed live run offers the story that ran, not the shelf", async ({ page }) => {
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);

  LIVE.running = true;
  setWhere("writing", true);
  publish({
    t: "scene_start", story: "tests/fixtures/doorway", characters: ["RIVEN", "MERRITT"],
    target: 700, chapter: 1,
  });
  publish({
    t: "scene_end", steps: 4, words: 138, done: true, stopped: false, chapter: 1, retries: {},
  });
  setWhere("idle", false);

  const modal = page.getByTestId("runended.modal");
  await expect(modal).toBeVisible();
  await page.locator("#runended-story").click();
  await expect(modal).toHaveCount(0);
  // The story is recovered from the run itself: no story page was ever visited, yet the
  // modal lands on the map, where the next chapter, the manuscript and the history live.
  await expect(page).toHaveURL(/#\/story\?dir=tests%2Ffixtures%2Fdoorway/);
  await expect(page.getByTestId("story.map-status")).toBeVisible();
});
