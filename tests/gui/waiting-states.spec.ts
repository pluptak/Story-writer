/** Waiting-state vocabulary — every long wait says what is happening, why,
 *  whether anything is needed, and whether looking elsewhere is safe. No fake
 *  progress, and no claims about a model "thinking": the client only ever
 *  knows a reply hasn't landed yet.
 *
 *  Ordering rule: `publish()`ed run events replay to a freshly arrived page
 *  (liveHistory); direct `sseWrite` frames (composing, run_state,
 *  continue_prompt, run_error) do not — so the page arrives first and the
 *  ephemeral frame is sent once its own event stream is open. */
import { LIVE, publish, setWhere, sseClients, sseWrite } from "../../live.ts";
import { arrive, expect, test } from "./harness.ts";
import type { Page } from "@playwright/test";

/** Arrive, then wait for the fresh page's own event stream: direct sseWrite
 *  frames send to whoever is connected right now and are silently dropped
 *  while the new document's EventSource is still opening. */
async function arriveLive(page: Page, served: number, hash: string) {
  await arrive(page, served, hash);
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
}

async function draftChapterOne() {
  publish({ t: "scene_start", story: "tests/fixtures/doorway", characters: ["RIVEN", "MERRITT"], target: 700, chapter: 1 });
  publish({ t: "draft", step: 1, consulting: "", salvaged: false, chapter: 1, words: 42,
            prose: "Merritt hears the courier out, then names the one thing the log will accept." });
}

test("starting names the work, the cause, and that leaving is safe", async ({ page, served }) => {
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
  LIVE.running = true;
  setWhere("writing", true);
  await arriveLive(page, served, "#/live");

  const empty = page.getByTestId("live.empty");
  await expect(empty).toContainText("Starting");
  await expect(empty).toContainText("reaching the model");
  await expect(empty).toContainText("nothing needed");
  await expect(empty).toContainText("look around");
});

test("writing and consulting sublines say nothing is needed", async ({ page, served }) => {
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
  LIVE.running = true;
  setWhere("writing", true);
  await arriveLive(page, served, "#/live");
  draftChapterOne();

  await expect(page.getByTestId("rail.phasesub")).toContainText("Nothing needed");

  sseWrite({ t: "composing", who: "MERRITT", secs: 4, chars: 100 });
  await expect(page.getByTestId("rail.phasesub")).toContainText("MERRITT is deciding");
});

test("a re-asked consult reads as still working, not stuck", async ({ page, served }) => {
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
  LIVE.running = true;
  setWhere("writing", true);
  await arriveLive(page, served, "#/live");
  draftChapterOne();
  publish({ t: "consult", character: "MERRITT", question: "", wants: "", attempt: 1,
            situation: "The courier has named a price for walking away." });
  publish({ t: "judge", character: "MERRITT", verdict: "retry", note: "too flat", attempt: 1, chapter: 1 });
  publish({ t: "consult", character: "MERRITT", question: "", wants: "", attempt: 2,
            situation: "The courier has named a price for walking away." });
  sseWrite({ t: "composing", who: "MERRITT", secs: 6, chars: 200 });

  await expect(page.getByTestId("rail.phasesub")).toContainText("Re-asking MERRITT");
  await expect(page.getByTestId("rail.phasesub")).toContainText("still working");
});

test("waiting on the author says the run holds as long as needed", async ({ page, served }) => {
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
  LIVE.running = true;
  setWhere("writing", true);
  await arriveLive(page, served, "#/live");
  draftChapterOne();
  publish({ t: "reader_ask", step: 2, framing: "Which way does Riven go?", options: ["Door", "Stairs"], chapter: 1 });

  await expect(page.getByTestId("rail.phasesub")).toContainText("Blocked on your choice");
  await expect(page.getByTestId("live.decision")).toContainText("waits as long as needed");
});

test("the spent budget says the run is holding and waits either way", async ({ page, served }) => {
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
  LIVE.running = true;
  setWhere("writing", true);
  await arriveLive(page, served, "#/live");
  draftChapterOne();

  sseWrite({ t: "continue_prompt", steps: 24, budget: 24, suggested: 8 });
  await expect(page.locator("#prompt")).toBeVisible();
  await expect(page.locator("#promptText")).toContainText("the run is holding");
  await expect(page.getByTestId("rail.phasesub")).toContainText("Holding");

  await page.locator("#promptStop").click();
  await expect(page.locator("#prompt")).toBeHidden();
});

test("paused and stopping name the boundary being honored", async ({ page, served }) => {
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
  LIVE.running = true;
  setWhere("writing", true);
  await arriveLive(page, served, "#/live");
  draftChapterOne();

  sseWrite({ t: "run_state", running: true, stopping: false, where: "writing", picking: false,
             loading: false, armed: false, paused: true, pausing: false, model: null, interactive: true });
  await expect(page.getByTestId("rail.phasesub")).toContainText("Held at a step boundary");
  await expect(page.getByTestId("rail.phasesub")).toContainText("safe to leave");

  sseWrite({ t: "run_state", running: true, stopping: true, where: "writing", picking: false,
             loading: false, armed: false, paused: false, pausing: false, model: null, interactive: true });
  await expect(page.getByTestId("rail.phasesub")).toContainText("Finishing the current step, then ending");
});

test("completion says nothing is running anymore", async ({ page, served }) => {
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
  LIVE.running = true;
  setWhere("writing", true);
  await arriveLive(page, served, "#/live");
  draftChapterOne();
  publish({ t: "scene_end", steps: 4, words: 138, done: true, stopped: false, chapter: 1, retries: {} });
  setWhere("idle", false);

  const modal = page.getByTestId("runended.modal");
  await expect(modal).toContainText("nothing is running");
  await expect(modal).toContainText("story page");
});

test("a failed start says nothing is running and what to do next", async ({ page, served }) => {
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
  await arriveLive(page, served, "#/story?dir=" + encodeURIComponent("tests/fixtures/doorway"));
  sseWrite({ t: "run_error", message: "boom" });

  await expect(page.locator("#page")).toContainText("Couldn't start that run — boom");
  await expect(page.locator("#page")).toContainText("Nothing is running");
});
