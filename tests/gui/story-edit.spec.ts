/** Block 4 — the write-path screens, over the REAL host: the editor's load/check/save and the
 *  story page's discard run the engine's own persistence against temp copies of the fixture, and
 *  every save/discard assertion reads the file it changed. Temp stories are registered as card
 *  providers — the real discovery re-reads the file on every /stories, and so does the harness. */
import { basename } from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { arrive, cardFromStory, copyFixtureStory, expect, registerStory, setHandoffFactory, setHostOverrides, setScaffoldFactory, test } from "./harness.ts";
import type { FixtureStory } from "./harness.ts";
import { NextChapterSession, ScaffoldSession } from "../../engine/architect.ts";
import { normalizeSpec } from "../../engine/story-spec.ts";
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
  models: { default: "none", architect: "none", assistant: "none" },
  thinking: { architect: "low", assistant: "low" },
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

/** The one editor path that cannot be allowed to run for real: `/story/suggest` calls a model.
 *  `setHostOverrides` answers it instead — installed after the server is already listening, which
 *  is the whole point of the seam. */
test("an architect suggestion lands in the form as an unsaved change", async ({ page, served }) => {
  const dir = await copyFixtureStory();
  registerLive(dir);
  const NEW_GOAL = "Get the package inside and be gone before 5am, whatever the porter decides.";
  try {
    setHostOverrides({
      suggestEdits: async (spec, text) => {
        const draft = JSON.parse(JSON.stringify(spec)) as { characters: { goal: string }[] };
        draft.characters[0].goal = NEW_GOAL;
        return {
          ok: true, kind: "edits", spec: draft,
          applied: [{ field: "characters.RIVEN.goal", before: "", after: NEW_GOAL }],
          ignored: [], problems: [], note: `asked: ${text}`,
        };
      },
    });

    await arrive(page, served, "#/edit?dir=" + encodeURIComponent(dir));
    await page.getByText("Ask the architect").click();
    await page.locator("#edit-suggest-text").fill("make Riven readier to force the door");
    await page.locator("#edit-suggest-btn").click();

    // The panel reports which fields it touched, and the edit is in the form, not just in the report.
    await expect(page.locator(".said.good")).toContainText("characters.RIVEN.goal");
    await expect(page.locator("#char-0-goal")).toHaveValue(NEW_GOAL);
    await expect(page.locator("#edit-save")).toBeEnabled();

    // "Unsaved" is the contract: a suggestion is a proposal, and nothing reaches the file until save.
    expect((await readStory(dir)).characters[0].goal).not.toBe(NEW_GOAL);
  } finally {
    setHostOverrides(null);
    await rm(dir, { recursive: true, force: true });
  }
});

// -- THE WRITE LOCKS -----------------------------------------------------------
// Three refusals, one mechanism (`storyWriteBlocked` in live.ts): a run is reading story.json, a
// picked story is still loading, or a handoff holds it. By hand each is a multi-tab dance around a
// live run; the flags they turn on are writable from here, so the refusal is what gets tested
// rather than the choreography needed to provoke it.

/** Arrive at the editor for `dir` and find the refusal instead of a form. */
const expectRefused = async (page, served: number, dir: string, reason: string) => {
  await arrive(page, served, "#/edit?dir=" + encodeURIComponent(dir));
  await expect(page.locator(".said.bad").first()).toContainText(reason);
  // The refusal is the whole page, not a banner over a working form: a form here would be one whose
  // every save the route is going to reject anyway.
  await expect(page.locator("#edit-premise")).toHaveCount(0);
};

test("the editor refuses to load while a run is in flight, and loads once it ends",
  async ({ page, served }) => {
    const dir = await copyFixtureStory();
    registerLive(dir);
    try {
      LIVE.running = true;
      await expectRefused(page, served, dir, "cannot edit while a run is in flight");

      LIVE.running = false;
      await arrive(page, served, "#/edit?dir=" + encodeURIComponent(dir));
      await expect(page.locator("#edit-premise")).toHaveValue(/restaurant that closed at one/);
    } finally {
      LIVE.running = false;
      await rm(dir, { recursive: true, force: true });
    }
  });

