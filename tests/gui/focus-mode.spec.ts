/** Focus mode — distraction-free prose on the live and manuscript views. No new page: one
 *  body class hides navigation, statistics, cast and engine chrome while prose, scene identity
 *  and the author's decision controls stay put. Toggling never re-renders, so scroll, drafts
 *  and the run survive it; `f` toggles, Escape leaves. */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LIVE, publish, setWhere, sseClients } from "../../live.ts";
import { arrive, cardFromStory, copyFixtureStory, expect, registerStory, test } from "./harness.ts";
import type { FixtureStory } from "./harness.ts";
import type { Page } from "@playwright/test";

const focusOn = (page: Page) => page.evaluate(() => document.body.classList.contains("focus"));

async function setupManuscript(dir: string) {
  await mkdir(join(dir, "chapters"));
  await writeFile(join(dir, "chapters", "1.md"),
    "# Chapter 1\n\nRiven checks the parcel twice before touching the service door.\n\n"
    + "Merritt hears the pause and asks which key Riven has.");
  registerStory(dir, async () => {
    const raw = JSON.parse(await readFile(join(dir, "story.json"), "utf8")) as FixtureStory;
    return { ...cardFromStory(dir, raw, "Focus piece"), chapters: [1] };
  });
}

test("focus mode on the manuscript keeps prose and identity while hiding chrome", async ({ page, served }) => {
  const dir = await copyFixtureStory();
  try {
    await setupManuscript(dir);
    await arrive(page, served, "#/readstory?dir=" + encodeURIComponent(dir));
    await expect(page.locator("#reader-ch-1")).toContainText("parcel twice");

    // A search draft is state the toggle must not lose.
    await page.locator("#reader-q").fill("which key");
    await expect(page.getByTestId("reader.hit")).toHaveCount(1);

    await page.locator("#focusbtn").click();
    await expect.poll(() => focusOn(page)).toBe(true);
    for (const sel of ["#sidenav", ".topbar", ".srcbar", "#reader-q", ".reader-tech"]) {
      await expect(page.locator(sel).first()).toBeHidden();
    }
    // Prose and identity stay: the chapter and the story name.
    await expect(page.locator("#reader-ch-1")).toBeVisible();
    await expect(page.locator("#reader-ch-1")).toContainText("parcel twice");
    await expect(page.locator("#page")).toContainText("Focus piece");
    // The way out is obvious and focused for keyboard users.
    await expect(page.locator("#focusexit")).toBeVisible();
    await expect(page.locator("#focusexit")).toBeFocused();

    await page.locator("#focusexit").click();
    await expect.poll(() => focusOn(page)).toBe(false);
    await expect(page.locator("#sidenav")).toBeVisible();
    // Untouched: the same DOM, so the draft and its hits are exactly as left.
    await expect(page.locator("#reader-q")).toHaveValue("which key");
    await expect(page.getByTestId("reader.hit")).toHaveCount(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("f toggles focus, typing f does not, and Escape leaves", async ({ page, served }) => {
  const dir = await copyFixtureStory();
  try {
    await setupManuscript(dir);
    await arrive(page, served, "#/readstory?dir=" + encodeURIComponent(dir));
    await expect(page.locator("#reader-ch-1")).toContainText("parcel twice");

    await page.locator(".reader-chapter").first().click();
    await page.keyboard.press("f");
    await expect.poll(() => focusOn(page)).toBe(true);

    await page.keyboard.press("Escape");
    await expect.poll(() => focusOn(page)).toBe(false);
    await expect(page.locator("#sidenav")).toBeVisible();

    // The shortcut never fires from inside a text control.
    await page.locator("#reader-q").fill("f");
    await expect(page.locator("#reader-q")).toHaveValue("f");
    await expect.poll(() => focusOn(page)).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("focus mode on live keeps prose, identity and run decisions", async ({ page }) => {
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);

  LIVE.running = true;
  setWhere("writing", true);
  publish({ t: "scene_start", story: "tests/fixtures/doorway", characters: ["RIVEN"], target: 700, chapter: 1 });
  publish({ t: "draft", step: 1, consulting: "", salvaged: false, chapter: 1, words: 42,
            prose: "Merritt hears the courier out, then names the one thing the log will accept." });
  await expect(page.getByTestId("live.prose-card")).toBeVisible();

  await page.locator("#focusbtn").click();
  await expect.poll(() => focusOn(page)).toBe(true);
  // Minimized: navigation, statistics, cast rail, engine metadata, secondary controls.
  for (const sel of ["#sidenav", ".topbar", ".srcbar", "#timeline", "#castcard"]) {
    await expect(page.locator(sel)).toBeHidden();
  }
  await expect(page.getByTestId("rail.status")).toBeHidden();
  await expect(page.getByTestId("rail.engine-details")).toBeHidden();
  await expect(page.locator("#interactive")).toBeHidden();
  // Retained: prose, scene identity, and the run's own decision controls.
  await expect(page.getByTestId("prose.piece")).toContainText("courier");
  await expect(page.getByTestId("live.head")).toContainText("doorway");
  await expect(page.locator("#stop")).toBeVisible();
  await expect(page.locator("#consultMe")).toBeVisible();

  // Leaving restores the chrome; the run underneath is untouched.
  await page.locator("#focusexit").click();
  await expect.poll(() => focusOn(page)).toBe(false);
  await expect(page.locator("#sidenav")).toBeVisible();
  await expect(page.getByTestId("rail.status")).toBeVisible();
  await expect(page.getByTestId("prose.piece")).toContainText("courier");
});

test("leaving the manuscript exits focus mode", async ({ page, served }) => {
  const dir = await copyFixtureStory();
  try {
    await setupManuscript(dir);
    await arrive(page, served, "#/readstory?dir=" + encodeURIComponent(dir));
    await expect(page.locator("#reader-ch-1")).toContainText("parcel twice");

    await page.locator("#focusbtn").click();
    await expect.poll(() => focusOn(page)).toBe(true);

    await page.evaluate(() => { location.hash = "#/shelf"; });
    await expect(page.locator("#sidenav")).toBeVisible();
    await expect.poll(() => focusOn(page)).toBe(false);
    await expect(page.locator("#focusbtn")).toBeHidden();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
