/** Block 10 — locator mode. The Locators section's own mechanism: ctrl/cmd+shift+L
 *  toggling the mode, ?locators=1 as a per-load switch, hovering badging the nearest
 *  tid-bearing ancestor, and clicking copying the full string while swallowing the
 *  click so pointing at a button never presses it. Plus the cheap guard the block
 *  calls for: every <button> carries a data-tid or an id (GUI-CHECKLIST "Rules for
 *  new work"), so a new un-addressed button fails the suite. */
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { arrive, cardFromStory, copyFixtureStory, expect, registerStory, test } from "./harness.ts";
import type { FixtureStory } from "./harness.ts";

test("ctrl+shift+L toggles locator mode", async ({ page, served }) => {
  await arrive(page, served, "#/shelf");
  await expect(page.getByTestId("shelf.picker")).toBeVisible();

  await expect(page.locator("body.locating")).toHaveCount(0);
  await page.keyboard.press("Control+Shift+L");
  await expect(page.locator("body.locating")).toHaveCount(1);
  await page.keyboard.press("Control+Shift+L");
  await expect(page.locator("body.locating")).toHaveCount(0);
});

test("?locators=1 starts the mode on for that load only", async ({ page, served }) => {
  // Fresh document load with the param — what pasting a URL is — starts on.
  await arrive(page, served, "#/shelf?locators=1");
  await expect(page.locator("body.locating")).toHaveCount(1);

  // The mode is owned by the toggle after that: syncHash drops params it does
  // not know on the next navigation, so the switch is per-load. Navigate via
  // the hash (a click would be swallowed while the mode is on) and the param
  // is gone from the URL while the mode itself survives.
  await page.evaluate(() => { (globalThis as any).location.hash = "#/catalog"; });
  await expect(page).toHaveURL(/#\/catalog$/);
  await expect(page).not.toHaveURL(/locators/);
  await expect(page.locator("body.locating")).toHaveCount(1);

  // And a load without the param starts off.
  await arrive(page, served, "#/shelf");
  await expect(page.locator("body.locating")).toHaveCount(0);
});

test("hovering badges the nearest tid-bearing ancestor", async ({ page, served }) => {
  await arrive(page, served, "#/shelf");
  await expect(page.getByTestId("shelf.picker")).toBeVisible();
  await page.keyboard.press("Control+Shift+L");
  await expect(page.locator("body.locating")).toHaveCount(1);

  const card = page.getByTestId("shelf.new-story-card");
  await card.hover();
  const badge = page.locator(".tid-badge.on");
  await expect(badge).toBeVisible();
  await expect(badge).toContainText("shelf.new-story-card");
  await expect(badge).toContainText("::");
  await expect(card).toHaveClass(/tid-outline/);
});

test("clicking copies the locator and never presses the button", async ({ page, served }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await arrive(page, served, "#/shelf");
  await expect(page.getByTestId("shelf.picker")).toBeVisible();
  await page.keyboard.press("Control+Shift+L");
  await expect(page.locator("body.locating")).toHaveCount(1);

  // The new-story card navigates to #/scaffold when actually pressed — under
  // locator mode the click must be swallowed instead.
  const card = page.getByTestId("shelf.new-story-card");
  await card.click();
  await expect(page).toHaveURL(/#\/shelf$/);
  const text = await page.evaluate(() => (globalThis as any).navigator.clipboard.readText() as Promise<string>);
  expect(text).toContain("#/shelf");
  expect(text).toContain("shelf.new-story-card");
  await expect(page.locator(".tid-badge")).toContainText("copied");
});

test("APP.locator names any element without needing the mode", async ({ page, served }) => {
  await arrive(page, served, "#/shelf");
  await expect(page.getByTestId("shelf.picker")).toBeVisible();
  const loc = await page.evaluate(() => {
    const g = globalThis as any;
    const el = g.document.querySelector('[data-tid="shelf.new-story-card"]');
    return g.window.APP.locator(el) as string;
  });
  expect(loc).toContain("shelf.new-story-card");
});

test("every button carries a data-tid or an id, on every route", async ({ page, served }) => {
  const dir = await copyFixtureStory();
  try {
    registerStory(dir, async () =>
      cardFromStory(dir, JSON.parse(await readFile(join(dir, "story.json"), "utf8")) as FixtureStory, dir));
    const hashes = ["#/shelf", "#/scaffold", "#/catalog", "#/catalog?kind=tags",
      "#/catalog?kind=styles", "#/catalog?kind=skills",
      `#/story?dir=${encodeURIComponent(dir)}`, `#/edit?dir=${encodeURIComponent(dir)}`];
    const offenders: string[] = [];
    for (const h of hashes) {
      await arrive(page, served, h);
      await expect(page.locator("#page")).not.toBeEmpty();
      const bad = await page.evaluate(() => {
        const g = globalThis as any;
        const out: string[] = [];
        for (const b of g.document.querySelectorAll("#page button, #sidenav button, #topbar button")) {
          if (!b.hasAttribute("data-tid") && !b.id) {
            out.push(`${g.location.hash} :: <${b.tagName.toLowerCase()} class="${b.className}" text="${(b.textContent || "").trim().slice(0, 40)}">`);
          }
        }
        return out;
      });
      offenders.push(...bad);
    }
    expect(offenders).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
