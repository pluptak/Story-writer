/** Focused accessibility pass: landmarks and skip link, focus survival across live
 *  re-renders, dialog focus return, announcements, distinct button names, pressed states,
 *  and text contrast in both themes. Semantic HTML first -- no ARIA added for what native
 *  elements (details/summary, button, dialog labelling) already say. */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LIVE, publish, setWhere, sseClients, sseWrite } from "../../live.ts";
import {
  arrive, cardFromStory, copyFixtureStory, expect, registerRunDirs, registerStory, test,
} from "./harness.ts";
import type { FixtureStory } from "./harness.ts";
import { llmLog, writingLog } from "./run-log.ts";
import type { Page } from "@playwright/test";

async function setupStory(): Promise<string> {
  const dir = await copyFixtureStory();
  await mkdir(join(dir, "chapters"));
  await writeFile(join(dir, "chapters", "1.md"),
    "# Chapter 1\n\nRiven checks the parcel twice before touching the service door.");
  await mkdir(join(dir, "out", "run-a", "llm"), { recursive: true });
  await writeFile(join(dir, "out", "run-a", "writing-log.jsonl"),
    writingLog({ characters: ["RIVEN", "MERRITT"], consults: [{ who: "MERRITT", attempts: 1 }] }));
  await writeFile(join(dir, "out", "run-a", "llm", "merritt.jsonl"), llmLog("MERRITT", "M", 3));
  registerRunDirs(dir, ["run-a"]);
  registerStory(dir, async () => {
    const raw = JSON.parse(await readFile(join(dir, "story.json"), "utf8")) as FixtureStory;
    return {
      ...cardFromStory(dir, raw, "Access audit"),
      chapters: [1],
      runs: [{ id: "run-a", mtimeMs: 2, chapter: 1, steps: 1, words: 40, done: true, stopped: false }],
    };
  });
  return dir;
}

