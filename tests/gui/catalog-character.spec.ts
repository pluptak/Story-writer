/** Block 9a — §13's character form. The lifecycle the shared catalog.spec does
 *  not pin down: delete's cancel/Escape/backdrop all keep the entry and a
 *  confirm never strands one; switching kinds keeps the draft with no modal
 *  while every Libraries entry lands on its kind; hide/restore neither
 *  disturbs an unsaved draft nor appears where the schema has no `hidden`;
 *  the toggle disables itself mid-flight; the review panel ignores backdrop
 *  and Escape but not its ×/Close; revert repaints live; the count stays live
 *  without stealing the caret; a never-saved draft is reviewable; the pager
 *  footer reads as one row and search keeps the caret with a pager showing. */
import { arrive, expect, holdCatalogWrites, test } from "./harness.ts";

async function newCharacter(page: import("@playwright/test").Page, name: string) {
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill(name);
}

test("the shelf's library card opens the catalog, empty but inviting", async ({ page, served }) => {
  await arrive(page, served, "#/shelf");
  await page.getByTestId("shelf.catalog-card").click();
  await expect(page).toHaveURL(/#\/catalog$/);
  // A first run with no entries reads as an invitation, clearly distinct
  // from a failed load: no error, no retry button, a way forward.
  await expect(page.locator("#page")).toContainText("Your library is empty");
  await expect(page.locator("#page")).not.toContainText("could not load");
  await expect(page.locator("#charlib-retry")).toHaveCount(0);
  await expect(page.locator("#charlib-new")).toBeVisible();
});

test("delete's cancel, Escape and backdrop all keep the entry", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await newCharacter(page, "IVET");
  await page.locator("#charlib-save").click();
  await expect(page.locator(".lib-row")).toHaveCount(1);

  const row = () => page.locator(".lib-row").first();
  await row().click();
  await page.locator("#charlib-delete").click();
  await expect(page.locator('[data-tid="confirm.dialog"]')).toBeVisible();
  await page.locator('[data-tid="confirm.cancel"]').click();
  await expect(page.locator(".lib-row")).toHaveCount(1);

  await page.locator("#charlib-delete").click();
  await expect(page.locator('[data-tid="confirm.dialog"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".lib-row")).toHaveCount(1);

  await page.locator("#charlib-delete").click();
  await expect(page.locator('[data-tid="confirm.dialog"]')).toBeVisible();
  await page.locator("#confirm-backdrop").click({ position: { x: 5, y: 5 } });
  await expect(page.locator(".lib-row")).toHaveCount(1);
});

test("a confirm never strands a delete", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await newCharacter(page, "IVET");
  await page.locator("#charlib-save").click();
  await page.locator(".lib-row").first().click();
  await page.locator("#charlib-delete").click();
  await expect(page.locator('[data-tid="confirm.dialog"]')).toBeVisible();

  // Away without confirming: reload drops the client state with it. The modal
  // backdrop intercepts sidenav clicks, so reload is the way out — nothing
  // was deleted, and no modal is left open.
  await page.reload();
  await expect(page.locator(".lib-row")).toHaveCount(1);
  await expect(page.locator('[data-tid="confirm.dialog"]')).toHaveCount(0);
});

test("switching kinds keeps the draft, and every Libraries entry lands on its kind", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill("KEEP");

  // No tab switcher exists — kinds change by navigation, behind the Libraries
  // disclosure — and the unsaved draft survives it with no modal: nothing is
  // lost, so nothing warns.
  await page.locator("#nav-libraries > summary").click();
  await page.locator("#nav-cat-tags").click();
  await expect(page).toHaveURL(/#\/catalog\?kind=tags/);
  await expect(page.locator('[data-tid="confirm.dialog"]')).toHaveCount(0);
  await page.locator("#nav-cat-characters").click();
  await expect(page.locator("#charlib-name")).toHaveValue("KEEP");

  // Each Libraries entry seeds the kind before the page loads.
  await page.locator("#nav-cat-styles").click();
  await expect(page).toHaveURL(/#\/catalog\?kind=styles/);
  await expect(page.locator(".lib-styles")).toBeVisible();
  await page.locator("#nav-cat-skills").click();
  await expect(page).toHaveURL(/#\/catalog\?kind=skills/);
  await expect(page.locator(".lib-skills")).toBeVisible();
  await page.locator("#nav-cat-tags").click();
  await expect(page.locator(".lib-tags")).toBeVisible();
  await page.locator("#nav-cat-characters").click();
  await expect(page.locator(".lib-characters")).toBeVisible();
});

test("hiding does not disturb an unsaved draft", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await newCharacter(page, "IVET");
  await page.locator("#charlib-save").click();
  await page.locator(".lib-row").first().click();

  await page.locator("#charlib-name").fill("IVET EDITED");
  await page.locator("#charlib-toggle-hidden").click();
  await expect(page.locator(".lib-row")).toContainText("Hidden");
  await expect(page.locator("#charlib-toggle-hidden")).toHaveText("Restore character");
  // A metadata write, not a content one: the unsaved edit is still in the form.
  await expect(page.locator("#charlib-name")).toHaveValue("IVET EDITED");
});

test("hide/restore is absent for kinds without it", async ({ page, served }) => {
  await arrive(page, served, "#/catalog?kind=tags");
  await page.locator("#taglib-new").click();
  await expect(page.locator("#taglib-toggle-hidden")).toHaveCount(0);
  await expect(page.locator("#page")).not.toContainText("Hide character");

  await arrive(page, served, "#/catalog?kind=skills");
  await page.locator("#skilllib-new").click();
  await expect(page.locator("#skilllib-toggle-hidden")).toHaveCount(0);
  await expect(page.locator("#page")).not.toContainText("Hide character");
});

test("the toggle button disables itself mid-flight", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await newCharacter(page, "IVET");
  await page.locator("#charlib-save").click();
  await page.locator(".lib-row").first().click();

  const release = holdCatalogWrites();
  try {
    await page.locator("#charlib-toggle-hidden").click();
    await expect(page.locator("#charlib-toggle-hidden")).toBeDisabled();
  } finally {
    release();
  }
  await expect(page.locator("#charlib-toggle-hidden")).toHaveText("Restore character");
});

test("the review panel ignores backdrop and Escape, but not its closes", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-belief").fill("Every lock has a polite way in.");
  await page.locator("#charlib-review-changes").click();
  const panel = page.locator('[aria-label="Review unsaved changes"]');
  await expect(panel).toBeVisible();

  await page.locator(".lib-modal-backdrop").first().click({ position: { x: 5, y: 5 } });
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeVisible();

  await page.locator("#charlib-changes-close").click();
  await expect(panel).toHaveCount(0);

  await page.locator("#charlib-review-changes").click();
  await expect(panel).toBeVisible();
  await page.locator("#charlib-changes-done").click();
  await expect(panel).toHaveCount(0);
});

