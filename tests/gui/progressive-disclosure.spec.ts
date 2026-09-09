/** Progressive disclosure — Level 1 (write/read) leads; Level 2 (authoring decisions) and
 *  Level 3 (engine detail) wait behind the existing details patterns. A new user meets story
 *  words first: verdicts and words, decision states, call counts. Steps, retries, token
 *  volumes, model ids and attempt mechanics stay in the DOM, one disclosure down. */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LIVE, publish, setWhere, sseClients } from "../../live.ts";
import {
  arrive, cardFromStory, copyFixtureStory, expect, registerRunDirs, registerStory, test,
} from "./harness.ts";
import type { FixtureStory } from "./harness.ts";
import { llmLog, writingLog } from "./run-log.ts";

function startRun() {
  LIVE.running = true;
  setWhere("writing", true);
  publish({ t: "scene_start", story: "tests/fixtures/doorway", characters: ["RIVEN"], target: 700, chapter: 1 });
}

test("the end marker leads with verdict and words; steps and retries disclose", async ({ page }) => {
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
  startRun();
  publish({ t: "draft", step: 1, consulting: "", salvaged: false, chapter: 1, words: 42,
            prose: "Riven names the price of the open door." });
  publish({ t: "scene_end", steps: 4, words: 138, done: true, stopped: false, chapter: 1,
            retries: { RIVEN: 2 } });
  await expect(page.getByTestId("live.prose-card")).toBeVisible();

  const end = page.getByTestId("prose.end");
  await expect(end).toContainText("scene finished");
  await expect(end).toContainText("138 words");
  // Level 3 stays in the DOM but collapsed: the summary names the steps, the retries hide.
  const detail = page.getByTestId("prose.end-details");
  await expect(detail.locator("summary")).toContainText("4 steps");
  await expect(detail.locator(".tech")).toBeHidden();
  await detail.locator("summary").click();
  await expect(detail.locator(".tech")).toContainText("4 steps");
  await expect(detail.locator(".tech")).toContainText("RIVEN ×2");
});

test("a retried consult's collapsed line carries no attempt count", async ({ page }) => {
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
  startRun();
  publish({ t: "consult", character: "RIVEN", question: "Do they open the door?", wants: "", attempt: 1,
            situation: "The lock sticks and the log needs a name." });
  publish({ t: "judge", character: "RIVEN", verdict: "retry", note: "answered beside the moment", attempt: 1, chapter: 1 });
  publish({ t: "consult", character: "RIVEN", question: "Do they open the door?", wants: "", attempt: 2,
            situation: "The lock sticks and the log needs a name, plainly this time." });
  publish({ t: "judge", character: "RIVEN", verdict: "accept", note: "in character", attempt: 2, chapter: 1 });
  publish({ t: "answer", character: "RIVEN", thought: "", action: "Riven shoulders the door.", note: "",
            speech: "Log it under my name." });
  publish({ t: "accept", character: "RIVEN", attempt: 2, speech: "Log it under my name.", action: "Riven shoulders the door.", chapter: 1 });
  await expect(page.getByTestId("live.prose-card")).toBeVisible();

  const summary = page.getByTestId("prose.consult").locator("summary").first();
  await expect(summary).toContainText("reasked");
  await expect(summary).not.toContainText("×2");
  // The count lives where the mechanics do.
  await expect(page.getByTestId("consult.engine-details").locator("summary")).toContainText("2 attempts");
});

test("an agent row leads with calls; volumes and models disclose", async ({ page, served }) => {
  const dir = await copyFixtureStory();
  try {
    await mkdir(join(dir, "out", "run-a", "llm"), { recursive: true });
    await writeFile(join(dir, "out", "run-a", "writing-log.jsonl"),
      writingLog({ characters: ["RIVEN", "MERRITT"], consults: [{ who: "MERRITT", attempts: 1 }] }));
    await writeFile(join(dir, "out", "run-a", "llm", "merritt.jsonl"),
      llmLog("MERRITT", "google/gemma-4-e4b", 3));
    registerRunDirs(dir, ["run-a"]);
    registerStory(dir, async () => ({
      ...cardFromStory(dir, JSON.parse(await readFile(join(dir, "story.json"), "utf8")) as FixtureStory, "Volumes"),
      runs: [{ id: "run-a", mtimeMs: 2, chapter: 1, steps: 1, words: 40, done: true, stopped: false }],
    }));

    await arrive(page, served, "#/story?dir=" + encodeURIComponent(dir));
    await page.locator('[data-tid="story.run-btn"][data-run="run-a"]').click();
    await expect(page.getByTestId("agents.panel")).toBeVisible();

    const row = page.getByTestId("agents.row").filter({ hasText: "MERRITT" });
    await expect(row).toContainText("3 calls");
    const volumes = row.getByTestId("agents.volumes");
    await expect(volumes.locator("summary")).toContainText("call detail");
    await expect(volumes.locator(".tech")).toBeHidden();
    await volumes.locator("summary").click();
    await expect(volumes.locator(".tech")).toContainText("google/gemma-4-e4b");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the run-ended modal leads with words; steps disclose", async ({ page }) => {
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
  LIVE.running = true;
  setWhere("writing", true);
  publish({
    t: "scene_start", story: "tests/fixtures/doorway", characters: ["RIVEN", "MERRITT"],
    target: 700, chapter: 1,
  });
  publish({
    t: "scene_end", steps: 4, words: 138, done: true, stopped: false, chapter: 1, retries: {},
  });
  setWhere("idle", false);

  const modal = page.getByTestId("runended.modal");
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("scene finished");
  await expect(modal).toContainText("138 words");
  const detail = page.getByTestId("runended.details");
  await expect(detail.locator("summary")).toContainText("4 steps");
  await expect(detail.locator(".tech")).toBeHidden();
  await detail.locator("summary").click();
  await expect(detail.locator(".tech")).toBeVisible();
});
