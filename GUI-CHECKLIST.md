# GUI-CHECKLIST

The manual pass that stands in for the GUI tests this repo does not have. `npm test` covers the
engine and the route modules; **everything under [server/gui/](server/gui/) is verified by reading it
and by running this list.** Run it after any change under `server/gui/`, and after any engine change
that alters what a route serves.

## Before you start

- [ ] LM Studio running at `http://localhost:1234/v1`, the story's models loaded.
- [ ] **Context length 16384.** The handoff's opening round resends every written chapter, roughly
      1,100 tokens each. At 10,000 preparing chapter 3 refuses even now that the worked example is
      gone from the handoff prompt.
- [ ] `npx tsc --noEmit` clean, `npm test` green (260 at the time of writing).
- [ ] Start the app browser-driven — no story argument, or the picker never hands over to the GUI:

```bash
npx tsx story-writer.ts --serve
```

- [ ] Open `http://localhost:8080`.

## Order matters — read this before clicking anything

`MAX_RUNS` is 3, so writing a run destroys the oldest retained one in that story. Where a check below
depends on a *particular* retained run existing, it says so and comes first.

The `unattributed` case in section 1 is already gone this way: the only run on disk that predated
chapter numbers rotated out on 2026-08-20. Nothing can recreate it — every run written from now on
carries a chapter — so that branch of the grouping is now unreachable in practice and cannot be
re-checked live.

## 1. Runs grouped by chapter — no run needed

Shelf → `the-final-meal` → the *previous runs* list at the bottom.

Run IDs rotate, so read the truth off disk rather than trusting a list written here:

```bash
for r in stories/the-final-meal/out/*/; do echo -n "$(basename $r) "; grep -o '"chapter":[0-9]*' "$r/writing-log.jsonl" | tail -1; done
```

- [ ] Every run that command prints appears on the page, under a label matching the chapter it printed.
- [ ] Groups are labelled in a left-hand column and ordered by chapter number ascending, matching the
      scene list above them. A run the command shows no chapter for belongs under **unattributed**, last.
- [ ] Clicking any of them still opens the read tab with that run loaded — the grouping nests the
      buttons one level deeper, so this is what proves the wiring survived it.
- [ ] Now open a single-scene story (`doorway`, 3 runs, or `three-in-a-cupboard`, 4).
      **No labels, flat list, exactly as before.** One group is not a grouping.

*If labels are missing everywhere:* `RunSummary.chapter` is not reaching the story card.
*If a single-scene story shows a label:* the one-group flat fallback is wrong.

## 2. Writing the chapter you asked for — the one that matters most

On `the-final-meal`, click **write chapter 2** (chapter 2 exists, so this is a rewrite; that is fine,
the point is which chapter the click selects).

- [ ] **Check the terminal, not the screen.** The run header must read `chapter 2 of 2`.

  If it reads `chapter 1 of 2`, `data-chapter` is not reaching `/select` and every per-chapter action
  in the viewer is decorative. Nothing else in this list matters until that is fixed.

- [ ] While it runs, from another shell — this is the new `RunMeta`, which is what lets a browser
      attaching cold say which chapter is running:

```bash
curl -s http://localhost:8080/run
```

      The `run` object must carry `"chapter":2` and `"chapters":2`.

- [ ] Reload the browser mid-run. It reattaches to the running scene rather than showing an idle
      screen.
- [ ] Let it finish. `stories/the-final-meal/chapters/2.json` now exists and is a byte-for-byte copy
      of `stories/the-final-meal/story.json`. That snapshot is what section 5 needs.

## 3. Reading accepted prose

Still on `the-final-meal`, on a written chapter's row.

- [ ] **read** opens the prose inline and the button becomes **close**.
- [ ] **close** collapses it again.
- [ ] Open chapter 1's prose, go back to the shelf, open another story: its chapter rows must not be
      showing chapter 1's text. *This needs a second story with a written chapter — no other story has
      one today, so either write one first or skip this and note it as unchecked.*

## 4. The handoff

`the-final-meal` story page → **prepare chapter 3**.

- [ ] No "preparing chapter 0" flashes at any point.
- [ ] The opening round completes. If it refuses, the message names both numbers — "this round needs
      about N tokens and <model> is loaded with M" — and the fix is LM Studio's context length, not the
      app. *(To see the worked-example saving for yourself, set the model's context low enough to
      trigger this and compare N against a run of the same story before commit `8f1ea70`.)*
- [ ] **History guard.** Tell the architect something like *"change scene 1's question to whether the
      cook ever intended to serve it"*. Expect the edit reported as **ignored**, reading
      `scene_1.question — chapter 1 is already written`, and expect the round to still apply everything
      else it proposed. It is an ignored edit, not an error.
- [ ] **Accept.** No stale flash on accept. `story.json` is rewritten, and the story page now shows a
      scene 3 row offering to write chapter 3.
- [ ] **Try again panel.** Unload the architect's model in LM Studio, then open a handoff. Expect a
      panel offering to retry, not a dead screen. Reload the model afterwards.

## 5. Drift warning — needs section 2 done first

Only chapters written *after* snapshots existed can be checked; `the-final-meal`'s chapter 1 predates
them and must stay quiet forever.

- [ ] Hand-edit `stories/the-final-meal/story.json`, changing scene 2's `question`.
- [ ] Open the handoff. Expect a warning on the panel: `chapter 2's prose was written from a different
      scene definition (question)`.
- [ ] Nothing is said about chapter 1 — it has no `chapters/1.json` to compare against.
- [ ] The warning does not block the handoff. Revising your own story is legitimate; the engine says
      so rather than undoing it.
- [ ] Put the question back.

## 6. Consult timeline strip

The strip lives outside `#page`, above the layout, so most of what can go wrong with it is about
which view it is showing and whether it clears itself.

Cheapest check first — it follows the read tab, so no run is needed:

- [ ] Story page → *previous runs* → read any run that has consults in it. A **consults** strip
      appears above the page with one marker per consult, named for the character.
- [ ] Click a marker. The page scrolls to that consult block **and expands it**. If it scrolls
      nowhere, the marker is finding itself instead of its block — both carry the same `data-seq`.
- [ ] Go back to the shelf. **The strip disappears.** A strip that survives the view change is
      showing you a run you are no longer looking at.
- [ ] Read a different run. The markers change to that run's consults, not the previous one's.
- [ ] A consult that was retried is coloured differently from one that was not, and its tooltip reads
      "N retries".

Then during a live run (section 2 leaves you well placed):

- [ ] Markers appear as consults happen, and clicking one still jumps to its block mid-run.

Capped markers need a story that can hit the ceiling — nothing on disk sets one:

- [ ] Add `"maxCharacterRetries": 1` to a scratch story's `config`, run a chapter, and confirm a
      character that gets retried once comes back marked capped (the `.capped` colour) with "capped"
      in its tooltip. *Skip and note as unchecked if you would rather not spend a run on it.*

## What this list cannot tell you

It exercises the paths a person clicks. It says nothing about the ones they do not: an SSE reconnect
mid-consult, two browsers attached at once, a run stopped at the exact moment a handoff opens. Those
remain unverified in any form.
