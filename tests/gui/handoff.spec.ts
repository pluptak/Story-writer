/** Block 4 — the handoff panel, driven by a ScriptedAgent session: the panel is the real
 *  /next-chapter surface over a NextChapterSession whose architect replies from a script, bound
 *  to a temp copy of the fixture. Start runs a scripted round (the applied change renders),
 *  accept is the two-click confirm, and accept rewrites the temp story.json through the engine's
 *  own accept path. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir as osTmp } from "node:os";
import { arrive, cardFromStory, expect, registerStory, setHandoffFactory, test } from "./harness.ts";
import { NextChapterSession } from "../../engine/architect.ts";
import { normalizeSpec } from "../../engine/story-spec.ts";
import { ScriptedAgent } from "../helpers.ts";
import type { Defaults } from "../../engine/story-format.ts";

const SCAFFOLD_DEFAULTS: Defaults = {
  models: { default: "none", architect: "none" },
  thinking: { architect: "low" },
  requestTimeout: 120, attempts: 3, maxTokens: 2000, stream: false, debug: false,
};

const NEW_GOAL = "Get the package inside and be gone before 5am, however it happens.";

test("a scripted handoff round reaches the panel and accept rewrites the story", async ({ page, served }) => {
  const dir = await mkdtemp(join(osTmp(), "pw-handoff-"));
  try {
    // What a between-chapters story looks like on disk: story.json plus a written chapter.
    await writeFile(join(dir, "story.json"),
      await readFile(new URL("../../tests/fixtures/doorway/story.json", import.meta.url), "utf8"));
    await mkdir(join(dir, "chapters"));
    await writeFile(join(dir, "chapters", "1.md"),
      "# Chapter 1\n\nMerritt logged a quiet night. The courier signed the ledger and left.");
    const raw = JSON.parse(await readFile(join(dir, "story.json"), "utf8"));
    registerStory(dir, () => cardFromStory(dir, raw));

    setHandoffFactory(async d => new NextChapterSession(
      new ScriptedAgent([
        JSON.stringify({ edits: [{ field: "characters.RIVEN.goal", value: NEW_GOAL }] }),
        JSON.stringify({ edits: [] }),                    // spare, for any follow-up round
      ]),
      SCAFFOLD_DEFAULTS, d,
      normalizeSpec(JSON.parse(await readFile(join(d, "story.json"), "utf8"))).spec,
      [{ n: 1, text: "Merritt logged a quiet night." }]));

    await arrive(page, served, "#/handoff?dir=" + encodeURIComponent(dir));
    await page.locator("#h-start").click();

    // The scripted round landed: the applied edit renders as before → after on the panel.
    await expect(page.getByTestId("handoff.change-row").first()).toContainText("RIVEN.goal");
    await expect(page.getByTestId("handoff.change-row").first()).toContainText(NEW_GOAL);
    const accept = page.locator("#h-accept");
    await expect(accept).toBeEnabled();

    // Accept is a two-click confirm, then the engine writes the story.
    await accept.click();
    await accept.click();
    await expect(page.locator("#h-write")).toBeVisible();   // "chapter 2 is prepared"
    await expect.poll(async () => JSON.parse(await readFile(join(dir, "story.json"), "utf8")).characters[0].goal)
      .toBe(NEW_GOAL);
  } finally {
    setHandoffFactory(null);
    await rm(dir, { recursive: true, force: true });
  }
});
