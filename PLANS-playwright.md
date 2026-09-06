# Plans — Playwright against the manual checklist

A single-topic annex to [`PLANS.md`](PLANS.md): what of [`GUI-CHECKLIST.md`](GUI-CHECKLIST.md) the
Playwright suite could take over, in blocks. It follows the same rule as everything in `PLANS.md` —
nothing here is committed work, and when a block ships, its coverage claim moves into
`GUI-CHECKLIST.md`'s own **Automated:** preamble and **the block is deleted from this file**. When
the last block is gone, so is this file.

**Verification for every block below:** `npm run check`, then `npm run test:gui`. No block here needs
LM Studio or a live run — that is the point of the list.

---

## Where the ceiling actually is

The checklist reads as though the split were *mechanical vs. human*. It is not. `tests/gui/harness.ts`
binds the real server over a fixture host, drives the real SSE bus with `publish()`/`sseWrite()`, and
runs the real persistence against temp copies of the doorway fixture. Against that, the two things
that genuinely stop a check from being automated are:

1. **A real model's behaviour** — the handoff conversation, the cast gate's judgement on a real cast,
   the assistant's phrasing, a malformed reply.
2. **A second client, or a truth that is not on the page** — an SSE reconnect, two browsers attached,
   the terminal's run header, `chapters/<n>.json` on disk.

Everything else — failure states, timers, locks, deep links, layout at a width, "does not refetch",
"does not survive navigation" — is mechanism, and mechanism is what Playwright is for. Several
sections read as *"unload the model in LM Studio"* or *"stop the engine"* where what is actually being
tested is how the page handles a failed fetch, which `page.route(…, r => r.abort())` produces in a
line.

## The count

188 checkboxes. This is a per-line judgement, so treat the numbers as an estimate with a stated
method rather than a measurement — "automatable today" means *no new harness capability, no model*.

| § | boxes | automated | automatable today | needs the seam (Block 2) | stays manual |
| --- | --- | --- | --- | --- | --- |
| 1 runs grouped by chapter | 7 | 2 | 5 | — | — |
| 2 writing the chapter you asked for | 6 | — | 2 | — | 4 |
| 3 reading accepted prose | 3 | 2 | 1 | — | — |
| 4 the handoff | 7 | 2 | 3 | 1 | 1 |
| 5 drift warning | 5 | — | 4 | — | 1 |
| 6 story editor | 23 | 4 | 15 | 1 | 3 |
| 7 consult timeline strip | 7 | 0 | 7 | — | — |
| 8 per-agent model-call panel | 8 | 0 | — | 8 | — |
| 9 live writer screen | 8 | 3 | 4 | — | 1 |
| 10 the story reader | 9 | 3 | 6 | — | — |
| 11 story-wide search | 7 | 2 | 5 | — | — |
| 12 the character card | 9 | 3 | 5 | 1 | — |
| 13 saved-run comparison | 10 | 4 | 4 | 2 | — |
| 14 the scaffold interview | 20 | 4 | 12 | — | 4 |
| 15 character catalog | 45 | ~11 | ~28 | 3 | ~3 |
| locators, shell, without an engine | 14 | — | 12 | — | 2 |
| **total** | **188** | **~40** | **~113** | **~16** | **~19** |

---

## Blocks

In dependency order. Each is independently pausable and worth shipping on its own.

### Block 1 — say what is already covered (docs only)

`GUI-CHECKLIST.md`'s *Before you start* names the suite as the automated floor for "sections 4, 6, 9,
12 and 15, and section 14's concept fields". It is also the floor for parts of **§1 and §3**
(`story-page.spec.ts`), **§10 and §11** (`reader.spec.ts`), **§13** (`compare.spec.ts`) and the
run-ended modal in **§9** (`run-ended.spec.ts`) — none of which carries an **Automated:** preamble.
Someone running the list today re-checks by hand things the suite already fails on.

**Done when** every section with coverage carries an **Automated:** preamble naming its spec file, and
the *Before you start* bullet lists the same set.

### Block 2 — the harness seam: per-test host overrides

`fixtureHost()` hard-codes `runLlmLogs: async () => []`, `readLlmLog: async () => null` and inherits
`suggestEdits` from the real `HOST`, and a test has no way to change any of them: the object is built
inside the `served` fixture. Add `setHostOverrides(partial)` beside the existing
`setScaffoldFactory`/`setHandoffFactory` — same shape, same lifetime, cleared in the fixture — so a
test can supply the few host answers it needs and nothing else.

This is the only new harness capability anything below asks for, and it unlocks §8 whole, §13's
transcripts, §12's boundary check and §6's suggest panel — about 16 checkboxes.

**Done when** a test can hand the fixture host an LLM-log listing and a transcript, and the override
is gone by the next test without that test knowing it existed.

