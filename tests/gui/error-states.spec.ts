/** Error presentation in two layers — what this means for the story first,
 *  the raw technical detail collapsed behind "Technical details" second.
 *  Nothing is hidden: the detail stays in the DOM, machine-readable, and the
 *  existing test ids and counts are unchanged. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir as osTmp } from "node:os";
import { arrive, cardFromStory, copyFixtureStory, expect, registerStory, registerRunDirs,
         setHandoffFactory, setHostOverrides, test } from "./harness.ts";
import { NextChapterSession } from "../../engine/architect.ts";
import { normalizeSpec } from "../../engine/story-spec.ts";
import { ScriptedAgent } from "../helpers.ts";
import type { FixtureStory } from "./harness.ts";
import type { Page } from "@playwright/test";

const openDetails = async (selector: string, page: Page) => {
  const details = page.locator(selector, { hasText: "Technical details" }).locator("details");
  await details.locator("summary").click();
  return details;
};

test("an invalid story leads with the consequence and keeps the raw error", async ({ page, served }) => {
  const dir = await copyFixtureStory();
  try {
    registerStory(dir, async () => ({
      ...cardFromStory(dir, JSON.parse(await readFile(join(dir, "story.json"), "utf8")) as FixtureStory, "Broken"),
      title: "Broken",
      ok: false as const, error: "scenes.0.length: Number must be greater than or equal to 1",
    }));

    // Shelf: consequence first, raw schema path one disclosure down.
    await arrive(page, served, "#/shelf");
    const card = page.locator(".cardwrap", { hasText: "Broken" });
    await expect(card).toContainText("can't be loaded");
    await expect(card.locator("summary")).toContainText("Technical details");
    await expect(card.locator(".tech")).toBeHidden();
    await card.locator("summary").click();
    await expect(card.locator(".tech")).toContainText("scenes.0.length");

    // Story page: same two layers, plus the way back.
    await arrive(page, served, "#/story?dir=" + encodeURIComponent(dir));
    await expect(page.locator("#page")).toContainText("can't be loaded");
    const storyTech = await openDetails("#page", page);
    await expect(storyTech).toContainText("scenes.0.length");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("model setup notes collapse while story warnings stay inline", async ({ page, served }) => {
  const dir = await copyFixtureStory();
  try {
    registerStory(dir, async () => {
      const raw = JSON.parse(await readFile(join(dir, "story.json"), "utf8")) as FixtureStory;
      return {
        ...cardFromStory(dir, raw, "Warnings"),
        warnings: [
          'Scene 1 grants reach to "NOBODY", who is not one of the characters — ignored',
          "   (not available in LM Studio: foo/bar — every call using this will error)",
        ],
      };
    });

    await arrive(page, served, "#/story?dir=" + encodeURIComponent(dir));
    // The character problem reads inline, where the author can act on it.
    await expect(page.locator("#page")).toContainText('grants reach to "NOBODY"');
    // The model note is one click away, collapsed, still on the page.
    const setup = page.getByTestId("story.setup-warnings");
    await expect(setup.locator("summary")).toContainText("Setup notes · 1");
    await expect(setup.locator(".prob").first()).toBeHidden();
    await setup.locator("summary").click();
    await expect(setup.locator(".prob").first()).toBeVisible();
    await expect(setup).toContainText("not available in LM Studio");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed handoff round keeps the raw model error in Technical details", async ({ page, served }) => {
  const dir = await mkdtemp(join(osTmp(), "pw-err-handoff-"));
  try {
    await writeFile(join(dir, "story.json"),
      await readFile(new URL("../../tests/fixtures/doorway/story.json", import.meta.url), "utf8"));
    await mkdir(join(dir, "chapters"));
    await writeFile(join(dir, "chapters", "1.md"), "# Chapter 1\n\nMerritt logged a quiet night.");
    const raw = JSON.parse(await readFile(join(dir, "story.json"), "utf8"));
    registerStory(dir, () => cardFromStory(dir, raw));
    // An empty script: the first model call throws, so the round fails hard
    // instead of asking a clarifying question.
    setHandoffFactory(async d => new NextChapterSession(
      new ScriptedAgent([]),
      { models: { default: "none", architect: "none", assistant: "none" },
        thinking: { architect: "low", assistant: "low" },
        requestTimeout: 120, attempts: 1, maxTokens: 2000, stream: false, debug: false },
      d, normalizeSpec(JSON.parse(await readFile(join(d, "story.json"), "utf8"))).spec,
      [{ n: 1, text: "Merritt logged a quiet night." }]));

    await arrive(page, served, "#/handoff?dir=" + encodeURIComponent(dir));
    await page.locator("#h-start").click();

    // The meaning names the consequence; the raw failure never reaches the headline.
    await expect(page.locator("#page")).toContainText("That round failed — nothing changed.");
    const tech = await openDetails("#page", page);
    await expect(tech).toContainText("ran out of replies");
  } finally {
    setHandoffFactory(null);
    await rm(dir, { recursive: true, force: true });
  }
});

test("an incomplete run names its id in Technical details", async ({ page, served }) => {
  const dir = await copyFixtureStory();
  try {
    await mkdir(join(dir, "out", "run-empty"), { recursive: true });
    await writeFile(join(dir, "out", "run-empty", "writing-log.jsonl"),
      JSON.stringify({ t: "scene_start", story: dir, characters: [], target: 700 }) + "\n");
    registerRunDirs(dir, ["run-empty"]);
    registerStory(dir, async () => ({
      ...cardFromStory(dir, JSON.parse(await readFile(join(dir, "story.json"), "utf8")) as FixtureStory, "Empty run"),
      runs: [{ id: "run-empty", mtimeMs: 2, chapter: 1, steps: 0, words: 0, done: false, stopped: true }],
    }));

    await arrive(page, served, "#/story?dir=" + encodeURIComponent(dir));
    await page.locator('[data-tid="story.run-btn"][data-run="run-empty"]').click();

    await expect(page.getByTestId("read.empty")).toContainText("This run is empty");
    const tech = await openDetails('[data-tid="read.empty"]', page);
    await expect(tech).toContainText("run-empty");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a partially applied suggestion separates consequence from raw skips", async ({ page, served }) => {
  const dir = await copyFixtureStory();
  try {
    registerStory(dir, async () => cardFromStory(dir,
      JSON.parse(await readFile(join(dir, "story.json"), "utf8")) as FixtureStory, "Suggest"));
    setHostOverrides({
      suggestEdits: async spec => ({
        ok: true as const, kind: "edits" as const, spec,
        applied: [{ field: "title", before: "", after: "The Door" }],
        ignored: ["characters.RIVEN.goal: no such field in this version"],
        problems: [], note: "",
      }),
    });

    await arrive(page, served, "#/edit?dir=" + encodeURIComponent(dir));
    await page.getByText("Ask the architect").click();
    await page.locator("#edit-suggest-text").fill("sharpen everything");
    await page.locator("#edit-suggest-btn").click();

    await expect(page.locator("#page")).toContainText("couldn't be applied");
    const tech = await openDetails("#edit-suggest-panel", page);
    await expect(tech).toContainText("characters.RIVEN.goal");
  } finally {
    setHostOverrides(null);
    await rm(dir, { recursive: true, force: true });
  }
});
