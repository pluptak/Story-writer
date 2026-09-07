/** Story-use selection in the direction and cast & world stages, backed by the real tag and
 *  style catalogs. Pickers live where their choice is decided -- vocabulary in direction, cast
 *  size and voice in cast & world -- post straight to the session, and never appear in the idea
 *  modal. */
import { arrive, expect, test } from "./harness.ts";
import { approveTo, abandonWalk, startStaged, startOneshot } from "./scaffold-walk.ts";
import type { Page } from "@playwright/test";

test("the idea modal asks only for the idea, and direction offers the tag catalog's vocabulary", async ({ page, served }) => {
  try {
    await arrive(page, served, "#/scaffold");

    // The modal is visible on arriving at #/scaffold with no interview active -- and it carries
    // no pickers: kind, cast and voice are decided in their own stages, not up front.
    await expect(page.getByTestId("scaffold.idea-modal")).toBeVisible();
    await expect(page.locator("#iv-backdrop .cat-chip")).toHaveCount(0);
    await expect(page.locator("#iv-backdrop #f-cast-size")).toHaveCount(0);

    await startStaged(page, served);

    // The three facet headings are present with their exact text, in the direction stage.
    const section = page.locator('[data-tid="scaffold.stage-section"][data-stage="direction"]');
    const facetHeadings = section.locator("div.cat-facet-heading");
    await expect(facetHeadings).toHaveCount(3);
    const headingTexts = await facetHeadings.allTextContents();
    expect(headingTexts).toEqual(["Genre", "Dramatic Mode", "Tone"]);

    // The chips are the catalog's, not this page's: an absent tags file yields the engine's seed.
    // Counted loosely on purpose — pinning the seed's exact size would fail this test for a reason
    // that has nothing to do with the stage.
    await expect.poll(async () => section.locator(".cat-chip").count()).toBeGreaterThanOrEqual(20);
  } finally {
    await abandonWalk(page, served);
  }
});

test("a chip posts to the session and stays posted through the re-render it causes", async ({ page, served }) => {
  try {
    await startStaged(page, served);

    // Every click posts to the session, and the returning snapshot re-renders the whole page,
    // replacing this node. The locator is a query, not a handle, so it resolves against whatever
    // is there now -- which is the property under test.
    const section = page.locator('[data-tid="scaffold.stage-section"][data-stage="direction"]');
    const chip = section.locator('button.cat-chip[data-tag-label="fantasy"]');   // a genre in TAG_SEED
    await chip.click();
    await expect(chip).toHaveClass(/on/);
    await chip.click();
    await expect(chip).not.toHaveClass(/on/);
  } finally {
    await abandonWalk(page, served);
  }
});

test("the direction pickers belong to the staged walk only", async ({ page, served }) => {
  try {
    await startStaged(page, served);
    await expect(page.locator('[data-tid="scaffold.direction-pickers"]')).toBeVisible();

    await abandonWalk(page, served);
    await startOneshot(page, served);
    // The whole-story proposal covers direction, cast and structure at once -- there is no
    // direction picker to steer a gate that never opens.
    await expect(page.locator('[data-tid="scaffold.direction-pickers"]')).toHaveCount(0);
  } finally {
    await abandonWalk(page, served);
  }
});

test("a chosen cast size is written to the session", async ({ page, served }) => {
  try {
    // The size steers the cast prompt, so it is decided in direction, before any cast exists.
    await startStaged(page, served);
    const section = page.locator('[data-tid="scaffold.stage-section"][data-stage="direction"]');

    // Set the cast size to 3: the change posts straight to the session, and the returning
    // snapshot re-renders the select from it.
    await section.locator("#f-cast-size").selectOption("3");
    await expect(section.locator("#f-cast-size")).toHaveValue("3");
  } finally {
    await abandonWalk(page, served);
  }
});

test("with an empty character catalog the cast picker says where characters come from", async ({ page, served }) => {
  try {
    await startStaged(page, served);
    const section = page.locator('[data-tid="scaffold.stage-section"][data-stage="direction"]');

    // No import chips are present when the catalog is empty.
    await expect(section.locator(".cat-chip[data-import-id]")).toHaveCount(0);

    // The hint text is visible explaining where characters come from.
    await expect(section.getByText(/No characters in the catalog yet/)).toBeVisible();

    // The cast-size select is still present: nothing is cast yet, so the size still means something.
    await expect(section.locator("#f-cast-size")).toBeVisible();
  } finally {
    await abandonWalk(page, served);
  }
});