### Block 3 — §7, the consult timeline strip (7 checks, no coverage, needs nothing)

The strip renders entirely off a saved run log, and `timeline.marker` is already a locator. A
hand-written `writing-log.jsonl` with several consults, one retried and one `retry_capped`, covers the
whole section: markers appear named for their character; clicking one scrolls to **and opens** its
block (marker and block share `data-seq` — the bug the checklist warns about is exactly what a naive
implementation reintroduces); the strip disappears on navigating to the shelf; reading a second run
replaces the markers rather than appending; a retried consult is coloured differently and its tooltip
reads "N retries"; a capped one reads capped.

The capped case is the one the checklist calls *"skip and note as unchecked if you would rather not
spend a run on it"* — as a fixture it costs nothing.

**Done when** `tests/gui/timeline.spec.ts` covers all seven and §7 loses its manual entries.

### Block 4 — §8, the per-agent model-call panel (8 checks)

Needs Block 2. With a scripted LLM-log listing and one transcript: the panel lists one row per agent
tagged `writer`/`character` with matching call counts; a call expands to its prompt messages and
response and collapses on a second click; reading a different run swaps the panel **and closes any
open transcript**; a run with an empty `llm/` folder says so rather than spinning.

The volume check ("expect tens of calls, the tab must stay responsive") does not transfer as written —
a fixture of 60 calls proves the panel does not inline them all, which is the actual claim.

**Done when** §8 is an **Automated:** preamble.

### Block 5 — the lock guards and the editor's failure paths (§6, ~8 checks)

`LIVE.running`, `LIVE.loading` and `LIVE.storyLock` are writable from the test process, which turns
§6's three multi-tab manual dances into three assertions with no run and no timing: the run-in-flight
409, the loading-window 409, and the handoff lock refusing a save until the handoff is abandoned.
Beside them, from the same file: a malformed `story.json` in a temp dir loading as error-plus-raw
rather than a blank editor; two pages in one context proving a stale tab stays stale until reloaded;
`page.close({ runBeforeUnload: true })` for the `beforeunload` guard the checklist marks *"hard to
automate; verify once"*; and the reach editor's round trip (`NAME: thing :: meaning` survives save and
reopen, a line with no colon is dropped) asserted against the file.

**Done when** §6's remaining manual entries are the three that need the architect model.

### Block 6 — failure states, as a class (~10 checks across §10, §12, §13, §15)

