/** Saved runs as story history: each row answers what chapter, when, outcome and how far;
 *  reading and comparison are the primary actions; the raw log stays one disclosure down. */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  arrive, cardFromStory, copyFixtureStory, expect, registerRunDirs, registerStory, test,
} from "./harness.ts";
import type { FixtureStory } from "./harness.ts";

const log = (prose: string, words: number, ended: object) => [
  { t: "scene_start", story: "temporary", characters: ["RIVEN"], target: 700, chapter: 1 },
  { t: "draft", step: 1, consulting: "", salvaged: false, chapter: 1, words, prose },
  { t: "scene_end", steps: 2, words, chapter: 1, retries: {}, ...ended },
].map(e => JSON.stringify(e)).join("\n") + "\n";

async function setupHistory(dir: string) {
  await mkdir(join(dir, "out", "run-done"), { recursive: true });
  await mkdir(join(dir, "out", "run-stopped"), { recursive: true });
  await writeFile(join(dir, "out", "run-done", "writing-log.jsonl"),
    log("Riven opens the service door carefully.", 7, { done: true, stopped: false }));
  await writeFile(join(dir, "out", "run-stopped", "writing-log.jsonl"),
    log("Riven reaches for the service door.", 4, { done: false, stopped: true }));
  registerRunDirs(dir, ["run-done", "run-stopped"]);
  registerStory(dir, async () => {
    const raw = JSON.parse(await readFile(join(dir, "story.json"), "utf8")) as FixtureStory;
    return {
      ...cardFromStory(dir, raw, "History pies"),
      runs: [
        { id: "run-done", mtimeMs: 2, chapter: 1, steps: 2, words: 7, done: true, stopped: false },
        { id: "run-stopped", mtimeMs: 1, chapter: 1, steps: 2, words: 4, done: false, stopped: true },
      ],
    };
  });
}

test("history rows answer chapter, outcome and how far, with read and compare actions", async ({ page, served }) => {
  const dir = await copyFixtureStory();
  try {
    await setupHistory(dir);
    await arrive(page, served, "#/story?dir=" + encodeURIComponent(dir));

    const rows = page.getByTestId("story.run-row");
    await expect(rows).toHaveCount(2);
    const done = rows.filter({ hasText: "run-done" });
    await expect(done).toContainText("chapter 1");
    await expect(done).toContainText("service corridor");
    await expect(done.getByTestId("story.run-outcome")).toHaveText("finished");
    await expect(done).toContainText("7 words");
    await expect(done).toContainText("2 steps");
    const stopped = rows.filter({ hasText: "run-stopped" });
    await expect(stopped.getByTestId("story.run-outcome")).toHaveText("stopped");
    // Reading and comparison are buttons; the raw log is a disclosure, not a third button.
    await expect(done.getByTestId("story.run-btn")).toHaveText("read");
    await expect(done.getByTestId("story.run-compare-btn")).toBeVisible();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reading a run shows its history entry with the raw log one disclosure down", async ({ page, served }) => {
  const dir = await copyFixtureStory();
  try {
    await setupHistory(dir);
    await arrive(page, served, "#/story?dir=" + encodeURIComponent(dir));
    await page.locator('[data-tid="story.run-btn"][data-run="run-done"]').click();

    const history = page.getByTestId("read.history");
    await expect(history).toBeVisible();
    await expect(history).toContainText("History pies — chapter 1");
    await expect(page.getByTestId("read.outcome")).toHaveText("finished");
    await expect(history).toContainText("7 words");
    await expect(page.getByTestId("read.compare-btn")).toBeVisible();
    // Raw identity is present but collapsed: searchable, not leading.
    await expect(page.getByTestId("read.run-log")).toContainText("run-done");
    await expect(page.getByTestId("read.open-log-btn")).toBeHidden();
    await page.getByTestId("read.run-log").locator("summary").click();
    await expect(page.getByTestId("read.open-log-btn")).toBeVisible();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a history row's compare action preselects the run with chapter-anchored labels", async ({ page, served }) => {
  const dir = await copyFixtureStory();
  try {
    await setupHistory(dir);
    await arrive(page, served, "#/story?dir=" + encodeURIComponent(dir));
    await page.locator('[data-tid="story.run-compare-btn"][data-run="run-stopped"]').click();

    await expect(page).toHaveURL(/#\/compare\?.*[?&]a=run-stopped/);
    await expect(page.getByTestId("compare.picker")).toBeVisible();
    await expect(page.locator("#compare-a option:checked")).toContainText("chapter 1");
    await expect(page.getByTestId("compare.pane")).toHaveCount(2);
    await expect(page.getByTestId("compare.pane").nth(0)).toContainText("Riven reaches for the service door.");
    await expect(page.getByTestId("compare.pane").nth(1)).toContainText("Riven opens the service door carefully.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