test("the editor refuses to load in the window after a story is picked", async ({ page, served }) => {
  const dir = await copyFixtureStory();
  registerLive(dir);
  try {
    // The gap between /select and the scene starting: story.json is being read, so it must not move.
    LIVE.loading = true;
    await expectRefused(page, served, dir, "cannot edit while a story is loading");

    LIVE.loading = false;
    await arrive(page, served, "#/edit?dir=" + encodeURIComponent(dir));
    await expect(page.locator("#edit-premise")).toHaveValue(/restaurant that closed at one/);
  } finally {
    LIVE.loading = false;
    await rm(dir, { recursive: true, force: true });
  }
});

test("an open handoff blocks the editor's save, and abandoning it lets the save through",
  async ({ page, served }) => {
    const dir = await copyFixtureStory();
    registerLive(dir);
    const NEW_TITLE = "Doorway, revised";
    try {
      // The lock is taken by the handoff itself rather than set by hand: host.handoffStart() claims
      // LIVE.storyLock the moment a round opens, and that claim is the thing under test.
      setHandoffFactory(async d => new NextChapterSession(
        new ScriptedAgent([JSON.stringify({ edits: [] })]),
        SCAFFOLD_DEFAULTS, d,
        normalizeSpec(JSON.parse(await readFile(join(d, "story.json"), "utf8"))).spec,
        [{ n: 1, text: "Merritt logged a quiet night." }]));

      // The editor opens FIRST: the lock refuses `/story/edit` as well as `/story/save`, so a tab
      // arriving after the handoff started never gets a form to try saving from. The case worth
      // testing is the one that actually happens — an editor already open when a handoff opens
      // behind it, holding a draft the route will no longer take.
      const editor = await page.context().newPage();
      try {
        await arrive(editor, served, "#/edit?dir=" + encodeURIComponent(dir));
        await editor.locator("#edit-title").fill(NEW_TITLE);

        await arrive(page, served, "#/handoff?dir=" + encodeURIComponent(dir));
        await page.locator("#h-start").click();
        await expect(page.locator("#h-accept")).toBeEnabled();
        await editor.locator("#edit-save").click();
        await expect(editor.locator(".said.bad").first()).toContainText("a chapter handoff is open");
        // The refusal is the file's, not just the page's.
        expect((await readStory(dir)).title).not.toBe(NEW_TITLE);

        await editor.request.post(`http://127.0.0.1:${served}/next-chapter/abandon`);
        await editor.locator("#edit-save").click();
        await expect.poll(async () => (await readStory(dir)).title).toBe(NEW_TITLE);
      } finally { await editor.close(); }
    } finally {
      setHandoffFactory(null);
      await rm(dir, { recursive: true, force: true });
    }
  });

// -- A FILE THE EDITOR CANNOT USE ----------------------------------------------

