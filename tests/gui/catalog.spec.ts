/** Block 4 — the catalog CRUD screens over the real engine catalog logic, isolated to temp files.
 *  The character form fills, saves, lists, selects, and deletes behind its armed confirm; the tag
 *  catalog seeds from the engine and its kind rides the URL. */
import { arrive, expect, test } from "./harness.ts";

test("the catalog creates, lists, and deletes a character entry", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");

  // An empty characters catalog: the form starts from nothing.
  await expect(page.getByTestId("catalog.entry-row")).toHaveCount(0);
  await page.locator("#cat-new").click();
  await page.locator("#cat-name").fill("IVET");
  await page.locator("#cat-persona").fill("Ex-locksmith, keeps every key on a labelled ring.");
  await page.locator("#cat-belief").fill("Every lock has a polite way in.");
  await page.locator("#cat-impulse").fill("When watched, slow down and narrate the work.");
  await page.locator("#cat-voice").fill('"Hold the door? I\'d rather hold the lock."');
  await page.locator("#cat-skills").fill("lockpicking :: opening a mechanical lock without its key");
  await page.locator("#cat-save").click();

  // The saved entry is on the list, backed by the real save path.
  await expect(page.getByTestId("catalog.entry-row")).toHaveCount(1);
  await expect(page.getByTestId("catalog.entry-row")).toContainText("IVET");

  // Deleting is a two-click confirm; the second click within the window removes the entry.
  await page.getByTestId("catalog.entry-row").first().click();
  const del = page.locator("#cat-delete");
  await del.click();
  await expect(del).toHaveText(/delete — sure\?/);
  await del.click();
  await expect(page.getByTestId("catalog.entry-row")).toHaveCount(0);
});

test("the tag catalog seeds from the engine and its kind rides the URL", async ({ page, served }) => {
  await arrive(page, served, "#/catalog?kind=tags");

  const rows = page.getByTestId("catalog.entry-row");
  await expect(rows.first()).toBeVisible();
  await expect.poll(async () => rows.count()).toBeGreaterThanOrEqual(20);   // the engine's seed
  await expect(page).toHaveURL(/kind=tags/);

  // Back to characters: the switcher is a real navigation, and the URL follows.
  await arrive(page, served, "#/catalog");
  await expect(page).toHaveURL(/#\/catalog$/);
  await expect(page.getByTestId("catalog.entry-row")).toHaveCount(0);
});

test("the skill catalog seeds from the engine and new entries can be created", async ({ page, served }) => {
  await arrive(page, served, "#/catalog?kind=skills");

  // The engine's seed: 3 entries (lockpicking, climbing, sleight-of-hand)
  const rows = page.getByTestId("catalog.entry-row");
  await expect(rows.first()).toBeVisible();
  await expect.poll(async () => rows.count()).toBe(3);
  await expect(page).toHaveURL(/kind=skills/);

  // Create a new skill
  await page.locator("#cat-new").click();
  await page.locator("#cat-name").fill("Telekinesis");
  await page.locator("#cat-meaning").fill("The ability to move objects with the mind alone, no physical contact required.");
  await page.locator("#cat-save").click();

  // The saved entry is on the list, backed by the real save path.
  await expect.poll(async () => rows.count()).toBe(4);
  await expect.poll(async () => {
    const entries = await page.getByTestId("catalog.entry-row").allTextContents();
    return entries.some(text => text.includes("Telekinesis"));
  }).toBe(true);
});