test("a character in the catalog can be cast, and the tray takes over the cast size", async ({ page, served }) => {
  try {
    // Create a character in the catalog.
    await arrive(page, served, "#/catalog");
    await page.locator("#charlib-new").click();
    await page.locator("#charlib-name").fill("IVET");
    await page.locator("#charlib-persona").fill("Ex-locksmith, keeps every key on a labelled ring.");
    await page.locator("#charlib-belief").fill("Every lock has a polite way in.");
    await page.locator("#charlib-impulse").fill("When watched, slow down and narrate the work.");
    await page.locator("#charlib-voice").fill('"Hold the door? I\'d rather hold the lock."');
    await page.locator("#charlib-skills").fill("lockpicking :: opening a mechanical lock without its key");
    await page.locator("#charlib-save").click();

    // Start the interview: direction decides the cast, before any cast exists.
    await startStaged(page, served);
    const section = page.locator('[data-tid="scaffold.stage-section"][data-stage="direction"]');
    const ivetChip = section.locator('button.cat-chip[data-import-id]').filter({ hasText: "IVET" });
    await expect(ivetChip).toBeVisible();

    // Before selecting, the cast-size select is present.
    await expect(section.locator("#f-cast-size")).toBeVisible();

    // Click the IVET chip to select it.
    await ivetChip.click();
    await expect(ivetChip).toHaveClass(/on/);

    // The cast-size select is now gone because the chosen cast is the opening cast.
    await expect(section.locator("#f-cast-size")).toHaveCount(0);

    // The hint text is visible explaining that the chosen cast is the opening cast.
    await expect(section.getByText(/The cast chosen above is the opening cast/)).toBeVisible();

    // Click the IVET chip again to deselect it.
    await ivetChip.click();
    await expect(ivetChip).not.toHaveClass(/on/);

    // The cast-size select is back.
    await expect(section.locator("#f-cast-size")).toBeVisible();
  } finally {
    // Clean up: abandon the walk, then delete the IVET character from the catalog so the next
    // test sees it empty.
    await abandonWalk(page, served);
    await arrive(page, served, "#/catalog");
    await page.locator(".lib-row").first().click();
    await page.locator("#charlib-delete").click();
    await expect(page.locator('[data-tid="confirm.dialog"]')).toBeVisible();
    await page.locator('[data-tid="confirm.ok"]').click();
    await expect(page.locator(".lib-row")).toHaveCount(0);
  }
});

// -- THE VOICE ---------------------------------------------------------------
// The style catalog has no engine seed -- presets are the author's own -- so these write two
// through the real save path first, which is also what proves the picker's cache is dropped on a
// write rather than serving a stale list for the life of the page.
const STYLES = [
  { id: "style-plain", version: 1, name: "Plain report", tags: ["thriller"],
    description: "Flat, unhurried, no adjectives it has not earned.",
    voice: "Third person, past tense. Short sentences. No metaphor." },
  { id: "style-lush", version: 1, name: "Lush close third", tags: ["fantasy"],
    description: "Dense sensory prose held tight to one head.",
    voice: "Third person, present tense. Long sentences, heavy on the senses." },
];

const seedStyles = async (page: Page, port: number) => {
  for (const entry of STYLES)
    await page.request.post(`http://127.0.0.1:${port}/catalog/save`, { data: { kind: "styles", entry } });
};

test("with no presets authored, the voice picker says so instead of offering nothing", async ({ page, served }) => {
  try {
    await startStaged(page, served);
    await approveTo(page, "castworld");
    const section = page.locator('[data-tid="scaffold.stage-section"][data-stage="castworld"]');
    await expect(section).toContainText("No styles in the catalog yet");
    await expect(section.locator("button.cat-chip[data-style-id]")).toHaveCount(0);
  } finally {
    await abandonWalk(page, served);
  }
});

