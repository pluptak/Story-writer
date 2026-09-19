/** Block 8 — §5, the drift warning. sceneDrift compares a written chapter's
 *  chapters/<n>.json snapshot against the current spec when the handoff opens; no
 *  model produces the warning. A temp story with a chapters/1.json whose question
 *  differs, opened through the REAL openNextChapter (drift computed by the engine,
 *  only the architect's replies scripted), asserts the warning names the chapter
 *  and the field, that a chapter with no snapshot draws none, and that the
 *  warning does not block accept. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir as osTmp } from "node:os";
import { arrive, cardFromStory, expect, registerStory, setHandoffFactory, test } from "./harness.ts";
import { openNextChapter } from "../../engine/architect.ts";
import { ScriptedAgent } from "../helpers.ts";
import type { Defaults } from "../../engine/story-format.ts";
import type { FixtureStory } from "./harness.ts";

const HANDOFF_DEFAULTS: Defaults = {
  models: { default: "none", architect: "none", assistant: "none" },
  thinking: { architect: "low", assistant: "low" },
  requestTimeout: 120, attempts: 3, maxTokens: 2000, stream: false, debug: false,
};

const NEW_GOAL = "Get the package inside and be gone before 5am, however it happens.";
const NEW_QUESTION = "Does Riven talk their way through the door instead of picking it?";

/** A between-chapters story on disk: story.json plus a written chapter 1. With
 *  `snapshot` the chapter carries its chapters/1.json definition snapshot (the
 *  byte-for-byte story.json copy a real run leaves beside its prose). */
async function setupDriftStory(snapshot: boolean, question: string | null) {
  const dir = await mkdtemp(join(osTmp(), "pw-drift-"));
  const original = await readFile(new URL("../../tests/fixtures/doorway/story.json", import.meta.url), "utf8");
  await writeFile(join(dir, "story.json"), original);
  await mkdir(join(dir, "chapters"));
  await writeFile(join(dir, "chapters", "1.md"),
    "# Chapter 1\n\nMerritt logged a quiet night. The courier signed the ledger and left.");
  if (snapshot) await writeFile(join(dir, "chapters", "1.json"), original);
  if (question != null) {
    const raw = JSON.parse(await readFile(join(dir, "story.json"), "utf8")) as FixtureStory;
    raw.scenes[0].question = question;
    await writeFile(join(dir, "story.json"), JSON.stringify(raw));
  }
  const raw = JSON.parse(await readFile(join(dir, "story.json"), "utf8"));
  registerStory(dir, () => ({ ...cardFromStory(dir, raw), chapters: [1] }));
  return dir;
}

/** The real openNextChapter — drift problems computed by the engine off the
 *  files above — with only the architect's replies scripted. */
function scriptRealHandoff() {
  setHandoffFactory(async d => {
    const s = await openNextChapter(HANDOFF_DEFAULTS, d);
    s.architect = new ScriptedAgent([
      JSON.stringify({ edits: [{ field: "characters.RIVEN.goal", value: NEW_GOAL }] }),
      JSON.stringify({ edits: [] }),
    ]);
    return s;
  });
}

test("an edited scene warns naming the chapter and the field, without blocking accept", async ({ page, served }) => {
  const dir = await setupDriftStory(true, NEW_QUESTION);
  try {
    scriptRealHandoff();
    await arrive(page, served, "#/handoff?dir=" + encodeURIComponent(dir));
    await page.locator("#h-start").click();

    // The warning names the chapter and the field — the engine's own wording.
    await expect(page.locator("#page")).toContainText(
      "chapter 1's prose was written from a different scene definition (question)");

    // The warning does not block the handoff: the round landed and accept works.
    await expect(page.getByTestId("handoff.change-row").first()).toContainText("RIVEN.goal");
    const accept = page.locator("#h-accept");
    await expect(accept).toBeEnabled();
    await accept.click();
    await accept.click();
    await expect(page.locator("#h-write")).toBeVisible();
  } finally {
    setHandoffFactory(null);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a chapter with no snapshot draws no warning", async ({ page, served }) => {
  const dir = await setupDriftStory(false, NEW_QUESTION);
  try {
    scriptRealHandoff();
    await arrive(page, served, "#/handoff?dir=" + encodeURIComponent(dir));
    await page.locator("#h-start").click();

    await expect(page.getByTestId("handoff.change-row").first()).toContainText("RIVEN.goal");
    await expect(page.locator("#page")).not.toContainText("was written from a different");
  } finally {
    setHandoffFactory(null);
    await rm(dir, { recursive: true, force: true });
  }
});

test("putting the question back clears the warning", async ({ page, served }) => {
  const dir = await setupDriftStory(true, NEW_QUESTION);
  try {
    scriptRealHandoff();
    await arrive(page, served, "#/handoff?dir=" + encodeURIComponent(dir));
    await page.locator("#h-start").click();
    await expect(page.locator("#page")).toContainText(
      "chapter 1's prose was written from a different scene definition (question)");

    // Restore the snapshotted definition, abandon the session, open again.
    // (Abandon lands on the bare story view — this arrival never set a story —
    // so go straight back to a fresh handoff load.)
    const snapshot = await readFile(join(dir, "chapters", "1.json"), "utf8");
    await writeFile(join(dir, "story.json"), snapshot);
    const abandon = page.locator("#h-abandon");
    await abandon.click();
    await abandon.click();
    await arrive(page, served, "#/handoff?dir=" + encodeURIComponent(dir));
    await page.locator("#h-start").click();

    await expect(page.getByTestId("handoff.change-row").first()).toContainText("RIVEN.goal");
    await expect(page.locator("#page")).not.toContainText("was written from a different");
  } finally {
    setHandoffFactory(null);
    await rm(dir, { recursive: true, force: true });
  }
});
