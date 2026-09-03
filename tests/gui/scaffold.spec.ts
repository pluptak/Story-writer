/** Block 3 — the architect's three-panel page, driven by a scripted staged session: the stepper
 *  tracks the published gate, the approve button names the gate it passes, and the tension the
 *  story stage coined reaches the right rail as its text — not as a "coined" flag. */
import { arrive, expect, setScaffoldFactory, test } from "./harness.ts";
import { ScaffoldSession } from "../../engine/architect.ts";
import { ScriptedAgent } from "../helpers.ts";
import { LIVE } from "../../live.ts";
import type { Defaults } from "../../engine/story-format.ts";

const SCAFFOLD_DEFAULTS: Defaults = {
  models: { default: "none", architect: "none" },
  thinking: { architect: "low" },
  requestTimeout: 120, attempts: 3, maxTokens: 2000, stream: false, debug: false,
};

const IDEA = "A night courier is asked to sign for a package that was never in their manifest.";
const TENSION = "Getting the receipt and staying unknown may not both be possible.";

// The story stage's reply — its tension is what the right rail must show as text.
const STORY_REPLY = JSON.stringify({
  title: "The Signature",
  premise: "A courier must sign for a package that was never in their manifest.",
  tension: TENSION,
  facts: ["The package carries no return address."],
});

// The cast stage's reply, after one approve. Every field normalizeSpec requires is present.
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

test("the stepper tracks the gate, the approve button names it, and the tension is its text", async ({ page, served }) => {
  setScaffoldFactory(async ({ idea, mode, tags, castSize }) => {
    if (mode !== "staged") throw new Error("this spec walks the staged checklist");
    if (idea !== IDEA) throw new Error("the idea reached the session unchanged");
    if (tags.length || castSize) throw new Error("this spec sends no concept");
    return new ScaffoldSession(
      new ScriptedAgent([STORY_REPLY, CAST_REPLY]), SCAFFOLD_DEFAULTS, idea,
      "unused-stories-dir", "staged",
      () => new ScriptedAgent(['{"ok":true,"why":""}']),   // the cast judge, if it is ever asked
      tags, castSize);
  });
  LIVE.awaitingPick = true;   // /scaffold/start refuses while no pick is pending
  try {
    await arrive(page, served, "#/scaffold");
    await page.locator("#f-idea").fill(IDEA);
    await page.locator("#iv-start").click();   // staged is the modal's own default

    // The story gate opens and coins the tension: its row is the open one, the approve button
    // names the gate it passes, and the rail carries the sentence itself.
    const gate = page.locator('[data-tid="scaffold.gate"][data-gate="story"]');
    await expect(gate).toHaveClass(/open/);
    await expect(page.locator("#iv-approve")).toContainText("accept the concept");
    await expect(page.getByTestId("scaffold.state-card")).toContainText(TENSION);

    // Approve passes the gate: story reads done, cast opens, and the label follows the gate.
    await page.locator("#iv-approve").click();
    await expect(page.locator('[data-tid="scaffold.gate"][data-gate="story"]')).toHaveClass(/done/);
    const cast = page.locator('[data-tid="scaffold.gate"][data-gate="cast"]');
    await expect(cast).toHaveClass(/open/);
    await expect(cast).toContainText("who walks into scene 1.");
    await expect(page.locator("#iv-approve")).toContainText("accept the cast");
  } finally {
    // SCAFFOLD is a module-level singleton (server/scaffold-routes.ts), outliving this test's own
    // server instance -- the next test to reach #/scaffold in this worker would otherwise inherit
    // this session instead of the idea modal.
    await page.request.post(`http://127.0.0.1:${served}/scaffold/abandon`).catch(() => {});
    setScaffoldFactory(null);
    LIVE.awaitingPick = false;
  }
});
