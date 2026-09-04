/** Saved runs — two retained logs are loaded through the real run-log route and compared in the
 * browser, including the accepted-prose word diff and both run panes. */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  arrive, cardFromStory, copyFixtureStory, expect, registerRunDirs, registerStory, test,
} from "./harness.ts";
import type { FixtureStory } from "./harness.ts";

const log = (prose: string, words: number) => [
  { t: "scene_start", story: "temporary", characters: ["RIVEN", "MERRITT"], target: 700, chapter: 1 },
  { t: "draft", step: 1, consulting: "", salvaged: false, chapter: 1, words, prose },
  { t: "scene_end", steps: 2, words, done: true, stopped: false, chapter: 1, retries: {} },
].map(e => JSON.stringify(e)).join("\n") + "\n";

test("the story compares two retained runs and highlights their prose diff", async ({ page, served }) => {
  const dir = await copyFixtureStory();
  try {
    await mkdir(join(dir, "out", "run-a"), { recursive: true });
    await mkdir(join(dir, "out", "run-b"), { recursive: true });
    await writeFile(join(dir, "out", "run-a", "writing-log.jsonl"),
      log("Riven opens the service door carefully.", 7));
    await writeFile(join(dir, "out", "run-b", "writing-log.jsonl"),
      log("Riven opens the service door quickly.", 7));

    registerRunDirs(dir, ["run-a", "run-b"]);
    registerStory(dir, async () => {
      const raw = JSON.parse(await readFile(join(dir, "story.json"), "utf8")) as FixtureStory;
      return {
        ...cardFromStory(dir, raw, "Doorway comparison"),
        chapters: [],
        runs: [
          { id: "run-a", mtimeMs: 2, chapter: 1, steps: 2, words: 7, done: true, stopped: false },
          { id: "run-b", mtimeMs: 1, chapter: 1, steps: 2, words: 7, done: true, stopped: false },
        ],
      };
    });

    await arrive(page, served, "#/story?dir=" + encodeURIComponent(dir));
    await page.locator("#story-compare").click();

    await expect(page.getByTestId("compare.picker")).toBeVisible();
    await expect(page.getByTestId("compare.pane")).toHaveCount(2);
    await expect(page.getByTestId("compare.pane").nth(0)).toContainText("Riven opens the service door carefully");
    await expect(page.getByTestId("compare.pane").nth(1)).toContainText("Riven opens the service door quickly");
    const diff = page.getByTestId("compare.diff");
    await expect(diff.locator(".diff-removed")).toContainText("carefully");
    await expect(diff.locator(".diff-added")).toContainText("quickly");
    await expect(page).toHaveURL(/#\/compare\?.*[?&]a=run-a.*[?&]b=run-b/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
