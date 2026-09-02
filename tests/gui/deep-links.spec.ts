/** Block 3 — deep links and modals. `&block=<seq>` and `&modal=character-card:<name>` are the URL
 *  a bug report pastes, so they must survive a reload, resolve once, and leave when dismissed.
 *  A hash-only goto is a same-document navigation whose hashchange makes the running app rewrite
 *  the URL from its own state — wiping the params before any reload. So every arrival below goes
 *  through about:blank: a fresh document load, which is what pasting a URL is, and boot reads the
 *  params itself. The scripted runs set LIVE.meta too, because a real mid-run reload has it —
 *  run-and-save sets it at scene start, and the header chips the modal resolves against paint
 *  from it on the first frame. */
import type { Page } from "@playwright/test";
import { LIVE, publish } from "../../live.ts";
import { expect, test } from "./harness.ts";

const arrive = async (page: Page, port: number, hash: string) => {
  await page.goto("about:blank");
  await page.goto(`http://127.0.0.1:${port}/${hash}`);
};

const runMeta = () => {
  LIVE.meta = {
    story: "tests/fixtures/doorway", chapter: 1, chapters: 1, target: 700,
    question: "Does Riven get through the door before Merritt decides what to do about them?",
    characters: [{ name: "RIVEN", skills: [], restrictions: [] },
                 { name: "MERRITT", skills: [], restrictions: [] }],
  };
};

const sceneStart = () =>
  publish({ t: "scene_start", story: "tests/fixtures/doorway", characters: ["RIVEN", "MERRITT"], target: 700, chapter: 1 });

/** scene_start (seq 1) + consult (seq 2) + judge + answer + accept + draft. */
const scriptRun = () => {
  sceneStart();
  publish({ t: "consult", character: "MERRITT", question: "", wants: "", attempt: 1,
            situation: "The courier has named a price for walking away: the package goes through the door." });
  publish({ t: "judge", character: "MERRITT", verdict: "accept", note: "the porter answers in character", attempt: 1, chapter: 1 });
  publish({ t: "answer", character: "MERRITT", thought: "", action: "", note: "",
            speech: "One package, one signature — that I can log." });
  publish({ t: "accept", character: "MERRITT", attempt: 1, speech: "One package, one signature — that I can log.", action: "", chapter: 1 });
  publish({ t: "draft", step: 1, consulting: "", salvaged: false, chapter: 1, words: 42,
            prose: "Merritt hears the courier out, then names the one thing the log will accept." });
};

test("&block= opens the named consult on arrival and keeps naming it", async ({ page, served }) => {
  runMeta();
  scriptRun();
  await arrive(page, served, "#/live?block=2");

  const consult = page.locator('[data-tid="prose.consult"][data-seq="2"]');
  await expect(consult).toHaveCount(1);
  // Opened by the deep link itself — no click happened — and the URL still pins it.
  await expect(consult).toHaveAttribute("open", "");
  await expect(page.getByTestId("consult.attempt")).toBeVisible();
  await expect(page).toHaveURL(/block=2$/);
});

test("&modal= reopens the character card with the authored sheet, then leaves the URL", async ({ page, served }) => {
  runMeta();
  sceneStart();
  await arrive(page, served, "#/live?modal=character-card%3AMERRITT");

  const modal = page.getByTestId("charcard.modal");
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("MERRITT");
  // The authored half is the /cast fetch — knows, goal, the quoted voice.
  await expect(page.getByTestId("charcard.cast-summary")).toContainText("The service door lock has been sticking");
  await expect(page.getByTestId("charcard.cast-summary")).toContainText("Which key did you say you had?");
  // Resolved: the pending want is consumed and the URL no longer names it.
  await expect(page).toHaveURL(/#\/live$/);
  // One-shot: a reload without the param reopens nothing.
  await page.reload();
  await expect(page.getByTestId("charcard.modal")).toHaveCount(0);
});

test("closing the card drops &modal= — ×, Escape, and backdrop alike", async ({ page, served }) => {
  runMeta();
  sceneStart();
  await arrive(page, served, "#/live");
  const chip = page.locator('[data-tid="cast.chip"][data-char-name="MERRITT"]');
  const modal = page.getByTestId("charcard.modal");
  const dropped = /#\/live$/;

  await chip.click();
  await expect(modal).toBeVisible();
  await expect(page).toHaveURL(/modal=character-card%3AMERRITT/);
  await page.locator("#charcard-close").click();
  await expect(page).toHaveURL(dropped);
  await expect(modal).toHaveCount(0);

  await chip.click();
  await expect(modal).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(dropped);
  await expect(modal).toHaveCount(0);

  await chip.click();
  await expect(modal).toBeVisible();
  await page.locator("#charcard-backdrop").click({ position: { x: 5, y: 5 } });
  await expect(page).toHaveURL(dropped);
  await expect(modal).toHaveCount(0);
});

test("syncHash drops params it does not know", async ({ page, served }) => {
  await arrive(page, served, "#/live?foo=bar");
  await expect(page).toHaveURL(/#\/live$/);
});
