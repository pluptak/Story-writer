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

104 checkboxes, down from 188: three sections and sixty-nine boxes have left the checklist as
the suite came to hold the whole of what they claimed. Every box below is still work for a person
today — the file carries nothing else — so the split here is about where each one *could* end
up, not where it is.

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
| 6 story editor | 16 | 13 | 3 |
| 7 live writer screen | 7 | 6 | 1 |
| 8 the story reader | 7 | 7 | — |
| 9 story-wide search | 5 | 5 | — |
| 10 the character card | 8 | 8 | — |
| 11 saved-run comparison | 9 | 9 | — |
| 12 the scaffold interview | 15 | 11 | 4 |
| 13 character catalog | 4 | — | 4 |
| locators, shell, without an engine | 13 | 11 | 2 |
| **total** | **104** | **~85** | **~19** |

---

## Blocks

In dependency order. Each is independently pausable and worth shipping on its own.

*No blocks remain — the last one shipped with its spec, and per the file's own rule it is deleted
rather than annotated. When the checklist's last manual box goes, so does this file.*

---

## Techniques the suite does not use yet

Named once here so a block above does not have to argue for them:

- **Request counting** (`page.on("request")`) — *typing does not refetch*, *no `/cast` fetch fires off
  the live screen*, *the chapters-written list does not recount every round*. All three are stated as
  network-tab observations.
- **A second page in the same context** — the stale-tab check, and *the reader is not on the SSE
  stream*.
- **`page.close({ runBeforeUnload: true })`** — the `beforeunload` guard.

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

The thing to watch is not runtime but the fixture surface. The shipped blocks settled where
those go: **a builder beside the specs, not a file under `tests/fixtures/`** — `tests/gui/run-log.ts` turns a description of a run into the
`writing-log.jsonl` and the `llm/*.jsonl` transcripts it would have written, the latter through the
engine's own `llmLogEntry` so the fixture cannot drift from the record the panel reads. The runs
these tests want differ by a field or two each, and near-identical logs on disk would hide the one
line that matters in each. The rule the fixture directory was protecting still holds: not as literals inside a spec file,
or the next person reads a spec to find out what a run looks like.
