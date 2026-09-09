/** The consultation inspector: one Writer ↔ Character consultation read as a dialogue, in a
 *  floating panel that never replaces the prose. Entry points are the inline consult's inspect
 *  button and the timeline markers; the live run and retained runs resolve against their own
 *  event store, so history can never show the live conversation. Semantics of the inline
 *  blocks, the timeline and the deep links are unchanged -- only extended. */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { LIVE, publish, setWhere, sseClients } from "../../live.ts";
import {
  arrive, cardFromStory, copyFixtureStory, expect, registerRunDirs, registerStory, test,
} from "./harness.ts";
import type { FixtureStory } from "./harness.ts";
import { writingLog } from "./run-log.ts";

function startRun() {
  LIVE.running = true;
  setWhere("writing", true);
  publish({ t: "scene_start", story: "tests/fixtures/doorway", characters: ["MARA"], target: 700, chapter: 1 });
}

/** scene_start (seq 1) + one accepted consult (seq 2) + draft. */
function scriptAccepted() {
  startRun();
  publish({ t: "consult", character: "MARA", question: "Does Mara name the price aloud?", wants: "speech", attempt: 1,
            situation: "The courier is two steps nearer the service door than when they arrived." });
  publish({ t: "answer", character: "MARA", thought: "The lock has been sticking for a month.",
            action: "Mara stays where she is.", note: "", speech: "Name it, then." });
  publish({ t: "judge", character: "MARA", verdict: "accept", note: "answers in character", attempt: 1, chapter: 1 });
  publish({ t: "accept", character: "MARA", attempt: 1, speech: "Name it, then.",
            action: "Mara stays where she is.", chapter: 1 });
  publish({ t: "draft", step: 1, consulting: "", salvaged: false, chapter: 1, words: 42,
            prose: "Mara names the price of the open door." });
}

/** scene_start + a consult rejected once, then accepted on a fresh instance + draft. */
function scriptRetried() {
  startRun();
  publish({ t: "consult", character: "MARA", question: "Does Mara name the price aloud?", wants: "speech", attempt: 1,
            situation: "The courier will not say what the package is worth." });
  publish({ t: "answer", character: "MARA", thought: "Say nothing yet.", speech: "", action: "", note: "" });
  publish({ t: "judge", character: "MARA", verdict: "retry", note: "asked for speech and gave none",
            attempt: 1, chapter: 1 });
  publish({ t: "consult", character: "MARA", question: "Does Mara name the price aloud?", wants: "speech", attempt: 2,
            situation: "The courier sets the package down and waits for a number." });
  publish({ t: "answer", character: "MARA", thought: "Someone has to name it.", speech: "Name it, then.",
            action: "Mara stays where she is.", note: "" });
  publish({ t: "judge", character: "MARA", verdict: "accept", note: "answers in character", attempt: 2, chapter: 1 });
  publish({ t: "accept", character: "MARA", attempt: 2, speech: "Name it, then.",
            action: "Mara stays where she is.", chapter: 1 });
  publish({ t: "draft", step: 2, consulting: "", salvaged: false, chapter: 1, words: 84,
            prose: "Mara names the price of the open door, and the courier writes it down." });
}

const openFromTimeline = async (page: Page) => {
  await page.getByTestId("timeline.marker").click();
  await expect(page.getByTestId("inspect.dialog")).toBeVisible();
};

test("a consultation appears in the timeline; opening it shows that exact exchange", async ({ page }) => {
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
  scriptAccepted();
  await expect(page.getByTestId("live.prose-card")).toBeVisible();

  const marker = page.getByTestId("timeline.marker");
  await expect(marker).toHaveCount(1);
  await expect(marker).toHaveText("MARA");

  await openFromTimeline(page);
  const dialog = page.getByTestId("inspect.dialog");
  await expect(dialog).toContainText("MARA");
  await expect(dialog).toContainText("was consulted");
  await expect(dialog).toContainText("two steps nearer the service door");
  await expect(dialog).toContainText("Name it, then.");
});

