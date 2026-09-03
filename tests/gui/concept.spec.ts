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
  const options = castSizeSelect.locator("option");
  const values = await options.evaluateAll(nodes => nodes.map(n => (n as HTMLOptionElement).value));
  expect(values).toEqual(["0", "2", "3", "4"]);
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
