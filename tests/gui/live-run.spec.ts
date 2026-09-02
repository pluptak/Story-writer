/** Block 2 — the SSE spine. A run's whole stimulus is a function call: the same publish()/
 *  sseWrite()/LIVE the real engine drives. Script one and assert what the live screen builds from
 *  it — prose pieces, the consult block with its attempt and verdict, collapsed notes, the end
 *  marker, the agent rail, and the run-start edge that pulls the viewer onto the live screen
 *  without anyone navigating. Event shapes mirror the RunEvent/ConsultEvent unions exactly. */
import { LIVE, publish, setWhere, sseClients, sseWrite } from "../../live.ts";
import { expect, test } from "./harness.ts";

test("a scripted run reaches the page: prose, consult, notes, end, and the agent rail", async ({ page }) => {
  // Gate on the server-side truth: the page's EventSource is open, so every frame below arrives
  // live and the run-start edge fires the way it would for a real run.
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);

  LIVE.running = true;
  setWhere("writing", true);            // run_state — the viewer follows to the live screen itself
  publish({ t: "scene_start", story: "tests/fixtures/doorway", characters: ["RIVEN", "MERRITT"], target: 700, chapter: 1 });
  publish({ t: "consult", character: "MERRITT", question: "", wants: "", attempt: 1,
            situation: "The courier has named a price for walking away: the package goes through the door." });
  publish({ t: "judge", character: "MERRITT", verdict: "accept", note: "the porter answers in character", attempt: 1, chapter: 1 });
  publish({ t: "answer", character: "MERRITT", thought: "", action: "", note: "",
            speech: "One package, one signature — that I can log." });
  publish({ t: "accept", character: "MERRITT", attempt: 1, speech: "One package, one signature — that I can log.", action: "", chapter: 1 });
  sseWrite({ t: "composing", who: "WRITER", secs: 2, chars: 300 });
  publish({ t: "draft", step: 1, consulting: "", salvaged: false, chapter: 1, words: 42,
            prose: "Merritt hears the courier out, then names the one thing the log will accept." });
  sseWrite({ t: "agent_stats", who: "WRITER", model: "google/gemma-4-e4b", durationMs: 2_400, promptTokens: 900, completionTokens: 120 });
  sseWrite({ t: "agent_stats", who: "MERRITT", model: "google/gemma-4-e4b", durationMs: 1_100, promptTokens: 500, completionTokens: 60 });
  publish({ t: "narration_flag", why: "the piece names what Merritt feels", retried: false, chapter: 1 });
  publish({ t: "scene_end", steps: 3, words: 210, done: true, stopped: false, chapter: 1, retries: {} });

  // The run-start edge pulled the viewer onto the live screen; nobody navigated.
  await expect(page.getByTestId("live.prose-card")).toBeVisible();

  // The drafted prose.
  const piece = page.getByTestId("prose.piece");
  await expect(piece).toHaveCount(1);
  await expect(piece).toContainText("names the one thing the log will accept");

  // The consult: collapsed by default; opened it carries the attempt, the situation, the answer
  // and the judge's verdict.
  const consult = page.getByTestId("prose.consult");
  await expect(consult).toHaveCount(1);
  await consult.locator("summary").click();
  await expect(page.getByTestId("consult.attempt")).toHaveCount(1);
  await expect(page.getByTestId("consult.situation")).toContainText("named a price for walking away");
  await expect(page.getByTestId("consult.answer")).toContainText("One package, one signature");
  await expect(page.getByTestId("consult.verdict")).toContainText("accept");
  await expect(page.getByTestId("consult.verdict")).toContainText("the porter answers in character");

  // A non-critical note collapses to a pill; the end marker renders its verdict line.
  await expect(page.getByTestId("prose.note-pill")).toHaveCount(1);
  await expect(page.getByTestId("prose.end")).toContainText("210 words");
  await expect(page.getByTestId("prose.end")).toContainText("3 steps");

  // The rail: per-agent model calls, the words-against-target stat, and the composing indicator.
  await expect(page.getByTestId("rail.agentstats")).toBeVisible();
  await expect(page.locator('[data-tid="rail.agent-row"][data-who="WRITER"]')).toBeVisible();
  await expect(page.locator('[data-tid="rail.agent-row"][data-who="MERRITT"]')).toBeVisible();
  await expect(page.locator('[data-tid="rail.stat"][data-k="words"]')).toContainText("42 / 700");
  await expect(page.getByTestId("rail.composing")).toContainText("WRITER");

  // The header built cast chips from scene_start, and the session bar shows live controls.
  await expect(page.getByTestId("cast.chip")).toHaveCount(2);
  await expect(page.locator("#sessionbar")).toBeVisible();
  await expect(page.locator("#stop")).toBeEnabled();
});
