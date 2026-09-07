/** Every screen worth looking at, driven into place and frozen. The stimulus is the one the GUI
 *  tests use — tests/gui/harness.ts binds the real server over a fixture host, and a run is a
 *  sequence of publish()/sseWrite() calls — so these are captures of the app, not of a lookalike.
 *
 *  One file, in order: snapshot.ts's `taken` registry is module state and the last capture writes
 *  the index from it.
 *
 *  Run: `npm run capture`. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  arrive, cardFromStory, copyFixtureStory, expect, registerRunDirs, registerStory,
  setHandoffFactory, setScaffoldFactory, test, FIXTURE_DIR,
} from "../../../tests/gui/harness.ts";
import type { FixtureStory } from "../../../tests/gui/harness.ts";
import { LIVE, publish, setWhere, sseClients, sseWrite } from "../../../live.ts";
import { NextChapterSession, ScaffoldSession } from "../../../engine/architect.ts";
import { normalizeSpec } from "../../../engine/story-spec.ts";
import { ScriptedAgent } from "../../../tests/helpers.ts";
import type { Defaults } from "../../../engine/story-format.ts";
import { snapshot, writeIndex } from "./snapshot.ts";

const ROOT = new URL("../../../", import.meta.url);
const fixtureRaw = async () =>
  JSON.parse(await readFile(new URL(`${FIXTURE_DIR}/story.json`, ROOT), "utf8")) as FixtureStory;

/** The SSE stream is open, so a published event actually reaches the page. */
const wired = () => expect.poll(() => sseClients.size, { timeout: 10_000 }).toBeGreaterThan(0);

const settle = (page: { waitForTimeout: (n: number) => Promise<void> }) => page.waitForTimeout(250);

// -- THE SCENE THE LIVE CAPTURES SHOW ----------------------------------------

/** What a mid-run reload has: the header's question, its chapter, and the cast the chips paint. */
const runMeta = () => {
  LIVE.meta = {
    story: FIXTURE_DIR, chapter: 2, chapters: 2, target: 700,
    question: "Does Riven get through the door before Merritt decides what to do about them?",
    characters: [
      { name: "RIVEN", skills: ["lockpicking", "climbing"], restrictions: [] },
      { name: "MERRITT", skills: ["keys"], restrictions: ["sight"] },
    ],
  };
};

const startRun = () => {
  runMeta();
  LIVE.running = true;
  LIVE.interactive = true;
  setWhere("writing", true);
  publish({ t: "scene_start", story: FIXTURE_DIR, characters: ["RIVEN", "MERRITT"], target: 700, chapter: 2 });
};

const agentStats = () => {
  sseWrite({ t: "agent_stats", who: "WRITER", model: "google/gemma-4-e4b", durationMs: 4_120, promptTokens: 3_180, completionTokens: 168 });
  sseWrite({ t: "agent_stats", who: "RIVEN", model: "google/gemma-4-e4b", durationMs: 1_640, promptTokens: 980, completionTokens: 74 });
  sseWrite({ t: "agent_stats", who: "MERRITT", model: "google/gemma-4-e4b", durationMs: 1_910, promptTokens: 1_040, completionTokens: 88 });
};

const PIECE_1 = "Riven sets the satchel down where the light does not reach and works the tape back with "
  + "a thumbnail. Somewhere past the bins the compressor cycles, and under it, closer, the sound of "
  + "someone breathing who has not moved in a while.\n\nThe lock is the old mechanical kind. That is "
  + "the one good thing about tonight.";
const PIECE_2 = "Merritt does not turn towards the sound. The crate creaks once, settling.\n\n"
  + "“You’re standing two feet nearer the door than when you started.”";

/** Two pieces of prose either side of a consult asked twice: the first answer refused for walking
 *  over MERRITT's restriction, the second accepted after the character asked a question back. */
