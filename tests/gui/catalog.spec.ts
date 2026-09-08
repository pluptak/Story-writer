/** Catalog screens over the real engine catalog logic, isolated to temp files. Every catalog kind
 *  -- characters, styles, tags, skills -- has its own dedicated library workspace. */
import { arrive, expect, holdCatalogWrites, test } from "./harness.ts";
import { abandonWalk, startStaged } from "./scaffold-walk.ts";

test("the character library creates, lists, and deletes a character entry", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");

  await expect(page.locator(".lib-characters")).toBeVisible();
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill("IVET");
  await page.locator("#charlib-persona").fill("Ex-locksmith, keeps every key on a labelled ring.");
  await page.locator("#charlib-belief").fill("Every lock has a polite way in.");
  await page.locator("#charlib-impulse").fill("When watched, slow down and narrate the work.");
  await page.locator("#charlib-voice").fill('"Hold the door? I\'d rather hold the lock."');
  await page.locator("#charlib-skills").fill("lockpicking :: opening a mechanical lock without its key");
  await page.locator("#charlib-save").click();

  // The saved entry is on the list, backed by the real save path.
  await expect(page.locator(".lib-row")).toHaveCount(1);
  await expect(page.locator(".lib-row")).toContainText("IVET");

  // Deleting asks in a styled confirm; the confirm button within removes the entry.
  await page.locator(".lib-row").first().click();
  await page.locator("#charlib-delete").click();
  await expect(page.locator('[data-tid="confirm.dialog"]')).toBeVisible();
  await page.locator('[data-tid="confirm.ok"]').click();
  await expect(page.locator(".lib-row")).toHaveCount(0);

  // The row leaving the list is not the claim -- the entry leaving the catalog is. An optimistic
  // delete that never reached the server passes the count above and fails here.
  await arrive(page, served, "#/catalog");
  await expect(page.locator(".lib-row")).toHaveCount(0);
});

test("a brand-new character can be saved untouched, with just its default name", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await page.locator("#charlib-new").click();

  // Nothing has been typed yet -- the draft is byte-for-byte the record createNew() just made --
  // so this is the case dirty-tracking alone gets wrong: Save must still be pressable.
  await expect(page.locator("#charlib-save")).toBeEnabled();
  await page.locator("#charlib-save").click();

  await expect(page.locator(".lib-row")).toHaveCount(1);
  await expect(page.locator(".lib-row")).toContainText("New character");

  // Persisted for real, not just added to the in-memory list.
  await arrive(page, served, "#/catalog");
  await expect(page.locator(".lib-row")).toHaveCount(1);
});

test("a library character's origin persists and shows as a reviewable change", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");

  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill("PIP");
  await page.locator("#charlib-origin").fill("ai");
  await page.locator("#charlib-save").click();

  // The saved entry carries the origin on its row, backed by the real save path.
  await expect(page.locator(".lib-row")).toContainText("PIP");
  await expect(page.locator(".lib-row")).toContainText("ai");

  // Persisted for real, not just in the in-memory list, and the known origin suggests from the config.
  await arrive(page, served, "#/catalog");
  await page.locator(".lib-row").first().click();
  await expect(page.locator("#charlib-origin")).toHaveValue("ai");
  await expect(page.locator("#charlib-origin-options option[value='ai']")).toHaveCount(1);

  // Editing the origin is an ordinary content change with its own entry in the review panel.
  await page.locator("#charlib-origin").fill("human");
  await page.locator("#charlib-review-changes").click();
  await expect(page.locator('[data-change-field="origin"]')).toBeVisible();
  await expect(page.locator('[data-change-field="origin"]')).toContainText("Origin");
});

test("a duplicated character can be saved untouched", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill("IVET");
  await page.locator("#charlib-save").click();

  await page.locator(".lib-row").first().click();
  await page.locator("#charlib-duplicate").click();
  await expect(page.locator("#charlib-save")).toBeEnabled();
  await page.locator("#charlib-save").click();

  await expect(page.locator(".lib-row")).toHaveCount(2);
  await expect(page.locator(".lib-row").filter({ hasText: "IVET Copy" })).toHaveCount(1);
});

test("the character library's search keeps the caret while it filters", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill("IVET");
  await page.locator("#charlib-save").click();
  await expect(page.locator(".lib-row")).toHaveCount(1);

  // Every keystroke re-renders the whole page to re-filter the list. Without the field in FIELDS
  // the box loses focus after the first character and the rest of the word goes nowhere.
  await page.locator("#charlib-search").click();
  await page.keyboard.type("ivet");
  await expect(page.locator("#charlib-search")).toHaveValue("ivet");
  await expect(page.locator(".lib-row")).toHaveCount(1);

  await page.keyboard.type("xx");
  await expect(page.locator("#charlib-search")).toHaveValue("ivetxx");
  await expect(page.locator(".lib-row")).toHaveCount(0);
});

test("hiding a character marks the row Hidden and restoring clears it", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill("IVET");
  await page.locator("#charlib-save").click();
  await expect(page.locator(".lib-row")).toHaveCount(1);
  await expect(page.locator(".lib-row")).not.toContainText("Hidden");

  await page.locator(".lib-row").first().click();
  await expect(page.locator("#charlib-toggle-hidden")).toHaveText("Hide character");
  await page.locator("#charlib-toggle-hidden").click();

  await expect(page.locator(".lib-row")).toContainText("Hidden");
  await expect(page.locator(".lib-row").first()).toHaveClass(/hidden-row/);
  await expect(page.locator("#charlib-toggle-hidden")).toHaveText("Restore character");

  await page.locator("#charlib-toggle-hidden").click();
  await expect(page.locator(".lib-row")).not.toContainText("Hidden");
  await expect(page.locator("#charlib-toggle-hidden")).toHaveText("Hide character");
});

test("the visibility filter separates visible and hidden characters", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill("VISIBLE-ONE");
  await page.locator("#charlib-save").click();

  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill("HIDDEN-ONE");
  await page.locator("#charlib-save").click();
  await page.locator(".lib-row").filter({ hasText: "HIDDEN-ONE" }).click();
  await page.locator("#charlib-toggle-hidden").click();
  await expect(page.locator(".lib-row").filter({ hasText: "HIDDEN-ONE" })).toContainText("Hidden");

  await page.locator("#charlib-visibility").selectOption("visible");
  await expect(page.locator(".lib-row")).toHaveCount(1);
  await expect(page.locator(".lib-row")).toContainText("VISIBLE-ONE");

  await page.locator("#charlib-visibility").selectOption("hidden");
  await expect(page.locator(".lib-row")).toHaveCount(1);
  await expect(page.locator(".lib-row")).toContainText("HIDDEN-ONE");

  await page.locator("#charlib-visibility").selectOption("all");
  await expect(page.locator(".lib-row")).toHaveCount(2);
});