test("Writer and Character messages render as two distinct voices", async ({ page }) => {
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
  scriptAccepted();
  await expect(page.getByTestId("live.prose-card")).toBeVisible();

  await page.getByTestId("prose.consult").locator("summary").first().click();
  await page.getByTestId("consult.inspect-btn").click();
  const dialog = page.getByTestId("inspect.dialog");
  await expect(dialog).toBeVisible();

  const writer = dialog.getByTestId("inspect.writer-msg");
  const who = dialog.getByTestId("inspect.character-msg");
  await expect(writer.first()).toContainText("two steps nearer the service door");
  await expect(who.first()).toContainText("Name it, then.");
  // The voices are told apart by label as well as styling -- not colour alone.
  await expect(writer.first()).toHaveAttribute("aria-label", "Writer");
  await expect(who.first()).toHaveAttribute("aria-label", "MARA");
  const classes = await dialog.evaluate(el => [...el.querySelectorAll('[data-tid="inspect.writer-msg"], [data-tid="inspect.character-msg"]')]
    .map(m => m.className));
  expect(new Set(classes).size).toBeGreaterThan(1);
});

test("an accepted consultation reads accepted", async ({ page }) => {
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
  scriptAccepted();
  await expect(page.getByTestId("live.prose-card")).toBeVisible();
  await openFromTimeline(page);

  const status = page.getByTestId("inspect.status");
  await expect(status).toContainText("Accepted");
  await expect(status).toContainText("✓");
});

test("a rejected previous attempt waits collapsed until asked for", async ({ page }) => {
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
  scriptRetried();
  await expect(page.getByTestId("live.prose-card")).toBeVisible();
  await openFromTimeline(page);
  const dialog = page.getByTestId("inspect.dialog");

  // The kept answer dominates: accepted after two attempts, rejected attempt undisclosed.
  await expect(page.getByTestId("inspect.status")).toContainText("Accepted");
  await expect(page.getByTestId("inspect.status")).toContainText("after 2 attempts");
  await expect(dialog).toContainText("sets the package down");
  const prev = page.getByTestId("inspect.prev-attempts");
  await expect(prev.locator("summary")).toContainText("1 previous attempt");
  await expect(dialog.getByText("will not say what the package is worth")).toBeHidden();

  await prev.locator("summary").click();
  await expect(dialog.getByText("will not say what the package is worth")).toBeVisible();
  await expect(dialog).toContainText("Set aside");
  await expect(dialog).toContainText("asked for speech and gave none");
});

test("character context shows what was sent, and nothing invented", async ({ page }) => {
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
  scriptAccepted();
  await expect(page.getByTestId("live.prose-card")).toBeVisible();
  await openFromTimeline(page);

  const ctx = page.getByTestId("inspect.context");
  await expect(ctx.locator("summary")).toContainText("Character context");
  await ctx.locator("summary").click();
  // Persisted inputs: the situation and the shape asked for.
  await expect(ctx).toContainText("two steps nearer the service door");
  await expect(ctx).toContainText("speech");
  // No snapshot is persisted today, so no definition renders -- an honest note instead.
  await expect(page.getByTestId("inspect.context-definition")).toHaveCount(0);
  await expect(ctx).toContainText("does not include a snapshot");
});

/** A retained run whose consult event carries a character-context snapshot -- the persistence
 *  contract's future shape, written as plain log lines so no engine type has to exist first. */
function logWithSnapshot(): string {
  const lines: string[] = [];
  let seq = 0;
  const put = (e: Record<string, unknown>) => lines.push(JSON.stringify({ seq: ++seq, ...e }));
  put({ t: "scene_start", story: "temporary", characters: ["MARA"], target: 700, chapter: 1 });
  put({ t: "draft", step: 1, consulting: "", salvaged: false, chapter: 1, words: 42,
        prose: "Mara names the price of the open door, and the courier writes it down." });
  put({ t: "consult", character: "MARA", attempt: 1,
        question: "Does Mara name the price aloud?", wants: "speech",
        situation: "The courier is two steps nearer the service door than when they arrived.",
        ctx: { persona: "Keeps the service door and its log.", knows: "The lock has been sticking for a month.",
               goal: "Get a number on the page.", skills: ["lockpicking — opening a lock without its key"],
               restrictions: ["sight"] } });
  put({ t: "answer", character: "MARA", thought: "Someone has to name it.", speech: "Name it, then.",
        action: "Mara stays where she is.", note: "" });
  put({ t: "judge", character: "MARA", verdict: "accept", note: "answers in character", attempt: 1, chapter: 1 });
  put({ t: "accept", character: "MARA", attempt: 1, speech: "Name it, then.",
        action: "Mara stays where she is.", chapter: 1 });
  put({ t: "scene_end", steps: 1, words: 42, done: true, stopped: false, chapter: 1, retries: {} });
  return lines.join("\n") + "\n";
}

