/** Block 4 — the write-path screens, over the REAL host: the editor's load/check/save and the
 *  story page's discard run the engine's own persistence against temp copies of the fixture, and
 *  every save/discard assertion reads the file it changed. Temp stories are registered as card
 *  providers — the real discovery re-reads the file on every /stories, and so does the harness. */
import { basename } from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { arrive, cardFromStory, copyFixtureStory, expect, registerStory, test } from "./harness.ts";
import type { FixtureStory } from "./harness.ts";

const readStory = async (dir: string) => JSON.parse(await readFile(join(dir, "story.json"), "utf8"));

/** The temp story as a live provider: every /stories re-reads the file, like real discovery. */
const registerLive = (dir: string) =>
  registerStory(dir, async () =>
    cardFromStory(dir, JSON.parse(await readFile(join(dir, "story.json"), "utf8")) as FixtureStory, basename(dir)));

test("the editor loads a story, saves an edit through the real path, and refuses an empty premise", async ({ page, served }) => {
  const dir = await copyFixtureStory();
  registerLive(dir);
  try {
    await arrive(page, served, "#/edit?dir=" + encodeURIComponent(dir));

    // The loaded draft renders: premise in the form, characters as cards.
    const premise = page.locator("#edit-premise");
    await expect(premise).toHaveValue(/behind a restaurant that closed at one/);
    await expect(page.locator('[data-tid="edit.char-card"][data-char="1"]')).toContainText("MERRITT");

    // An edit dirties the draft and enables save; the save goes through the real persist path.
    const goal = page.locator("#char-0-goal");
    await goal.fill("Get the package inside and be gone before 5am, however it happens.");
    await expect(page.locator("#edit-save")).toBeEnabled();
    await page.locator("#edit-save").click();
    await expect.poll(async () => (await readStory(dir)).characters[0].goal)
      .toBe("Get the package inside and be gone before 5am, however it happens.");

    // The empty premise is the save guard's own refusal, and it reaches the page — the file keeps
    // the premise it had.
    await premise.fill("");
    await expect(page.locator("#edit-save")).toBeEnabled();   // a warning, not an issue: saveable
    await page.locator("#edit-save").click();
    await expect(page.locator(".said.bad").first()).toContainText("Premise is empty");
    await expect.poll(async () => (await readStory(dir)).premise).toContain("restaurant that closed at one");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the story page discards the last unwritten chapter's scene — and only that one", async ({ page, served }) => {
  const dir = await copyFixtureStory();
  registerLive(dir);
  try {
    // A second scene: the discard flow's precondition is a last authored scene that is unwritten.
    const raw = await readStory(dir) as FixtureStory;
    raw.scenes.push({
      place: "the cab rank on the avenue", question: "Does the courier take the fare and ride?",
      pov: "MERRITT", length: 500, roster: [],
    });
    await writeFile(join(dir, "story.json"), JSON.stringify(raw, null, 2) + "\n");

    await arrive(page, served, "#/story?dir=" + encodeURIComponent(dir));

    // Scene 2 is the last authored, unwritten — discardable; scene 1 has no discard button.
    const discard2 = page.locator('[data-tid="story.scene-row"][data-chapter="2"] [data-tid="story.discard-btn"]');
    await expect(discard2).toBeVisible();
    await expect(page.locator('[data-tid="story.scene-row"][data-chapter="1"] [data-tid="story.discard-btn"]')).toHaveCount(0);

    // The story page confirms first — accept the dialog, then the real discard path writes the file.
    page.on("dialog", d => d.accept());
    await discard2.click();
    await expect.poll(async () => (await readStory(dir)).scenes.length).toBe(1);
    // The page follows the disk, because the provider re-reads it: scene 2's row is gone.
    await expect(page.locator('[data-tid="story.scene-row"][data-chapter="2"]')).toHaveCount(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