async function contrast(page: Page, sel: string): Promise<number> {
  return page.evaluate((s) => {
    const lum = (c: string) => {
      const parts = (c.match(/[\d.]+/g) || []).map(Number).slice(0, 3).map((v) => {
        v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      const r = parts[0] || 0, g = parts[1] || 0, b = parts[2] || 0;
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const el = document.querySelector(s) as HTMLElement;
    let n: HTMLElement | null = el;
    let bg = "rgb(255, 255, 255)";
    while (n) {
      const c = getComputedStyle(n).backgroundColor;
      if (c && !/^rgba\(0,\s*0,\s*0,\s*0\)$/.test(c)) { bg = c; break; }
      n = n.parentElement;
    }
    const a = lum(getComputedStyle(el).color), b = lum(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }, sel);
}

test("landmarks and skip link: banner, nav, main, and a working skip", async ({ page, served }) => {
  const dir = await setupStory();
  try {
    await arrive(page, served, "#/shelf");
    await expect(page.locator("#page")).not.toBeEmpty();

    await expect(page.getByRole("banner")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "sections" })).toBeVisible();
    await expect(page.getByRole("main")).toBeVisible();
    expect(await page.getByRole("heading", { level: 1 }).count()).toBeGreaterThan(0);

    await page.keyboard.press("Tab");
    await expect(page.locator(".skip")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#page")).toBeFocused();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a reader answer keeps focus and its draft across a live re-render", async ({ page }) => {
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
  LIVE.running = true;
  setWhere("writing", true);
  publish({ t: "scene_start", story: "tests/fixtures/doorway", characters: ["RIVEN"], target: 700, chapter: 1 });
  publish({ t: "reader_ask", step: 2, framing: "Which way does Riven go?", options: ["Door", "Stairs"], chapter: 1 });
  await expect(page.getByTestId("live.prose-card")).toBeVisible();

  const box = page.getByTestId("reader.own-input");
  await box.fill("my answer");
  await expect(box).toBeFocused();
  // A new frame rebuilds the page wholesale mid-sentence.
  publish({ t: "draft", step: 3, consulting: "", salvaged: false, chapter: 1, words: 42,
            prose: "Riven names the price of the open door." });
  await expect(page.getByTestId("prose.piece")).toContainText("price of the open door");
  await expect(box).toBeFocused();
  await expect(box).toHaveValue("my answer");
});

test("a focused consult summary and timeline marker survive a re-render", async ({ page }) => {
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
  LIVE.running = true;
  setWhere("writing", true);
  publish({ t: "scene_start", story: "tests/fixtures/doorway", characters: ["RIVEN"], target: 700, chapter: 1 });
  publish({ t: "consult", character: "RIVEN", question: "Do they open the door?", wants: "", attempt: 1,
            situation: "The lock sticks and the log needs a name." });
  publish({ t: "judge", character: "RIVEN", verdict: "accept", note: "in character", attempt: 1, chapter: 1 });
  publish({ t: "answer", character: "RIVEN", thought: "", action: "Riven shoulders the door.", note: "",
            speech: "Log it under my name." });
  publish({ t: "accept", character: "RIVEN", attempt: 1, speech: "Log it under my name.", action: "Riven shoulders the door.", chapter: 1 });
  await expect(page.getByTestId("live.prose-card")).toBeVisible();

  const summary = page.getByTestId("prose.consult").locator("summary").first();
  await summary.click();
  await expect(summary).toBeFocused();
  publish({ t: "draft", step: 3, consulting: "", salvaged: false, chapter: 1, words: 42,
            prose: "Riven names the price of the open door." });
  await expect(page.getByTestId("prose.piece")).toContainText("price of the open door");
  await expect(summary).toBeFocused();

  const marker = page.getByTestId("timeline.marker").first();
  await marker.focus();
  publish({ t: "draft", step: 4, consulting: "", salvaged: false, chapter: 1, words: 60,
            prose: "The door gives a little more." });
  await expect(page.getByTestId("prose.piece").nth(1)).toContainText("gives a little more");
  await expect(marker).toBeFocused();
});

test("a cancelled confirm returns focus to its invoker", async ({ page, served }) => {
  const dir = await setupStory();
  try {
    await arrive(page, served, "#/edit?dir=" + encodeURIComponent(dir));
    const premise = page.locator("#edit-premise");
    await expect(premise).toHaveValue(/behind a restaurant that closed at one/);
    await premise.fill("A changed premise, unsaved.");
    await page.locator("#nav-shelf").click();
    await expect(page.getByTestId("confirm.dialog")).toBeVisible();
    await expect(page.getByTestId("confirm.ok")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("confirm.dialog")).toHaveCount(0);
    await expect(page.locator("#nav-shelf")).toBeFocused();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the budget prompt announces itself; toggles expose pressed state", async ({ page, served }) => {
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
  LIVE.running = true;
  setWhere("writing", true);
  await arrive(page, served, "#/live");
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
  publish({ t: "scene_start", story: "tests/fixtures/doorway", characters: ["RIVEN"], target: 700, chapter: 1 });
  sseWrite({ t: "continue_prompt", steps: 24, budget: 24, suggested: 8 });
  await expect(page.locator("#prompt")).toBeVisible();
  expect(await page.locator("#prompt").getAttribute("role")).toBe("status");

  await expect(page.locator("#interactive")).toHaveAttribute("aria-pressed", "true");
});

test("repeated buttons carry distinct accessible names", async ({ page, served }) => {
  const dir = await setupStory();
  try {
    await arrive(page, served, "#/story?dir=" + encodeURIComponent(dir));
    await expect(page.getByTestId("story.run-row")).toBeVisible();

    await expect(page.getByRole("button", { name: /read chapter 1.*run/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /compare chapter 1.*run/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "read chapter 1", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /edit chapter 1 scenes/ })).toBeVisible();

    await page.locator('[data-tid="story.run-btn"][data-run="run-a"]').click();
    await expect(page.getByTestId("agents.panel")).toBeVisible();
    await expect(page.getByRole("button", { name: "open MERRITT transcript" })).toBeVisible();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("secondary text keeps 4.5:1 in light and dark", async ({ page, served }) => {
  const dir = await setupStory();
  try {
    await arrive(page, served, "#/shelf");
    await expect(page.locator("#page")).not.toBeEmpty();
    // Faint secondary text on a card, muted premise on a card.
    expect(await contrast(page, ".shelf-meta")).toBeGreaterThanOrEqual(4.5);
    expect(await contrast(page, ".card .pre")).toBeGreaterThanOrEqual(4.5);

    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(200);
    expect(await contrast(page, ".shelf-meta")).toBeGreaterThanOrEqual(4.5);
    expect(await contrast(page, ".card .pre")).toBeGreaterThanOrEqual(4.5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
