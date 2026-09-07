/** Writer-first live hierarchy: identity → question → prose → decision → context → engine.
 *  Prose dominates; steps/model/retries/judges hide until disclosed. Consult + reader behaviour
 *  itself is unchanged (live-run.spec owns that); this spec owns the ordering. */
import { LIVE, publish, setWhere, sseClients } from "../../live.ts";
import { expect, test } from "./harness.ts";

async function scriptBasicRun() {
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
  LIVE.running = true;
  setWhere("writing", true);
  publish({ t: "scene_start", story: "tests/fixtures/doorway", characters: ["RIVEN"], target: 700, chapter: 1 });
  publish({ t: "consult", character: "RIVEN", question: "", wants: "", attempt: 1,
            situation: "The door is barred and the log needs a name." });
  publish({ t: "judge", character: "RIVEN", verdict: "accept", note: "in character", attempt: 1, chapter: 1 });
  publish({ t: "answer", character: "RIVEN", thought: "", action: "", note: "", speech: "Log it under my name." });
  publish({ t: "accept", character: "RIVEN", attempt: 1, speech: "Log it under my name.", action: "", chapter: 1 });
  publish({ t: "draft", step: 1, consulting: "", salvaged: false, chapter: 1, words: 42,
            prose: "Riven names the price of the open door." });
}

test("live hierarchy: identity first, prose dominant, engine disclosed", async ({ page }) => {
  await scriptBasicRun();
  await expect(page.getByTestId("live.prose-card")).toBeVisible();

  // 1–3. Story/chapter identity + scene question precede the prose card in DOM order.
  const head = page.getByTestId("live.head");
  await expect(head).toBeVisible();
  await expect(head).toContainText("chapter");
  await expect(head).toContainText("doorway");
  const order = await page.evaluate(() => {
    const ids = ["live.head", "live.prose-card", "rail.status", "rail.engine-details"];
    const els = ids.map(id => document.querySelector(`[data-tid="${id}"]`));
    const pos = (el: Element | null) => {
      if (!el) return -1;
      const r = el.getBoundingClientRect();
      return r.top;
    };
    return els.map(pos);
  });
  expect(order[0]).toBeGreaterThanOrEqual(0);
  expect(order[1]).toBeGreaterThan(order[0]); // prose below identity
  expect(order[2]).toBeGreaterThanOrEqual(0);

  // 3. Prose dominates: serif column at ≥17px beats the 12px rail.
  const sizes = await page.evaluate(() => {
    const prose = document.querySelector(".prosecard .prose");
    const rail = document.querySelector(".rail");
    const f = (el: Element | null) => el ? parseFloat(getComputedStyle(el).fontSize) : 0;
    return { prose: f(prose), rail: f(rail) };
  });
  expect(sizes.prose).toBeGreaterThanOrEqual(17);
  expect(sizes.prose).toBeGreaterThan(sizes.rail);

  // Words stay visible in the card head; steps hide until Run details opens.
  await expect(page.getByTestId("live.words")).toContainText("42 / 700 words");
  await expect(page.locator('[data-tid="rail.stat"][data-k="words"]')).toBeVisible();
  await expect(page.locator('[data-tid="rail.stat"][data-k="steps"]')).toBeHidden();
  await expect(page.locator('[data-tid="rail.stat"][data-k="model"]')).toBeHidden();
  await expect(page.locator('[data-tid="rail.stat"][data-k="retries"]')).toBeHidden();

  // Judge internals hide until disclosed: opening the consult shows the story, opening How
  // this was decided shows the attempt and verdict (interaction preserved).
  await expect(page.getByTestId("consult.verdict")).toBeHidden();
  await page.getByTestId("prose.consult").locator("summary").first().click();
  await expect(page.getByTestId("consult.outcome")).toContainText("Decided");
  await expect(page.getByTestId("consult.verdict")).toBeHidden();
  await page.getByTestId("consult.engine-details").locator("summary").click();
  await expect(page.getByTestId("consult.verdict")).toContainText("accept");

  // No author decision banner when nothing is waiting.
  await expect(page.getByTestId("live.decision")).toHaveCount(0);
});

test("pending reader choice surfaces a decision banner above the prose", async ({ page }) => {
  await scriptBasicRun();
  publish({ t: "reader_ask", step: 2, framing: "Which way does Riven go?", options: ["Door", "Stairs"], chapter: 1 });
  await expect(page.getByTestId("live.prose-card")).toBeVisible();

  const banner = page.getByTestId("live.decision");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("needs your call");
  // Banner precedes the prose card; the working reader card itself is unchanged.
  const precedes = await page.evaluate(() => {
    const b = document.querySelector('[data-tid="live.decision"]');
    const p = document.querySelector('[data-tid="live.prose-card"]');
    return b && p ? b.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING : 0;
  });
  expect(precedes).toBeTruthy();
  await expect(page.locator(".reader.pending").first()).toBeVisible();
});
