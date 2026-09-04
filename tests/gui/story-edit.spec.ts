/** Block 4 — the write-path screens, over the REAL host: the editor's load/check/save and the
 *  story page's discard run the engine's own persistence against temp copies of the fixture, and
 *  every save/discard assertion reads the file it changed. Temp stories are registered as card
 *  providers — the real discovery re-reads the file on every /stories, and so does the harness. */
import { basename } from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { arrive, cardFromStory, copyFixtureStory, expect, registerStory, setScaffoldFactory, test } from "./harness.ts";
import type { FixtureStory } from "./harness.ts";
import { ScaffoldSession } from "../../engine/architect.ts";
import { ScriptedAgent } from "../helpers.ts";
import { LIVE } from "../../live.ts";
import type { Defaults } from "../../engine/story-format.ts";

const readStory = async (dir: string) => JSON.parse(await readFile(join(dir, "story.json"), "utf8"));

/** The temp story as a live provider: every /stories re-reads the file, like real discovery. */
const registerLive = (dir: string) =>
  registerStory(dir, async () =>
    cardFromStory(dir, JSON.parse(await readFile(join(dir, "story.json"), "utf8")) as FixtureStory, basename(dir)));

test("the editor loads a story, saves an edit through the real path, and refuses an empty premise", async ({ page, served }) => {
  const dir = await copyFixtureStory();
  registerLive(dir);
  try {
    await arrive(page, served, "#/edit?dir=" + encodeURIComponent(dir));

    // The loaded draft renders: premise in the form, characters as cards.
    const premise = page.locator("#edit-premise");
    await expect(premise).toHaveValue(/behind a restaurant that closed at one/);
    await expect(page.locator('[data-tid="edit.char-card"][data-char="1"]')).toContainText("MERRITT");

    // An edit dirties the draft and enables save; the save goes through the real persist path.
    const goal = page.locator("#char-0-goal");
    await goal.fill("Get the package inside and be gone before 5am, however it happens.");
    await expect(page.locator("#edit-save")).toBeEnabled();
    await page.locator("#edit-save").click();
    await expect.poll(async () => (await readStory(dir)).characters[0].goal)
      .toBe("Get the package inside and be gone before 5am, however it happens.");

    // The empty premise is the save guard's own refusal, and it reaches the page — the file keeps
    // the premise it had.
    await premise.fill("");
    await expect(page.locator("#edit-save")).toBeEnabled();   // a warning, not an issue: saveable
    await page.locator("#edit-save").click();
    await expect(page.locator(".said.bad").first()).toContainText("Premise is empty");
    await expect.poll(async () => (await readStory(dir)).premise).toContain("restaurant that closed at one");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the story page discards the last unwritten chapter's scene — and only that one", async ({ page, served }) => {
  const dir = await copyFixtureStory();
  registerLive(dir);
  try {
    // A second scene: the discard flow's precondition is a last authored scene that is unwritten.
    const raw = await readStory(dir) as FixtureStory;
    raw.scenes.push({
      place: "the cab rank on the avenue", question: "Does the courier take the fare and ride?",
      pov: "MERRITT", length: 500, roster: [],
    });
    await writeFile(join(dir, "story.json"), JSON.stringify(raw, null, 2) + "\n");

    await arrive(page, served, "#/story?dir=" + encodeURIComponent(dir));

    // Scene 2 is the last authored, unwritten — discardable; scene 1 has no discard button.
    const discard2 = page.locator('[data-tid="story.scene-row"][data-chapter="2"] [data-tid="story.discard-btn"]');
    await expect(discard2).toBeVisible();
    await expect(page.locator('[data-tid="story.scene-row"][data-chapter="1"] [data-tid="story.discard-btn"]')).toHaveCount(0);

    // The story page confirms first — accept the dialog, then the real discard path writes the file.
    page.on("dialog", d => d.accept());
    await discard2.click();
    await expect.poll(async () => (await readStory(dir)).scenes.length).toBe(1);
    // The page follows the disk, because the provider re-reads it: scene 2's row is gone.
    await expect(page.locator('[data-tid="story.scene-row"][data-chapter="2"]')).toHaveCount(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// -- SCAFFOLD -> REVIEW SCREEN -------------------------------------------------
const SCAFFOLD_DEFAULTS: Defaults = {
  models: { default: "none", architect: "none" },
  thinking: { architect: "low" },
  requestTimeout: 120, attempts: 3, maxTokens: 2000, stream: false, debug: false,
};

const IDEA = "A night courier is asked to sign for a package that was never in their manifest.";

// The story stage's reply.
const STORY_REPLY = JSON.stringify({
  title: "The Signature",
  premise: "A courier must sign for a package that was never in their manifest.",
  facts: ["The package carries no return address."],
});

// The cast stage's reply -- lands after one approve, and is what makes haveStory() true, which is
// what gates "edit in full →" (interview.js) into existing at all.
const CAST_REPLY = JSON.stringify({
  characters: [{
    name: "RIVEN",
    persona: "A cautious courier who buys time by asking questions rather than declaring a position.",
    goal: "Hand the package over without signing for what they cannot account for.",
    knows: "The manifest closed at midnight.",
    belief: "A signature is a promise.",
    impulse: "Double-check the paperwork before moving.",
    voice: ["I sign for what I see, not for what I'm told."],
    skills: [], restrictions: [],
  }],
});

test("the review-new-story screen loads the scaffold's StoryJson-shaped draft", async ({ page, served }) => {
  setScaffoldFactory(async ({ idea, mode }) => {
    if (mode !== "staged") throw new Error("this spec walks the staged checklist");
    return new ScaffoldSession(
      new ScriptedAgent([STORY_REPLY, CAST_REPLY]), SCAFFOLD_DEFAULTS, idea,
      "unused-stories-dir", "staged",
      () => new ScriptedAgent(['{"ok":true,"why":""}']),   // the cast judge, if it is ever asked
      [], 0);
  });
  LIVE.awaitingPick = true;
  try {
    await arrive(page, served, "#/scaffold");
    await page.locator("#f-idea").fill(IDEA);
    await page.locator("#iv-start").click();   // staged is the modal's own default

    // Pass the story gate; the cast gate's reply lands and haveStory() goes true.
    await page.locator("#iv-approve").click();
    await expect(page.locator("#iv-edit")).toBeVisible();

    // "edit in full →" hands the review screen the scaffold's StoryJson-shaped draft directly
    // (server/scaffold-routes.ts's storyDraft field, not specView's GUI-facing shape) -- this is
    // the path scaffoldStory() used to hand-convert client-side before it was deleted.
    await page.locator("#iv-edit").click();
    await expect(page.locator("#edit-title")).toHaveValue("The Signature");
    await expect(page.locator("#edit-premise")).toHaveValue(/courier must sign/);
    await expect(page.locator('[data-tid="edit.char-card"][data-char="0"]')).toContainText("RIVEN");

    // A leftover `scene` alias or exploded {text,meaning} skills -- exactly the bug scaffoldStory()'s
    // own comment recorded -- would make the debounced /story/check reject with "Unrecognized key"
    // and leave "confirm and write" permanently disabled (editNew's toolbar uses that button, not
    // #edit-save). An edit reaching an enabled button proves the draft is genuine StoryJson the
    // schema accepts.
    await page.locator("#edit-title").fill("The Signature.");
    await expect(page.locator("#edit-scaffold-accept")).toBeEnabled();
  } finally {
    // SCAFFOLD is a module-level singleton (server/scaffold-routes.ts), outliving this test's own
    // server instance -- the next test to reach #/scaffold in this worker would otherwise inherit
    // this session instead of the idea modal.
    await page.request.post(`http://127.0.0.1:${served}/scaffold/abandon`).catch(() => {});
    setScaffoldFactory(null);
    LIVE.awaitingPick = false;
  }
});