Everywhere the checklist says *"unload the model"*, *"stop the engine"* or *"throttle the network"*, it
is testing how the page handles a failed fetch. `page.route` covers the lot: `/cast` unavailable (the
card falls back to the pill's can/cannot row in one muted line); a chapter whose prose will not load
(that slot says *could not load*, **the others still render**); a broken catalog fetch showing its
retry button; a failed visibility write keeping both the draft and the old state; a failed run-log
fetch in compare showing an error rather than stale content from the previous selection.

**Done when** none of those five say "stop the engine".

### Block 7 — §14's scripted gates (~8 checks)

These read as *"needs the architect model"* and do not — `ScaffoldSession` takes a `ScriptedAgent` and
a judge factory, which `tests/gui/scaffold.spec.ts` already proves. A reply that asks instead of
proposing covers *a question pins the gate* (field relabels to **send answer →**, approve disappears,
draft unchanged). A cast-judge reply of `{"ok":false,…}` covers the refusal whole: the judgement card
rather than a red failure line, the stepper's pointer staying on *Cast*, **approve anyway →** in the
warning colour, the 8-second window passing the gate and expiring back (`page.clock`), and an armed
override not carrying to a later gate. A bespoke `name :: meaning` skill in the cast reply covers the
**new skills** candidate and **promote to bible** — the harness already has the `promote` hook, and
the negative half (a bare skill with no meaning, and a scene's `reach`, must never be offered) is the
I4 invariant worth a test.

The folder step needs no agent at all: *stories/&lt;slug&gt; already exists* disabling the button as
you type, and `Bay 4 — Hatches!` previewing `stories/bay-4-hatches`.

**Done when** §14's manual entries are only the four that read a real round's content.

### Block 8 — §5, the drift warning (4 checks)

`sceneDrift` ([`engine/architect.ts`](engine/architect.ts)) compares a chapter's snapshot spec against
the current one; no model produces the warning. A temp story with a `chapters/1.json` whose question
differs, plus a scripted handoff session, asserts the warning names the chapter and the field, that a
chapter with no snapshot draws none, and that the warning does not block accept.

**Done when** §5 is an **Automated:** preamble with "put the question back" gone as an instruction.

### Block 9 — §15's remainder (~28 checks)

The largest section, and mostly mechanism: issues and problems as two labelled blocks that are never
merged; a rejected save keeping the drafted text on screen; the delete arm/disarm window (`page.clock`
— the reason it is manual today is that nobody wants an 8-second sleep) and the armed state not
surviving navigation; the unsaved-edit confirm on switching entries and on switching kinds; tags
grouped STORY/STYLE **derived** (add the tag to a style, the row moves by itself); usage counts as
observed counts that climb and fall; a tag's version bumping without changing the entry count; the
duplicate-facet advisory that still saves; off-vocabulary chips persisting on save; hide/restore not
disturbing a draft and absent for kinds whose schema has no `hidden`; the review panel's revert
repainting the field live and its count staying live while typing without the caret jumping; the whole
of the styles and skills subsections, including the cross-kind one the checklist flags as *"the check
most likely to regress"* — a promoted `telepathy` stopping the character form calling it unknown.

Worth splitting in two when picked up: the character form, then styles/skills.

**Done when** §15's manual entries are the three that need a live assistant model.

### Block 10 — locator mode (~4 checks, no coverage)

The *Locators* section's own mechanism is untested: **ctrl/⌘+shift+L** toggling the mode, `?locators=1`
on a hash being per-load, hovering badging the nearest tid-bearing ancestor, and clicking copying the
full string **and swallowing the click** — pointing at a button must never press it. Needs
`grantPermissions(["clipboard-read"])`; everything else is keyboard and hover.

A second, cheaper test belongs here: crawl each page and assert every `<button>` carries a `data-tid`
or an `id`. That is the rule *Rules for new work* states and nothing enforces.

**Done when** locator mode has a spec and a new un-addressed button fails the suite.

### Block 11 — the width sweep (~6 checks)

Scattered through §9, §10, §13, §14 and the shell, all the same shape: at `<900px` the rail stacks
below the prose **and stays visible** (if it vanishes, the only way to stop a run goes with it); the
compare panes stack; the scaffold sidebar stacks and the stepper rail disappears; the nav becomes a
horizontal strip and hides below 680px; at 375px there is no horizontal scrollbar. `setViewportSize`
plus a `document.documentElement.scrollWidth` assertion covers the last one across every route at
once. §15's automated overflow sweep already does this for the catalog — this generalises it.

The nav's *both themes* check is a `data-theme` attribute swap in the same file.

**Done when** every width claim in the checklist is an assertion.

---

## Techniques the suite does not use yet

Named once here so a block above does not have to argue for them:

- **`page.clock`** — every arm/disarm and override window (catalog delete, the cast gate's 8 seconds).
- **`page.route(…, r => r.abort())`** — Block 6 whole.
- **Request counting** (`page.on("request")`) — *typing does not refetch*, *no `/cast` fetch fires off
  the live screen*, *the chapters-written list does not recount every round*. All three are stated as
  network-tab observations.
- **A second page in the same context** — the stale-tab check, and *the reader is not on the SSE
  stream*.
- **`page.close({ runBeforeUnload: true })`** — the `beforeunload` guard.
- **Bounding boxes** — a search jump's heading not hidden under the sticky topbar; the width sweep.
- **Clipboard permissions** — locator mode.

## What stays manual, and why

Kept honest, because a list that claims too much is worse than the manual pass it replaced.

- **A real model's behaviour.** The handoff conversation and its refusal token numbers; the settings
  gate honouring a chosen voice preset; the imported-cast gate preserving travelling fields; the
  assistant against a live model, its "not configured" and "model is down" messages, and a malformed
  reply.
- **Truths that are not on the page.** §2's terminal run header naming chapter `U`, and
  `chapters/U.json` being a byte-for-byte copy — those belong to `npm test`, not here.
- **Transient flashes.** *"No preparing chapter 0 flashes"*, *"not even for a frame"*. Reachable with a
  MutationObserver, and it would be flaky. Leave them.
- **Aesthetic judgement.** *"Reads as an invitation, not an error"*, *"without visually colliding"*.
  A test can assert the empty state is distinguishable from the failure state; it cannot assert it
  reads well.
- **What the checklist's own closing section names** — an SSE reconnect mid-consult, two browsers
  attached at once, a run stopped as a handoff opens. The suite is one page, one client, one
  connection, and shares that blindness exactly.

## Cost

Every block above is deterministic and model-free, so the suite stays a static check: it should keep
running in well under a minute and stay out of `npm run check` for the reason that is already
documented — it needs a browser.

The thing to watch is not runtime but the fixture surface. Blocks 3, 4 and 8 each want a small
hand-written artefact (a writing log, an LLM log, a chapter snapshot). Those belong beside
`tests/fixtures/doorway/` under names that say what they are for, not as literals inside spec files,
or the next person reads a spec to find out what a run looks like.
