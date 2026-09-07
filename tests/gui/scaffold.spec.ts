/** The architect's stage progression, driven by a scripted staged session: the progression
 *  names the open stage, the approve button names the gate it passes, and the tension the story
 *  stage coined reaches the direction stage as its text — not as a "coined" flag. */
import { expect, test } from "./harness.ts";
import { approveTo, abandonWalk, startStaged, WALK_TENSION } from "./scaffold-walk.ts";

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
    await expect(castworld).toContainText("What should change about the cast or voice?");
    await expect(page.locator("#iv-approve")).toContainText("accept the cast");
  } finally {
    await abandonWalk(page, served);
  }
});
