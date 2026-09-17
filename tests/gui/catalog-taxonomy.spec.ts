/** Block 9b — §13's tags, styles and skills. What catalog.spec leaves manual:
 *  the save round-trip's own verdict (a general skill's name saves with its
 *  advisory in a labelled Problems block, and a refused save keeps the draft
 *  beside a labelled Issues block — never merged); tag rows deriving their
 *  STORY/STYLE cut and usage counts from what styles actually carry, with the
 *  detail naming associated styles or nothing at all; label edits staying
 *  updates and duplicate facet+labels saving anyway; style tag chips toggling
 *  and an origin's off-list grant surviving save; the style invitation,
 *  create-then-v2, perception advisory and refused empty name; the skill seed
 *  materializing on first save, multi-line meanings, refused empty meanings,
 *  the `::` and duplicate-spelling advisories, and the telepathy cross-kind
 *  check; landing back on each kind by URL. */
import { arrive, expect, seedCatalogEntries, test } from "./harness.ts";

async function newTag(page: import("@playwright/test").Page, facet: string, label: string) {
  await page.locator("#taglib-new").click();
  await page.locator("#taglib-facet").selectOption(facet);
  await page.locator("#taglib-label").fill(label);
}

test("a general skill's name saves with its advisory, and a refused save keeps the draft", async ({ page, served }) => {
  await arrive(page, served, "#/catalog?kind=skills");
  await page.locator("#skilllib-new").click();
  await page.locator("#skilllib-name").fill("sight");
  await page.locator("#skilllib-meaning").fill("Seeing with eyes.");
  await page.locator("#skilllib-save").click();

  // Saved anyway, with the advisory in its own labelled block — never merged
  // into an error, and never refusing. The saved row is the selected one.
  await expect(page.locator(".lib-row.selected", { hasText: "sight" })).toHaveCount(1);
  const notes = page.locator(".lib-save-notes");
  await expect(notes.filter({ hasText: "Problems — saved anyway" })).toBeVisible();
  await expect(notes).toContainText("every character already has");
  await expect(notes.filter({ hasText: "Issues" })).toHaveCount(0);

  // Empty the meaning: the save is refused, the error names it, the typed
  // name stays on screen, and the earlier advisory is still beside it.
  await page.locator("#skilllib-meaning").fill("");
  await page.locator("#skilllib-save").click();
  await expect(page.locator(".said.bad")).toContainText("needs a meaning");
  await expect(page.locator("#skilllib-name")).toHaveValue("sight");
  await expect(notes.filter({ hasText: "Issues — not saved" })).toBeVisible();
  await expect(notes.filter({ hasText: "Problems — saved anyway" })).toBeVisible();
});

test("a tag's cut and usage derive from what styles actually carry", async ({ page, served }) => {
  await arrive(page, served, "#/catalog?kind=tags");
  await newTag(page, "tone", "crepuscular");
  await page.locator("#taglib-save").click();
  const row = page.locator(".lib-row", { hasText: "crepuscular" });
  await expect(row).toBeVisible();
  // No style carries it: the Story cut, and no usage line at all.
  await expect(row.locator(".lib-cut")).toHaveText("Story");
  await expect(row).not.toContainText("used by");

  // Give it to a style: the cut flips to Style by itself and the count climbs.
  await arrive(page, served, "#/catalog?kind=styles");
  await page.locator("#stylib-new").click();
  await page.locator("#stylib-name").fill("Dusk");
  await page.locator("#stylib-voice").fill("Short sentences.");
  // The tag picker reads the vocabulary cache, which lands after the style
  // list does, and collapses long facets behind an expander — wait for the
  // chip rather than assuming it.
  await page.locator('[data-style-tag="__facet-tone__"]').click();
  const tagChip = page.locator('[data-style-tag="crepuscular"]');
  await expect(tagChip).toBeVisible();
  await tagChip.click();
  await expect(tagChip).toHaveClass(/on/);
  await page.locator("#stylib-save").click();
  await expect(page.locator(".lib-row", { hasText: "Dusk" })).toBeVisible();

  await arrive(page, served, "#/catalog?kind=tags");
  await expect(row.locator(".lib-cut")).toHaveText("Style");
  await expect(row).toContainText("used by 1 style");

  // The detail names the associated style; a carried-by-none tag shows none.
  await row.click();
  await expect(page.locator(".lib-inspector .lib-chips", { hasText: "Dusk" })).toBeVisible();
  await page.locator("#taglib-close").click();
  await newTag(page, "tone", "unborrowed");
  await page.locator("#taglib-save").click();
  await page.locator(".lib-row", { hasText: "unborrowed" }).click();
  await expect(page.locator(".lib-inspector .lib-chips")).toHaveCount(0);

  // Take it back off the style: the cut falls back and the count with it.
  await arrive(page, served, "#/catalog?kind=styles");
  await page.locator(".lib-row", { hasText: "Dusk" }).click();
  await page.locator('[data-style-tag="__facet-tone__"]').click();
  const offChip = page.locator('[data-style-tag="crepuscular"]');
  await expect(offChip).toBeVisible();
  await offChip.click();
  await expect(offChip).not.toHaveClass(/on/);
  await page.locator("#stylib-save").click();
  await arrive(page, served, "#/catalog?kind=tags");
  await expect(row.locator(".lib-cut")).toHaveText("Story");
  await expect(row).not.toContainText("used by");
});