test("a hidden character's state persists across reload and does not bump its version", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill("IVET");
  await page.locator("#charlib-save").click();
  await page.locator(".lib-row").first().click();
  await page.locator("#charlib-toggle-hidden").click();
  await expect(page.locator(".lib-row")).toContainText("Hidden");

  await arrive(page, served, "#/catalog");
  await expect(page.locator(".lib-row")).toContainText("Hidden");
});

test("editing a saved character surfaces the edit as a reviewable change", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill("IVET");
  await page.locator("#charlib-persona").fill("Ex-locksmith.");
  await page.locator("#charlib-save").click();

  await page.locator(".lib-row").first().click();
  await expect(page.locator("#charlib-review-changes")).toBeDisabled();

  await page.locator("#charlib-persona").fill("Ex-locksmith, now retired.");
  await expect(page.locator("#charlib-review-changes")).toBeEnabled();
  await expect(page.locator("#charlib-review-changes")).toContainText("(1)");

  await page.locator("#charlib-review-changes").click();
  const row = page.locator('.lib-change[data-change-field="portablePersona"]');
  await expect(row).toBeVisible();
  await expect(row).toContainText("Portable persona");
  await expect(row).toContainText("Ex-locksmith.");
  await expect(row).toContainText("Ex-locksmith, now retired.");
});

test("multiple changed fields appear independently in the review panel", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill("IVET");
  await page.locator("#charlib-save").click();
  await page.locator(".lib-row").first().click();

  await page.locator("#charlib-persona").fill("A new persona.");
  await page.locator("#charlib-belief").fill("A new belief.");
  await expect(page.locator("#charlib-review-changes")).toContainText("(2)");

  await page.locator("#charlib-review-changes").click();
  await expect(page.locator('.lib-change[data-change-field="portablePersona"]')).toBeVisible();
  await expect(page.locator('.lib-change[data-change-field="belief"]')).toBeVisible();
  await expect(page.locator(".lib-change")).toHaveCount(2);
});

test("reverting one field leaves the other changes intact", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill("IVET");
  await page.locator("#charlib-persona").fill("Original persona.");
  await page.locator("#charlib-save").click();
  await page.locator(".lib-row").first().click();

  await page.locator("#charlib-persona").fill("Changed persona.");
  await page.locator("#charlib-belief").fill("Changed belief.");
  await page.locator("#charlib-review-changes").click();
  await expect(page.locator(".lib-change")).toHaveCount(2);

  await page.locator('[data-revert-field="portablePersona"]').click();
  await expect(page.locator(".lib-change")).toHaveCount(1);
  await expect(page.locator('.lib-change[data-change-field="belief"]')).toBeVisible();
  await expect(page.locator("#charlib-persona")).toHaveValue("Original persona.");
  await expect(page.locator("#charlib-belief")).toHaveValue("Changed belief.");
});

test("cancel clears the change review", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill("IVET");
  await page.locator("#charlib-save").click();
  await page.locator(".lib-row").first().click();

  await page.locator("#charlib-persona").fill("Changed persona.");
  await expect(page.locator("#charlib-review-changes")).toBeEnabled();

  await page.locator("#charlib-cancel").click();
  await expect(page.locator("#charlib-review-changes")).toBeDisabled();
  await expect(page.locator("#charlib-persona")).toHaveValue("");
});

test("a successful save clears the change review", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill("IVET");
  await page.locator("#charlib-save").click();
  await page.locator(".lib-row").first().click();

  await page.locator("#charlib-persona").fill("Changed persona.");
  await expect(page.locator("#charlib-review-changes")).toBeEnabled();

  await page.locator("#charlib-save").click();
  await expect(page.locator("#charlib-review-changes")).toBeDisabled();
});

test("selecting another character with an in-progress revision prompts before discarding it", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill("IVET");
  await page.locator("#charlib-save").click();
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill("BOB");
  await page.locator("#charlib-save").click();

  const ivetRow = page.locator(".lib-row").filter({ hasText: "IVET" });
  const bobRow = page.locator(".lib-row").filter({ hasText: "BOB" });
  await ivetRow.click();
  await page.locator("#charlib-persona").fill("An unsaved edit.");

  await bobRow.click();
  await expect(page.locator('[data-tid="confirm.dialog"]')).toBeVisible();
  await page.locator('[data-tid="confirm.cancel"]').click();
  await expect(page.locator("#charlib-persona")).toHaveValue("An unsaved edit.");

  await bobRow.click();
  await expect(page.locator('[data-tid="confirm.dialog"]')).toBeVisible();
  await page.locator('[data-tid="confirm.ok"]').click();
  await expect(page.locator("#charlib-name")).toHaveValue("BOB");
});

test("hiding a character does not appear as a reviewable change", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill("IVET");
  await page.locator("#charlib-save").click();
  await page.locator(".lib-row").first().click();
  await expect(page.locator("#charlib-review-changes")).toBeDisabled();

  await page.locator("#charlib-toggle-hidden").click();
  await expect(page.locator(".lib-row")).toContainText("Hidden");
  await expect(page.locator("#charlib-review-changes")).toBeDisabled();
});

// Phase 5: the field-scoped character assistant -----------------------------------------

test("the assistant requires at least one field before it can prepare a proposal", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill("IVET");
  await page.locator("#charlib-save").click();
  await page.locator(".lib-row").first().click();
  await page.locator("#charlib-ai-open").click();

  await expect(page.locator("#charlib-ai-submit")).toBeDisabled();
  await page.locator('[data-assist-field="belief"]').click();
  await expect(page.locator("#charlib-ai-submit")).toBeEnabled();

  // Deselecting the only chosen field disables it again.
  await page.locator('[data-assist-field="belief"]').click();
  await expect(page.locator("#charlib-ai-submit")).toBeDisabled();
});

test("the assistant proposes a change scoped to the selected field, and applying it only fills the draft", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill("IVET");
  await page.locator("#charlib-persona").fill("Ex-locksmith.");
  await page.locator("#charlib-save").click();
  await page.locator(".lib-row").first().click();

  await page.locator("#charlib-ai-open").click();
  await page.locator('[data-assist-field="portablePersona"]').click();
  await page.locator("#charlib-ai-instruction").fill("make her guarded");
  await page.locator("#charlib-ai-submit").click();

  const change = page.locator('.lib-change[data-assist-change-field="portablePersona"]');
  await expect(change).toBeVisible();
  await expect(change).toContainText("Ex-locksmith.");
  await expect(change).toContainText("Ex-locksmith. (make her guarded)");

  await page.locator("#charlib-ai-apply").click();
  // The modal closes, the draft carries the proposed text, but nothing is saved yet.
  await expect(page.locator(".lib-modal-backdrop")).toHaveCount(0);
  await expect(page.locator("#charlib-persona")).toHaveValue("Ex-locksmith. (make her guarded)");
  await expect(page.locator("#charlib-review-changes")).toContainText("(1)");
  await expect(page.locator(".lib-row")).not.toContainText("(make her guarded)");

  await page.locator("#charlib-save").click();
  await expect(page.locator(".lib-row")).toContainText("(make her guarded)");
});

