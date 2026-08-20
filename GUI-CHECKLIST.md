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
- [ ] `npx tsc --noEmit` clean, `npm test` green.
- [ ] Start the app browser-driven — no story argument, or the picker never hands over to the GUI:

```bash
npx tsx story-writer.ts --serve
```

- [ ] Open `http://localhost:8080`.

## Order matters — read this before clicking anything

`MAX_RUNS` is 3, so writing a run destroys the oldest retained one in that story. Where a check below
depends on a *particular* retained run existing, it says so and comes first.

The `unattributed` case in section 1 went this way on 2026-08-20: the last run predating chapter
numbers rotated out, and every run written since carries one. That branch of the grouping is
unreachable in practice and cannot be re-checked live.

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

## 6. Story editor

Open `http://localhost:8080/#/edit?dir=the-final-meal` (or open a story and click **edit story**).

- [ ] **Load.** The editor shows metadata, scenes, characters, facts, config and models sections.
- [ ] **Sections are collapsible.** Metadata and scenes open by default; config, models and facts start closed.
- [ ] **Edit a field.** Change the title. The "unsaved changes" banner appears. The save button becomes enabled.
- [ ] **Server-side validation.** Remove the premise text. After ~400ms the debounced `/story/check` call shows a validation error in both the issues list and the metadata section.
- [ ] **Revert.** Click **revert**. Confirm the dialog. The title goes back to what it was. The "unsaved changes" banner disappears.
- [ ] **Save.** Change the premise, click **save**. The save button briefly shows "saving…" then returns to "save". The "unsaved changes" banner disappears. Reload the page to confirm the edit persisted.
- [ ] **Dirty guard.** With unsaved changes, click **back to story**. A `confirm()` dialog warns about unsaved changes. Cancel stays on the editor; confirm navigates away.
- [ ] **Dirty guard — browser close.** With unsaved changes, close the tab. The browser fires `beforeunload` with a confirmation. (Hard to automate; verify once.)
- [ ] **Scene editor.** Change a scene's question, length, or roster. Verify the value is reflected after save.
- [ ] **Character editor.** Change a character's persona, knows, or goal. Add a skill. Verify after save.
- [ ] **Config editor.** Expand the config section. Change `retries` to 5, save, reload, confirm it stuck.
- [ ] **Models editor.** Expand the models section. Change `default` model, save, reload.
- [ ] **Story facts.** Add a fact, save, reload, confirm it appears.
- [ ] **Architect suggestion.** Expand "Ask the architect". Type a change request, click **suggest**. The button shows "thinking…" then returns results showing applied fields and any problems. *(Requires LM Studio with the architect model loaded.)*
- [ ] **Run-in-flight guard.** Start a run. While it runs, navigate to the editor. Expect: the editor refuses to load with "cannot edit while a run is in flight". Alternately, open a story, start its run, then in another tab open the editor — verify the 409 response.
- [ ] **Malformed story.** Directly open a story directory that has an unparseable `story.json` (modify one manually to be invalid JSON). The editor loads showing the error and the raw content (or `{ ok: false, error, raw }`).
- [ ] **No concurrent edit loss.** Open the editor in two tabs. Edit in tab A, save. Tab B still shows stale data. Reload tab B — it gets the saved version.

## 7. Consult timeline strip

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

## 8. Per-agent model-call panel

Also read-tab only, so no run is needed. Ground truth, to check the numbers against:

```bash
for f in stories/*/out/*/llm/*.jsonl; do echo "$f  $(wc -l < "$f") calls"; done
```

- [ ] Read any run that has an `llm/` folder. A **Model calls** panel appears below the cast, one row
      per agent, each tagged `writer` or `character`.
- [ ] The agents listed, and their call counts, match what the command printed for that run.
- [ ] Open a *character's* transcript. A list of calls appears, one button per call, numbered.
- [ ] Click a call. Its prompt messages and the response appear below, each labelled by role.
- [ ] Click the same call again — it collapses.
- [ ] Now open the **writer's** transcript. This is the volume check: expect tens of calls, and the
      page must stay responsive. Expanding one writer call renders a genuinely large prompt; if the
      tab hangs, the panel is inlining more than one call's worth.
- [ ] Read a *different* run. The panel changes to that run's agents and **no transcript stays open**
      from the previous one.
- [ ] Read a run with an empty `llm/` folder — a run killed before its first generation, if you have
      one. Expect "this run logged no model calls", not an error and not a spinner.