test("the voice picker offers the style catalog's presets, ranked by the chosen tags", async ({ page, served }) => {
  try {
    await seedStyles(page, served);
    await startStaged(page, served);

    // A tag ranks the presets and does nothing else to them: both are still on offer.
    await page.locator('[data-tid="scaffold.stage-section"][data-stage="direction"]')
      .locator('button.cat-chip[data-tag-label="fantasy"]').click();

    await approveTo(page, "castworld");
    const section = page.locator('[data-tid="scaffold.stage-section"][data-stage="castworld"]');
    const chips = section.locator("button.cat-chip[data-style-id]");
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(0)).toHaveText("Lush close third");
    await expect(chips.nth(1)).toHaveText("Plain report");
  } finally {
    await abandonWalk(page, served);
  }
});

test("a voice is picked one at a time, and picking the chosen one again clears it", async ({ page, served }) => {
  try {
    await seedStyles(page, served);
    await startStaged(page, served);
    await approveTo(page, "castworld");
    const section = page.locator('[data-tid="scaffold.stage-section"][data-stage="castworld"]');

    const plain = section.locator('button.cat-chip[data-style-id="style-plain"]');
    const lush = section.locator('button.cat-chip[data-style-id="style-lush"]');

    await plain.click();
    await expect(plain).toHaveClass(/on/);
    await expect(section).toContainText("asked only what THIS cast and POV");

    // A second pick replaces the first rather than adding to it.
    await lush.click();
    await expect(lush).toHaveClass(/on/);
    await expect(plain).not.toHaveClass(/on/);

    // And clicking the chosen one clears it: "no preset" is an answer, not the absence of one.
    await lush.click();
    await expect(lush).not.toHaveClass(/on/);
    await expect(section).toContainText("the architect writes the house style itself");
  } finally {
    await abandonWalk(page, served);
  }
});

test("the voice belongs to the staged walk only", async ({ page, served }) => {
  try {
    await seedStyles(page, served);
    await startOneshot(page, served);
    // The whole-story proposal asks for no voice: there is no settings gate to hand one to.
    await expect(page.locator("button.cat-chip[data-style-id]")).toHaveCount(0);
  } finally {
    await abandonWalk(page, served);
  }
});

test("a cast character is inspected and removed as this story's use, never as the catalog entry", async ({ page, served }) => {
  try {
    // Create a character in the catalog.
    await arrive(page, served, "#/catalog");
    await page.locator("#charlib-new").click();
    await page.locator("#charlib-name").fill("IVET");
    await page.locator("#charlib-persona").fill("Ex-locksmith, keeps every key on a labelled ring.");
    await page.locator("#charlib-belief").fill("Every lock has a polite way in.");
    await page.locator("#charlib-save").click();

    // Cast her in direction: the story-framed inspect block appears, read-only.
    await startStaged(page, served);
    const section = page.locator('[data-tid="scaffold.stage-section"][data-stage="direction"]');
    const ivetChip = section.locator('button.cat-chip[data-import-id]').filter({ hasText: "IVET" });
    await expect(ivetChip).toBeVisible();
    await ivetChip.click();
    const member = section.locator('[data-tid="scaffold.story-cast-member"]');
    await expect(member).toContainText("IVET — in this story");
    // Inspect shows the reusable fields but offers no editor for them here.
    await expect(member).toContainText("Every lock has a polite way in.");
    await expect(member.locator("input, textarea, select")).toHaveCount(0);

    // Removing takes her out of this story only: the chip toggles off, the catalog keeps her.
    await member.locator("summary").click();
    await member.locator("[data-remove-import]").click();
    await expect(ivetChip).not.toHaveClass(/on/);
    await expect(section.locator('[data-tid="scaffold.story-cast-member"]')).toHaveCount(0);
  } finally {
    await abandonWalk(page, served);
    await arrive(page, served, "#/catalog");
    await expect(page.locator(".lib-row").filter({ hasText: "IVET" })).toHaveCount(1);

    // Clean up.
    await page.locator(".lib-row").first().click();
    await page.locator("#charlib-delete").click();
    await expect(page.locator('[data-tid="confirm.dialog"]')).toBeVisible();
    await page.locator('[data-tid="confirm.ok"]').click();
    await expect(page.locator(".lib-row")).toHaveCount(0);
  }
});