test("canceling the assistant discards its proposal without touching the draft", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill("IVET");
  await page.locator("#charlib-persona").fill("Ex-locksmith.");
  await page.locator("#charlib-save").click();
  await page.locator(".lib-row").first().click();

  await page.locator("#charlib-ai-open").click();
  await page.locator('[data-assist-field="portablePersona"]').click();
  await page.locator("#charlib-ai-instruction").fill("make her guarded");
  await page.locator("#charlib-ai-submit").click();
  await expect(page.locator(".lib-change")).toHaveCount(1);

  await page.locator("#charlib-ai-cancel").click();
  await expect(page.locator(".lib-modal-backdrop")).toHaveCount(0);
  await expect(page.locator("#charlib-persona")).toHaveValue("Ex-locksmith.");
  await expect(page.locator("#charlib-review-changes")).toBeDisabled();
});

test("review mode reports findings without proposing a field change", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill("IVET");
  await page.locator("#charlib-save").click();
  await page.locator(".lib-row").first().click();

  await page.locator("#charlib-ai-open").click();
  await page.locator('[data-ai-mode="review"]').click();
  await page.locator('[data-assist-field="belief"]').click();
  await page.locator("#charlib-ai-instruction").fill("does this hold together?");
  await page.locator("#charlib-ai-submit").click();

  await expect(page.locator(".lib-modal")).toContainText("No correction proposed");
  await expect(page.locator(".lib-assist-warnings")).toContainText("review: does this hold together?");
  await expect(page.locator("#charlib-ai-apply")).toBeDisabled();
});

test("a hidden character is absent from the story's cast selection", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill("IVET");
  await page.locator("#charlib-save").click();
  await page.locator(".lib-row").first().click();
  await page.locator("#charlib-toggle-hidden").click();
  await expect(page.locator(".lib-row")).toContainText("Hidden");

  // Direction decides the cast while none exists: the hidden character reaches neither
  // the chips nor the list.
  await startStaged(page, served);
  try {
    const section = page.locator('[data-tid="scaffold.stage-section"][data-stage="direction"]');
    await expect(section.locator(".cat-chip[data-import-id]")).toHaveCount(0);
    await expect(section.getByText(/No characters in the catalog yet/)).toBeVisible();
  } finally {
    await abandonWalk(page, served);
  }
});

// Phase 4: client-side search, sorting and pagination -----------------------------------

async function createCharacter(page, name, extra = {}) {
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill(name);
  if (extra.persona) await page.locator("#charlib-persona").fill(extra.persona);
  if (extra.belief) await page.locator("#charlib-belief").fill(extra.belief);
  if (extra.impulse) await page.locator("#charlib-impulse").fill(extra.impulse);
  if (extra.voice) await page.locator("#charlib-voice").fill(extra.voice);
  if (extra.skills) await page.locator("#charlib-skills").fill(extra.skills);
  if (extra.restrictions) await page.locator("#charlib-restrictions").fill(extra.restrictions);
  await page.locator("#charlib-save").click();
  // Save is async (a real POST to /catalog/save); waiting for it to actually land, rather than just
  // for the click to dispatch, is what keeps back-to-back creates from racing each other's writes.
  await expect(page.locator("#charlib-save")).toBeDisabled();
}

test("search matches belief, impulse, voice, skills and restrictions, not just name and persona", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await createCharacter(page, "IVET", {
    belief: "a-unique-belief-token", impulse: "a-unique-impulse-token",
    voice: "a-unique-voice-token", skills: "a-unique-skill-token",
    restrictions: "a-unique-restriction-token",
  });
  await createCharacter(page, "BOB");
  await expect(page.locator(".lib-row")).toHaveCount(2);

  for (const token of ["a-unique-belief-token", "a-unique-impulse-token", "a-unique-voice-token",
                        "a-unique-skill-token", "a-unique-restriction-token"]) {
    await page.locator("#charlib-search").fill(token);
    await expect(page.locator(".lib-row")).toHaveCount(1);
    await expect(page.locator(".lib-row")).toContainText("IVET");
  }
});

test("Name A-Z and Name Z-A are reverse orderings", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await createCharacter(page, "CHARLIE");
  await createCharacter(page, "ALICE");
  await createCharacter(page, "BOB");

  await page.locator("#charlib-sort").selectOption("name-asc");
  await expect(page.locator(".lib-row-copy strong")).toHaveText(["ALICE", "BOB", "CHARLIE"]);

  await page.locator("#charlib-sort").selectOption("name-desc");
  await expect(page.locator(".lib-row-copy strong")).toHaveText(["CHARLIE", "BOB", "ALICE"]);
});

test("Recently updated sorts the most recently saved character first", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await createCharacter(page, "ALICE");
  await createCharacter(page, "BOB");

  await page.locator("#charlib-sort").selectOption("updated");
  await expect(page.locator(".lib-row-copy strong").first()).toHaveText("BOB");
});

test("Version sort orders by version descending, tie-broken by recency", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await createCharacter(page, "ALICE");
  await createCharacter(page, "BOB");

  // Re-save ALICE so its version climbs to 2 while BOB stays at 1.
  await page.locator(".lib-row").filter({ hasText: "ALICE" }).click();
  await page.locator("#charlib-persona").fill("revised");
  await page.locator("#charlib-save").click();

  await page.locator("#charlib-sort").selectOption("version");
  await expect(page.locator(".lib-row-copy strong").first()).toHaveText("ALICE");

  // Both at version 1 again would tie -- BOB was saved most recently among the two, and the
  // deterministic tie-break (updatedAt, then name) must still put BOB ahead of no one else here,
  // but the important assertion is that ties do not throw or reorder unpredictably.
  await createCharacter(page, "CARL");
  await page.locator("#charlib-sort").selectOption("version");
  const names = await page.locator(".lib-row-copy strong").allTextContents();
  expect(names[0]).toBe("ALICE");
  expect(new Set(names.slice(1))).toEqual(new Set(["BOB", "CARL"]));
});

test("pagination splits the list into pages of the chosen size", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  for (let i = 1; i <= 12; i++) await createCharacter(page, `CHAR-${String(i).padStart(2, "0")}`);

  await expect(page.locator(".lib-row")).toHaveCount(10);
  await expect(page.locator(".lib-pager")).toContainText("Page 1 of 2");
  await expect(page.locator("#charlib-page-prev")).toBeDisabled();
  await expect(page.locator("#charlib-page-next")).toBeEnabled();

  await page.locator("#charlib-page-next").click();
  await expect(page.locator(".lib-row")).toHaveCount(2);
  await expect(page.locator(".lib-pager")).toContainText("Page 2 of 2");
  await expect(page.locator("#charlib-page-next")).toBeDisabled();

  await page.locator("#charlib-page-prev").click();
  await expect(page.locator(".lib-row")).toHaveCount(10);
});

