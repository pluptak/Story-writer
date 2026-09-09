/** Contextual character cards — a pill opens the same card everywhere, but the
 *  card leads with what matters to the chapter at hand (role, place, question,
 *  this-scene grants) and labels the persistent definition as saved in the
 *  story. Opening one never navigates: the prose or map underneath stays put. */
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LIVE, publish, sseClients } from "../../live.ts";
import { arrive, cardFromStory, copyFixtureStory, expect, registerStory, test } from "./harness.ts";
import type { FixtureStory } from "./harness.ts";

async function setupTwoSceneStory() {
  const dir = await copyFixtureStory();
  const raw = JSON.parse(await readFile(join(dir, "story.json"), "utf8")) as FixtureStory;
  raw.scenes = [
    { place: "The service corridor", question: "Does Riven get through the door?", pov: "RIVEN",
      length: 700, roster: ["RIVEN", "MERRITT"], reach: { MERRITT: ["keys :: the porter's own ring"] } },
    { place: "The stairwell", question: "Does Merritt follow?", pov: "MERRITT",
      length: 700, roster: ["MERRITT"] },
  ];
  await writeFile(join(dir, "story.json"), JSON.stringify(raw));
  registerStory(dir, async () => ({ ...cardFromStory(dir, raw, "Card context"), title: "Card context" }));
  return dir;
}

test("a scene roster pill opens a card led by that scene", async ({ page, served }) => {
  const dir = await setupTwoSceneStory();
  try {
    await arrive(page, served, "#/story?dir=" + encodeURIComponent(dir));
    const row = page.locator('[data-tid="story.scene-row"][data-chapter="1"]');
    await row.getByTestId("story.scene-roster").locator('[data-char-name="MERRITT"]').click();

    const modal = page.getByTestId("charcard.modal");
    await expect(modal).toBeVisible();
    // Scene first: chapter, role with cast-mates, place, question, this-scene grant.
    const scene = page.getByTestId("charcard.scene");
    await expect(scene).toContainText("In this scene · Chapter 1");
    await expect(scene).toContainText("In this scene with RIVEN.");
    await expect(scene).toContainText("The service corridor");
    await expect(scene).toContainText("Does Riven get through the door?");
    await expect(scene).toContainText("keys");
    await expect(scene).toContainText("Only in this scene");
    // Then the persistent definition, labelled as such.
    await expect(page.getByTestId("charcard.cast-summary")).toContainText("saved in the story");

    // Inspecting never navigates: the map is still underneath, on the same URL.
    await expect(page).toHaveURL(new RegExp("#\\/story\\?dir="));
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
    await expect(row).toBeVisible();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the point-of-view character's card names the role", async ({ page, served }) => {
  const dir = await setupTwoSceneStory();
  try {
    await arrive(page, served, "#/story?dir=" + encodeURIComponent(dir));
    const row = page.locator('[data-tid="story.scene-row"][data-chapter="2"]');
    await row.getByTestId("story.scene-roster").locator('[data-char-name="MERRITT"]').click();

    const scene = page.getByTestId("charcard.scene");
    await expect(scene).toContainText("Chapter 2");
    await expect(scene).toContainText("the point of view is MERRITT");
    await page.keyboard.press("Escape");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a live header pill opens the running chapter's card with the authored sheet", async ({ page, served }) => {
  const dir = await setupTwoSceneStory();
  try {
    await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
    LIVE.meta = {
      story: dir, chapter: 1, chapters: 2, target: 700,
      question: "Does Riven get through the door?",
      characters: [{ name: "RIVEN", skills: [], restrictions: [] },
                   { name: "MERRITT", skills: [], restrictions: [] }],
    };
    publish({ t: "scene_start", story: dir, characters: ["RIVEN", "MERRITT"], target: 700, chapter: 1 });
    // Via the shelf first: the card's scene half resolves against the loaded
    // shelf cards, which a direct #/live arrival never fetches.
    await arrive(page, served, "#/shelf");
    await expect(page.locator(".cardwrap", { hasText: "Card context" })).toBeVisible();
    await page.locator("#nav-live").click();

    await page.locator('[data-tid="cast.chip"][data-char-name="RIVEN"]').first().click();
    const modal = page.getByTestId("charcard.modal");
    await expect(modal).toBeVisible();
    await expect(page.getByTestId("charcard.scene")).toContainText("In this scene · Chapter 1");
    await expect(page.getByTestId("charcard.scene")).toContainText("the point of view is RIVEN");
    // The authored half is the /cast sheet, labelled persistent.
    await expect(page.getByTestId("charcard.cast-summary")).toContainText("saved in the story");
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
    await expect(page).toHaveURL(/#\/live$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a shelf pill opens the card without a scene section", async ({ page, served }) => {
  const dir = await setupTwoSceneStory();
  try {
    await arrive(page, served, "#/shelf");
    const card = page.locator(".cardwrap", { hasText: "Card context" });
    await card.getByTestId("cast.chip").first().click();

    const modal = page.getByTestId("charcard.modal");
    await expect(modal).toBeVisible();
    // Story-level pill, no chapter: definition only, no scene half.
    await expect(page.getByTestId("charcard.scene")).toHaveCount(0);
    await expect(page.getByTestId("charcard.cast-summary")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
    await expect(page).toHaveURL(/#\/shelf$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
