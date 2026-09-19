/** Block 7 — §12's scripted gates. These read as "needs the architect model" and
 *  do not: a reply that asks instead of proposing pins the gate (field relabels
 *  to send answer →, approve disappears, draft unchanged); a cast-judge refusal
 *  reads as a judgement card with the pointer staying on Cast, approve anyway →
 *  in the warning colour, the 8-second window expiring back, and an armed
 *  override not carrying to a later gate; a bespoke name :: meaning skill shows
 *  a new-skills candidate with promote to bible (a bare skill never offered);
 *  the folder step refuses a taken name as you type and previews a slugified
 *  one. All through ScriptedAgent sessions — no model, no second client. */
import { readFile } from "node:fs/promises";
import { arrive, cardFromStory, expect, registerStory, setScaffoldFactory, test } from "./harness.ts";
import { ScaffoldSession } from "../../engine/architect.ts";
import { ScriptedAgent } from "../helpers.ts";
import { LIVE } from "../../live.ts";
import type { Page } from "@playwright/test";
import type { FixtureStory } from "./harness.ts";
import { WALK_DEFAULTS, WALK_IDEA, WALK_TENSION, STORY_REPLY, CAST_REPLY } from "./scaffold-walk.ts";
import { abandonWalk, startOneshot } from "./scaffold-walk.ts";

const ASK_REPLY = JSON.stringify({ ask: "Who is the courier working for?" });