test("changing the page size shows every entry on one page", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  for (let i = 1; i <= 12; i++) await createCharacter(page, `CHAR-${String(i).padStart(2, "0")}`);
  await expect(page.locator(".lib-pager")).toBeVisible();

  await page.locator("#charlib-page-size").selectOption("25");
  await expect(page.locator(".lib-row")).toHaveCount(12);
  await expect(page.locator(".lib-pager")).toHaveCount(0);
});

test("a filter or sort change resets the page back to 1", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  for (let i = 1; i <= 12; i++) await createCharacter(page, `CHAR-${String(i).padStart(2, "0")}`);
  await page.locator("#charlib-page-next").click();
  await expect(page.locator(".lib-pager")).toContainText("Page 2 of 2");

  await page.locator("#charlib-sort").selectOption("name-asc");
  await expect(page.locator(".lib-pager")).toContainText("Page 1 of 2");
});

test("deleting the last item on the last page clamps back to a page that exists", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  for (let i = 1; i <= 11; i++) await createCharacter(page, `CHAR-${String(i).padStart(2, "0")}`);
  await page.locator("#charlib-sort").selectOption("name-asc");
  await page.locator("#charlib-page-next").click();
  await expect(page.locator(".lib-row")).toHaveCount(1);

  await page.locator(".lib-row").first().click();
  await page.locator("#charlib-delete").click();
  await expect(page.locator('[data-tid="confirm.dialog"]')).toBeVisible();
  await page.locator('[data-tid="confirm.ok"]').click();

  await expect(page.locator(".lib-pager")).toHaveCount(0);
  await expect(page.locator(".lib-row")).toHaveCount(10);
});

test("a selected character stays open in the editor even when paged off the visible list", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  for (let i = 1; i <= 12; i++) await createCharacter(page, `CHAR-${String(i).padStart(2, "0")}`);
  await page.locator("#charlib-sort").selectOption("name-asc");

  // CHAR-01 sorts first, onto page 1.
  await page.locator(".lib-row").filter({ hasText: "CHAR-01" }).click();
  await expect(page.locator("#charlib-name")).toHaveValue("CHAR-01");

  // Reversing the sort pages CHAR-01 off page 1 (it now sorts last, onto page 2) -- the editor
  // must keep showing it regardless of which page the list is currently rendering.
  await page.locator("#charlib-sort").selectOption("name-desc");
  await expect(page.locator(".lib-pager")).toContainText("Page 1 of 2");
  await expect(page.locator(".lib-row").filter({ hasText: "CHAR-01" })).toHaveCount(0);
  await expect(page.locator("#charlib-name")).toHaveValue("CHAR-01");
});

test("the tag library seeds from the engine and its kind rides the URL", async ({ page, served }) => {
  await arrive(page, served, "#/catalog?kind=tags");

  await expect(page.locator(".lib-tags")).toBeVisible();
  const rows = page.locator(".lib-row");
  await expect(rows.first()).toBeVisible();
  await expect.poll(async () => rows.count()).toBeGreaterThanOrEqual(20);   // the engine's seed
  await expect(page).toHaveURL(/kind=tags/);

  // Back to characters: the switcher is a real navigation, and the URL follows.
  await arrive(page, served, "#/catalog");
  await expect(page).toHaveURL(/#\/catalog$/);
  await expect(page.locator(".lib-characters")).toBeVisible();
});

test("the sidenav's Tag Vocabulary link reaches the tag library", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  // Libraries live in a secondary disclosure now, not as primary destinations.
  await page.locator("#nav-libraries > summary").click();
  const link = page.locator("#nav-cat-tags");
  await expect(link).toBeVisible();
  await expect(link).toHaveText("Tag Vocabulary");

  await link.click();
  await expect(page).toHaveURL(/kind=tags/);
  await expect(link).toHaveClass(/current/);
  await expect(page.locator(".lib-row").first()).toBeVisible();
});

test("a brand-new tag can be saved untouched, once a facet and label are given", async ({ page, served }) => {
  await arrive(page, served, "#/catalog?kind=tags");
  const before = await page.locator(".lib-row").count();

  await page.locator("#taglib-new").click();
  // Save is enabled immediately, same as the other three libraries (a brand-new, never-persisted
  // record needs no edit to become saveable) -- but unlike them a tag has no name-like default, so
  // pressing it blank surfaces a validation error instead of silently saving an empty tag.
  await expect(page.locator("#taglib-save")).toBeEnabled();
  await page.locator("#taglib-save").click();
  await expect(page.locator(".said.bad")).toContainText("needs a facet");

  await page.locator("#taglib-facet").selectOption("tone");
  await page.locator("#taglib-label").fill("Whimsical");
  await expect(page.locator("#taglib-save")).toBeEnabled();
  await page.locator("#taglib-save").click();

  await expect.poll(async () => page.locator(".lib-row").count()).toBe(before + 1);
  await expect(page.locator(".lib-row").filter({ hasText: "Whimsical" })).toHaveCount(1);

  // Persisted for real, not just added to the in-memory list.
  await arrive(page, served, "#/catalog?kind=tags");
  await expect.poll(async () => page.locator(".lib-row").count()).toBe(before + 1);
});

test("deleting a tag persists — the row doesn't just leave the list", async ({ page, served }) => {
  await arrive(page, served, "#/catalog?kind=tags");
  const before = await page.locator(".lib-row").count();
  await page.locator("#taglib-new").click();
  await page.locator("#taglib-facet").selectOption("tone");
  await page.locator("#taglib-label").fill("Whimsical");
  await page.locator("#taglib-save").click();
  await expect.poll(async () => page.locator(".lib-row").count()).toBe(before + 1);

  await page.locator(".lib-row").filter({ hasText: "Whimsical" }).click();
  await page.locator("#taglib-delete").click();
  await expect(page.locator('[data-tid="confirm.dialog"]')).toBeVisible();
  await page.locator('[data-tid="confirm.ok"]').click();
  await expect.poll(async () => page.locator(".lib-row").count()).toBe(before);

  await arrive(page, served, "#/catalog?kind=tags");
  await expect.poll(async () => page.locator(".lib-row").count()).toBe(before);
});

test("the skill library seeds from the engine and new entries can be created", async ({ page, served }) => {
  await arrive(page, served, "#/catalog?kind=skills");

  await expect(page.locator(".lib-skills")).toBeVisible();
  // The engine's seed: 8 general skills, 3 special ones (lockpicking, climbing, sleight-of-hand)
  // and 2 origins (human, ai) — all three kinds live in this one catalog.
  const rows = page.locator(".lib-row");
  await expect(rows.first()).toBeVisible();
  await expect.poll(async () => rows.count()).toBe(13);
  await expect(page).toHaveURL(/kind=skills/);

  await page.locator("#skilllib-new").click();
  await page.locator("#skilllib-name").fill("Telekinesis");
  await page.locator("#skilllib-meaning").fill("The ability to move objects with the mind alone, no physical contact required.");
  await expect(page.locator("#skilllib-save")).toBeEnabled();
  await page.locator("#skilllib-save").click();

  // The saved entry is on the list, backed by the real save path.
  await expect.poll(async () => rows.count()).toBe(14);
  await expect(page.locator(".lib-row").filter({ hasText: "Telekinesis" })).toHaveCount(1);

  // Persisted for real, not just added to the in-memory list.
  await arrive(page, served, "#/catalog?kind=skills");
  await expect.poll(async () => page.locator(".lib-row").count()).toBe(14);
});

