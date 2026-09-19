/** Block 6 — failure states, as a class. Everywhere the checklist says "unload
 *  the model", "stop the engine" or "throttle the network", it is testing how the
 *  page handles a failed fetch — and page.route produces that in a line, no LM
 *  Studio or second process needed: /cast unavailable (the card falls back to
 *  the pill's can/cannot row in one muted line); a chapter whose prose will not
 *  load (that slot says it could not be opened, the others still render); a
 *  broken catalog fetch showing its retry button; a failed visibility write
 *  keeping both the draft and the old state; a failed run-log fetch in compare
 *  showing an error rather than stale content from the previous selection. */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LIVE, publish, sseClients } from "../../live.ts";
import { arrive, cardFromStory, copyFixtureStory, expect, registerRunDirs, registerStory, test } from "./harness.ts";
import type { FixtureStory } from "./harness.ts";

async function setupLiveStory() {
  const dir = await copyFixtureStory();
  const raw = JSON.parse(await readFile(join(dir, "story.json"), "utf8")) as FixtureStory;
  registerStory(dir, async () => ({ ...cardFromStory(dir, raw, "Failure states") }));
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
  LIVE.meta = {
    story: dir, chapter: 1, chapters: 1, target: 700,
    question: "Does Riven get through the door before Merritt decides what to do about them?",
    characters: [{ name: "RIVEN", skills: ["lockpicking", "climbing"], restrictions: [] },
                 { name: "MERRITT", skills: ["keys"], restrictions: ["sight"] }],
  };
  publish({ t: "scene_start", story: dir, characters: ["RIVEN", "MERRITT"], target: 700, chapter: 1,
    question: "Does Riven get through the door before Merritt decides what to do about them?" });
  return dir;
}

test("a /cast failure falls back to the pill's can/cannot row in one muted line", async ({ page, served }) => {
  const dir = await setupLiveStory();
  try {
    await page.route("**/cast?*", (route) => route.abort());
    // Via the shelf first: chips resolve their scene half against the loaded
    // shelf cards, which a direct #/live arrival never fetches.
    await arrive(page, served, "#/shelf");
    await page.locator("#nav-live").click();

    await page.locator('[data-tid="cast.chip"][data-char-name="RIVEN"]').first().click();
    const modal = page.getByTestId("charcard.modal");
    await expect(modal).toBeVisible();
    // One muted line saying so, and still the pill's own row beside it.
    await expect(page.getByTestId("charcard.cast-summary")).toContainText("could not load cast");
    await expect(page.getByTestId("charcard.cast-summary").locator(".cast-tags")).toContainText("can lockpicking, climbing");
    await page.keyboard.press("Escape");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a chapter whose prose will not load fails in its own slot, the others still render", async ({ page, served }) => {
  const dir = await copyFixtureStory();
  try {
    await mkdir(join(dir, "chapters"));
    await writeFile(join(dir, "chapters", "1.md"),
      "# Chapter 1\n\nRiven checks the parcel twice before touching the service door.");
    await writeFile(join(dir, "chapters", "2.md"),
      "# Chapter 2\n\nMerritt listens from the crate without moving.");
    registerStory(dir, async () => {
      const raw = JSON.parse(await readFile(join(dir, "story.json"), "utf8")) as FixtureStory;
      return { ...cardFromStory(dir, raw, "Failure states"), chapters: [1, 2] };
    });

    await page.route("**/chapter?*", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("n") === "2") await route.abort();
      else await route.continue();
    });
    await arrive(page, served, "#/readstory?dir=" + encodeURIComponent(dir));

    await expect(page.locator("#reader-ch-1")).toContainText("Riven checks the parcel twice");
    await expect(page.locator("#reader-ch-2")).toContainText("could not be opened");
    await expect(page.locator("#reader-ch-1")).not.toContainText("could not be opened");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a broken catalog fetch shows its retry button, and retrying recovers", async ({ page, served }) => {
  await page.route("**/catalog?*", (route) => route.abort());
  await arrive(page, served, "#/catalog");

  await expect(page.locator("#page")).toContainText("Couldn't load the character library");
  await expect(page.locator("#charlib-retry")).toBeVisible();

  await page.unroute("**/catalog?*");
  await page.locator("#charlib-retry").click();
  await expect(page.locator("#page")).toContainText("Showing 0 characters");
  await expect(page.locator("#charlib-new")).toBeVisible();
});

test("a failed visibility write keeps the draft and the old state", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill("IVET");
  await page.locator("#charlib-save").click();
  await expect(page.locator(".lib-row")).toHaveCount(1);

  // An unsaved content edit is on the form when the visibility write fails.
  await page.locator(".lib-row").first().click();
  await page.locator("#charlib-name").fill("IVET EDITED");
  await page.route("**/catalog/visibility", (route) => route.abort());
  await expect(page.locator("#charlib-toggle-hidden")).toHaveText("Hide character");
  await page.locator("#charlib-toggle-hidden").click();

  // An error line appears, the button does not relabel, the draft is untouched.
  await expect(page.locator("#page")).toContainText("could not change visibility");
  await expect(page.locator("#charlib-toggle-hidden")).toHaveText("Hide character");
  await expect(page.locator("#charlib-name")).toHaveValue("IVET EDITED");
  await expect(page.locator(".lib-row")).not.toContainText("Hidden");
});

const log = (prose: string) => [
  { t: "scene_start", story: "temporary", characters: ["RIVEN", "MERRITT"], target: 700, chapter: 1 },
  { t: "draft", step: 1, consulting: "", salvaged: false, chapter: 1, words: 7, prose },
  { t: "scene_end", steps: 2, words: 7, done: true, stopped: false, chapter: 1, retries: {} },
].map((e) => JSON.stringify(e)).join("\n") + "\n";

test("a failed run-log fetch in compare shows an error, not the previous selection", async ({ page, served }) => {
  const dir = await copyFixtureStory();
  try {
    for (const id of ["run-a", "run-b", "run-c"]) await mkdir(join(dir, "out", id), { recursive: true });
    await writeFile(join(dir, "out", "run-a", "writing-log.jsonl"), log("Riven opens the service door carefully."));
    await writeFile(join(dir, "out", "run-b", "writing-log.jsonl"), log("Riven opens the service door quickly."));
    await writeFile(join(dir, "out", "run-c", "writing-log.jsonl"), log("Riven never reaches the service door."));
    registerRunDirs(dir, ["run-a", "run-b", "run-c"]);
    registerStory(dir, async () => {
      const raw = JSON.parse(await readFile(join(dir, "story.json"), "utf8")) as FixtureStory;
      return {
        ...cardFromStory(dir, raw, "Failure states"),
        runs: ["run-a", "run-b", "run-c"].map((id, i) =>
          ({ id, mtimeMs: 3 - i, chapter: 1, steps: 2, words: 7, done: true, stopped: false })),
      };
    });

    await arrive(page, served, "#/story?dir=" + encodeURIComponent(dir));
    await page.locator("#story-compare").click();
    await expect(page.getByTestId("compare.pane")).toHaveCount(2);
    await expect(page.getByTestId("compare.pane").nth(0)).toContainText("carefully");
    await expect(page.getByTestId("compare.pane").nth(1)).toContainText("quickly");

    // The next selection's log will not load: an error, not run-b's prose again.
    await page.route("**/runs/log?*", (route) => route.abort());
    await page.locator("#compare-b").selectOption("run-c");
    await expect(page.locator("#page")).toContainText("could not load one of those runs");
    await expect(page.getByTestId("compare.pane")).toHaveCount(0);
    await expect(page.locator("#page")).not.toContainText("quickly");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