test("a tag label edit stays an update, and a duplicate facet+label still saves", async ({ page, served }) => {
  await arrive(page, served, "#/catalog?kind=tags");
  await newTag(page, "tone", "crepuscular");
  await page.locator("#taglib-save").click();
  const count = await page.locator(".lib-row").count();

  await page.locator(".lib-row", { hasText: "crepuscular" }).click();
  await page.locator("#taglib-label").fill("crepuscular-evening");
  await page.locator("#taglib-save").click();
  // An update, not a new entry: the count never moves.
  await expect(page.locator(".lib-row")).toHaveCount(count);
  await expect(page.locator(".lib-row", { hasText: "crepuscular-evening" })).toHaveCount(1);

  await newTag(page, "tone", "crepuscular-evening");
  await page.locator("#taglib-save").click();
  await expect(page.locator(".lib-row", { hasText: "crepuscular-evening" })).toHaveCount(2);
  await expect(page.locator(".lib-save-notes")).toContainText("already exists");
});

test("style tag chips toggle, and an origin's off-list grant survives save", async ({ page, served }) => {
  await arrive(page, served, "#/catalog?kind=tags");
  await newTag(page, "tone", "crepuscular");
  await page.locator("#taglib-save").click();

  // Chips toggle visibly on and off, and the draft follows.
  await arrive(page, served, "#/catalog?kind=styles");
  await page.locator("#stylib-new").click();
  await page.locator("#stylib-name").fill("Dusk");
  await page.locator('[data-style-tag="__facet-tone__"]').click();
  const chip = page.locator('[data-style-tag="crepuscular"]');
  await expect(chip).toBeVisible();
  await expect(chip).not.toHaveClass(/on/);
  await chip.click();
  await expect(chip).toHaveClass(/on/);
  await chip.click();
  await expect(chip).not.toHaveClass(/on/);

  // An origin carrying a grant the general catalog does not know shows it
  // off-list — and keeps it on save instead of silently dropping it.
  await seedCatalogEntries("skills", [{
    id: "skl_nightfolk", name: "Nightfolk", meaning: "Kinds that see in the dark.",
    kind: "origin", general: ["farsight"],
  }]);
  await arrive(page, served, "#/catalog?kind=skills");
  await page.locator(".lib-row", { hasText: "Nightfolk" }).click();
  const offList = page.locator(".lib-pick.off-vocab");
  await expect(offList).toHaveCount(1);
  await expect(offList).toContainText("farsight");
  await expect(page.locator("#page")).toContainText("Kept when you save");
  await page.locator("#skilllib-meaning").fill("Kinds that see in the dark. Really.");
  await page.locator("#skilllib-save").click();
  await expect(page.locator(".lib-pick.off-vocab")).toHaveCount(1);
  await expect(page.locator(".lib-pick.off-vocab")).toContainText("farsight");
});

test("styles invite, version on edit, advise on perception rules, refuse empty names", async ({ page, served }) => {
  await arrive(page, served, "#/catalog?kind=styles");
  // No seed, unlike tags: a first run is an invitation, not an error.
  await expect(page.locator("#page")).toContainText("Your style library is empty");
  await expect(page.locator("#page")).not.toContainText("could not load");

  await page.locator("#stylib-new").click();
  await page.locator("#stylib-name").fill("Dusk");
  await page.locator("#stylib-description").fill("Short sentences after dark.");
  await page.locator("#stylib-voice").fill("Short sentences.");
  await page.locator("#stylib-save").click();
  await expect(page.locator(".lib-row", { hasText: "Dusk" })).toHaveCount(1);

  // Editing the voice and saving again is v2, not a second entry.
  await page.locator(".lib-row", { hasText: "Dusk" }).click();
  await expect(page.locator(".lib-meta")).toContainText("v1");
  await page.locator("#stylib-voice").fill("Short sentences. Nothing more.");
  await page.locator("#stylib-save").click();
  await expect(page.locator(".lib-meta")).toContainText("v2");
  await expect(page.locator(".lib-row")).toHaveCount(1);

  // A perception rule saves, with an advisory — never as an error.
  await page.locator("#stylib-voice").fill("Write only what is visible. Nothing that is only visible.");
  await page.locator("#stylib-save").click();
  await expect(page.locator(".lib-row", { hasText: "Dusk" })).toHaveCount(1);
  await expect(page.locator(".lib-save-notes")).toContainText("perception rule");

  // An empty name is refused, and the typed description and voice stay put.
  await page.locator("#stylib-name").fill("");
  await page.locator("#stylib-save").click();
  await expect(page.locator(".said.bad")).toContainText("needs a name");
  await expect(page.locator("#stylib-description")).toHaveValue("Short sentences after dark.");
  await expect(page.locator("#stylib-voice")).toContainText("only visible");
});

