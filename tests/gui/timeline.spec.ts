/** The consult timeline strip (GUI-CHECKLIST §7). It lives outside `#page`, above the layout, so
 *  what can go wrong with it is which store it is showing and whether it clears itself — neither of
 *  which needs a model. Every run below is a `writing-log.jsonl` fixture served through the real
 *  /runs/log route, except the last, which is the same strip built from live SSE frames. */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  arrive, cardFromStory, copyFixtureStory, expect, registerRunDirs, registerStory, test,
} from "./harness.ts";
import type { FixtureStory } from "./harness.ts";
import { writingLog } from "./run-log.ts";
import { LIVE, publish, setWhere, sseClients } from "../../live.ts";

/** Two consults, the second retried once and capped — the three marker states in one run. */
const RUN_A = writingLog({
  characters: ["RIVEN", "MERRITT"],
  consults: [
    { who: "RIVEN", attempts: 1 },
    { who: "MERRITT", attempts: 2, capped: true },
  ],
});
/** A different run of the same chapter, so the strip has something else to become. */
const RUN_B = writingLog({
  characters: ["RIVEN", "MERRITT"],
  consults: [{ who: "MERRITT", attempts: 1 }],
});

/** A story on disk with those runs retained, registered the way real discovery would report them. */
async function storyWithRuns(): Promise<string> {
  const dir = await copyFixtureStory();
  for (const [id, log] of [["run-a", RUN_A], ["run-b", RUN_B]] as const) {
    await mkdir(join(dir, "out", id), { recursive: true });
    await writeFile(join(dir, "out", id, "writing-log.jsonl"), log);
  }
  registerRunDirs(dir, ["run-a", "run-b"]);
  registerStory(dir, async () => ({
    ...cardFromStory(dir, JSON.parse(await readFile(join(dir, "story.json"), "utf8")) as FixtureStory,
                     "Timeline"),
    runs: [
      { id: "run-a", mtimeMs: Date.parse("2026-09-05T04:02:10"), chapter: 1, steps: 2, words: 120, done: true, stopped: false },
      { id: "run-b", mtimeMs: Date.parse("2026-09-05T03:41:22"), chapter: 1, steps: 1, words: 60, done: true, stopped: false },
    ],
  }));
  return dir;
}

const openRun = async (page, served: number, dir: string, id: string) => {
  await arrive(page, served, "#/story?dir=" + encodeURIComponent(dir));
  await page.locator(`[data-tid="story.run-btn"][data-run="${id}"]`).click();
  await expect(page.getByTestId("prose.piece").first()).toBeVisible();
};

test("the strip carries one marker per consult, named for the character asked", async ({ page, served }) => {
  const dir = await storyWithRuns();
  try {
    await openRun(page, served, dir, "run-a");

    const strip = page.getByTestId("chrome.timeline");
    await expect(strip).toBeVisible();
    await expect(strip).toContainText("consults");

    const markers = page.getByTestId("timeline.marker");
    await expect(markers).toHaveCount(2);
    await expect(markers.nth(0)).toHaveText("RIVEN");
    await expect(markers.nth(1)).toHaveText("MERRITT");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a marker scrolls to its own block and opens it — not to itself", async ({ page, served }) => {
  const dir = await storyWithRuns();
  try {
    await openRun(page, served, dir, "run-a");

    // The second consult is below the fold on arrival: that is what makes the scroll observable.
    // Marker and block carry the same data-seq, so a marker that "finds itself" passes the open
    // assertion below and fails this one.
    const marker = page.getByTestId("timeline.marker").nth(1);
    const seq = await marker.getAttribute("data-seq");
    const block = page.locator(`[data-tid="prose.consult"][data-seq="${seq}"]`);
    await expect(block).toHaveCount(1);
    await expect(block).not.toBeInViewport();

    await marker.click();

    await expect(block).toBeInViewport();
    await expect(block).toHaveAttribute("open", "");
    // The jump is addressable: what you clicked is what a pasted link reopens.
    await expect(page).toHaveURL(new RegExp(`block=${seq}$`));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the strip belongs to the view: it empties on the shelf and follows the run you read",
  async ({ page, served }) => {
    const dir = await storyWithRuns();
    try {
      await openRun(page, served, dir, "run-a");
      await expect(page.getByTestId("timeline.marker")).toHaveCount(2);

      // A strip that survives the view change is showing a run nobody is looking at.
      await page.locator("#nav-shelf").click();
      await expect(page.getByTestId("chrome.timeline")).toBeHidden();
      await expect(page.getByTestId("timeline.marker")).toHaveCount(0);

      // The second run's markers replace the first's rather than joining them.
      await openRun(page, served, dir, "run-b");
      const markers = page.getByTestId("timeline.marker");
      await expect(markers).toHaveCount(1);
      await expect(markers).toHaveText("MERRITT");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

test("a retried consult and a capped one read and colour differently from a plain one",
  async ({ page, served }) => {
    const dir = await storyWithRuns();
    try {
      await openRun(page, served, dir, "run-a");

      const plain = page.getByTestId("timeline.marker").nth(0);
      const marked = page.getByTestId("timeline.marker").nth(1);

      await expect(plain).toHaveAttribute("title", "RIVEN");
      await expect(marked).toHaveAttribute("title", "MERRITT · 1 retry · capped");
      await expect(marked).toHaveClass(/retried/);
      await expect(marked).toHaveClass(/capped/);

      // The class is only half the claim — the checklist asks that they LOOK different. Retried
      // repaints the text, capped the ground behind it.
      const paint = (l: typeof plain) => l.evaluate(el => {
        const s = getComputedStyle(el);
        return { color: s.color, bg: s.backgroundColor, border: s.borderTopColor };
      });
      const [a, b] = [await paint(plain), await paint(marked)];
      expect(b.color).not.toBe(a.color);
      expect(b.bg).not.toBe(a.bg);
      expect(b.border).not.toBe(a.border);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

test("markers arrive during a live run and still jump", async ({ page }) => {
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);

  LIVE.running = true;
  setWhere("writing", true);
  publish({ t: "scene_start", story: "tests/fixtures/doorway", characters: ["RIVEN", "MERRITT"], target: 700, chapter: 1 });
  await expect(page.getByTestId("chrome.timeline")).toBeHidden();   // nothing consulted yet

  publish({ t: "consult", character: "MERRITT", question: "", wants: "", attempt: 1,
            situation: "The courier is two steps nearer the door than when they arrived." });
  publish({ t: "answer", character: "MERRITT", thought: "", action: "", note: "",
            speech: "You're standing two feet nearer the door than when you started." });
  publish({ t: "judge", character: "MERRITT", verdict: "accept", note: "in character", attempt: 1, chapter: 1 });
  publish({ t: "accept", character: "MERRITT", attempt: 1, chapter: 1, speech: "", action: "" });

  const marker = page.getByTestId("timeline.marker");
  await expect(marker).toHaveCount(1);
  await expect(marker).toHaveText("MERRITT");

  const seq = await marker.getAttribute("data-seq");
  await marker.click();
  await expect(page.locator(`[data-tid="prose.consult"][data-seq="${seq}"]`)).toHaveAttribute("open", "");
});