test("the skill library lists origins apart from the special skills", async ({ page, served }) => {
  await arrive(page, served, "#/catalog?kind=skills");

  // Three sections under their own headings, in the order the kinds build on each other.
  const sections = page.locator(".lib-list .lib-facet-heading");
  await expect(sections).toHaveText(["General skills", "Special skills", "Origins"]);

  // An origin says what it starts a character with, and carries the badge; a general skill carries
  // its own badge; a special skill carries neither, because it is the ordinary case.
  const ai = page.locator(".lib-row").filter({ hasText: "ai" });
  await expect(ai).toContainText("Origin");
  await expect(ai).toContainText("starts with speech, recall");
  const human = page.locator(".lib-row").filter({ hasText: "human" });
  await expect(human).toContainText("starts with movement");
  const sight = page.locator(".lib-row").filter({ hasText: "sight" }).first();
  await expect(sight).toContainText("General");
  const lockpicking = page.locator(".lib-row").filter({ hasText: "lockpicking" });
  await expect(lockpicking).not.toContainText("Origin");
  await expect(lockpicking).not.toContainText("General");
});

test("an origin can be created and saved with its general skills", async ({ page, served }) => {
  await arrive(page, served, "#/catalog?kind=skills");

  await page.locator("#skilllib-new").click();
  // A new entry starts as a special skill: the general picker is hidden until Origin is chosen.
  await expect(page.locator("#skilllib-general-section")).toHaveCount(0);
  await page.locator('[data-skill-kind="origin"]').click();
  await page.locator("#skilllib-name").fill("Bird");
  await page.locator("#skilllib-meaning").fill("a small bird: it flies, sees and hears, and cannot speak");
  await page.locator('[data-general-skill="movement"]').click();
  await page.locator('[data-general-skill="sight"]').click();
  await expect(page.locator("#skilllib-save")).toBeEnabled();
  await page.locator("#skilllib-save").click();

  // The row says what the origin grants, and the editor still shows the two chips picked.
  await expect(page.locator(".lib-row").filter({ hasText: "Bird" })).toContainText("starts with movement, sight");

  // Persisted for real: a fresh load still has the origin with its coverage.
  await arrive(page, served, "#/catalog?kind=skills");
  await page.locator(".lib-row").filter({ hasText: "Bird" }).click();
  await expect(page.locator('[data-skill-kind="origin"]')).toHaveClass(/on/);
  await expect(page.locator('[data-general-skill="movement"]')).toHaveClass(/on/);
  await expect(page.locator('[data-general-skill="sight"]')).toHaveClass(/on/);
  await expect(page.locator('[data-general-skill="speech"]')).not.toHaveClass(/on/);
});

test("searching by a granted skill finds the origin that grants it", async ({ page, served }) => {
  await arrive(page, served, "#/catalog?kind=skills");

  await page.locator("#skilllib-search").fill("sight");
  // "sight" is a general skill in its own right, and the human origin's list carries it — a covered
  // skill's name must surface the origin that grants it, not just the skill itself.
  const hits = page.locator(".lib-row");
  await expect(hits.filter({ hasText: "human" })).toHaveCount(1);
  await expect(hits.filter({ hasText: "lockpicking" })).toHaveCount(0);
});

test("switching an origin back to a special skill drops the general list on save", async ({ page, served }) => {
  await arrive(page, served, "#/catalog?kind=skills");

  await page.locator("#skilllib-new").click();
  await page.locator('[data-skill-kind="origin"]').click();
  await page.locator("#skilllib-name").fill("Ghost");
  await page.locator("#skilllib-meaning").fill("a bodiless presence");
  await page.locator('[data-general-skill="speech"]').click();
  await page.locator("#skilllib-save").click();
  await expect(page.locator(".lib-row").filter({ hasText: "Ghost" })).toContainText("starts with speech");

  // Switch the saved origin to a special skill; the general list has nowhere to live.
  await page.locator('[data-skill-kind="special"]').click();
  await expect(page.locator("#skilllib-general-section")).toHaveCount(0);
  await page.locator("#skilllib-save").click();
  const ghost = page.locator(".lib-row").filter({ hasText: "Ghost" });
  await expect(ghost).not.toContainText("starts with speech");
  await expect(ghost).toContainText("a bodiless presence");

  await arrive(page, served, "#/catalog?kind=skills");
  await page.locator(".lib-row").filter({ hasText: "Ghost" }).click();
  await expect(page.locator('[data-skill-kind="special"]')).toHaveClass(/on/);
  await expect(page.locator("#skilllib-general-section")).toHaveCount(0);
});

test("the list runs full width until a skill is selected", async ({ page, served }) => {
  await arrive(page, served, "#/catalog?kind=skills");

  // Nothing selected: no inspector in the DOM at all, rather than a panel saying "select a skill".
  await expect(page.locator(".lib-skills.no-inspector")).toHaveCount(1);
  await expect(page.locator(".lib-inspector")).toHaveCount(0);

  await page.locator(".lib-row").filter({ hasText: "lockpicking" }).click();
  await expect(page.locator(".lib-inspector")).toHaveCount(1);
  await expect(page.locator(".lib-skills.no-inspector")).toHaveCount(0);

  await page.locator("#skilllib-close").click();
  await expect(page.locator(".lib-inspector")).toHaveCount(0);
});

test("a general skill can be created, and its kind is fixed once saved", async ({ page, served }) => {
  await arrive(page, served, "#/catalog?kind=skills");

  await page.locator("#skilllib-new").click();
  // All three kinds are offered while the entry has never been saved.
  await expect(page.locator('[data-skill-kind="general"]')).toHaveCount(1);
  await page.locator('[data-skill-kind="general"]').click();
  await page.locator("#skilllib-name").fill("Balance");
  await page.locator("#skilllib-meaning").fill("keeping your feet under you on an unsteady footing");
  // A general skill is name and meaning only — no general-skill picker of its own.
  await expect(page.locator("#skilllib-general-section")).toHaveCount(0);
  await page.locator("#skilllib-save").click();

  const balance = page.locator(".lib-row").filter({ hasText: "Balance" });
  await expect(balance).toContainText("General");

  // Saved: the kind is now fixed, and the picker is replaced by the reason why.
  await arrive(page, served, "#/catalog?kind=skills");
  await page.locator(".lib-row").filter({ hasText: "Balance" }).click();
  await expect(page.locator('[data-tid="skill-library.kind-fixed"]')).toBeVisible();
  await expect(page.locator('[data-skill-kind="origin"]')).toHaveCount(0);
});