test("a story.json that will not parse loads as an error, and a mis-shaped one shows its raw content",
  async ({ page, served }) => {
    const dir = await copyFixtureStory();
    registerLive(dir);
    try {
      // Two failures the checklist ran as one. A SYNTAX error never becomes an object, so there is
      // nothing raw to show and `loadStoryJson` returns the message alone.
      await writeFile(join(dir, "story.json"), "{ not json");
      await arrive(page, served, "#/edit?dir=" + encodeURIComponent(dir));
      await expect(page.locator(".said.bad").first()).toContainText("could not read story.json");
      await expect(page.locator("pre.editor-raw")).toHaveCount(0);

      // A file that parses but fails the schema does have a raw object, and showing it is what makes
      // the message actionable — you can see the field it is talking about.
      await writeFile(join(dir, "story.json"), JSON.stringify({ title: "Doorway", scenes: "not a list" }));
      await arrive(page, served, "#/edit?dir=" + encodeURIComponent(dir));
      await expect(page.locator(".said.bad").first()).toBeVisible();
      await expect(page.locator("pre.editor-raw")).toContainText("not a list");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

test("a second tab keeps the story it loaded until it is reloaded", async ({ page, served }) => {
  const dir = await copyFixtureStory();
  registerLive(dir);
  const NEW_PREMISE = "A courier, a locked door, and a porter who hears everything.";
  try {
    await arrive(page, served, "#/edit?dir=" + encodeURIComponent(dir));
    const stale = await page.context().newPage();
    try {
      await arrive(stale, served, "#/edit?dir=" + encodeURIComponent(dir));
      await expect(stale.locator("#edit-premise")).toHaveValue(/restaurant that closed at one/);

      await page.locator("#edit-premise").fill(NEW_PREMISE);
      await page.locator("#edit-save").click();
      await expect.poll(async () => (await readStory(dir)).premise).toBe(NEW_PREMISE);

      // No push, by design: the other tab is holding a draft of its own, and replacing it under the
      // author would lose whatever they had typed. It goes stale, and a reload is the fix.
      await expect(stale.locator("#edit-premise")).toHaveValue(/restaurant that closed at one/);
      await stale.reload();
      await expect(stale.locator("#edit-premise")).toHaveValue(NEW_PREMISE);
    } finally { await stale.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("closing a tab with unsaved changes is guarded", async ({ page, served }) => {
  const dir = await copyFixtureStory();
  registerLive(dir);
  try {
    // Never the fixture page: closing that one takes the harness's own teardown with it.
    const doomed = await page.context().newPage();
    await arrive(doomed, served, "#/edit?dir=" + encodeURIComponent(dir));
    // A real click first: Chromium raises a beforeunload dialog only on a document that has had
    // sticky user activation, and fill() alone does not grant it.
    await doomed.locator("#edit-title").click();
    await doomed.locator("#edit-title").fill("Doorway, half-edited");
    await expect(doomed.locator("#edit-save")).toBeEnabled();   // dirty, which is the guard's gate

    // close() only asks; the dialog arrives as its own event, so wait for that rather than for the
    // close to resolve — the dialog IS the guard firing.
    const asked = doomed.waitForEvent("dialog", { timeout: 10_000 });
    const closing = doomed.close({ runBeforeUnload: true });
    await (await asked).dismiss();
    await closing;
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a reach grant round-trips through save, and a line with no colon is dropped",
  async ({ page, served }) => {
    const dir = await copyFixtureStory();
    registerLive(dir);
    const GRANT = "cameras :: perceiving through the lobby cameras";
    try {
      await arrive(page, served, "#/edit?dir=" + encodeURIComponent(dir));
      // RIVEN, not an invented name: a name matching no character warns at load, which is a
      // different check and would stand in the way of this one.
      await page.locator("#scene-1-reach").fill(`RIVEN: ${GRANT}\nthis line has no colon`);
      await page.locator("#edit-save").click();

      // Reach is scene-scoped (I1): it lands under the scene and never on the character.
      await expect.poll(async () => (await readStory(dir)).scenes[0].reach).toEqual({ RIVEN: [GRANT] });
      expect(JSON.stringify(await readStory(dir))).not.toContain("no colon");

      // It comes back as the same text it was typed as.
      await arrive(page, served, "#/edit?dir=" + encodeURIComponent(dir));
      await expect(page.locator("#scene-1-reach")).toHaveValue(`RIVEN: ${GRANT}`);

      // And clearing it takes the grant off the scene rather than leaving the name behind empty.
      await page.locator("#scene-1-reach").fill("");
      await page.locator("#edit-save").click();
      await expect.poll(async () => (await readStory(dir)).scenes[0].reach?.RIVEN).toBeUndefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