async function storyWithRuns(): Promise<string> {
  const dir = await copyFixtureStory();
  await mkdir(join(dir, "out", "run-a"), { recursive: true });
  await writeFile(join(dir, "out", "run-a", "writing-log.jsonl"), writingLog({
    characters: ["RIVEN", "MERRITT"],
    consults: [{ who: "RIVEN", attempts: 1 }, { who: "MERRITT", attempts: 2, capped: true }],
  }));
  await mkdir(join(dir, "out", "run-b"), { recursive: true });
  await writeFile(join(dir, "out", "run-b", "writing-log.jsonl"), logWithSnapshot());
  registerRunDirs(dir, ["run-a", "run-b"]);
  registerStory(dir, async () => ({
    ...cardFromStory(dir, JSON.parse(await readFile(join(dir, "story.json"), "utf8")) as FixtureStory,
                     "Consult inspector"),
    runs: [
      { id: "run-a", mtimeMs: Date.parse("2026-09-05T04:02:10"), chapter: 1, steps: 2, words: 120, done: true, stopped: false },
      { id: "run-b", mtimeMs: Date.parse("2026-09-05T03:41:22"), chapter: 1, steps: 1, words: 60, done: true, stopped: false },
    ],
  }));
  return dir;
}

const openRun = async (page: Page, served: number, dir: string, id: string) => {
  await arrive(page, served, "#/story?dir=" + encodeURIComponent(dir));
  await page.locator(`[data-tid="story.run-btn"][data-run="${id}"]`).click();
  await expect(page.getByTestId("prose.piece").first()).toBeVisible();
  await page.evaluate("window.scrollTo(0, 0)");
};