## 9. Live writer screen

Needs a run, so pair it with section 2. What the redesign changed:

- [ ] The page opens with an eyebrow (`chapter N of M · story`), the **scene question as the
      headline**, and a lede. The topbar no longer repeats the question — it reads
      `live chapter · <phase>` instead.
- [ ] The prose sits in a card whose title tracks the phase: *A draft is arriving* while writing,
      *A choice is being checked* during a consult, *The writer wants your call* on a reader round,
      *The step budget is spent* at the budget prompt.
- [ ] The chip row shows words against target, the consult count, and `interactive` / `hands off`.
- [ ] The run controls are in the right-hand rail, not across the top. **Click each one**: pause,
      resume, consult me, the model select, and stop (twice — it arms first). They were relocated as
      elements rather than re-emitted, so if one is dead the relocation broke its wiring.
- [ ] The rail shows phase, steps, words, model, then the bar and counts. Phase tracks what the run is
      doing; model shows the override or `story default`.
- [ ] The status bar reads `<story> · chapter N of M`, agreeing with the terminal's own run header.
- [ ] On the read tab the rail drops phase and model, and there is no headline or prose card — both
      are live-only.
- [ ] **Narrow the window below 900px.** The rail stacks below the prose and stays visible. If it
      vanishes, the only way to stop a run has gone with it.

## 10. The story reader

No run needed, and nothing here destroys one, so this can go anywhere in the pass. `the-final-meal`
story page → **read story**. The button only appears once a story has a written chapter.

- [ ] **It opens.** Every written chapter under its own `chapter N` divider, in numeric order, as
      continuous prose. No run controls, no rail stats, no consult chrome.
- [ ] **It is not on the SSE stream.** Start a run in another tab and leave the reader open. The
      reader must not move — it is static once loaded. (The topbar reads `reading <story>`.)
- [ ] **Deep link.** The address bar reads `#/readstory?dir=…` — check it picked up the `dir`, since
      the hash is written twice, once by `go()` before the story is known and again by `loadReader`.
      Reload the page on that URL: it comes back to the same story's prose, not the shelf.
- [ ] **back** returns to the story page it was opened from, not the shelf.
- [ ] **The saved-run view is untouched.** Open a retained run from the read tab, note which run it
      is, then open the reader and come back. `#/read?dir=&id=` still opens that run, still labelled —
      the reader must not have cleared it.
- [ ] **Empty story.** Open the reader on a story with no written chapters, e.g. by hand at
      `#/readstory?dir=doorway`. Expect *no chapters written yet*, not a blank page or a spinner that
      never stops.
- [ ] **A chapter that will not load.** Temporarily rename one of `stories/the-final-meal/chapters/`'s
      prose files and reopen the reader. That chapter's slot says *could not load*; **the others still
      render**. One bad chapter must not blank the story. Put the file back.
- [ ] **Switching stories.** Open the reader on one story, go back, open it on another: the second
      must never show the first one's prose under the second one's title, not even for a frame. *Needs
      a second story with a written chapter — see the note in section 3; write one first or record
      this as unchecked.*
- [ ] **Narrow the window below 900px.** The prose column reflows and stays readable.

## Checking the viewer without an engine

Most of the above can be checked without LM Studio or a run at all. `server/gui/` is static, and the
viewer handles "no engine attached" — the API calls just 404. Serve the folder on its own port and
open it, and you get the real modules, the real CSS, and the real render path.

From there, the browser console can drive the actual screen, because a dynamic `import()` of a module
the page already loaded returns **the same instance**:

```js
const { APP, LIVEV } = await import('/viewer/state.js');
LIVEV.meta = { story:"stories/doorway", chapter:2, chapters:3, target:700, question:"…", characters:[] };
LIVEV.events = [ /* the same shapes writing-log.jsonl holds */ ];
APP.view = "live"; APP.live = true; APP.render();
```

That renders any state you like — every phase, an empty run, a stopped one — without spending a run to
reach it. It is how sections 6-8 were built, and it is the only way to see a state that needs the
engine to be in a particular mood. It does not replace a live pass: it cannot tell you that SSE
delivers those events, only that the screen draws them correctly once it has them.

## What this list cannot tell you

It exercises the paths a person clicks. It says nothing about the ones they do not: an SSE reconnect
mid-consult, two browsers attached at once, a run stopped at the exact moment a handoff opens. Those
remain unverified in any form.