const scriptScene = () => {
  publish({ t: "draft", step: 1, consulting: "", salvaged: false, chapter: 2, words: 44, prose: PIECE_1 });
  publish({ t: "consult", character: "MERRITT", attempt: 1,
            question: "Riven has just moved closer to the door. What does Merritt do?",
            wants: "a line, and whether they stand up",
            situation: "The courier has been quiet for a minute and is now two steps nearer the service door than when they arrived." });
  publish({ t: "answer", character: "MERRITT", thought: "The lock has been sticking for a month.",
            action: "Stands, blocking the line to the door.", note: "",
            speech: "I can see exactly what you are doing." });
  publish({ t: "judge", character: "MERRITT", verdict: "reject", attempt: 1, chapter: 2,
            note: "“I can see” — MERRITT is blind; the answer walks straight over the restriction" });
  publish({ t: "consult", character: "MERRITT", attempt: 2,
            question: "Riven has just moved closer to the door. What does Merritt do?",
            wants: "a line, and whether they stand up",
            situation: "The courier has been quiet for a minute and is now two steps nearer the service door than when they arrived." });
  publish({ t: "clarify", question: "Is the courier between me and the door, or past me?",
            answer: "Past you — nearer the door than you are, and on the bins side." });
  publish({ t: "answer", character: "MERRITT",
            thought: "Nine years of this corridor. The crate is where it is for a reason.",
            action: "Stays on the crate, turns their head a few degrees towards the bins.", note: "",
            speech: "You’re standing two feet nearer the door than when you started." });
  publish({ t: "judge", character: "MERRITT", verdict: "accept", attempt: 2, chapter: 2,
            note: "heard, not seen — the porter answers in character and hands the writer something to write" });
  publish({ t: "accept", character: "MERRITT", attempt: 2, chapter: 2,
            speech: "You’re standing two feet nearer the door than when you started.",
            action: "Stays on the crate, turns their head a few degrees towards the bins." });
  publish({ t: "draft", step: 2, consulting: "MERRITT", salvaged: false, chapter: 2, words: 38, prose: PIECE_2 });
  publish({ t: "narration_flag", why: "the piece named what Merritt was feeling", retried: true, chapter: 2 });
  agentStats();
};

// -- A STORY WITH A HISTORY --------------------------------------------------

const CH1 = "# Chapter 1\n\nThe corridor keeps its silence while Riven waits at the door. Three in the "
  + "morning, and the sodium lamp makes everything the colour of weak tea.\n\nMerritt is already there, "
  + "on the crate, the way they are every night between two and four.\n\n“Which key did you say you had?”";
const CH2 = "# Chapter 2\n\nThe package goes inside at ten past four. Riven signs the ledger with a name "
  + "that is nearly their own, and Merritt writes the time down without being asked for it.";

const runLog = (prose: string, words: number) => [
  { t: "scene_start", story: "temporary", characters: ["RIVEN", "MERRITT"], target: 700, chapter: 2 },
  { t: "consult", character: "MERRITT", attempt: 1, question: "Riven has moved closer to the door. What does Merritt do?",
    wants: "a line", situation: "The courier is two steps nearer the service door than when they arrived." },
  { t: "answer", character: "MERRITT", thought: "The lock has been sticking for a month.", action: "", note: "",
    speech: "You’re standing two feet nearer the door than when you started." },
  { t: "judge", character: "MERRITT", verdict: "accept", attempt: 1, chapter: 2, note: "in character" },
  { t: "accept", character: "MERRITT", attempt: 1, chapter: 2, speech: "", action: "" },
  { t: "draft", step: 1, consulting: "", salvaged: false, chapter: 2, words, prose },
  { t: "scene_end", steps: 4, words, done: true, stopped: false, chapter: 2, retries: {} },
].map(e => JSON.stringify(e)).join("\n") + "\n";

/** A temp copy of the fixture with two written chapters and two retained runs — what a story looks
 *  like once it has been worked on, which is the state every browse screen is interesting in. */
