/** The story map as structural navigation: where am I, what happened, what's next — with
 *  every scene offering run / read / edit / inspect paths in place. Editing capabilities
 *  themselves are untouched (story-edit.spec owns them); this spec owns the map. */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LIVE, setWhere } from "../../live.ts";
import { arrive, cardFromStory, copyFixtureStory, expect, registerStory, test } from "./harness.ts";
import type { FixtureStory } from "./harness.ts";

/** A temp story with three scenes: chapter 1 written, 2 and 3 planned, RIVEN in scene 2. */
async function threeSceneStory() {
  const dir = await copyFixtureStory();
  const raw = JSON.parse(await readFile(join(dir, "story.json"), "utf8")) as FixtureStory;
  raw.scenes = [
    { ...raw.scenes[0], roster: ["RIVEN"] },
    { place: "The locker's shadow", question: "Does Merritt log the package or let it through?",
      pov: "MERRITT", length: 600, roster: ["RIVEN", "MERRITT"] },
    { place: "The open door", question: "Who walks through first?",
      pov: "RIVEN", length: 500, roster: ["RIVEN"] },
  ];
  await writeFile(join(dir, "story.json"), JSON.stringify(raw));
  await mkdir(join(dir, "chapters"), { recursive: true });
  await writeFile(join(dir, "chapters", "1.md"),
    "# Chapter 1\n\nThe corridor keeps its silence while Riven waits at the door.");
  registerStory(dir, async () => {
    const r = JSON.parse(await readFile(join(dir, "story.json"), "utf8")) as FixtureStory;
    return { ...cardFromStory(dir, r, "Three chapters"), chapters: [1] };
  });
  return dir;
}

test("the map answers where am I, what happened, what's next", async ({ page, served }) => {
  const dir = await threeSceneStory();
  try {
    await arrive(page, served, "#/story?dir=" + encodeURIComponent(dir));

    // The strip: progress made, and what comes next.
    const status = page.getByTestId("story.map-status");
    await expect(status).toContainText("1 of 3 chapters written");
    await expect(status).toContainText("next: chapter 2");

    // States read at a glance: completed, current, upcoming.
    const row1 = page.locator('[data-tid="story.scene-row"][data-chapter="1"]');
    const row2 = page.locator('[data-tid="story.scene-row"][data-chapter="2"]');
    const row3 = page.locator('[data-tid="story.scene-row"][data-chapter="3"]');
    await expect(row1).toHaveAttribute("data-state", "completed");
    await expect(row1).toContainText("written");
    await expect(row2).toHaveAttribute("data-state", "current");
    await expect(row2).toContainText("next");
    await expect(row3).toHaveAttribute("data-state", "upcoming");
    await expect(row3).toContainText("upcoming");

    // The card prioritizes question, POV, length, and who is involved.
    await expect(row2).toContainText("Does Merritt log the package");
    await expect(row2).toContainText("pov MERRITT");
    await expect(row2).toContainText("~600 words");
    await expect(row2.getByTestId("story.scene-roster")).toContainText("MERRITT");

    // Reach and world mechanics wait behind Context, not on the card face.
    await expect(row2.locator(".map-extra")).toHaveCount(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("each scene offers run, read, edit and inspect paths", async ({ page, served }) => {
  const dir = await threeSceneStory();
  try {
    await arrive(page, served, "#/story?dir=" + encodeURIComponent(dir));
    const row1 = page.locator('[data-tid="story.scene-row"][data-chapter="1"]');
    const row2 = page.locator('[data-tid="story.scene-row"][data-chapter="2"]');

    // Run it: the current chapter's write button is primary and enabled.
    const write = row2.getByTestId("story.write-btn");
    await expect(write).toHaveText("write chapter 2");
    await expect(write).toHaveClass(/primary/);

    // Read its result: inline prose opens on the written chapter.
    await row1.getByTestId("story.read-btn").click();
    await expect(row1.locator(".prose")).toContainText("keeps its silence");

    // Inspect: a roster chip opens the character card.
    await row2.getByTestId("story.scene-roster").locator('[data-char-name="MERRITT"]').click();
    const modal = page.getByTestId("charcard.modal");
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("MERRITT");
    await page.keyboard.press("Escape");

    // Edit it: per-scene edit reaches the story editor.
    await row2.getByTestId("story.scene-edit-btn").click();
    await expect(page).toHaveURL(/#\/edit/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("setup and voice sit behind the map, not on it", async ({ page, served }) => {
  const dir = await threeSceneStory();
  try {
    await arrive(page, served, "#/story?dir=" + encodeURIComponent(dir));
    const setup = page.getByTestId("story.setup-details");
    await expect(setup).toBeVisible();
    await expect(page.locator("#story-model")).toBeHidden();
    await setup.locator("summary").click();
    await expect(page.locator("#story-model")).toBeVisible();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a run in flight parks the current chapter as waiting", async ({ page, served }) => {
  const dir = await threeSceneStory();
  try {
    // A run already in flight when the map loads: the running edge would have pulled a live
    // viewer onto the Write screen, so set the state before arrival and land on the map itself.
    LIVE.running = true;
    setWhere("writing", true);
    await arrive(page, served, "#/story?dir=" + encodeURIComponent(dir));

    // The map says what is happening and the current chapter waits; finished work stays readable.
    await expect(page.getByTestId("story.map-blocked")).toContainText("Waiting");
    await expect(page.locator('[data-tid="story.scene-row"][data-chapter="2"]'))
      .toHaveAttribute("data-state", "blocked");
    await expect(page.locator('[data-tid="story.scene-row"][data-chapter="1"]'))
      .toHaveAttribute("data-state", "completed");
    await expect(page.locator('[data-tid="story.scene-row"][data-chapter="2"]')
      .getByTestId("story.write-btn")).toBeDisabled();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a scene with no question reads as problematic", async ({ page, served }) => {
  const dir = await copyFixtureStory();
  try {
    const raw = JSON.parse(await readFile(join(dir, "story.json"), "utf8")) as FixtureStory;
    raw.scenes = [{ ...raw.scenes[0], question: "" }];
    await writeFile(join(dir, "story.json"), JSON.stringify(raw));
    registerStory(dir, async () => {
      const r = JSON.parse(await readFile(join(dir, "story.json"), "utf8")) as FixtureStory;
      return { ...cardFromStory(dir, r, "No question"), chapters: [] };
    });

    await arrive(page, served, "#/story?dir=" + encodeURIComponent(dir));
    const row = page.locator('[data-tid="story.scene-row"][data-chapter="1"]');
    await expect(row).toHaveAttribute("data-state", "problematic");
    await expect(row).toContainText("needs a question");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
