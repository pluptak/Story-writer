/** The rail answers "what do I need to know while writing": Scene status, cast, controls,
 *  then the collapsed engine disclosure — in that DOM order, with nothing duplicated out of it. */
import { LIVE, publish, setWhere, sseClients } from "../../live.ts";
import { expect, test } from "./harness.ts";

function startRun() {
  LIVE.running = true;
  setWhere("writing", true);
  publish({ t: "scene_start", story: "tests/fixtures/doorway", characters: ["RIVEN", "MERRITT"], target: 700, chapter: 1 });
  publish({ t: "draft", step: 1, consulting: "", salvaged: false, chapter: 1, words: 42,
            prose: "Riven names the price of the open door." });
}

test("rail order is status, cast, controls, engine details", async ({ page }) => {
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
  startRun();
  await expect(page.getByTestId("live.prose-card")).toBeVisible();

  // DOM order is the hierarchy: Scene card, cast, controls, engine disclosure last.
  const order = await page.evaluate(() => {
    const ids = ["runscene", "castcard", "runctrl", "railstats"];
    return ids.map(id => {
      const el = document.getElementById(id);
      if (!el) return -1;
      const r = el.getBoundingClientRect();
      return r.top;
    });
  });
  expect(order.every(v => v >= 0)).toBe(true);
  expect(order[0]).toBeLessThan(order[1]);
  expect(order[1]).toBeLessThan(order[2]);
  expect(order[2]).toBeLessThan(order[3]);

  // Each level labelled; status carries phase + chapter progress, not engine numbers.
  await expect(page.locator("#runscene")).toContainText("Scene");
  await expect(page.getByTestId("rail.status")).toBeVisible();
  await expect(page.locator('[data-tid="rail.stat"][data-k="words"]')).toContainText("42 / 700");
  await expect(page.locator("#castcard")).toContainText("cast in scene");
  await expect(page.getByTestId("cast.chip")).toHaveCount(2);
  await expect(page.locator("#runctrl")).toContainText("run controls");

  // Advanced engine information is collapsed: steps/model/retries hide until opened.
  const details = page.getByTestId("rail.engine-details");
  await expect(details).toBeVisible();
  await expect(page.locator('[data-tid="rail.stat"][data-k="steps"]')).toBeHidden();
  await expect(page.locator('[data-tid="rail.stat"][data-k="retries"]')).toBeHidden();
  await details.locator("summary").click();
  await expect(page.locator('[data-tid="rail.stat"][data-k="steps"]')).toBeVisible();
  await expect(page.locator('[data-tid="rail.stat"][data-k="retries"]')).toBeVisible();
});

test("off the live screen the rail keeps only what applies", async ({ page }) => {
  // Shelf: nothing running, nothing to control or track — both cards hide.
  await expect(page.getByTestId("chrome.sidenav")).toBeVisible();
  await expect(page.locator("#runscene")).toBeHidden();
  await expect(page.locator("#runctrl")).toBeHidden();
  await expect(page.locator("#castcard")).toBeHidden();
});

test("narrow screens keep the rail usable: stacked, visible, no sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 500, height: 900 });
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
  startRun();
  await expect(page.getByTestId("live.prose-card")).toBeVisible();

  // Below 900px the rail stacks below the prose instead of sticking beside it — and stays
  // visible, since the only way to stop a run lives there.
  const position = await page.evaluate(() => getComputedStyle(document.getElementById("rail")!).position);
  expect(position).toBe("static");
  await expect(page.locator("#runctrl")).toBeVisible();
  await expect(page.locator("#stop")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