test("the skill seed materializes on first save, and meanings keep their paragraphs", async ({ page, served }) => {
  await arrive(page, served, "#/catalog?kind=skills");
  await expect(page.locator(".lib-row", { hasText: "lockpicking" })).toHaveCount(1);
  const seeded = await page.locator(".lib-row").count();

  await page.locator("#skilllib-new").click();
  await page.locator("#skilllib-name").fill("tidewalking");
  await page.locator("#skilllib-meaning").fill("Walking where the tide goes out.\n\nBarefoot only.");
  await page.locator("#skilllib-save").click();
  // The seed writes out beside the new entry: every seeded skill is now real.
  await expect(page.locator(".lib-row")).toHaveCount(seeded + 1);
  await page.locator(".lib-row", { hasText: "tidewalking" }).click();
  await expect(page.locator("#skilllib-meaning")).toHaveValue("Walking where the tide goes out.\n\nBarefoot only.");

  // Delete a seeded one and reload: it stays gone.
  await page.locator(".lib-row", { hasText: "climbing" }).click();
  await page.locator("#skilllib-delete").click();
  await page.locator('[data-tid="confirm.ok"]').click();
  await expect(page.locator(".lib-row", { hasText: "climbing" })).toHaveCount(0);
  await arrive(page, served, "#/catalog?kind=skills");
  await expect(page.locator(".lib-row", { hasText: "climbing" })).toHaveCount(0);
  await expect(page.locator(".lib-row", { hasText: "tidewalking" })).toHaveCount(1);
});

test("skill name advisories never refuse, and telepathy stops reading as unknown", async ({ page, served }) => {
  await arrive(page, served, "#/catalog?kind=skills");
  await page.locator("#skilllib-new").click();
  await page.locator("#skilllib-name").fill("sight :: seeing");
  await page.locator("#skilllib-meaning").fill("Extra eyes.");
  await page.locator("#skilllib-save").click();
  await expect(page.locator(".lib-row", { hasText: "sight :: seeing" })).toHaveCount(1);
  await expect(page.locator(".lib-save-notes")).toContainText('contains "::"');

  // A second spelling of a seeded name advises the same way, and still saves.
  await page.locator("#skilllib-new").click();
  await page.locator("#skilllib-name").fill("Sleight of Hand");
  await page.locator("#skilllib-meaning").fill("Quick fingers.");
  await page.locator("#skilllib-save").click();
  await expect(page.locator(".lib-row", { hasText: "Sleight of Hand" })).toHaveCount(1);
  await expect(page.locator(".lib-save-notes")).toContainText("canonical spelling");

  // The cross-kind check most likely to regress: once telepathy is in the
  // bible, a character's bare telepathy stops calling itself unknown.
  await page.locator("#skilllib-new").click();
  await page.locator("#skilllib-name").fill("telepathy");
  await page.locator("#skilllib-meaning").fill("Reading minds.");
  await page.locator("#skilllib-save").click();
  await arrive(page, served, "#/catalog");
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill("IVET");
  await page.locator("#charlib-skills").fill("telepathy");
  await page.locator("#charlib-save").click();
  await expect(page.locator(".lib-row", { hasText: "IVET" })).toHaveCount(1);
  await expect(page.locator("#page")).not.toContainText("not a bible skill");

  // And the skill's own row observes it: used by one character. Deleting the
  // character drops the count back off — observed, both directions.
  await arrive(page, served, "#/catalog?kind=skills");
  await expect(page.locator(".lib-row", { hasText: "telepathy" })).toContainText("used by 1 character");
  await arrive(page, served, "#/catalog");
  await page.locator(".lib-row", { hasText: "IVET" }).click();
  await page.locator("#charlib-delete").click();
  await page.locator('[data-tid="confirm.ok"]').click();
  await expect(page.locator(".lib-row", { hasText: "IVET" })).toHaveCount(0);
  await arrive(page, served, "#/catalog?kind=skills");
  await expect(page.locator(".lib-row", { hasText: "telepathy" })).not.toContainText("used by");
});

test("landing back on each kind by URL", async ({ page, served }) => {
  for (const [kind, marker] of [["tags", ".lib-tags"], ["styles", ".lib-styles"], ["skills", ".lib-skills"]] as const) {
    await arrive(page, served, `#/catalog?kind=${kind}`);
    await expect(page.locator(marker)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`kind=${kind}`));
  }
  await arrive(page, served, "#/catalog");
  await expect(page.locator(".lib-characters")).toBeVisible();
});