test("a persisted context snapshot renders when the run record carries one", async ({ page, served }) => {
  const dir = await storyWithRuns();
  try {
    await openRun(page, served, dir, "run-b");
    await page.getByTestId("timeline.marker").click();
    await expect(page.getByTestId("inspect.dialog")).toBeVisible();
    await page.getByTestId("inspect.context").locator("summary").click();
    const def = page.getByTestId("inspect.context-definition");
    await expect(def).toContainText("Keeps the service door");
    await expect(def).toContainText("lockpicking");
    await expect(def).toContainText("sight");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a past run opens its own historical conversation, never another run's", async ({ page, served }) => {
  const dir = await storyWithRuns();
  try {
    await openRun(page, served, dir, "run-a");
    await page.getByTestId("timeline.marker").first().click();
    const dialog = page.getByTestId("inspect.dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("RIVEN");
    await expect(dialog).toContainText("standing nearer the door");

    // Opening another run drops the inspector rather than showing a stale conversation.
    await page.locator("#nav-story").click();
    await page.locator('[data-tid="story.run-btn"][data-run="run-b"]').click();
    await expect(page.getByTestId("prose.piece").first()).toBeVisible();
    await expect(dialog).toHaveCount(0);

    await page.getByTestId("timeline.marker").click();
    await expect(page.getByTestId("inspect.dialog")).toContainText("MARA");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("closing the inspector returns to Write with focus on the consultation event", async ({ page }) => {
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
  scriptAccepted();
  await expect(page.getByTestId("live.prose-card")).toBeVisible();

  const marker = page.getByTestId("timeline.marker");
  await marker.click();
  const dialog = page.getByTestId("inspect.dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("inspect.close")).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(marker).toBeFocused();
  await expect(page.getByTestId("live.prose-card")).toBeVisible();
  // The consultation stays addressable; only the inspector half of the URL leaves.
  await expect(page).toHaveURL(/block=2$/);
});

/** scene_start + two accepted consults for the same character + drafts. */
function scriptTwoConsults() {
  startRun();
  publish({ t: "consult", character: "MARA", question: "Does Mara name the price aloud?", wants: "speech", attempt: 1,
            situation: "The courier is two steps nearer the service door than when they arrived." });
  publish({ t: "answer", character: "MARA", thought: "The lock has been sticking for a month.",
            action: "Mara stays where she is.", note: "", speech: "Name it, then." });
  publish({ t: "judge", character: "MARA", verdict: "accept", note: "answers in character", attempt: 1, chapter: 1 });
  publish({ t: "accept", character: "MARA", attempt: 1, speech: "Name it, then.",
            action: "Mara stays where she is.", chapter: 1 });
  publish({ t: "draft", step: 1, consulting: "", salvaged: false, chapter: 1, words: 42,
            prose: "Mara names the price of the open door." });
  publish({ t: "consult", character: "MARA", question: "Does Mara open the door herself?", wants: "action", attempt: 1,
            situation: "The courier sets the package down and waits for someone to turn the key." });
  publish({ t: "answer", character: "MARA", thought: "Someone has to turn it.", speech: "",
            action: "Mara turns the key.", note: "" });
  publish({ t: "judge", character: "MARA", verdict: "accept", note: "answers in character", attempt: 1, chapter: 1 });
  publish({ t: "accept", character: "MARA", attempt: 1, speech: "", action: "Mara turns the key.", chapter: 1 });
  publish({ t: "draft", step: 2, consulting: "", salvaged: false, chapter: 1, words: 84,
            prose: "Mara turns the key, and the door swings wide." });
}

/** scene_start + one accepted consult + a group reaction the same character answered. */
function scriptConsultAndReaction() {
  startRun();
  publish({ t: "consult", character: "MARA", question: "Does Mara name the price aloud?", wants: "speech", attempt: 1,
            situation: "The courier is two steps nearer the service door than when they arrived." });
  publish({ t: "answer", character: "MARA", thought: "The lock has been sticking for a month.",
            action: "Mara stays where she is.", note: "", speech: "Name it, then." });
  publish({ t: "judge", character: "MARA", verdict: "accept", note: "answers in character", attempt: 1, chapter: 1 });
  publish({ t: "accept", character: "MARA", attempt: 1, speech: "Name it, then.",
            action: "Mara stays where she is.", chapter: 1 });
  publish({ t: "reaction_fanout", reactors: ["MARA", "JULES"],
            situation: "The alarm sounds through the whole wing.", chapter: 1 });
  publish({ t: "reaction", character: "MARA", thought: "Not the boiler again.",
            speech: "Everyone stay where you are.", action: "", chapter: 1 });
  publish({ t: "reaction", character: "JULES", thought: "They never drill us.",
            speech: "", action: "Jules backs against the wall.", chapter: 1 });
  publish({ t: "draft", step: 2, consulting: "", salvaged: false, chapter: 1, words: 84,
            prose: "The alarm sounds, and Mara holds the room." });
}

test("the inspector steps through one character's consultations across the whole run", async ({ page }) => {
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
  scriptTwoConsults();
  await expect(page.getByTestId("live.prose-card")).toBeVisible();
  await expect(page.getByTestId("timeline.marker")).toHaveCount(2);

  await page.getByTestId("timeline.marker").first().click();
  const dialog = page.getByTestId("inspect.dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("two steps nearer the service door");
  await expect(page.getByTestId("inspect.behavior"))
    .toContainText("MARA across this run: 2 consults");
  await expect(page.getByTestId("inspect.pos")).toContainText("1 of 2");
  await expect(page.getByTestId("inspect.prev")).toBeDisabled();

  await page.getByTestId("inspect.next").click();
  await expect(dialog).toContainText("sets the package down");
  await expect(page.getByTestId("inspect.pos")).toContainText("2 of 2");
  await expect(page.getByTestId("inspect.next")).toBeDisabled();
  // The panel and the prose stay in sync: stepping retags the URL to the new consultation.
  await expect(page).toHaveURL(/inspect=\d+$/);

  await page.getByTestId("inspect.prev").click();
  await expect(dialog).toContainText("two steps nearer the service door");
});

test("a group reaction they answered reads as part of their run", async ({ page }) => {
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
  scriptConsultAndReaction();
  await expect(page.getByTestId("live.prose-card")).toBeVisible();

  await openFromTimeline(page);
  const dialog = page.getByTestId("inspect.dialog");
  await expect(page.getByTestId("inspect.behavior")).toContainText("1 reaction");

  const more = page.getByTestId("inspect.run-more");
  await expect(more.locator("summary")).toContainText("More from MARA in this run (1)");
  // The other character's answer is not theirs: only Mara's reaction waits inside.
  await expect(dialog.getByText("They never drill us")).toBeHidden();
  await more.locator("summary").click();
  await expect(dialog).toContainText("Everyone stay where you are.");
  await expect(dialog).toContainText("Not the boiler again.");
  await expect(dialog).toContainText("leaves in memory");
  await expect(dialog.getByText("They never drill us")).toHaveCount(0);
});

/** scene_start with two characters, but only MARA is consulted + draft. */
function scriptTwoCastOneConsult() {
  LIVE.running = true;
  setWhere("writing", true);
  publish({ t: "scene_start", story: "tests/fixtures/doorway", characters: ["MARA", "JULES"], target: 700, chapter: 1 });
  publish({ t: "consult", character: "MARA", question: "Does Mara name the price aloud?", wants: "speech", attempt: 1,
            situation: "The courier is two steps nearer the service door than when they arrived." });
  publish({ t: "answer", character: "MARA", thought: "The lock has been sticking for a month.",
            action: "Mara stays where she is.", note: "", speech: "Name it, then." });
  publish({ t: "judge", character: "MARA", verdict: "accept", note: "answers in character", attempt: 1, chapter: 1 });
  publish({ t: "accept", character: "MARA", attempt: 1, speech: "Name it, then.",
            action: "Mara stays where she is.", chapter: 1 });
  publish({ t: "draft", step: 1, consulting: "", salvaged: false, chapter: 1, words: 42,
            prose: "Mara names the price of the open door." });
}

test("a cast pill's chat shortcut opens that character's conversation", async ({ page }) => {
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
  scriptTwoCastOneConsult();
  await expect(page.getByTestId("live.prose-card")).toBeVisible();

  // MARA was consulted, JULES was not: one shortcut live, one honestly disabled.
  const maraChat = page.locator('[data-tid="cast.chat"][data-chat-for="MARA"]');
  const julesChat = page.locator('[data-tid="cast.chat"][data-chat-for="JULES"]');
  await expect(maraChat).toBeEnabled();
  await expect(julesChat).toBeDisabled();
  await expect(julesChat).toHaveAttribute("aria-label", /no consultation in this run yet/);

  await maraChat.click();
  const dialog = page.getByTestId("inspect.dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("MARA");
  await expect(dialog).toContainText("Name it, then.");
  await expect(page).toHaveURL(/inspect=\d+$/);

  // Closing hands focus back to the shortcut that opened the panel.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(maraChat).toBeFocused();
});

test("a retained run's cast pills open that character's conversation", async ({ page, served }) => {
  const dir = await storyWithRuns();
  try {
    await openRun(page, served, dir, "run-a");
    const rivenChat = page.locator('[data-tid="cast.chat"][data-chat-for="RIVEN"]');
    await expect(rivenChat).toBeEnabled();
    await rivenChat.click();
    const dialog = page.getByTestId("inspect.dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("RIVEN");
    await expect(dialog).toContainText("standing nearer the door");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("&inspect= opens that consultation on arrival", async ({ page, served }) => {
  scriptAccepted();
  await arrive(page, served, "#/live?block=2&inspect=2");

  const dialog = page.getByTestId("inspect.dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("MARA");
  await expect(dialog).toContainText("Name it, then.");
});

test("the inspector holds together dark and narrow", async ({ page }) => {
  await expect.poll(() => sseClients.size, { timeout: 5_000 }).toBeGreaterThan(0);
  scriptAccepted();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.getByTestId("live.prose-card")).toBeVisible();

  await openFromTimeline(page);
  const dialog = page.getByTestId("inspect.dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("inspect.status")).toContainText("Accepted");
  const overflow = await page.evaluate(
    "document.documentElement.scrollWidth - document.documentElement.clientWidth");
  expect(overflow).toBeLessThanOrEqual(1);

  await page.getByTestId("inspect.close").click();
  await expect(dialog).toHaveCount(0);
});
