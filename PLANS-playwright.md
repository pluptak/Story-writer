# Plans — Playwright against the manual checklist

A single-topic annex to [`PLANS.md`](PLANS.md): what of [`GUI-CHECKLIST.md`](GUI-CHECKLIST.md) the
Playwright suite could take over, in blocks. It follows the same rule as everything in `PLANS.md` —
nothing here is committed work, and when a block ships **the block is deleted from this file**. When
the last block is gone, so is this file.

Shipping a block also takes its checks *out* of `GUI-CHECKLIST.md`: that file holds only work for a
person, so a check the suite now asserts in full is deleted there rather than annotated, and a
section with nothing manual left goes with it. What the suite covers is `tests/gui/`'s business to
say — the checklist does not keep a second copy of that list, which is the mistake its per-section
**Automated:** preambles were making.

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

**The seam, and when not to reach for it.** `setHostOverrides()` (`tests/gui/harness.ts`) answers a
host method for one test. It is read at *call* time, through a proxy on the host the server holds,
because the fixture host is built before the test body runs — an override merged in at build time
could never come from the test that needs it. Use it only where the real method must not run:
`suggestEdits` calls a model. Anything that is a pure function of files on disk — run logs,
transcripts, chapters, snapshots — gets real files in a temp story dir instead, so the test exercises
the engine's own reading of them. That distinction is why the model-call panel needed no seam at all:
the stubs that had been standing in for `runLlmLogs`/`readLlmLog` were removed rather than made
configurable.

## The count

162 checkboxes, down from 188: two sections and eleven boxes left the checklist when the suite came
to hold the whole of what they claimed. Every box below is still work for a person today — the file
carries nothing else — so the split here is about where each one *could* end up, not where it is.

**Mechanizable** means the whole of that box is reachable without a model and without a second
client. A box that is already half-covered counts as mechanizable, because finishing it is what
retires it from the list. This is a per-line judgement: an estimate with a stated method, not a
measurement.

| § | boxes left | mechanizable | stays manual |
| --- | --- | --- | --- |
| 1 runs grouped by chapter | 6 | 6 | — |
| 2 writing the chapter you asked for | 6 | 2 | 4 |
| 3 reading accepted prose | 1 | 1 | — |
| 4 the handoff | 7 | 6 | 1 |
| 5 drift warning | 5 | 4 | 1 |
| 6 story editor | 16 | 13 | 3 |
| 7 live writer screen | 8 | 7 | 1 |
| 8 the story reader | 9 | 9 | — |
| 9 story-wide search | 6 | 6 | — |
| 10 the character card | 9 | 9 | — |
| 11 saved-run comparison | 10 | 10 | — |
| 12 the scaffold interview | 20 | 16 | 4 |
| 13 character catalog | 45 | 42 | 3 |
| locators, shell, without an engine | 14 | 12 | 2 |
| **total** | **162** | **~143** | **~19** |

---

## Blocks

In dependency order. Each is independently pausable and worth shipping on its own.

### Block 6 — failure states, as a class (~10 checks across §8, §10, §11, §13)

Everywhere the checklist says *"unload the model"*, *"stop the engine"* or *"throttle the network"*, it
is testing how the page handles a failed fetch. `page.route` covers the lot: `/cast` unavailable (the
card falls back to the pill's can/cannot row in one muted line); a chapter whose prose will not load
(that slot says *could not load*, **the others still render**); a broken catalog fetch showing its
retry button; a failed visibility write keeping both the draft and the old state; a failed run-log
fetch in compare showing an error rather than stale content from the previous selection.

**Done when** none of those five say "stop the engine".

### Block 7 — §12's scripted gates (~8 checks)

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

**Done when** §12's manual entries are only the four that read a real round's content.

### Block 8 — §5, the drift warning (4 checks)

`sceneDrift` ([`engine/architect.ts`](engine/architect.ts)) compares a chapter's snapshot spec against
the current one; no model produces the warning. A temp story with a `chapters/1.json` whose question
differs, plus a scripted handoff session, asserts the warning names the chapter and the field, that a
chapter with no snapshot draws none, and that the warning does not block accept.

**Done when** §5 is gone from the checklist — "put the question back" included.

### Block 9 — §13's remainder (~28 checks)

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

**Done when** §13's manual entries are the three that need a live assistant model.

### Block 10 — locator mode (~4 checks, no coverage)

The *Locators* section's own mechanism is untested: **ctrl/⌘+shift+L** toggling the mode, `?locators=1`
on a hash being per-load, hovering badging the nearest tid-bearing ancestor, and clicking copying the
full string **and swallowing the click** — pointing at a button must never press it. Needs
`grantPermissions(["clipboard-read"])`; everything else is keyboard and hover.

A second, cheaper test belongs here: crawl each page and assert every `<button>` carries a `data-tid`
or an `id`. That is the rule *Rules for new work* states and nothing enforces.

**Done when** locator mode has a spec and a new un-addressed button fails the suite.

### Block 11 — the width sweep (~6 checks)

Scattered through §7, §8, §11, §12 and the shell, all the same shape: at `<900px` the rail stacks
below the prose **and stays visible** (if it vanishes, the only way to stop a run goes with it); the
compare panes stack; the scaffold sidebar stacks and the stepper rail disappears; the nav becomes a
horizontal strip and hides below 680px; at 375px there is no horizontal scrollbar. `setViewportSize`
plus a `document.documentElement.scrollWidth` assertion covers the last one across every route at
once. §13's automated overflow sweep already does this for the catalog — this generalises it.

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

The thing to watch is not runtime but the fixture surface. Block 8 still wants a small artefact (a
chapter snapshot). The shipped blocks settled where those go: **a builder beside the specs, not a
file under `tests/fixtures/`** — `tests/gui/run-log.ts` turns a description of a run into the
`writing-log.jsonl` and the `llm/*.jsonl` transcripts it would have written, the latter through the
engine's own `llmLogEntry` so the fixture cannot drift from the record the panel reads. The runs
these tests want differ by a field or two each, and near-identical logs on disk would hide the one
line that matters in each. The rule the fixture directory was protecting still holds: not as literals inside a spec file,
or the next person reads a spec to find out what a run looks like.
