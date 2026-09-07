/** A consult is a story decision, not an engine procedure. The collapsed line names who
 *  decides and the state in story words; the open block reads situation → decision → answer →
 *  what-happens-next; attempt mechanics wait behind How this was decided. Semantics unchanged:
 *  same events, same blocks, same deep links. */
import { LIVE, publish, setWhere, sseClients } from "../../live.ts";
import { expect, test } from "./harness.ts";

function startRun() {
  LIVE.running = true;
  setWhere("writing", true);
  publish({ t: "scene_start", story: "tests/fixtures/doorway", characters: ["RIVEN"], target: 700, chapter: 1 });
}

test("a retried decision reads decided, with the superseded attempt disclosed", async ({ page }) => {
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
  publish({ t: "draft", step: 3, consulting: "", salvaged: false, chapter: 1, words: 42,
            prose: "Riven names the price of the open door." });
  await expect(page.getByTestId("live.prose-card")).toBeVisible();

  // Collapsed: who decides + state in story words, not attempt numbers.
  const consult = page.getByTestId("prose.consult");
  const summary = consult.locator("summary").first();
  await expect(summary).toContainText("RIVEN");
  await expect(summary).toContainText("decides");
  await expect(summary).toContainText("reasked");

  // Open: situation → decision → answer → what happens next.
  await summary.click();
  await expect(page.getByTestId("consult.situation")).toContainText("plainly this time");
  await expect(page.getByTestId("consult.question")).toContainText("Do they open the door?");
  await expect(page.getByTestId("consult.answer")).toContainText("Log it under my name");
  await expect(page.getByTestId("consult.outcome")).toContainText("Decided");
  await expect(page.getByTestId("consult.outcome")).toContainText("story continues");

  // Mechanics one level down: two attempts, first set aside, second kept.
  await expect(page.getByTestId("consult.attempt").first()).toBeHidden();
  await page.getByTestId("consult.engine-details").locator("summary").click();
  await expect(page.getByTestId("consult.attempt")).toHaveCount(2);
  const verdicts = page.getByTestId("consult.verdict");
  await expect(verdicts.nth(0)).toContainText("retry");
  await expect(verdicts.nth(1)).toContainText("accept");
});

test("an unanswered decision reads waiting — the story pauses for the character", async ({ page }) => {
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
  startRun();
  publish({ t: "consult", character: "RIVEN", question: "Do they open the door?", wants: "", attempt: 1,
            situation: "The lock sticks and the log needs a name." });
  await expect(page.getByTestId("live.prose-card")).toBeVisible();

  const consult = page.getByTestId("prose.consult");
  await consult.locator("summary").first().click();
  await expect(page.getByTestId("consult.situation")).toContainText("lock sticks");
  await expect(page.getByTestId("consult.outcome")).toContainText("Waiting");
  await expect(page.getByTestId("consult.outcome")).toContainText("pauses here");
});