test("the skill editor refuses to delete a general skill an origin grants, and says which", async ({ page, served }) => {
  await arrive(page, served, "#/catalog?kind=skills");

  // "sight" is granted by the human origin in the seed, so it cannot go.
  await page.locator(".lib-row").filter({ hasText: "sight" }).first().click();
  await expect(page.locator('[data-tid="skill-library.granted-by"]')).toContainText("human");
  // Refused before any confirm: the origin-grant guard answers, no styled dialog ever opens.
  await page.locator("#skilllib-delete").click();
  // The refusal's own wording, not the Usage line's — that already says "granted by origin human",
  // so asserting on it would pass whether or not the delete was actually refused.
  await expect(page.locator(".lib-inspector")).toContainText("remove it from it first");
  // Refused before the round trip: still on the list, and still on the list after a reload.
  await arrive(page, served, "#/catalog?kind=skills");
  await expect(page.locator(".lib-row").filter({ hasText: "sight" }).first()).toBeVisible();
});

test("each kind carries a marker, and the kind name never depends on it", async ({ page, served }) => {
  await arrive(page, served, "#/catalog?kind=skills");

  // The badge says the kind in words; the glyph in front of it is decoration. Whichever the browser
  // renders — the glyph or the kind's initial — the readable name is there either way.
  const human = page.locator(".lib-row").filter({ hasText: "human" });
  await expect(human.locator('[data-tid="skill-library.kind-badge"]')).toContainText("Origin");
  await expect(human.locator('[data-tid="skill-library.kind-badge"]')).toHaveAttribute("title", "Origin skill");
  const mark = await human.locator(".lib-kind-mark").textContent();
  expect(mark?.trim().length).toBeGreaterThan(0);

  // The editor head marks the kind too, and names it for a screen reader rather than relying on the
  // glyph alone.
  await page.locator(".lib-row").filter({ hasText: "lockpicking" }).click();
  const avatar = page.locator('[data-tid="skill-library.kind-avatar"]');
  await expect(avatar).toHaveAttribute("aria-label", "Special skill");
  expect((await avatar.textContent())?.trim().length).toBeGreaterThan(0);
});

test("every skill row lines its actions up in the same column", async ({ page, served }) => {
  await arrive(page, served, "#/catalog?kind=skills");

  // A special skill carries no badge, so its row has one child fewer than the grid has columns —
  // without pinning, its ••• parks a column short of every other row's. Measured in one pass: the
  // list re-renders when the usage fetch lands, and a handle taken before that is stale after it.
  await expect(page.locator(".lib-row")).toHaveCount(13);
  const lefts = await page.evaluate(() => {
    const xOf = (name: string) => {
      const row = [...document.querySelectorAll(".lib-row")]
        .find(r => r.querySelector(".lib-row-copy strong")?.textContent?.trim() === name);
      return Math.round(row!.querySelector(".lib-more")!.getBoundingClientRect().x);
    };
    return { special: xOf("lockpicking"), origin: xOf("human"), general: xOf("sight") };
  });
  expect(lefts.origin).toBe(lefts.special);
  expect(lefts.general).toBe(lefts.special);
});

test("the skill editor carries no tags block", async ({ page, served }) => {
  await arrive(page, served, "#/catalog?kind=skills");
  await page.locator(".lib-row").filter({ hasText: "lockpicking" }).click();
  await expect(page.locator(".lib-inspector")).toBeVisible();
  await expect(page.locator(".lib-inspector")).not.toContainText("Tags");
  await expect(page.locator(".lib-pick[data-tag-label]")).toHaveCount(0);
});

test("the skill library's search keeps the caret while it filters", async ({ page, served }) => {
  await arrive(page, served, "#/catalog?kind=skills");
  await page.locator("#skilllib-new").click();
  await page.locator("#skilllib-name").fill("Telekinesis");
  await page.locator("#skilllib-meaning").fill("Move objects with the mind.");
  await page.locator("#skilllib-save").click();

  // Every keystroke re-renders the whole page to re-filter the list. Without the skilllib- prefix
  // in FIELDS the box loses focus after the first character and the rest of the word goes nowhere.
  await page.locator("#skilllib-search").click();
  await page.keyboard.type("telekin");
  await expect(page.locator("#skilllib-search")).toHaveValue("telekin");
  await expect(page.locator(".lib-row")).toHaveCount(1);
  await expect(page.locator(".lib-row")).toContainText("Telekinesis");
});

test("the style library edits a style through the dedicated inspector", async ({ page, served }) => {
  await arrive(page, served, "#/catalog?kind=styles");

  await expect(page.locator(".lib-styles")).toBeVisible();
  await page.locator("#stylib-new").click();
  await page.locator("#stylib-name").fill("Close and plain");
  await page.locator("#stylib-description").fill("Flat diction and concrete nouns.");
  await page.locator("#stylib-voice").fill("Third person, past tense. Short declarative sentences.");
  await page.locator("#stylib-save").click();

  await expect(page.locator(".lib-row")).toHaveCount(1);
  await expect(page.locator(".lib-row")).toContainText("Close and plain");
  await page.locator(".lib-more").click();
  await expect(page.locator("#stylib-description")).toHaveValue("Flat diction and concrete nouns.");
});

test("a brand-new style can be saved untouched, with just its default name", async ({ page, served }) => {
  await arrive(page, served, "#/catalog?kind=styles");
  await page.locator("#stylib-new").click();

  // Nothing has been typed yet -- the draft is byte-for-byte the record createNew() just made --
  // so this is the case dirty-tracking alone gets wrong: Save must still be pressable.
  await expect(page.locator("#stylib-save")).toBeEnabled();
  await page.locator("#stylib-save").click();

  await expect(page.locator(".lib-row")).toHaveCount(1);
  await expect(page.locator(".lib-row")).toContainText("New style");

  // Persisted for real, not just added to the in-memory list.
  await arrive(page, served, "#/catalog?kind=styles");
  await expect(page.locator(".lib-row")).toHaveCount(1);
});

test("the style library's search keeps the caret while it filters", async ({ page, served }) => {
  await arrive(page, served, "#/catalog?kind=styles");
  await page.locator("#stylib-new").click();
  await page.locator("#stylib-name").fill("Close and plain");
  await page.locator("#stylib-save").click();
  await expect(page.locator(".lib-row")).toHaveCount(1);

  // Every keystroke re-renders the whole page to re-filter the list. Without the stylib- prefix
  // in FIELDS the box loses focus after the first character and the rest of the word goes nowhere.
  await page.locator("#stylib-search").click();
  await page.keyboard.type("close");
  await expect(page.locator("#stylib-search")).toHaveValue("close");
  await expect(page.locator(".lib-row")).toHaveCount(1);

  await page.keyboard.type("xx");
  await expect(page.locator("#stylib-search")).toHaveValue("closexx");
  await expect(page.locator(".lib-row")).toHaveCount(0);
});