async function workedStory(name: string) {
  const dir = await copyFixtureStory();
  const raw = JSON.parse(await readFile(join(dir, "story.json"), "utf8")) as FixtureStory;
  raw.scenes.push({
    place: "The service corridor behind Kessel's, still 3am",
    question: "Does Merritt write the courier into the night log?",
    pov: "MERRITT", length: 600, roster: [],
  });
  raw.scenes.push({
    place: "The dispatch office at first light",
    question: "Who does Riven tell about the corridor?",
    pov: "RIVEN", length: 650, roster: [],
  });
  await writeFile(join(dir, "story.json"), JSON.stringify(raw, null, 2) + "\n");

  await mkdir(join(dir, "chapters"), { recursive: true });
  await writeFile(join(dir, "chapters", "1.md"), CH1);
  await writeFile(join(dir, "chapters", "2.md"), CH2);
  await mkdir(join(dir, "out", "2026-09-05T03-41-22"), { recursive: true });
  await mkdir(join(dir, "out", "2026-09-05T04-02-10"), { recursive: true });
  await writeFile(join(dir, "out", "2026-09-05T03-41-22", "writing-log.jsonl"),
    runLog("Merritt does not turn towards the sound. The crate creaks once, settling.", 148));
  await writeFile(join(dir, "out", "2026-09-05T04-02-10", "writing-log.jsonl"),
    runLog("Merritt does not turn towards the noise. The crate creaks, settling under them.", 151));

  registerRunDirs(dir, ["2026-09-05T03-41-22", "2026-09-05T04-02-10"]);
  registerStory(dir, async () => ({
    ...cardFromStory(dir, JSON.parse(await readFile(join(dir, "story.json"), "utf8")) as FixtureStory, name),
    chapters: [1, 2],
    runs: [
      { id: "2026-09-05T04-02-10", mtimeMs: Date.parse("2026-09-05T04:02:10"), chapter: 2, steps: 4, words: 151, done: true, stopped: false },
      { id: "2026-09-05T03-41-22", mtimeMs: Date.parse("2026-09-05T03:41:22"), chapter: 2, steps: 4, words: 148, done: true, stopped: false },
    ],
  }));
  return dir;
}

const SCAFFOLD_DEFAULTS: Defaults = {
  models: { default: "google/gemma-4-e4b", architect: "google/gemma-4-e4b", assistant: "google/gemma-4-e4b" },
  thinking: { architect: "low", assistant: "low" },
  requestTimeout: 120, attempts: 3, maxTokens: 2000, stream: false, debug: false,
};

// ============================================================================
// 1 · BROWSE
// ============================================================================

test("the shelf", async ({ page, served }) => {
  const raw = await fixtureRaw();

  const signature = structuredClone(raw);
  signature.title = "The Signature";
  signature.premise = "A night courier is asked to sign for a package that was never in their manifest, "
    + "by a clerk who will not say who sent it.";
  signature.scenes = [
    { ...raw.scenes[0], place: "The loading bay, 4am", question: "Does Riven sign for it?" },
    { ...raw.scenes[0], place: "The dispatch office", question: "Who does the clerk call once the door closes?" },
  ];
  signature.characters = [
    { ...raw.characters[0], name: "RIVEN" },
    { ...raw.characters[1], name: "TOBIAS", skills: ["recall :: quoting a document from memory, years later"], restrictions: [] },
  ];
  registerStory("data/stories/the-signature", () => ({
    ...cardFromStory("data/stories/the-signature", signature, "the-signature"),
    chapters: [1],
    runs: [{ id: "2026-09-04T22-11-08", mtimeMs: Date.parse("2026-09-04T22:11:08"), chapter: 2, steps: 6, words: 512, done: false, stopped: true }],
  }));

  const lowTide = structuredClone(raw);
  lowTide.title = "Low Tide";
  lowTide.premise = "Two salvage divers surface with one working air supply between them and a "
    + "disagreement about what they saw on the seabed.";
  lowTide.scenes = [{ ...raw.scenes[0], place: "The dive boat, six miles out", question: "Which of them goes back down?" }];
  lowTide.characters = [
    { ...raw.characters[0], name: "HALLE", skills: ["diving :: working at depth on a single tank"], restrictions: [] },
    { ...raw.characters[1], name: "OKON", skills: ["salvage :: reading a wreck for what will still lift"], restrictions: ["speech"] },
  ];
  registerStory("data/stories/low-tide", () => cardFromStory("data/stories/low-tide", lowTide, "low-tide"));

  await arrive(page, served, "#/shelf");
  await expect(page.getByTestId("shelf.story-card")).toHaveCount(3);
  await settle(page);
  await snapshot(page, {
    name: "shelf", group: "1 · Browse", title: "The shelf", dark: true,
    blurb: "Where every session starts: one card per story on disk, each carrying its scene question, "
      + "its cast, and whatever runs and chapters it already has.",
  });
});

