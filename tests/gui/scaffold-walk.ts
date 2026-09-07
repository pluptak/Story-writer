/** Shared driver for Architect stage-progression GUI tests: start a scripted staged (or
 *  one-shot) interview through the real ServerHost, approve gate to gate, and abandon cleanly.
 *  SCAFFOLD is a module-level singleton outliving any one test's server instance, so every walk
 *  ends with abandonWalk() in a finally. */
import { arrive, expect, setScaffoldFactory } from "./harness.ts";
import { ScaffoldSession } from "../../engine/architect.ts";
import { ScriptedAgent } from "../helpers.ts";
import { LIVE } from "../../live.ts";
import type { Defaults } from "../../engine/story-format.ts";
import type { Page } from "@playwright/test";

export const WALK_DEFAULTS: Defaults = {
  models: { default: "none", architect: "none", assistant: "none" },
  thinking: { architect: "low", assistant: "low" },
  requestTimeout: 120, attempts: 3, maxTokens: 2000, stream: false, debug: false,
};

export const WALK_IDEA = "A night courier is asked to sign for a package that was never in their manifest.";
export const WALK_TENSION = "Getting the receipt and staying unknown may not both be possible.";

// The story stage's reply — coins the tension the direction stage must show as text.
export const STORY_REPLY = JSON.stringify({
  title: "The Signature",
  premise: "A courier must sign for a package that was never in their manifest.",
  tension: WALK_TENSION,
  facts: ["The package carries no return address."],
});

// The cast stage's reply. Every field normalizeSpec requires is present.
export const CAST_REPLY = JSON.stringify({
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

// The one-shot walk's single reply: direction, cast and structure at once.
export const WHOLE_REPLY = JSON.stringify({
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
    skills: [], restrictions: [],
  }],
  scenes: [{ place: "A depot counter.", question: "Will RIVEN sign?", pov: "RIVEN", roster: ["RIVEN"] }],
});

const judgeStub = () => new ScriptedAgent(['{"ok":true,"why":""}']);

/** Start a scripted staged interview and wait for the direction stage to open. */
export async function startStaged(page: Page, served: number,
    replies: string[] = [STORY_REPLY, CAST_REPLY], idea: string = WALK_IDEA) {
  setScaffoldFactory(async ({ idea: got, mode }) => {
    if (mode !== "staged") throw new Error("this helper walks the staged checklist");
    if (got !== idea) throw new Error("the idea reached the session unchanged");
    return new ScaffoldSession(
      new ScriptedAgent(replies), WALK_DEFAULTS, got,
      "unused-stories-dir", "staged", judgeStub, [], 0);
  });
  LIVE.awaitingPick = true;   // /scaffold/start refuses while no pick is pending
  await arrive(page, served, "#/scaffold");
  await page.locator("#f-idea").fill(idea);
  await page.locator("#iv-start").click();   // staged is the modal's own default
  await expect(page.locator('[data-tid="scaffold.stage"][data-stage="direction"]')).toHaveClass(/open/);
}

/** Start a scripted one-shot interview and wait for its review stage to open. The proposal is
 *  followed by the two automatic passes, which answer "nothing" here. */
export async function startOneshot(page: Page, served: number,
    replies: string[] = [WHOLE_REPLY, "{}", "{}"], idea: string = WALK_IDEA) {
  setScaffoldFactory(async ({ idea: got, mode }) => {
    if (mode !== "oneshot") throw new Error("this helper walks the one-shot walk");
    if (got !== idea) throw new Error("the idea reached the session unchanged");
    return new ScaffoldSession(
      new ScriptedAgent(replies), WALK_DEFAULTS, got,
      "unused-stories-dir", "oneshot", judgeStub, [], 0);
  });
  LIVE.awaitingPick = true;
  await arrive(page, served, "#/scaffold");
  await page.locator("#f-idea").fill(idea);
  await page.locator('input[name="mode"][value="oneshot"]').click();
  await page.locator("#iv-start").click();
  await expect(page.locator('[data-tid="scaffold.stage"][data-stage="review"]')).toHaveClass(/open/);
}

/** Approve the open gate and wait for the given stage to open. */
export async function approveTo(page: Page, stage: string) {
  await page.locator("#iv-approve").click();
  await expect(page.locator(`[data-tid="scaffold.stage"][data-stage="${stage}"]`)).toHaveClass(/open/);
}

/** Abandon the walk and restore the refusal, so the next test inherits the idea modal. */
export async function abandonWalk(page: Page, served: number) {
  await page.request.post(`http://127.0.0.1:${served}/scaffold/abandon`).catch(() => {});
  setScaffoldFactory(null);
  LIVE.awaitingPick = false;
}
