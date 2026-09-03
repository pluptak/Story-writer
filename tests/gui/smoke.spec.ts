/** Block 1 — the loop closes. One test, and its job is to be able to fail: the viewer's ES modules
 *  must actually boot (the failure class lint provably cannot catch — it parses, never boots) and
 *  the shelf must render the fixture story's card from the harness's ServerHost. */
import { expect, test } from "./harness.ts";

test("the viewer boots and the shelf renders the fixture story's card", async ({ page }) => {
  const card = page.getByTestId("shelf.story-card");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText(
    "Does Riven get through the door before Merritt decides what to do about them?");
  await expect(card).toContainText("RIVEN");
  await expect(card).toContainText("MERRITT");
  await expect(card).toBeEnabled();
  await expect(page.locator("#page")).not.toBeEmpty();
});
