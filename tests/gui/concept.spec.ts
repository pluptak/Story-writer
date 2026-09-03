/** Block 5 — the concept fields in the idea modal, backed by the real tag catalog.
 *  The tag picker and cast-size select are visible only for staged walks, reload through
 *  mode changes, and survive switching back and forth. */
import { arrive, expect, test } from "./harness.ts";

test("the idea modal offers the tag catalog's own vocabulary", async ({ page, served }) => {
  await arrive(page, served, "#/scaffold");

  // The modal is visible on arriving at #/scaffold with no interview active.
  await expect(page.getByTestId("scaffold.idea-modal")).toBeVisible();

  // The three facet headings are present with their exact text.
  const facetHeadings = page.locator("div.cat-facet-heading");
  await expect(facetHeadings).toHaveCount(3);
  const headingTexts = await facetHeadings.allTextContents();
  expect(headingTexts).toEqual(["Genre", "Dramatic Mode", "Tone"]);

  // The chips are the catalog's, not this page's: an absent tags file yields the engine's seed.
  // Counted loosely on purpose — pinning the seed's exact size would fail this test for a reason
  // that has nothing to do with the modal.
  await expect.poll(async () => page.locator("#iv-backdrop .cat-chip").count()).toBeGreaterThanOrEqual(20);

  // The cast-size select exists with the correct option values.
  const castSizeSelect = page.locator("#f-cast-size");
  await expect(castSizeSelect).toBeVisible();
  // Read through locators rather than evaluateAll: this project's tsconfig has no DOM lib, so a
  // handler annotated with an HTML element type does not typecheck.
  const options = castSizeSelect.locator("option");
  await expect(options).toHaveCount(4);
  for (const [i, value] of ["0", "2", "3", "4"].entries())
    await expect(options.nth(i)).toHaveAttribute("value", value);
});

test("a chip toggles and stays toggled through the re-render it causes", async ({ page, served }) => {
  await arrive(page, served, "#/scaffold");

  // Every click re-renders the whole page, replacing this node. The locator is a query, not a
  // handle, so it resolves against whatever is there now -- which is the property under test.
  const chip = page.locator('button.cat-chip[data-tag-label="fantasy"]');   // a genre in TAG_SEED
  await chip.click();
  await expect(chip).toHaveClass(/on/);
  await chip.click();
  await expect(chip).not.toHaveClass(/on/);
});

test("the concept belongs to the staged walk only", async ({ page, served }) => {
  await arrive(page, served, "#/scaffold");

  // The picker and cast-size select are visible by default (staged is the default mode).
  await expect(page.locator(".cat-tags-picker")).toBeVisible();
  await expect(page.locator("#f-cast-size")).toBeVisible();

  // Select the oneshot radio.
  await page.locator('input[name="mode"][value="oneshot"]').click();

  // Both are now gone from the DOM.
  await expect(page.locator(".cat-tags-picker")).toHaveCount(0);
  await expect(page.locator("#f-cast-size")).toHaveCount(0);

  // Select staged again.
  await page.locator('input[name="mode"][value="staged"]').click();

  // Both are back.
  await expect(page.locator(".cat-tags-picker")).toBeVisible();
  await expect(page.locator("#f-cast-size")).toBeVisible();
});

test("a chosen cast size survives switching walks", async ({ page, served }) => {
  await arrive(page, served, "#/scaffold");

  // Set the cast size to 3.
  await page.locator("#f-cast-size").selectOption("3");

  const chip = page.locator('button.cat-chip[data-tag-label="fantasy"]');
  await chip.click();
  await expect(chip).toHaveClass(/on/);

  // Switch to oneshot.
  await page.locator('input[name="mode"][value="oneshot"]').click();

  // Switch back to staged.
  await page.locator('input[name="mode"][value="staged"]').click();

  // The cast size is still 3.
  await expect(page.locator("#f-cast-size")).toHaveValue("3");

  await expect(chip).toHaveClass(/on/);
});

test("with an empty character catalog the import picker says where characters come from", async ({ page, served }) => {
  await arrive(page, served, "#/scaffold");

  // No import chips are present when the catalog is empty.
  await expect(page.locator(".cat-chip[data-import-id]")).toHaveCount(0);

  // The hint text is visible explaining where characters come from.
  await expect(page.getByText(/No characters in the catalog yet/)).toBeVisible();

  // The cast-size select is still present: nothing is imported yet, so the size still means something.
  await expect(page.locator("#f-cast-size")).toBeVisible();
});

test("a character in the catalog can be cast, and the tray takes over the cast size", async ({ page, served }) => {
  // Create a character in the catalog.
  await arrive(page, served, "#/catalog");
  await page.locator("#cat-new").click();
  await page.locator("#cat-name").fill("IVET");
  await page.locator("#cat-persona").fill("Ex-locksmith, keeps every key on a labelled ring.");
  await page.locator("#cat-belief").fill("Every lock has a polite way in.");
  await page.locator("#cat-impulse").fill("When watched, slow down and narrate the work.");
  await page.locator("#cat-voice").fill('"Hold the door? I\'d rather hold the lock."');
  await page.locator("#cat-skills").fill("lockpicking :: opening a mechanical lock without its key");
  await page.locator("#cat-save").click();

  // Go to the scaffold and wait for the IVET chip to appear.
  await arrive(page, served, "#/scaffold");
  const ivetChip = page.locator('button.cat-chip[data-import-id]').filter({ hasText: "IVET" });
  await expect(ivetChip).toBeVisible();

  // Before selecting, the cast-size select is present.
  await expect(page.locator("#f-cast-size")).toBeVisible();

  // Click the IVET chip to select it.
  await ivetChip.click();
  await expect(ivetChip).toHaveClass(/on/);

  // The cast-size select is now gone because the imported cast is the opening cast.
  await expect(page.locator("#f-cast-size")).toHaveCount(0);

  // The hint text is visible explaining that the imported cast is the opening cast.
  await expect(page.getByText(/The imported cast is the opening cast/)).toBeVisible();

  // Click the IVET chip again to deselect it.
  await ivetChip.click();
  await expect(ivetChip).not.toHaveClass(/on/);

  // The cast-size select is back.
  await expect(page.locator("#f-cast-size")).toBeVisible();

  // Clean up: delete the IVET character from the catalog so the next test sees it empty.
  await arrive(page, served, "#/catalog");
  await page.getByTestId("catalog.entry-row").first().click();
  const del = page.locator("#cat-delete");
  await del.click();
  await expect(del).toHaveText(/delete — sure\?/);
  await del.click();
  await expect(page.getByTestId("catalog.entry-row")).toHaveCount(0);
});