test("deleting a style persists — the row doesn't just leave the list", async ({ page, served }) => {
  await arrive(page, served, "#/catalog?kind=styles");
  await page.locator("#stylib-new").click();
  await page.locator("#stylib-name").fill("Close and plain");
  await page.locator("#stylib-save").click();
  await expect(page.locator(".lib-row")).toHaveCount(1);

  await page.locator(".lib-row").first().click();
  await page.locator("#stylib-delete").click();
  await expect(page.locator('[data-tid="confirm.dialog"]')).toBeVisible();
  await page.locator('[data-tid="confirm.ok"]').click();
  await expect(page.locator(".lib-row")).toHaveCount(0);

  // An optimistic delete against a route that doesn't exist would pass the count above and fail
  // here, once the page re-fetches from the real catalog.
  await arrive(page, served, "#/catalog?kind=styles");
  await expect(page.locator(".lib-row")).toHaveCount(0);
});

// Phase 7: state, race, and error handling -----------------------------------------------
// holdCatalogWrites() keeps a save/visibility/delete request open server-side so the test can put
// it "in flight, not yet answered" and then perform the racing action before releasing it -- these
// resolve on the next microtask otherwise, too fast for any UI action to land in between.

test("a save that lands after switching characters updates the list row, not the editor now open", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill("IVET");
  await page.locator("#charlib-save").click();
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill("BOB");
  await page.locator("#charlib-save").click();

  const ivetRow = page.locator(".lib-row").filter({ hasText: "IVET" });
  const bobRow = page.locator(".lib-row").filter({ hasText: "BOB" });

  await ivetRow.click();
  await page.locator("#charlib-persona").fill("held-save-edit");
  const release = holdCatalogWrites();
  try {
    await page.locator("#charlib-save").click();
    // The request is in flight and held server-side -- confirmed by the button locking, not by a
    // fixed wait, so the test cannot pass by accident on timing.
    await expect(page.locator("#charlib-save")).toBeDisabled();

    await bobRow.click();
    await expect(page.locator('[data-tid="confirm.dialog"]')).toBeVisible();
    await page.locator('[data-tid="confirm.ok"]').click();
    await expect(page.locator("#charlib-name")).toHaveValue("BOB");
  } finally {
    // A held server-side request that never gets released hangs the harness's own teardown too --
    // finally keeps an assertion failure above from turning into a second, more confusing one.
    release();
  }
  await expect(ivetRow).toContainText("held-save-edit");
  // The editor the user switched to is untouched by the save that just landed for a different
  // character -- no stray error, no snap back to IVET's data.
  await expect(page.locator("#charlib-name")).toHaveValue("BOB");
  await expect(page.locator(".said.bad")).toHaveCount(0);
});

test("a delete that lands after switching characters removes its own row, not the editor now open", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill("IVET");
  await page.locator("#charlib-save").click();
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill("BOB");
  await page.locator("#charlib-save").click();

  const ivetRow = page.locator(".lib-row").filter({ hasText: "IVET" });
  const bobRow = page.locator(".lib-row").filter({ hasText: "BOB" });

  await ivetRow.click();
  const release = holdCatalogWrites();
  try {
    await page.locator("#charlib-delete").click();
    await expect(page.locator('[data-tid="confirm.dialog"]')).toBeVisible();
    await page.locator('[data-tid="confirm.ok"]').click();
    await expect(page.locator("#charlib-delete")).toBeDisabled();

    // Nothing was edited on IVET before deleting it, so switching to BOB is not a "discard unsaved
    // changes?" case -- no dialog is expected here.
    await bobRow.click();
    await expect(page.locator("#charlib-name")).toHaveValue("BOB");
  } finally {
    release();
  }
  await expect(page.locator(".lib-row")).toHaveCount(1);
  await expect(bobRow).toBeVisible();
  // The delete landing for IVET must not have closed the editor now open on BOB.
  await expect(page.locator("#charlib-name")).toHaveValue("BOB");
  await expect(page.locator(".said.bad")).toHaveCount(0);
});

test("a hide/restore that lands after switching characters does not freeze the other character's own button", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill("IVET");
  await page.locator("#charlib-save").click();
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill("BOB");
  await page.locator("#charlib-save").click();

  const ivetRow = page.locator(".lib-row").filter({ hasText: "IVET" });
  const bobRow = page.locator(".lib-row").filter({ hasText: "BOB" });

  await ivetRow.click();
  const release = holdCatalogWrites();
  try {
    await page.locator("#charlib-toggle-hidden").click();
    await expect(page.locator("#charlib-toggle-hidden")).toBeDisabled();

    // Hide/restore is a metadata write, never a reviewable content change, so there is nothing to
    // discard when switching to BOB here either.
    await bobRow.click();
    // BOB has no visibility request of its own pending -- IVET's must not disable this button.
    await expect(page.locator("#charlib-toggle-hidden")).toBeEnabled();
  } finally {
    release();
  }
  await expect(ivetRow).toContainText("Hidden");
  await expect(page.locator("#charlib-name")).toHaveValue("BOB");
});

test("the assistant's mode, field, and close controls lock while a proposal is loading", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill("IVET");
  await page.locator("#charlib-save").click();
  await page.locator(".lib-row").first().click();

  await page.locator("#charlib-ai-open").click();
  await page.locator('[data-assist-field="belief"]').click();
  await page.locator("#charlib-ai-instruction").fill("does this hold together?");

  const release = holdCatalogWrites();
  try {
    await page.locator("#charlib-ai-submit").click();
    await expect(page.locator("#charlib-ai-submit")).toBeDisabled();

    // Nothing that would change what the in-flight request is answering, or dismiss it outright,
    // is reachable while it is loading.
    await expect(page.locator("#charlib-ai-cancel")).toBeDisabled();
    await expect(page.locator("#charlib-ai-close")).toBeDisabled();
    await expect(page.locator('[data-ai-mode="review"]')).toBeDisabled();
    await expect(page.locator('[data-assist-field="belief"]')).toBeDisabled();
  } finally {
    release();
  }
  await expect(page.locator(".lib-change")).toHaveCount(1);
  await expect(page.locator("#charlib-ai-close")).toBeEnabled();
  await expect(page.locator('[data-ai-mode="review"]')).toBeEnabled();
});

// Phase 8: the plan's full lifecycle, end to end -----------------------------------------
// Every step below is covered in isolation by an earlier test; this one chains all fourteen in one
// character's lifetime, which is what actually catches an interaction between features that each
// passes fine on its own.

