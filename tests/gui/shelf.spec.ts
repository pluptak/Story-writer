/** The shelf as project library — each card leads with what the author needs
 *  to decide (title, premise, standing, progress, last touch, cast, actionable
 *  warnings), Continue writing is the obvious primary, and Read/Edit are one
 *  click away. Loading/preflight behaviour is untouched: these are the same
 *  cards, reshaped. */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { arrive, cardFromStory, copyFixtureStory, expect, registerStory, test } from "./harness.ts";
import type { FixtureStory } from "./harness.ts";

async function setupLibraryStory(opts?: { warnings?: string[]; ok?: boolean }) {
  const dir = await copyFixtureStory();
  await mkdir(join(dir, "chapters"));
  await writeFile(join(dir, "chapters", "1.md"),
    "# Chapter 1\n\nRiven checks the parcel twice before touching the service door.");
  registerStory(dir, async () => {
    const raw = JSON.parse(await readFile(join(dir, "story.json"), "utf8")) as FixtureStory;
    return {
      ...cardFromStory(dir, raw, "Doorway library"),
      title: "The Doorway",
      chapters: [1],
      runs: [{ id: "run-1", mtimeMs: Date.now(), chapter: 1, steps: 2, words: 70, done: true, stopped: false }],
      warnings: opts?.warnings ?? [],
      ...(opts?.ok === false ? { ok: false as const, error: "boom" } : {}),
    };
  });
  return dir;
}

const cardFor = (page: Page, title: string) =>
  page.locator(".cardwrap", { hasText: title });

test("a shelf card leads with title, standing, progress, activity and cast", async ({ page, served }) => {
  const dir = await setupLibraryStory();
  try {
    await arrive(page, served, "#/shelf");
    const card = cardFor(page, "The Doorway");

    await expect(card.getByTestId("shelf.story-card")).toBeVisible();
    await expect(card).toContainText("The Doorway");
    await expect(card).toContainText("service corridor");
    // Standing + progress off the plan, not engine numbers: no step budgets here.
    // (The one-scene fixture with its chapter written reads as complete.)
    await expect(card.getByTestId("shelf.status")).toContainText("Complete · 1 of 1 chapters");
    await expect(card.locator('[role="progressbar"]')).toBeVisible();
    await expect(card.getByTestId("shelf.activity")).toContainText("Last run today");
    await expect(card.getByTestId("cast.chip").first()).toBeVisible();
    await expect(card).not.toContainText("steps");
    // The primary is obvious; secondaries sit beside it.
    await expect(card.getByTestId("shelf.continue")).toHaveText(/Continue writing/);
    await expect(card.getByTestId("shelf.read")).toBeVisible();
    await expect(card.getByTestId("shelf.edit")).toBeVisible();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Continue writing, Read and Edit leave the shelf for the right place", async ({ page, served }) => {
  const dir = await setupLibraryStory();
  try {
    await arrive(page, served, "#/shelf");
    const card = cardFor(page, "The Doorway");

    await card.getByTestId("shelf.continue").click();
    await expect(page).toHaveURL(new RegExp("#\\/story\\?dir="));
    await expect(page.locator("#page")).toContainText("Doorway library");

    await page.locator("#nav-shelf").click();
    await cardFor(page, "The Doorway").getByTestId("shelf.read").click();
    await expect(page).toHaveURL(new RegExp("#\\/readstory\\?dir="));
    await expect(page.locator(".reader-chapter")).toHaveCount(1);

    await page.locator("#nav-shelf").click();
    await cardFor(page, "The Doorway").getByTestId("shelf.edit").click();
    await expect(page).toHaveURL(new RegExp("#\\/edit\\?dir="));
    await expect(page.locator(".editor")).toBeVisible();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("only actionable warnings show on a shelf card", async ({ page, served }) => {
  const dir = await setupLibraryStory({
    warnings: [
      '   Scene 2 has no "question" — the writer has no dramatic question to close',
      "   (model check skipped: no model list from LM Studio at http://localhost:1234/v1)",
      "   (not available in LM Studio: foo/bar — every call using this will error)",
    ],
  });
  try {
    await arrive(page, served, "#/shelf");
    const card = cardFor(page, "The Doorway");
    await expect(card).toContainText('has no "question"');
    await expect(card).not.toContainText("model check skipped");
    await expect(card).not.toContainText("not available in LM Studio");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a story that does not load offers no actions", async ({ page, served }) => {
  const dir = await setupLibraryStory({ ok: false });
  try {
    await arrive(page, served, "#/shelf");
    const card = cardFor(page, "The Doorway");
    await expect(card).toContainText("can't be loaded");
    await expect(card.getByTestId("shelf.continue")).toHaveCount(0);
    await expect(card.getByTestId("shelf.read")).toHaveCount(0);
    await expect(card.getByTestId("shelf.edit")).toHaveCount(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
