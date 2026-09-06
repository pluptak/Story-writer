/** The per-agent model-call panel (GUI-CHECKLIST §8). Every claim in that section is about files
 *  the engine wrote and how the panel reads them, so the fixture is real transcripts in a temp
 *  story's `out/<id>/llm/` — the harness leaves `runLlmLogs`/`readLlmLog` alone precisely so this
 *  exercises the engine's own reading of them rather than a stand-in.
 *
 *  The load-bearing claim is the last one: the panel exists to tell you which agent is worth
 *  opening BEFORE you open it, because a writer transcript runs to a megabyte. A panel that inlined
 *  more than one call's body would still pass every other assertion here. */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  arrive, cardFromStory, copyFixtureStory, expect, registerRunDirs, registerStory, test,
} from "./harness.ts";
import type { FixtureStory } from "./harness.ts";
import { llmLog, writingLog } from "./run-log.ts";

const MODEL = "google/gemma-4-e4b";
const WRITER_CALLS = 24;      // lopsided on purpose: the panel's whole reason for existing
const MERRITT_CALLS = 3;

const LOG = writingLog({ characters: ["RIVEN", "MERRITT"], consults: [{ who: "MERRITT", attempts: 1 }] });

/** Three runs: one with two agents' transcripts, one with a different agent, one that logged
 *  nothing — the run killed before its first generation. */
async function storyWithTranscripts(): Promise<string> {
  const dir = await copyFixtureStory();

  const put = async (id: string, files: Record<string, string> | null) => {
    await mkdir(join(dir, "out", id), { recursive: true });
    await writeFile(join(dir, "out", id, "writing-log.jsonl"), LOG);
    await mkdir(join(dir, "out", id, "llm"), { recursive: true });   // present but empty when null
    for (const [file, text] of Object.entries(files ?? {}))
      await writeFile(join(dir, "out", id, "llm", file), text);
  };
  await put("run-a", {
    "writer.jsonl": llmLog("WRITER", MODEL, WRITER_CALLS),
    "merritt.jsonl": llmLog("MERRITT", MODEL, MERRITT_CALLS),
  });
  await put("run-b", { "riven.jsonl": llmLog("RIVEN", MODEL, 2) });
  await put("run-silent", null);

  const ids = ["run-a", "run-b", "run-silent"];
  registerRunDirs(dir, ids);
  registerStory(dir, async () => ({
    ...cardFromStory(dir, JSON.parse(await readFile(join(dir, "story.json"), "utf8")) as FixtureStory, "Agents"),
    runs: ids.map((id, i) => ({
      id, mtimeMs: 100 - i, chapter: 1, steps: 1, words: 40, done: true, stopped: false,
    })),
  }));
  return dir;
}

const readRun = async (page, served: number, dir: string, id: string) => {
  await arrive(page, served, "#/story?dir=" + encodeURIComponent(dir));
  await page.locator(`[data-tid="story.run-btn"][data-run="${id}"]`).click();
  await expect(page.getByTestId("agents.panel")).toBeVisible();
};

test("the panel lists one row per agent, tagged by role, with the calls it actually logged",
  async ({ page, served }) => {
    const dir = await storyWithTranscripts();
    try {
      await readRun(page, served, dir, "run-a");

      const rows = page.getByTestId("agents.row");
      await expect(rows).toHaveCount(2);

      // Ground truth is the file: these counts are the lines each transcript holds, which is what
      // the checklist's `wc -l` command reads off disk.
      const writer = rows.filter({ hasText: "WRITER" });
      await expect(writer).toContainText(`${WRITER_CALLS} calls`);
      await expect(writer.locator(".tag")).toHaveText("writer");

      const merritt = rows.filter({ hasText: "MERRITT" });
      await expect(merritt).toContainText(`${MERRITT_CALLS} calls`);
      await expect(merritt.locator(".tag")).toHaveText("character");
      await expect(merritt).toContainText(MODEL);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

test("a transcript opens to one numbered button per call, and a call expands and collapses",
  async ({ page, served }) => {
    const dir = await storyWithTranscripts();
    try {
      await readRun(page, served, dir, "run-a");
      await page.getByTestId("agents.row").filter({ hasText: "MERRITT" })
        .getByTestId("agents.open-btn").click();

      const calls = page.getByTestId("agents.call-btn");
      await expect(calls).toHaveCount(MERRITT_CALLS);
      await expect(calls.first()).toContainText("#1");
      await expect(calls.nth(2)).toContainText("#3");

      // Expanded: the prompt messages and the response, each labelled by its role.
      await calls.first().click();
      const body = page.locator(".callbody");
      await expect(body).toHaveCount(1);
      await expect(body).toContainText("MERRITT system prompt, call 1");
      await expect(body).toContainText("MERRITT was asked this on call 1");
      await expect(body).toContainText("MERRITT answered this on call 1");
      await expect(body.locator(".msg-role").first()).toHaveText("system");
      await expect(body.locator(".msg-role").last()).toHaveText("response");

      await calls.first().click();
      await expect(page.locator(".callbody")).toHaveCount(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

test("opening one of a writer's many calls inlines that call and no other", async ({ page, served }) => {
  const dir = await storyWithTranscripts();
  try {
    await readRun(page, served, dir, "run-a");
    await page.getByTestId("agents.row").filter({ hasText: "WRITER" })
      .getByTestId("agents.open-btn").click();

    const calls = page.getByTestId("agents.call-btn");
    await expect(calls).toHaveCount(WRITER_CALLS);

    await calls.nth(4).click();
    await expect(page.locator(".callbody")).toHaveCount(1);
    await expect(page.locator(".callbody")).toContainText("WRITER answered this on call 5");

    // The claim behind "the tab must stay responsive": the other 23 calls' bodies are not on the
    // page at all. A panel that rendered every body would satisfy the count above and fail here.
    const page_text = await page.locator("#page").innerText();
    expect(page_text).not.toContain("WRITER answered this on call 6");
    expect(page_text).not.toContain("WRITER system prompt, call 1\n");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("reading another run replaces the panel and leaves no transcript open", async ({ page, served }) => {
  const dir = await storyWithTranscripts();
  try {
    await readRun(page, served, dir, "run-a");
    await page.getByTestId("agents.row").filter({ hasText: "MERRITT" })
      .getByTestId("agents.open-btn").click();
    await page.getByTestId("agents.call-btn").first().click();
    await expect(page.locator(".callbody")).toHaveCount(1);

    await readRun(page, served, dir, "run-b");

    // The other run's agents are gone, not appended, and nothing it had open survived.
    const rows = page.getByTestId("agents.row");
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText("RIVEN");
    await expect(page.getByTestId("agents.call-btn")).toHaveCount(0);
    await expect(page.locator(".callbody")).toHaveCount(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a run that logged no model calls says so, rather than erroring or spinning",
  async ({ page, served }) => {
    const dir = await storyWithTranscripts();
    try {
      await readRun(page, served, dir, "run-silent");
      await expect(page.getByTestId("agents.panel")).toContainText("this run logged no model calls");
      await expect(page.getByTestId("agents.row")).toHaveCount(0);
      await expect(page.getByTestId("agents.panel")).not.toContainText("reading…");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
