/** The architect's stage progression, driven by a scripted staged session: the progression
 *  names the open stage, the approve button names the gate it passes, and the tension the story
 *  stage coined reaches the direction stage as its text — not as a "coined" flag. */
import { expect, test } from "./harness.ts";
import { approveTo, abandonWalk, startStaged, startOneshot, WALK_TENSION } from "./scaffold-walk.ts";

test("the progression tracks the stage, the approve button names it, and the tension is its text", async ({ page, served }) => {
  try {
    await startStaged(page, served);

    // The direction stage opens and coins the tension: its row is the open one, the approve
    // button names the gate it passes, and the section carries the sentence itself.
    const direction = page.locator('[data-tid="scaffold.stage"][data-stage="direction"]');
    await expect(direction).toHaveClass(/open/);
    await expect(page.locator("#iv-approve")).toContainText("accept the concept");
    const section = page.locator('[data-tid="scaffold.stage-section"][data-stage="direction"]');
    await expect(section).toContainText(WALK_TENSION);

    // Approve passes the gate: direction reads decided, cast & world opens, and the label
    // follows the gate.
    await approveTo(page, "castworld");
    await expect(page.locator('[data-tid="scaffold.stage"][data-stage="direction"]')).toHaveClass(/done/);
    await expect(page.locator('[data-tid="scaffold.stage-section"][data-stage="direction"]'))
      .toContainText(WALK_TENSION);
    const castworld = page.locator('[data-tid="scaffold.stage-section"][data-stage="castworld"]');
    await expect(castworld).toContainText("What should change about the cast or style?");
    await expect(page.locator("#iv-approve")).toContainText("accept the cast");
  } finally {
    await abandonWalk(page, served);
  }
});

test("the open stage names its question once, in the page banner, not again inside its own card", async ({ page, served }) => {
  try {
    await startStaged(page, served);
    // The page banner (pageTitle) carries the stage's question; the open stage's own card head
    // used to repeat it verbatim as a second heading right underneath -- it no longer does.
    await expect(page.locator(".sc-head h2")).toContainText("What kind of story should it become?");
    const section = page.locator('[data-tid="scaffold.stage-section"][data-stage="direction"]');
    await expect(section.locator("h3")).toHaveCount(0);
    await expect(section).toContainText("Direction · deciding now");
  } finally {
    await abandonWalk(page, served);
  }
});

test("the accept stage reads as one card, with the folder's own decision -- not a duplicate headline or the raw needs_folder flag", async ({ page, served }) => {
  try {
    await startOneshot(page, served);
    await page.locator("#iv-accept").click();
    await expect(page.locator('[data-tid="scaffold.stage"][data-stage="handoff"]')).toHaveClass(/open/);

    const folderCard = page.locator('[data-tid="scaffold.folder-card"]');
    // Flattened into the open stage's own card -- folder-card itself is no longer a second,
    // nested "card" with its own head (the complete-Blueprint groups inside it are still cards;
    // that's the same collapsed detail Review uses, not the duplicate this test is about).
    await expect(folderCard).not.toHaveClass(/\bcard\b/);
    await expect(folderCard).not.toContainText("needs_folder");
    await expect(page.locator("#iv-folder")).toContainText("Start writing");
    await expect(page.locator("#iv-save-leave")).toBeVisible();
  } finally {
    await abandonWalk(page, served);
  }
});