test("a revert repaints the field live", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-belief").fill("Every lock has a polite way in.");
  await page.locator("#charlib-persona").fill("Ex-locksmith.");
  await page.locator("#charlib-review-changes").click();
  await expect(page.locator('[data-change-field="belief"]')).toBeVisible();
  await expect(page.locator('[data-change-field="portablePersona"]')).toBeVisible();

  // No panel round-trip: the textarea takes the baseline back at once, and
  // the panel's remaining entries update to match.
  await page.locator('[data-revert-field="belief"]').click();
  await expect(page.locator("#charlib-belief")).toHaveValue("");
  await expect(page.locator('[data-change-field="belief"]')).toHaveCount(0);
  await expect(page.locator('[data-change-field="portablePersona"]')).toBeVisible();
  await expect(page.locator("#charlib-review-changes")).toContainText("(1)");
});

test("the review count stays live while typing, and the caret stays put", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-belief").fill("Every lock has a polite way in.");
  await expect(page.locator("#charlib-review-changes")).toContainText("(1)");

  // Typing re-renders the page on every keystroke; the count follows without
  // rebuilding the field out from under the caret.
  await page.locator("#charlib-persona").click();
  await page.keyboard.type("Ex-locksmith");
  await expect(page.locator("#charlib-review-changes")).toContainText("(2)");
  const focused = await page.evaluate(() => (globalThis as any).document.activeElement?.id);
  expect(focused).toBe("charlib-persona");

  await page.locator("#charlib-review-changes").click();
  await expect(page.locator('[data-change-field="belief"]')).toBeVisible();
  await expect(page.locator('[data-change-field="portablePersona"]')).toBeVisible();
});

test("a brand-new, never-saved character can still be reviewed", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-belief").fill("Every lock has a polite way in.");
  await page.locator("#charlib-persona").fill("Ex-locksmith.");

  // Against the character's own initial draft, not an error or empty panel.
  await expect(page.locator("#charlib-review-changes")).toBeEnabled();
  await page.locator("#charlib-review-changes").click();
  const belief = page.locator('[data-change-field="belief"]');
  await expect(belief).toBeVisible();
  await expect(belief).toContainText("(empty)");
  await expect(belief).toContainText("Every lock has a polite way in.");
  await expect(page.locator('[data-change-field="portablePersona"]')).toBeVisible();
});

test("on one page the pager disappears while the page-size selector stays", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await newCharacter(page, "IVET");
  await page.locator("#charlib-save").click();
  await expect(page.locator(".lib-row")).toHaveCount(1);

  await expect(page.locator("#charlib-page-prev")).toHaveCount(0);
  await expect(page.locator("#charlib-page-next")).toHaveCount(0);
  await expect(page.locator(".lib-list-footer")).toContainText("Showing 1-1 of 1 characters");
  await expect(page.locator("#charlib-page-size")).toBeVisible();
});

test("the pager footer reads as one row, and search keeps the caret with a pager", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  for (let i = 0; i < 11; i++) {
    await page.locator("#charlib-new").click();
    await page.locator("#charlib-name").fill(`PAGER${i}`);
    await page.locator("#charlib-save").click();
  }
  await expect(page.locator(".lib-row")).toHaveCount(10);

  // Range, pager and size select share one footer row — with the editor
  // closed and the list column at full width. (With the inspector open the
  // column narrows and the footer wraps instead of colliding; asserting the
  // wrap would pin an accident, asserting one row here pins the intent.)
  await page.locator("#charlib-close").click();
  const footer = page.locator(".lib-list-footer");
  await expect(footer).toContainText("Showing 1-10 of 11 characters");
  const rangeBox = await footer.locator("span").first().boundingBox();
  const pagerBox = await page.locator("#charlib-page-prev").boundingBox();
  const sizeBox = await page.locator("#charlib-page-size").boundingBox();
  expect(rangeBox && pagerBox && sizeBox).toBeTruthy();
  for (const [a, b] of [[rangeBox, pagerBox], [pagerBox, sizeBox]] as const) {
    const overlap = Math.min(a!.y + a!.height, b!.y + b!.height) - Math.max(a!.y, b!.y);
    expect(overlap).toBeGreaterThan(0);
  }

  // Typing filters without fighting the caret, pager and all.
  await page.locator("#charlib-search").click();
  await page.keyboard.type("pager1");
  await expect(page.locator("#charlib-search")).toHaveValue("pager1");
  const focused = await page.evaluate(() => (globalThis as any).document.activeElement?.id);
  expect(focused).toBe("charlib-search");
  await expect(page.locator(".lib-row")).toHaveCount(2);
});