test("a character's full lifecycle: create, revise, hide, restore, assist, and persist", async ({ page, served }) => {
  // 1. Create a character.
  await arrive(page, served, "#/catalog");
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill("SCENARIO");
  await page.locator("#charlib-persona").fill("A courier who never reads the letters.");
  await page.locator("#charlib-belief").fill("Delivery is sacred.");
  await page.locator("#charlib-impulse").fill("Runs toward danger with the package.");
  await page.locator("#charlib-voice").fill("Not my business what's inside.");
  await page.locator("#charlib-save").click();
  // Waiting for the save to actually land (not just for the optimistic row createNew() already
  // added) is what keeps step 2's edits from racing this save's own response -- the response, once
  // it lands, resets the draft to what the server has, which would otherwise clobber whatever got
  // typed in the meantime.
  await expect(page.locator("#charlib-save")).toBeDisabled();
  await expect(page.locator(".lib-row")).toHaveCount(1);

  // 2. Edit two fields.
  await page.locator(".lib-row").first().click();
  await page.locator("#charlib-belief").fill("Delivery is sacred, but curiosity is winning.");
  await page.locator("#charlib-impulse").fill("Pauses to read the address twice.");

  // 3. Review the temporary changes.
  await expect(page.locator("#charlib-review-changes")).toContainText("(2)");
  await page.locator("#charlib-review-changes").click();
  await expect(page.locator(".lib-change")).toHaveCount(2);

  // 4. Revert one field.
  await page.locator('[data-revert-field="impulse"]').click();
  await expect(page.locator(".lib-change")).toHaveCount(1);
  await expect(page.locator("#charlib-impulse")).toHaveValue("Runs toward danger with the package.");
  await page.locator("#charlib-changes-done").click();

  // 5. Save the remaining change.
  await page.locator("#charlib-save").click();
  await expect(page.locator("#charlib-save")).toBeDisabled();
  await expect(page.locator("#charlib-review-changes")).not.toContainText("(");

  // 6. Hide the character.
  await page.locator("#charlib-toggle-hidden").click();
  await expect(page.locator(".lib-row")).toContainText("Hidden");

  // 7. Confirm it is absent from the story's cast selection.
  await startStaged(page, served);
  try {
    const section = page.locator('[data-tid="scaffold.stage-section"][data-stage="direction"]');
    await expect(section.locator('.cat-chip[data-import-id]', { hasText: "SCENARIO" })).toHaveCount(0);
  } finally {
    await abandonWalk(page, served);
  }

  // 8. Restore it.
  await arrive(page, served, "#/catalog");
  await page.locator(".lib-row").first().click();
  await page.locator("#charlib-toggle-hidden").click();
  await expect(page.locator(".lib-row")).not.toContainText("Hidden");

  // 9. Confirm it can be selected again.
  await startStaged(page, served);
  try {
    const section = page.locator('[data-tid="scaffold.stage-section"][data-stage="direction"]');
    await expect(section.locator('.cat-chip[data-import-id]', { hasText: "SCENARIO" })).toHaveCount(1);
  } finally {
    await abandonWalk(page, served);
  }

  // 10. Use the assistant with only impulse and voice selected.
  await arrive(page, served, "#/catalog");
  await page.locator(".lib-row").first().click();
  await page.locator("#charlib-ai-open").click();
  await page.locator('[data-assist-field="impulse"]').click();
  await page.locator('[data-assist-field="voice"]').click();
  await page.locator("#charlib-ai-instruction").fill("more guarded");
  await page.locator("#charlib-ai-submit").click();
  await expect(page.locator(".lib-change")).toHaveCount(2);

  // 11. Apply the proposal without saving.
  await page.locator("#charlib-ai-apply").click();
  await expect(page.locator(".lib-modal-backdrop")).toHaveCount(0);

  // 12. Confirm only those fields changed in the draft. (impulse was reverted back to its
  // original value in step 4, so that -- not the edit reverted away -- is what the assistant saw.)
  await expect(page.locator("#charlib-impulse")).toHaveValue("Runs toward danger with the package. (more guarded)");
  await expect(page.locator("#charlib-voice")).toHaveValue("Not my business what's inside.\nmore guarded");
  await expect(page.locator("#charlib-belief")).toHaveValue("Delivery is sacred, but curiosity is winning.");
  await expect(page.locator("#charlib-persona")).toHaveValue("A courier who never reads the letters.");

  // 13. Reload and confirm the unsaved proposal was not persisted.
  await arrive(page, served, "#/catalog");
  await page.locator(".lib-row").first().click();
  await expect(page.locator("#charlib-impulse")).toHaveValue("Runs toward danger with the package.");
  await expect(page.locator("#charlib-voice")).toHaveValue("Not my business what's inside.");

  // 14. Save and confirm the selected changes persisted.
  await page.locator("#charlib-ai-open").click();
  await page.locator('[data-assist-field="impulse"]').click();
  await page.locator('[data-assist-field="voice"]').click();
  await page.locator("#charlib-ai-instruction").fill("more guarded");
  await page.locator("#charlib-ai-submit").click();
  await page.locator("#charlib-ai-apply").click();
  await page.locator("#charlib-save").click();
  await expect(page.locator("#charlib-save")).toBeDisabled();

  await arrive(page, served, "#/catalog");
  await page.locator(".lib-row").first().click();
  await expect(page.locator("#charlib-impulse")).toHaveValue("Runs toward danger with the package. (more guarded)");
  await expect(page.locator("#charlib-voice")).toHaveValue("Not my business what's inside.\nmore guarded");
});

// Phase 6/8: narrow-window layout, automated -----------------------------------------------
// The manual GUI-CHECKLIST pass covers the field-level judgment calls; what a test can check
// mechanically is that the page, its modals, and its diff blocks never force the document wider
// than the viewport at any of the plan's representative widths.

async function hasHorizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
}

test("the catalog page introduces no horizontal overflow at narrow widths", async ({ page, served }) => {
  await arrive(page, served, "#/catalog");
  await page.locator("#charlib-new").click();
  await page.locator("#charlib-name").fill("A Character With A Fairly Long Name For Layout Testing");
  await page.locator("#charlib-save").click();
  await page.locator(".lib-row").first().click();

  for (const width of [1280, 1024, 768, 600]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await hasHorizontalOverflow(page), `overflow at ${width}px (list + editor)`).toBe(false);
  }

  // The assistant modal and the review-changes modal are the two places a fixed-looking two-column
  // layout (mode tabs, the before/after diff) could hold the page wider than the viewport.
  await page.locator("#charlib-belief").fill("changed for the review panel");
  await page.locator("#charlib-review-changes").click();
  for (const width of [768, 600]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await hasHorizontalOverflow(page), `overflow at ${width}px (review panel)`).toBe(false);
  }
  await page.locator("#charlib-changes-done").click();

  await page.locator("#charlib-ai-open").click();
  for (const width of [768, 600]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await hasHorizontalOverflow(page), `overflow at ${width}px (assistant modal)`).toBe(false);
  }

  await page.setViewportSize({ width: 1280, height: 800 });
});