test("the story map", async ({ page, served }) => {
  const dir = await workedStory("doorway");
  try {
    await arrive(page, served, "#/story?dir=" + encodeURIComponent(dir));
    await page.locator('[data-tid="story.scene-row"][data-chapter="1"]').getByTestId("story.read-btn").click();
    await expect(page.locator('[data-tid="story.scene-row"][data-chapter="1"] .prose')).toContainText("weak tea");
    await settle(page);
    await snapshot(page, {
      name: "story-map", group: "1 · Browse", title: "The story map",
      blurb: "One story: its scenes in order, which are written, the retained runs grouped by the "
        + "chapter they wrote, and chapter 1 opened inline.",
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the manuscript", async ({ page, served }) => {
  const dir = await workedStory("doorway");
  try {
    await arrive(page, served, "#/readstory?dir=" + encodeURIComponent(dir));
    await expect(page.locator(".reader-chapter")).toHaveCount(2);
    await page.locator("#reader-q").fill("crate");
    await expect(page.getByTestId("reader.hit").first()).toBeVisible();
    await settle(page);
    await snapshot(page, {
      name: "manuscript", group: "1 · Browse", title: "The manuscript",
      blurb: "The accepted prose end to end, with the in-browser search open on a hit — the reading "
        + "surface, as opposed to the writing one.",
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a saved run", async ({ page, served }) => {
  const dir = await workedStory("doorway");
  try {
    await arrive(page, served, "#/story?dir=" + encodeURIComponent(dir));
    await page.locator('[data-tid="story.run-btn"]').first().click();
    await expect(page.getByTestId("prose.piece").first()).toBeVisible();
    await page.getByTestId("prose.consult").first().locator("summary").click();
    await settle(page);
    await snapshot(page, {
      name: "saved-run", group: "1 · Browse", title: "A saved run, read back",
      blurb: "A retained writing log replayed read-only: the same prose-and-consult column as the "
        + "live screen, with the run controls gone and the consult opened.",
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("two runs compared", async ({ page, served }) => {
  const dir = await workedStory("doorway");
  try {
    await arrive(page, served, "#/story?dir=" + encodeURIComponent(dir));
    await page.locator("#story-compare").click();
    await expect(page.getByTestId("compare.pane")).toHaveCount(2);
    await settle(page);
    await snapshot(page, {
      name: "compare", group: "1 · Browse", title: "Two runs compared",
      blurb: "The same scene written twice, side by side, with the word-level diff of the accepted "
        + "prose above the two panes.",
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ============================================================================
// 2 · WRITING
// ============================================================================

test("a scene being written", async ({ page }) => {
  await wired();
  startRun();
  scriptScene();
  sseWrite({ t: "composing", who: "WRITER", secs: 6, chars: 412 });
  await expect(page.getByTestId("prose.piece")).toHaveCount(2);
  await settle(page);
  await snapshot(page, {
    name: "live-writing", group: "2 · Writing", title: "A scene being written", dark: true,
    blurb: "The live screen mid-run: drafted prose in the column, the consult that produced it "
      + "collapsed between the pieces, the agent rail counting model calls, and the writer composing.",
  });
});

test("a consult, opened", async ({ page }) => {
  await wired();
  startRun();
  scriptScene();
  await expect(page.getByTestId("prose.consult")).toHaveCount(1);
  await page.getByTestId("prose.consult").locator("summary").click();
  await expect(page.getByTestId("consult.attempt")).toHaveCount(2);
  await settle(page);
  await snapshot(page, {
    name: "live-consult", group: "2 · Writing", title: "A consult, opened",
    blurb: "The asymmetry made visible: what the character was told, the fact it asked back for, the "
      + "answer the judge refused, and the fresh instance that never learned it was refused.",
  });
});

test("a group reaction", async ({ page }) => {
  await wired();
  startRun();
  publish({ t: "draft", step: 1, consulting: "", salvaged: false, chapter: 2, words: 44, prose: PIECE_1 });
  publish({ t: "reaction_fanout", reactors: ["RIVEN", "MERRITT"],
            situation: "The service door gives half an inch and stops, and the sound carries the length of the corridor." });
  publish({ t: "reaction", character: "RIVEN", thought: "That was louder than it needed to be.",
            speech: "", action: "Puts a flat hand on the door to stop it moving again." });
  publish({ t: "reaction", character: "MERRITT", thought: "That is the top hinge, not the lock.",
            speech: "That door has been doing that for a month.",
            action: "Stands up off the crate for the first time tonight." });
  publish({ t: "promote", character: "MERRITT", action: "Stands up off the crate for the first time tonight." });
  agentStats();
  await expect(page.getByTestId("prose.reaction")).toHaveCount(1);
  await settle(page);
  await snapshot(page, {
    name: "live-reaction", group: "2 · Writing", title: "A group reaction",
    blurb: "One beat put to everyone present at once, in isolation: each reactor's thought and line, "
      + "with the single deed the writer promoted marked and the rest left as impulses.",
  });
});

test("the reader's seat", async ({ page }) => {
  await wired();
  startRun();
  publish({ t: "draft", step: 1, consulting: "", salvaged: false, chapter: 2, words: 44, prose: PIECE_1 });
  publish({ t: "reader_ask",
            framing: "Riven has the lock half-turned and Merritt has stood up. Whose call is the next move?",
            options: ["Riven keeps working the lock", "Riven steps back and talks", "Merritt reaches for the ring of keys"] });
  agentStats();
  await expect(page.getByTestId("prose.reader")).toBeVisible();
  await settle(page);
  await snapshot(page, {
    name: "live-reader-seat", group: "2 · Writing", title: "The reader's seat",
    blurb: "Interactive mode: the writer stops and puts the choice to the author, either as one of "
      + "its options or as anything they care to type.",
  });
});

test("the step budget is spent", async ({ page }) => {
  await wired();
  startRun();
  scriptScene();
  sseWrite({ t: "continue_prompt", steps: 24, budget: 24, suggested: 8 });
  await expect(page.getByTestId("chrome.budget-prompt")).toHaveClass(/on/);
  await settle(page);
  await snapshot(page, {
    name: "live-budget", group: "2 · Writing", title: "The step budget is spent",
    blurb: "The run stops and asks for more rope: the scene is unfinished, the budget is gone, and "
      + "nothing else moves until the author answers.",
  });
});

test("the run ends", async ({ page }) => {
  await wired();
  startRun();
  scriptScene();
  publish({ t: "scene_end", steps: 9, words: 684, done: true, stopped: false, chapter: 2, retries: { MERRITT: 1 } });
  setWhere("idle", false);
  await expect(page.getByTestId("runended.modal")).toBeVisible();
  await settle(page);
  await snapshot(page, {
    name: "run-ended", group: "2 · Writing", title: "The run ends",
    blurb: "A finished scene does not evaporate into the shelf — the completed page stays put and the "
      + "modal asks what to do with it.",
  });
});

test("a character card", async ({ page, served }) => {
  await wired();
  startRun();
  scriptScene();
  await arrive(page, served, "#/live?modal=character-card%3AMERRITT");
  await expect(page.getByTestId("charcard.modal")).toBeVisible();
  await expect(page.getByTestId("charcard.cast-summary")).toContainText("service door lock");
  await settle(page);
  await snapshot(page, {
    name: "character-card", group: "2 · Writing", title: "A character card",
    blurb: "What one agent actually holds — persona, what it knows, its goal, its voice, its skills "
      + "and the restriction the judge enforces. Reached from a cast chip, or from a pasted URL.",
  });
});

// ============================================================================
// 3 · AUTHORING
// ============================================================================

test("the story editor", async ({ page, served }) => {
  const dir = await copyFixtureStory();
  registerStory(dir, async () =>
    cardFromStory(dir, JSON.parse(await readFile(join(dir, "story.json"), "utf8")) as FixtureStory, "doorway"));
  try {
    await arrive(page, served, "#/edit?dir=" + encodeURIComponent(dir));
    await expect(page.locator("#edit-premise")).toHaveValue(/restaurant that closed at one/);
    await settle(page);
    await snapshot(page, {
      name: "story-editor", group: "3 · Authoring", title: "The story editor", dark: true,
      blurb: "story.json as a form: premise and style up top, the scene list, and one card per "
        + "character holding the three psychology fields, the voice lines, skills and restrictions.",
    });

    await page.locator("#edit-premise").fill("");
    await page.locator("#edit-save").click();
    await expect(page.locator(".said.bad").first()).toContainText("Premise is empty");
    await settle(page);
    await snapshot(page, {
      name: "story-editor-refused", group: "3 · Authoring", title: "A save the engine refuses",
      blurb: "The same editor after saving an empty premise: the refusal is the engine's own, "
        + "reported where the edit was made, and nothing reached the file.",
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const IDEA = "A night courier is asked to sign for a package that was never in their manifest.";
const STORY_REPLY = JSON.stringify({
  title: "The Signature",
  premise: "A courier must sign for a package that was never in their manifest, in a loading bay "
    + "where the only other person on shift has already decided how tonight goes.",
  tension: "Getting the receipt and staying unknown may not both be possible.",
  facts: ["The package carries no return address.", "The manifest closed at midnight and cannot be reopened."],
});
const CAST_REPLY = JSON.stringify({
  characters: [{
    name: "RIVEN",
    persona: "A cautious courier who buys time by asking questions rather than declaring a position.",
    goal: "Hand the package over without signing for what they cannot account for.",
    knows: "The manifest closed at midnight.",
    belief: "A signature is a promise, and a promise about a thing you have not seen is a lie.",
    impulse: "Double-check the paperwork before moving, even when there is no time to.",
    voice: ["I sign for what I see, not for what I'm told."],
    skills: [], restrictions: [],
  }],
});

test("the architect's idea step", async ({ page, served }) => {
  await arrive(page, served, "#/scaffold");
  await expect(page.getByTestId("scaffold.idea-modal")).toBeVisible();
  await page.locator("#f-idea").fill(IDEA);
  await page.locator('button.cat-chip[data-tag-label="literary"]').click();
  await page.locator('button.cat-chip[data-tag-label="procedural"]').click();
  await page.locator('button.cat-chip[data-tag-label="unsettling"]').click();
  await page.locator("#f-cast-size").selectOption("3");
  await settle(page);
  await snapshot(page, {
    name: "scaffold-idea", group: "3 · Authoring", title: "The architect's idea step",
    blurb: "Starting a story from nothing: the rough idea, the tag vocabulary the catalog owns, a "
      + "cast size, and the choice between a staged walk and the whole story at once.",
  });
});

test("the architect proposes", async ({ page, served }) => {
  setScaffoldFactory(async ({ idea, tags, castSize }) => new ScaffoldSession(
    new ScriptedAgent([STORY_REPLY, CAST_REPLY]), SCAFFOLD_DEFAULTS, idea,
    "unused-stories-dir", "staged",
    () => new ScriptedAgent(['{"ok":true,"why":""}']), tags, castSize));
  LIVE.awaitingPick = true;
  try {
    await arrive(page, served, "#/scaffold");
    await page.locator("#f-idea").fill(IDEA);
    await page.locator("#iv-start").click();
    await expect(page.locator('[data-tid="scaffold.gate"][data-gate="story"]')).toHaveClass(/open/);
    await settle(page);
    await snapshot(page, {
      name: "scaffold-story-gate", group: "3 · Authoring", title: "The architect proposes",
      blurb: "The staged walk at its first gate: the checklist on the left, the round in the middle, "
        + "and what has actually been settled — title, premise, tension, facts — on the right.",
    });

    await page.locator("#iv-approve").click();
    await expect(page.locator('[data-tid="scaffold.gate"][data-gate="cast"]')).toHaveClass(/open/);
    await settle(page);
    await snapshot(page, {
      name: "scaffold-cast-gate", group: "3 · Authoring", title: "A gate passed, the cast open",
      blurb: "One gate later: the story gate reads done and the cast gate is open, with the "
        + "characters proposed as the three psychology fields the engine actually consults.",
    });
  } finally {
    await page.request.post(`http://127.0.0.1:${served}/scaffold/abandon`).catch(() => {});
    setScaffoldFactory(null);
    LIVE.awaitingPick = false;
  }
});

const NEW_GOAL = "Get the package inside and be gone before 5am, whatever the porter decides to do about it.";

test("the handoff", async ({ page, served }) => {
  const dir = await mkdtemp(join(tmpdir(), "cap-handoff-"));
  try {
    await writeFile(join(dir, "story.json"), await readFile(new URL(`${FIXTURE_DIR}/story.json`, ROOT), "utf8"));
    await mkdir(join(dir, "chapters"));
    await writeFile(join(dir, "chapters", "1.md"), CH1);
    const raw = JSON.parse(await readFile(join(dir, "story.json"), "utf8")) as FixtureStory;
    registerStory(dir, () => ({ ...cardFromStory(dir, raw, "doorway"), chapters: [1] }));

    setHandoffFactory(async d => new NextChapterSession(
      new ScriptedAgent([
        JSON.stringify({ edits: [
          { field: "characters.RIVEN.goal", value: NEW_GOAL },
          { field: "characters.MERRITT.knows", value: "The service door lock has been sticking for a month, and last night somebody got it open." },
        ] }),
        JSON.stringify({ edits: [] }),
      ]),
      SCAFFOLD_DEFAULTS, d,
      normalizeSpec(JSON.parse(await readFile(join(d, "story.json"), "utf8"))).spec,
      [{ n: 1, text: CH1 }]));

    await arrive(page, served, "#/handoff?dir=" + encodeURIComponent(dir));
    await page.locator("#h-start").click();
    await expect(page.getByTestId("handoff.change-row").first()).toContainText("RIVEN.goal");
    await settle(page);
    await snapshot(page, {
      name: "handoff-round", group: "3 · Authoring", title: "Between chapters",
      blurb: "The architect re-reads what was written and re-authors the cast for the next chapter: "
        + "each edit as before → after, with the story it will rewrite locked while the panel is open.",
    });

    await page.locator("#h-accept").click();
    await page.locator("#h-accept").click();
    await expect(page.locator("#h-write")).toBeVisible();
    await settle(page);
    await snapshot(page, {
      name: "handoff-accepted", group: "3 · Authoring", title: "The next chapter is prepared",
      blurb: "Accept is a two-click confirm, and only then does story.json change on disk. The panel "
        + "reports what it wrote and hands the story back.",
    });
  } finally {
    setHandoffFactory(null);
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 4 · LIBRARIES
// ============================================================================

const seedCharacter = async (page, name: string, persona: string, belief: string, impulse: string,
                            voice: string, skills: string) => {
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill(name);
  await page.locator("#charlib-persona").fill(persona);
  await page.locator("#charlib-belief").fill(belief);
  await page.locator("#charlib-impulse").fill(impulse);
  await page.locator("#charlib-voice").fill(voice);
  await page.locator("#charlib-skills").fill(skills);
  await page.locator("#charlib-save").click();
};

test("the character library", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await seedCharacter(page, "IVET",
    "Ex-locksmith, sixty, keeps every key she ever cut on a labelled ring she will not let anyone else carry.",
    "Every lock has a polite way in, and the polite way is always slower.",
    "When watched, slow down and narrate the work.",
    '"Hold the door? I\'d rather hold the lock."',
    "lockpicking :: opening a mechanical lock without its key, given time and quiet");
  await seedCharacter(page, "TOBIAS",
    "A dispatch clerk who has read every manifest that came through this building for eleven years.",
    "Paper outlasts people; get it written down and it stops being your problem.",
    "When pressed for a decision, look something up instead.",
    '"That is not what the manifest says."',
    "recall :: quoting a document from memory, accurately, years later");
  await expect(page.locator(".lib-row")).toHaveCount(2);
  await page.locator(".lib-row").filter({ hasText: "IVET" }).click();
  await expect(page.locator("#charlib-name")).toHaveValue("IVET");
  await settle(page);
  await snapshot(page, {
    name: "catalog-characters", group: "4 · Libraries", title: "The character library", dark: true,
    blurb: "Characters that outlive the story they were written for: the portable half only — no "
      + "goal, no knows, no reach, because those belong to a position in a particular scene.",
  });

  await page.locator("#charlib-persona").fill(
    "Ex-locksmith, sixty, retired twice. Keeps every key she ever cut on a labelled ring.");
  await page.locator("#charlib-belief").fill("Every lock has a polite way in, and she has the time.");
  await page.locator("#charlib-review-changes").click();
  await expect(page.locator(".lib-change")).toHaveCount(2);
  await settle(page);
  await snapshot(page, {
    name: "catalog-changes", group: "4 · Libraries", title: "An edit, under review",
    blurb: "Editing a saved entry is a reviewable change, not a silent overwrite: every touched "
      + "field shows before and after, and any one of them can be reverted on its own.",
  });
});

test("the tag vocabulary", async ({ page, served }) => {
  await arrive(page, served, "#/catalog?kind=tags");
  await expect(page.locator(".lib-tags, .lib-row").first()).toBeVisible();
  await settle(page);
  await snapshot(page, {
    name: "catalog-tags", group: "4 · Libraries", title: "The tag vocabulary",
    blurb: "The faceted vocabulary the architect's idea step offers — genre, dramatic mode, tone — "
      + "seeded by the engine and extended by the author.",
  });
});

test("the skill bible", async ({ page, served }) => {
  await arrive(page, served, "#/catalog?kind=skills");
  // The bible arrives seeded, so the interesting state is an existing entry open, not a blank draft.
  await page.locator(".lib-row").filter({ hasText: "lockpicking" }).click();
  await expect(page.locator("#skilllib-name")).toHaveValue("lockpicking");
  await settle(page);
  await snapshot(page, {
    name: "catalog-skills", group: "4 · Libraries", title: "The skill bible",
    blurb: "What a named skill is allowed to mean, written once and resolved everywhere — the half "
      + "of a capability the engine will not let a story redefine per character.",
  });
});

test("the style library", async ({ page, served }) => {
  await arrive(page, served, "#/catalog?kind=styles");
  await page.locator("#stylib-new").click();
  await page.locator("#stylib-name").fill("Close and quiet");
  await page.locator("#stylib-description").fill(
    "Present tense, close third, concrete nouns — the corridor voice.");
  await page.locator("#stylib-voice").fill(
    "Close third on the POV character, present tense. Concrete nouns. Let the place do the work — "
    + "sound, cold, the smell off the bins — rather than adjectives about mood.\n\n"
    + "Dialogue is sparse and does not explain itself. People answer a question with a different "
    + "question and leave sentences unfinished when the other person already knows the end.");
  await page.locator("#stylib-save").click();
  await expect(page.locator(".lib-row").filter({ hasText: "Close and quiet" })).toHaveCount(1);
  await settle(page);
  await snapshot(page, {
    name: "catalog-styles", group: "4 · Libraries", title: "The style library",
    blurb: "Reusable writer voices: the prose instruction a new story starts from, kept apart from "
      + "any one story so it can be picked at the idea step.",
  });
});

// The index is built from what actually got captured, so it goes last.
test("the index", async () => {
  await writeIndex();
});