const CAST_BARE = JSON.stringify({
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

const CAST_SKILLED = JSON.stringify({
  characters: [{
    name: "RIVEN",
    persona: "A cautious courier who buys time by asking questions rather than declaring a position.",
    goal: "Hand the package over without signing for what they cannot account for.",
    knows: "The manifest closed at midnight.",
    belief: "A signature is a promise.",
    impulse: "Double-check the paperwork before moving.",
    voice: ["I sign for what I see, not for what I'm told."],
    skills: ["morse-code :: tapping messages on the heating pipes", "tunnel-sense"],
    restrictions: [],
  }],
});

// The one-shot walk's single reply, carrying the same skilled cast.
const WHOLE_SKILLED = JSON.stringify({
  title: "The Signature",
  premise: "A courier must sign for a package that was never in their manifest.",
  tension: WALK_TENSION,
  facts: ["The package carries no return address."],
  characters: [{
    name: "RIVEN",
    persona: "A cautious courier who buys time by asking questions rather than declaring a position.",
    goal: "Hand the package over without signing for what they cannot account for.",
    knows: "The manifest closed at midnight.",
    belief: "A signature is a promise.",
    impulse: "Double-check the paperwork before moving.",
    voice: ["I sign for what I see, not for what I'm told."],
    skills: ["morse-code :: tapping messages on the heating pipes", "tunnel-sense"],
    restrictions: [],
  }],
  scenes: [{ place: "A depot counter.", question: "Will RIVEN sign?", pov: "RIVEN", roster: ["RIVEN"] }],
});

const REFINE_GOAL = JSON.stringify({
  edits: [{ field: "characters.RIVEN.goal", value: "Hand the package over and learn who else signs." }],
});

const BLOCK_WHY = "Nobody here wants anything the others could block.";

function stagedWith(replies: string[], judgeReplies: string[] = ['{"ok":true,"why":""}']) {
  setScaffoldFactory(async ({ idea: got, mode }) => {
    if (mode !== "staged") throw new Error("this helper walks the staged checklist");
    if (got !== WALK_IDEA) throw new Error("the idea reached the session unchanged");
    return new ScaffoldSession(
      new ScriptedAgent(replies), WALK_DEFAULTS, got,
      "unused-stories-dir", "staged", () => new ScriptedAgent([...judgeReplies]), [], 0);
  });
  LIVE.awaitingPick = true;
}

async function startInterview(page: Page, served: number) {
  await arrive(page, served, "#/scaffold");
  await page.locator("#f-idea").fill(WALK_IDEA);
  await page.locator("#iv-start").click();
}

async function approveCast(page: Page) {
  // Direction is open: passing it lands the cast stage and its content.
  await expect(page.locator("#iv-approve")).toContainText("accept the concept");
  await page.locator("#iv-approve").click();
  await expect(page.locator('[data-tid="scaffold.stage"][data-stage="castworld"]')).toHaveClass(/open/);
}

test("a question pins the gate until it is answered", async ({ page, served }) => {
  try {
    stagedWith([ASK_REPLY, STORY_REPLY, CAST_REPLY]);
    await startInterview(page, served);

    // The round asked instead of proposing: the answer field relabels, the
    // approve button disappears, and the draft is unchanged.
    await expect(page.locator(".field-label[for='f-say']")).toHaveText("Your answer");
    await expect(page.locator("#iv-say")).toHaveText("send answer →");
    await expect(page.locator("#iv-approve")).toHaveCount(0);
    await expect(page.locator('[data-tid="scaffold.stage"][data-stage="direction"]')).toHaveClass(/open/);
    await expect(page.locator('[data-tid="scaffold.stage-section"][data-stage="direction"]'))
      .not.toContainText(WALK_TENSION);

    // Answering re-runs the stage: the story lands and the gate can pass.
    await page.locator("#f-say").fill("The courier works for the harbormaster.");
    await page.locator("#iv-say").click();
    await expect(page.locator('[data-tid="scaffold.stage-section"][data-stage="direction"]'))
      .toContainText(WALK_TENSION);
    await expect(page.locator("#iv-approve")).toContainText("accept the concept");
  } finally {
    await abandonWalk(page, served);
  }
});

test("a refused cast reads as a judgement the author can overrule, refine, or outwait", async ({ page, served }) => {
  try {
    stagedWith([STORY_REPLY, CAST_BARE, REFINE_GOAL],
      [`{"ok":false,"why":"${BLOCK_WHY}"}`]);
    await startInterview(page, served);
    await approveCast(page);
    // The fake clock owns the override window from here: it is installed
    // before the blocking approve, so no real 8-second sleep is needed.
    await page.clock.install();
    await page.locator("#iv-approve").click();

    // The refusal whole: a judgement card rather than a red failure line, the
    // stepper's pointer staying on Cast, approve anyway → in warning colour.
    const card = page.locator(".round-note", { hasText: "the cast gate" });
    await expect(card).toBeVisible();
    await expect(card).toContainText(BLOCK_WHY);
    await expect(page.locator(".said.bad")).toHaveCount(0);
    await expect(page.locator('[data-tid="scaffold.stage"][data-stage="castworld"]')).toHaveClass(/open/);
    await expect(page.locator('[data-tid="scaffold.stage"][data-stage="structure"]')).not.toHaveClass(/open/);
    const approve = page.locator("#iv-approve");
    await expect(approve).toHaveText("approve anyway →");
    await expect(approve).toHaveClass(/danger/);

    // Refining instead of overruling lands a round, and the armed override
    // does not carry: the button reverts once the round lands.
    await page.locator("#f-say").fill("Give RIVEN a sharper goal.");
    await page.locator("#iv-say").click();
    await expect(page.locator("#iv-approve")).toContainText("accept the cast");
    await expect(page.locator("#iv-approve")).not.toHaveClass(/danger/);

    // Blocking again arms another 8-second window, and waiting it out passes
    // the gate back: the button expires to its normal self.
    await page.locator("#iv-approve").click();
    await expect(page.locator("#iv-approve")).toHaveText("approve anyway →");
    await page.clock.runFor(8000);
    await expect(page.locator("#iv-approve")).toContainText("accept the cast");
    await expect(page.locator("#iv-approve")).not.toHaveClass(/danger/);
  } finally {
    await abandonWalk(page, served);
  }
});

test("an invented skill offers promote to bible; a bare skill is never offered", async ({ page, served }) => {
  // The candidates card renders at review: reach it in one one-shot proposal
  // carrying the skilled cast, the same shape the accept test walks.
  setScaffoldFactory(async ({ idea: got, mode }) => {
    if (mode !== "oneshot") throw new Error("this test walks the whole story at once");
    return new ScaffoldSession(
      new ScriptedAgent([WHOLE_SKILLED, "{}", "{}"]), WALK_DEFAULTS, got,
      "unused-stories-dir", "oneshot", () => new ScriptedAgent(['{"ok":true,"why":""}']), [], 0);
  });
  LIVE.awaitingPick = true;
  try {
    await arrive(page, served, "#/scaffold");
    await page.locator("#f-idea").fill(WALK_IDEA);
    await page.locator('input[name="mode"][value="oneshot"]').click();
    await page.locator("#iv-start").click();
    await expect(page.locator('[data-tid="scaffold.stage"][data-stage="review"]')).toHaveClass(/open/);

    // The bespoke skill names its meaning and who holds it; the bare skill
    // with no meaning is not a candidate and is never offered.
    const candidates = page.getByTestId("scaffold.bible-candidates");
    await expect(candidates).toBeVisible();
    await expect(candidates).toContainText("morse-code");
    await expect(candidates).toContainText("tapping messages on the heating pipes");
    await expect(candidates).toContainText("RIVEN");
    await expect(candidates).not.toContainText("tunnel-sense");

    // Promoting writes it to the skills catalog and the candidate disappears —
    // re-derived from the cast, so vanishing means the bible really holds it.
    await candidates.getByTestId("scaffold.promote").click();
    await expect(candidates).toHaveCount(0);

    await arrive(page, served, "#/catalog?kind=skills");
    await expect(page.locator(".lib-row", { hasText: "morse-code" })).toHaveCount(1);
  } finally {
    await abandonWalk(page, served);
  }
});

test("the folder step says what is taken before the click", async ({ page, served }) => {
  const raw = JSON.parse(
    await readFile(new URL("../../tests/fixtures/doorway/story.json", import.meta.url), "utf8")) as FixtureStory;
  registerStory("scratch", () => cardFromStory("scratch", raw, "Scratch"));
  try {
    await startOneshot(page, served);
    await page.locator("#iv-accept").click();
    await expect(page.getByTestId("scaffold.folder-card")).toBeVisible();

    // A taken name disables the button as you type, saying so up front.
    await page.locator("#f-folder").fill("scratch");
    await expect(page.locator("#iv-folder-note")).toContainText("already exists");
    await expect(page.locator("#iv-folder")).toBeDisabled();

    // A name that slugifies differently previews where it lands instead.
    await page.locator("#f-folder").fill("Bay 4 — Hatches!");
    await expect(page.locator("#iv-folder-note")).toContainText("data/stories/bay-4-hatches");
    await expect(page.locator("#iv-folder")).toBeEnabled();
  } finally {
    await abandonWalk(page, served);
  }
});
