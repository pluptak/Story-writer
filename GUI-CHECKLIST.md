# GUI-CHECKLIST

The manual pass for the parts of the GUI no automated test watches. `npm test` covers the engine and
the route modules; **`npm run test:gui` covers the viewer's mechanical half** — boot, a scripted live
run, deep links and modals, the editor's save path, discard, the catalog, the scaffold's concept
fields, and the handoff panel —
in Playwright, driving the real server in-process over a fixture ServerHost, with no LM Studio and
nothing in `stories/` touched. What that suite cannot see — layout, theme, focus, feel, and every
section it does not name — is verified by reading the code and by running this list. Run the suite
and the relevant sections after any change under `server/gui/`, and after any engine change that
alters what a route serves.

## Before you start

- [ ] LM Studio running at `http://localhost:1234/v1`, the story's models loaded.
- [ ] **Context length 16384.** The handoff's opening round resends every written chapter, roughly
      1,100 tokens each. At 10,000 preparing chapter 3 refuses even now that the worked example is
      gone from the handoff prompt.
- [ ] `npx tsc --noEmit` clean, `npm test` green.
- [ ] `npm run test:gui` green. The Playwright suite (`tests/gui/`, `playwright.config.ts`) is the
      automated floor for sections 4, 6, 9, 12 and 15 below, and for section 14's concept fields
      (only those — the walk itself needs the architect) — a new machine needs
      `npx playwright install chromium` once. It is also the boot check the next bullet describes:
      a viewer module that fails to link fails the suite instead of shipping as the bare shell.
- [ ] `npm run lint` clean. Neither of the above touches `server/gui/viewer/*.js` — it's
      browser-loaded, not part of the TS build — so what breaks there ships silently otherwise: a
      plain syntax error (an `await` outside `async` broke every screen on 2026-08-21, `6dc7047`)
      fails ES module linking for the whole viewer, and every page renders as the bare shell with
      nothing in `#page`. ESLint parses all of those modules and resolves names across them, so it
      also catches what the per-file `node --check` it replaced could not see: a name used but never
      imported (`loadStories` in `story-page.js` threw a `ReferenceError` on every chapter discard
      until the first lint run found it), and imports nothing references any more.
- [ ] Start the app browser-driven — no story argument, or the picker never hands over to the GUI:

```bash
npx tsx story-writer.ts --serve
```

- [ ] Open `http://localhost:8080`.

## Locators — how to name what you are looking at

Every meaningful rendered element carries a stable `data-tid="<area>.<component>"` attribute
(`shelf.story-card`, `live.prose-card`, `consult.attempt`), so a bug report can say *where* without
prose. Elements that already have a unique `id=` (editor fields, the handoff's `h-*` buttons) count
as addressed. Instances are told apart by the data-* key beside the tid: `data-seq`, `data-dir`,
`data-chapter`, `data-n`, `data-name`, `data-view`.

Rules for new work:

- A component added under [server/gui/](server/gui/) carries a `data-tid`; build it with the `tid()`
  helper from `util.js`.
- The tid names the **role**, never state or position (`story.write-btn`, not `story.write-btn-green`
  or `story.write-btn2`) — a restyle or reorder must never invalidate a locator.
- The area is the page (`shelf.`, `story.`, `live.`, `read.`, `edit.`, `handoff.`, `scaffold.`,
  `compare.`), chrome (`chrome.`), or a shared component family (`prose.`, `consult.`, `reader.`,
  `reaction.`, `timeline.`, `agents.`, `cast.`, `charcard.`, `runended.`).

In the browser console, `[...document.querySelectorAll("[data-tid]")]` lists everything locatable;
a CSS selector like `[data-tid="prose.consult"][data-seq="3"] .attempt[data-n="1"]` pins one element.

**Locator mode** makes this a click instead of a query: press **ctrl/⌘+shift+L** anywhere (or load a
page with `?locators=1` on its hash — note `syncHash()` drops unknown params on the next navigation,
so that switch is per-load). While on, hovering outlines the nearest tid-bearing ancestor and badges
its locator; clicking copies the full string to the clipboard and swallows the click, so pointing at
a button is never pressing it:

```
#/read?dir=<story>&id=r7 :: prose.consult[seq=3] > consult.attempt[n=2]
```

The chain is built from the tid ancestors outward-in, each with its instance key folded in as
`[key=value]`; with no tid ancestor it falls back to the nearest `#id`. Paste that into a bug report
verbatim — URL plus component path is the whole address. The console escape hatch needs no mode:
`APP.locator(document.activeElement)` returns the path for any element.

**Deep links** make parts of that address reloadable, so the pasted URL alone reopens the exact spot:

- `&block=<seq>` on `#/live` or `#/read` scrolls to and opens that consult once its block exists.
  Clicking a timeline marker writes it; toggling a consult open/close updates or drops it; closing
  it (or leaving live/read) removes it.
- `&modal=character-card:<name>` on any route reopens that character's card as soon as a chip naming
  them is rendered. Opening a card writes it; closing it (×, backdrop, Escape) drops it.

Reload on any such URL: the same spot comes back. That is the check.

## Order matters — read this before clicking anything

`MAX_RUNS` is 10, so writing a run eventually destroys the oldest retained one in that story. Where a
check below depends on a *particular* retained run existing, it says so and comes first.

The `unattributed` case in section 1 went this way on 2026-08-20: the last run predating chapter
numbers rotated out, and every run written since carries one. That branch of the grouping is
unreachable in practice and cannot be re-checked live.

## Pick your stories — do this before section 1

`stories/` is the author's own content and is gitignored, so **this list never names a story**: every
story it once named has since been deleted, taking a third of the pass with it. The checks below
refer to stories by the role they have to play. Find today's cast first:

```bash
for d in stories/*/; do n=$(basename "$d"); echo "$n | scenes=$(node -p "JSON.parse(require('fs').readFileSync('$d/story.json','utf8')).scenes?.length??1") | chapters=[$(ls "$d/chapters" 2>/dev/null | grep -c json)] | runs=$(ls -d "$d"/out/*/ 2>/dev/null | wc -l)"; done
```

- **THE SERIAL** — two or more scenes and at least one written chapter. Sections 2, 4, 5, 9 and 10
  run on it. **A story with two or more *written* chapters is what sections 1 and 5 want**; if none
  exists, section 2 creates one by writing the next chapter, so run section 2 before them.
- **THE SINGLETON** — one scene, two or more retained runs. Section 1's flat-list check needs it.
- **THE BLANK** — no written chapters, for section 10's empty-reader check. If every story on disk
  has one, make a throwaway: copy any `story.json` into `stories/scratch/` and leave it unrun.

Where a check needs more than the role gives it, it says so and offers the skip.

## 1. Runs grouped by chapter — no run needed

Shelf → **THE SERIAL** → the *previous runs* list at the bottom.

Run IDs rotate, so read the truth off disk rather than trusting a list written here:

```bash
for r in stories/<THE SERIAL>/out/*/; do echo -n "$(basename $r) "; grep -o '"chapter":[0-9]*' "$r/writing-log.jsonl" | tail -1; done
```

- [ ] Every run that command prints appears on the page, under a label matching the chapter it printed.
- [ ] Groups are labelled in a left-hand column and ordered by chapter number ascending, matching the
      scene list above them. A run the command shows no chapter for belongs under **unattributed**, last.
- [ ] Clicking any of them still opens the read tab with that run loaded — the grouping nests the
      buttons one level deeper, so this is what proves the wiring survived it.
- [ ] Now open **THE SINGLETON**. **No labels, flat list, exactly as before.** One group is not a
      grouping. A SERIAL whose runs all sit in one chapter reads the same way, so if the grouped
      check above had nothing to group, this one proves nothing either — write a second chapter
      (section 2) and come back.

*If labels are missing everywhere:* `RunSummary.chapter` is not reaching the story card.
*If a single-scene story shows a label:* the one-group flat fallback is wrong.

## 2. Writing the chapter you asked for — the one that matters most

On **THE SERIAL**. Call `W` its last written chapter and `U` the next unwritten one. Both halves of
this section matter: the rewrite confirm needs `W`, and everything after it needs the run to be for
the chapter the click actually named.

- [ ] **A written chapter asks first.** Click **write chapter W**. The click raises a confirm naming
      chapter W as a rewrite. Cancel it: nothing is sent, the shelf stays put.

  Only a confirmed rewrite sends `replace`, and `chapters/` is the durable record, so the run
  refuses to start without it. The refusal is what covers a story list this page read before the
  chapter existed: leave the shelf open, write a chapter from another shell
  (`npx tsx story-writer.ts stories/<story> --chapter=n`), then start that same chapter from the
  still-open page. No confirm is offered — the page does not know it exists — and the run must be
  refused with `chapter n is already written` rather than overwriting it silently.

- [ ] Now click **write chapter U** — unwritten, so no confirm — and let that be the run the rest of
      this section follows.

- [ ] **Check the terminal, not the screen.** The run header must name chapter `U`, not chapter 1.

  If it names the wrong chapter, `data-chapter` is not reaching `/select` and every per-chapter action
  in the viewer is decorative. Nothing else in this list matters until that is fixed.

- [ ] While it runs, from another shell — this is the new `RunMeta`, which is what lets a browser
      attaching cold say which chapter is running:

```bash
curl -s http://localhost:8080/run
```

      The `run` object's `chapter` must be `U`, and `chapters` the story's scene count.

- [ ] Reload the browser mid-run. It reattaches to the running scene rather than showing an idle
      screen.
- [ ] Let it finish. `chapters/U.json` now exists under that story and is a byte-for-byte copy of its
      `story.json`. That snapshot is what section 5 needs, and this run is what gives sections 1 and 5
      a second written chapter to work with.

## 3. Reading accepted prose

Still on **THE SERIAL**, on a written chapter's row.

- [ ] **read** opens the prose inline and the button becomes **close**.
- [ ] **close** collapses it again.
- [ ] Open chapter 1's prose, go back to the shelf, open another story: its chapter rows must not be
      showing chapter 1's text. *Needs a second story with a written chapter; if only one story on
      disk has one, write one first or record this as unchecked.*

## 4. The handoff

**Automated:** the round panel and the two-click accept against a scripted architect
(`tests/gui/handoff.spec.ts`), with no model. The conversation itself, the refusal numbers, and the
drift warning below stay manual.

**THE SERIAL**'s story page → **prepare chapter P**, where `P` is the one after `U`, the chapter
section 2 wrote. (`P` has to be a scene the story does not have yet — that is what the handoff is for.)

- [ ] No "preparing chapter 0" flashes at any point.
- [ ] The opening round completes. If it refuses, the message names both numbers — "this round needs
      about N tokens and <model> is loaded with M" — and the fix is LM Studio's context length, not the
      app. *(To see the worked-example saving for yourself, set the model's context low enough to
      trigger this and compare N against a run of the same story before commit `8f1ea70`.)*
- [ ] **Chapters written.** Under the proposed chapter, expect a `chapters written` list: one
      `✓ ch N · place · NNN words` row per accepted chapter (a brief "counting words…" first while the
      counts fetch), closed by a `· ch P — being prepared` row. The word counts match the prose on
      disk, and the list does not reappear-and-recount on every refinement round.
- [ ] **History guard.** Tell the architect something like *"change scene 1's question to whether the
      cook ever intended to serve it"*. Expect the edit reported as **ignored**, reading
      `scene_1.question — chapter 1 is already written`, and expect the round to still apply everything
      else it proposed. It is an ignored edit, not an error.
- [ ] **Accept.** No stale flash on accept. `story.json` is rewritten, and the story page now shows a
      scene `P` row offering to write chapter `P`.
- [ ] **Discard the unwritten chapter.** On that same scene `P` row (accepted but not yet written), a
      red **discard chapter P** button sits beside **write chapter P**. It appears only on the last
      scene while unwritten — written chapters and any earlier scene have none. Click it, confirm the
      dialog, and the scene `P` row disappears; the row for the last *written* chapter is untouched,
      and **prepare chapter P** can add it back. The button is disabled while a run is in flight.
- [ ] **Try again panel.** Unload the architect's model in LM Studio, then open a handoff. Expect a
      panel offering to retry, not a dead screen. Reload the model afterwards.

## 5. Drift warning — needs section 2 done first

Drift is detected by comparing a chapter's prose against the `chapters/<n>.json` snapshot taken when
it was written, so only chapters that *have* one can be checked. Any chapter written before snapshots
existed stays quiet forever — check `ls stories/<THE SERIAL>/chapters/` and use a chapter that has a
`.json` beside its `.md`. Call it `S` — the chapter section 2 wrote is always one.

- [ ] Hand-edit that story's `story.json`, changing scene `S`'s `question`.
- [ ] Open the handoff. Expect a warning on the panel: `chapter S's prose was written from a different
      scene definition (question)`.
- [ ] A chapter with no `chapters/<n>.json` draws no warning — there is nothing to compare it to.
- [ ] The warning does not block the handoff. Revising your own story is legitimate; the engine says
      so rather than undoing it.
- [ ] Put the question back.

## 6. Story editor

**Automated:** load, an edit saved through the real persist path (asserted on the file), the
empty-premise refusal, and discard of the last unwritten scene from the story page
(`tests/gui/story-edit.spec.ts`). Section collapse states and the suggest panel stay manual.

Open `http://localhost:8080/#/edit?dir=<any story>` (or open a story and click **edit story**).

- [ ] **Load.** The editor shows metadata, scenes, characters, facts, config and models sections.
- [ ] **Sections are collapsible.** Metadata and scenes open by default; config, models and facts start closed.
- [ ] **Edit a field.** Change the title. The "unsaved changes" banner appears. The save button becomes enabled.
- [ ] **Server-side validation.** Remove the premise text. After ~400ms the debounced `/story/check` call shows a validation error in both the issues list and the metadata section.
- [ ] **Revert.** Click **revert**. Confirm the dialog. The title goes back to what it was. The "unsaved changes" banner disappears.
- [ ] **Save.** Change the premise, click **save**. The save button briefly shows "saving…" then returns to "save". The "unsaved changes" banner disappears. Reload the page to confirm the edit persisted.
- [ ] **Dirty guard.** With unsaved changes, click **back to story**. A `confirm()` dialog warns about unsaved changes. Cancel stays on the editor; confirm navigates away.
- [ ] **Dirty guard — browser close.** With unsaved changes, close the tab. The browser fires `beforeunload` with a confirmation. (Hard to automate; verify once.)
- [ ] **Scene editor.** Change a scene's question, length, or roster. Verify the value is reflected after save.
- [ ] **Reach editor.** In a scene's "Reach" textarea, add one line per grant, `NAME: thing :: meaning`
      (e.g. `AURA: cameras :: perceiving through the lobby cameras`). Save, reopen the editor, confirm
      the line survived. Delete the line and save — it is gone. A line with no colon is silently
      dropped from the draft; a name that matches no character warns at load, not here.
- [ ] **Reach survives a handoff.** With a reach grant saved on the next unwritten scene, run a
      chapter, open the handoff, accept it, then reopen the editor: reach on an untouched scene is
      still there, labelled by scene everywhere it shows.
- [ ] **Reach never reads as intrinsic.** Open a cast pill's character card on the live screen (§12)
      for a story whose
      scenes carry reach: each grant appears as its own accent-coloured tag naming its scene
      (`⇢ cameras · scene N`), separate from skills (`+…`) and restrictions (`no …`), and never as a
      `+skill` on the same card.
- [ ] **Character editor.** Change a character's persona, knows, or goal. Set a belief, an impulse, and one or two voice lines (one per line in the voice box). Add a skill. Verify after save.
- [ ] **Character card warnings.** Clear a character's belief, impulse, and voice. After ~400ms `/story/check` shows the three "has no …" warnings; refilling them clears them again.
- [ ] **Config editor.** Expand the config section. Change `retries` to 5, save, reload, confirm it stuck.
- [ ] **Models editor.** Expand the models section. Change `default` model, save, reload.
- [ ] **Story facts.** Add a fact, save, reload, confirm it appears.
- [ ] **Architect suggestion.** Expand "Ask the architect". Type a change request, click **suggest**. The button shows "thinking…" then returns results showing applied fields and any problems, and applied edits land in the form as unsaved changes (Save enabled). *(Requires LM Studio with the architect model loaded.)*
- [ ] **Run-in-flight guard.** Start a run. While it runs, navigate to the editor. Expect: the editor refuses to load with "cannot edit while a run is in flight". Alternately, open a story, start its run, then in another tab open the editor — verify the 409 response.
- [ ] **Loading-window guard.** Pick a story and immediately open the editor in another tab, before the scene starts. Expect a "cannot … while a story is loading" 409, and normal behaviour again once the run is on screen.
- [ ] **Handoff lock.** Open the handoff panel for a story and leave it open. In another tab, try to save from the editor — expect "cannot … while a chapter handoff is open …". Abandon the handoff; the save goes through afterwards.
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

**Automated:** a scripted run — prose pieces, consult blocks with attempt and verdict, note pills,
the end marker, the agent rail, the session bar, header cast chips, and the run-start edge that
pulls the viewer onto the live screen (`tests/gui/live-run.spec.ts`). What needs a real model's
behaviour stays manual.

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

No run needed, and nothing here destroys one, so this can go anywhere in the pass. **THE SERIAL**'s
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
- [ ] **Empty story.** Open the reader on **THE BLANK** by hand at `#/readstory?dir=<THE BLANK>`.
      Expect *no chapters written yet*, not a blank page or a spinner that never stops.
- [ ] **A chapter that will not load.** Temporarily rename one of THE SERIAL's `chapters/*.md` prose
      files and reopen the reader. That chapter's slot says *could not load*; **the others still
      render**. One bad chapter must not blank the story. Put the file back.
- [ ] **Switching stories.** Open the reader on one story, go back, open it on another: the second
      must never show the first one's prose under the second one's title, not even for a frame. *Needs
      a second story with a written chapter — see the note in section 3.*
- [ ] **Narrow the window below 900px.** The prose column reflows and stays readable.

## 11. Story-wide search

In the reader (section 10), using the search box above the prose.

- [ ] **Empty box shows nothing.** No results panel, no "no matches" — just the chapters below.
- [ ] **A word you know is there.** Type it. A match count appears and a hit per matching line, each
      labelled with its chapter and showing the line with every occurrence highlighted.
- [ ] **Case-insensitive.** The same word in a different case finds the same lines.
- [ ] **Jump.** Click a hit. The page scrolls to that chapter's heading, and the heading is not hidden
      under the sticky topbar.
- [ ] **No results.** Type something not in the story. *no matches for "…"* — not a blank panel.
- [ ] **Typing does not refetch.** With the network tab open, type several characters. No `/chapter`
      or `/stories` requests fire — search is over prose already loaded. Focus stays in the box.
- [ ] **Switching stories clears it.** Search for something, go back, open the reader on another
      story: the box is empty and no prior hits remain. *(Needs a second story with a written
      chapter — same note as section 3.)*

## 12. The character card behind a cast pill

**Automated:** the `&modal=` deep link reopening the card with the authored sheet, all three close
paths (×, Escape, backdrop) dropping the param, and the URL sync around them
(`tests/gui/deep-links.spec.ts`). Reach-labelling, the live-only fallback, and unavailability below
stay manual.

Needs a run, so pair it with section 2. The live header's cast pills open a modal; on the live
screen the modal carries the authored sheet, and the rail holds no cast panel of its own.

- [ ] **The pill opens the card.** Click a cast pill in the live header (or focus it and press
      Enter): a modal titled with the character's name opens; Escape, the ×, or a backdrop click
      closes it.
- [ ] **It carries the authored data.** On the live screen the modal shows persona / knows / goal /
      belief / impulse, the quoted voice lines, and the character's `+skill` / `no restriction`
      tags — proof it is the `/cast` fetch, not the
      `scene_start` names. (Pick a story whose characters have a non-empty `knows`.)
- [ ] **Reach shows per scene, labelled.** On a story whose scene carries a `reach` grant, the
      character it names gets an accent-coloured `⇢ name · scene N` tag with a tooltip explaining it
      is available only through where they are standing here — visibly distinct from both `+skill`
      and `no restriction`, never merged into either list.
- [ ] **Read-only.** No inputs, no edit affordances — it is for the human reviewing what a consult
      was working from, never an edit surface.
- [ ] **Live only.** The same pill on the shelf or the read tab opens the card with the pill's own
      can/cannot row only — no authored fields, and no `/cast` fetch fires. The sheet belongs to a
      running scene.
- [ ] **It survives a model swap and a pause** without refetching visibly or losing the fields —
      the sheet is keyed by story, not by run state.
- [ ] **Cast unavailable is graceful.** If `/cast` cannot answer, the card says so in one muted line
      and still shows the pill's can/cannot row. (Force it by loading the live screen with no engine
      behind it, per the section below.)
- [ ] **No duplicate cast panels.** The rail holds run controls and the model-calls panel and
      nothing else — there is no second "cast" section beside the header's "cast in scene".
- [ ] **The boundary holds.** This data is shown to you only. It must never appear in any agent's
      transcript on the per-agent panel (section 8) — the card is a GUI read of already-authored
      data, not anything the writer or a character is ever told.

## 13. Saved-run comparison

Needs two retained runs from the same chapter. Use a story with two completed runs, or create them
before starting this section. The comparison is opened from the story page's **compare runs** action.

- [ ] **Picker.** The comparison screen lists two run selectors, starts with two different runs from
      the same chapter, and displays their run metadata.
- [ ] **Deep link.** Changing either selector updates `#/compare?dir=&a=&b=`; reload the page and verify
      the same story and run choices return.
- [ ] **Same chapter guard.** Select runs from different chapters, if available. The screen refuses
      the selection rather than fetching or comparing it.
- [ ] **Two panes.** After loading, each selected run has its own prose pane, cast, event blocks, and
      model-call panel. A pane never shows events or agents from the other run.
- [ ] **Independent transcripts.** Open a transcript in pane A, then one in pane B. Each pane keeps its
      own open transcript and expanded call.
- [ ] **Word diff.** The accepted prose diff appears above the panes. Unchanged words are plain, added
      words are highlighted, and removed words are struck through.
- [ ] **Diff safety.** A draft containing `<b>markup</b>` displays that text literally, not as HTML.
- [ ] **Empty and failed runs.** A run with no draft prose shows the empty state. If either log fetch
      fails, the comparison shows an error rather than stale content from an earlier selection.
- [ ] **Responsive layout.** Resize below 900px. The panes stack vertically and the diff remains readable.
- [ ] **Single-run regression.** Open a retained run through the ordinary **read** action. It still has
      its original one-pane view and its original shared agent transcript behavior.

## 14. The scaffold interview — the new-story page

The `#/scaffold` route. Most of the layout and state machine can be driven engine-free (see the next
section); the rounds themselves need the architect model. Nothing here destroys a run — accept creates
a *new* story folder — so it can go anywhere in the pass.

- [ ] **Open it.** Shelf → **start a new story**. The idea step is a modal over an empty scaffold
      shell: the idea box, two "how it proposes" radio cards (**stage by stage** selected), the model
      select, and **propose →**. Escape or a backdrop click returns to the shelf. The card now reads
      **continue new story…** — clicking it comes back to the same session.
- [ ] **The concept.** Between the radio cards and the model select sits *the concept* — the tag
      picker (three facet rows, **Genre** / **Dramatic Mode** / **Tone**, filled from the tag
      catalog) and an **opening cast** select. Chips toggle; a chosen chip and a chosen size both
      survive switching to **the whole story at once** and back, because they live in the page's
      draft rather than in the markup. Choosing the one-shot walk removes the whole block: it has
      no story gate for tags to steer and no cast gate for a size to reach. With an empty tag
      catalog the picker is replaced by a link to `#/catalog?kind=tags` — the vocabulary is the
      catalog's alone, and nothing here authors a tag.
- [ ] **Casting from the library.** Under *cast from the library* the catalog's characters appear as
      chips. Picking one **replaces the opening-cast select** with a line saying the imported cast is
      already the size — the tray is the answer, so the number stops being one. A fourth pick
      disables the rest; deselecting brings the select back. An empty character catalog shows a link
      to `#/catalog` instead. Add a character on the catalog page and come back: the chip is there,
      because saving one drops the cached library rather than leaving a stale list.
- [ ] **The imported cast gate is a different gate.** With a tray, approving *story* opens a *cast*
      round that places those people rather than inventing any: the proposal keeps their belief,
      impulse, voice, skills and restrictions exactly as the catalog holds them, fills in `goal` and
      `knows`, and extends each persona with this story's context. **Read the sidebar's flags after
      that round** — if the architect edited a travelling field, the engine reverted it and says so
      there; if it dropped somebody, they are back with a note. Those messages are the contract
      working, not a failure. This needs the architect model, so it belongs to a live pass.
- [ ] **What the concept does, and stops doing.** Once a staged session is open, the sidebar carries
      *tags* and *opening cast* beside *tension*, and **revise concept** opens the same picker
      inline. Each half is marked **· spent** once the stage that reads it has produced content —
      tags at the story stage, cast size at the cast stage — and once all of it is spent the revise
      button disappears rather than going quietly inert. An imported cast reads **· placed** rather
      than *spent*: the tray was not discarded, it became the cast. A tag the catalog does not hold
      shows as an advisory under the stats and is sent to the architect anyway; an imported id the
      catalog no longer holds shows as a second advisory saying it was dropped. **The word "spent"
      is load-bearing:** it is the difference between a control that steers a prompt ahead and one
      that edits a string nobody will read again.
- [ ] **Promoting a skill the cast invented.** When a landed cast holds a bespoke
      `name :: meaning` skill your bible does not have, a **new skills** card appears in the sidebar
      naming it, what it means, and who holds it. **promote to bible** writes it to
      `#/catalog?kind=skills` and the candidate disappears — it is re-derived from the cast, not
      removed by the page, so the only way for it to vanish is for the bible to really hold it now.
      Check the skills catalog afterwards. Two things that should NOT happen: a bare skill with no
      `:: meaning` offered as a candidate, and a scene's `reach` entry offered as one — reach is
      never promotable (I4). **A promoted skill does not appear in the architect's own list until
      the next session**, because the system prompt is sent once; validation accepts it immediately,
      which is the part to check.
- [ ] **Revising after a reload.** Reload the page mid-session and open **revise concept** without
      ever seeing the idea modal. Both pickers must fill. They are fed from the catalog on first
      need, and the load has to be triggered by the panel — not by the picker markup, which only
      exists once the data has arrived. An empty picker here is that circularity coming back.
- [ ] **Staged walk.** After **propose →**, the story stage lands (title, premise, tension, facts — no
      cast yet). Its proposal card immediately shows those fields, and the composer says *what should
      change?*, not *say more about it*. The checklist shows *story* open, the rest upcoming; the sidebar
      reads walk *staged* · open gate *story* · on disk *nothing yet*. **approve & continue →** opens
      *cast*, then *settings*, *technical*, and *scene*, ticking each passed gate. House style and run
      settings appear in a highlighted current-stage section at the top of the proposal as their gates
      land; the earlier stages remain below it. The button is gone at the *scene* gate.
- [ ] **The cast gate can refuse.** Approving *cast* with a cast whose restrictions do not bite on the
      tension (easiest: refine the cast until nobody has a restriction, then approve) comes back as a
      judgement card headed **the cast gate**, not a red failure line — it names what would need a
      restriction and says *approve again to overrule this*. The checklist pointer stays on *cast* and
      no next stage appears. The approve button becomes **approve anyway →** in the warning colour;
      clicking it within 8 seconds passes the gate, and waiting longer than that returns it to
      **approve & continue →**. Refine instead of overruling and the button reverts once the round
      lands, so an armed override never carries to a later gate.
- [ ] **A question pins the gate.** When a round asks instead of proposing, the answer field relabels
      to *your answer* / **send answer →**, the approve button disappears, and the draft is unchanged.
      Answering re-runs that stage.
- [ ] **Refinement stays put.** Type a change and **send**: it applies within the open gate and the
      checklist pointer does not move. Round labels carry the gate (`[cast] changed: …`).
- [ ] **One-shot.** Start again choosing **the whole story at once**. One proposal, **no checklist**,
      sidebar walk *one-shot*.
- [ ] **Edit in full.** The sidebar's **edit in full →** opens the schema editor on the same draft;
      a change there is reflected on the proposal card when you come **back to interview**. Change a
      field there — clear a character's restrictions, say — and **confirm and write** stays enabled:
      the draft the editor validates is a story, not a spec view, and the first edit is what triggers
      the first check. If something ever does invalidate it, the reason renders above the button
      rather than leaving it dead with nothing said.
- [ ] **Accept.** The sidebar's **accept & choose folder** opens the folder step in the main column
      (**write story.json →**). On success the run starts and the page follows to the live screen.
      Accepting over unsent text or a `problems` flag takes a confirming second click.
- [ ] **The folder step says what is taken, before the click.** Type the name of a story that already
      exists: the step says *stories/&lt;slug&gt; already exists — pick another name* and **write
      story.json →** goes disabled, updating as you type without the caret jumping. Type a name that
      slugifies to something different (`Bay 4 — Hatches!`) and it previews *this lands in
      stories/bay-4-hatches* instead. Two stories built from one premise get the same title and so
      the same slug, which is how this is hit in practice.
- [ ] **Abandon** (second click) drops the session and returns to the shelf.
- [ ] **Reload mid-session** on `#/scaffold` lands back in the same session — the state lives on the
      server, not the tab.
- [ ] **Responsive.** Below 900px the sidebar stacks under the proposal; at 375px there is **no
      horizontal scrollbar**.

## 15. Character catalog

**Automated:** character create/list/delete behind the armed confirm, the seeded tag catalog, the
seeded skill bible and a skill created through the real save path, and the kind riding the URL
(`tests/gui/catalog.spec.ts`). The forms' field-level behaviour below stays manual.

The global character library, accessible from the shelf and reloadable by direct navigation to
`#/catalog`. Unlike every other page, the catalog is not scoped to a story.

- [ ] **Entry point.** Shelf → **library of characters** card (under the "start a new story" card).
      It navigates to `#/catalog`.
- [ ] **Empty state.** On a first run with no catalog entries, the page reads as an invitation to add
      one, not as an error or a broken panel. The empty state is clearly distinguished from a failed load.
- [ ] **Load failure.** Break the catalog fetch (or unload the engine). The page shows the failure
      message with a **retry** button.
- [ ] **Issues vs. problems.** A cataloged entry is shown with two **separate, labelled blocks**:
  - `issues` — schema failures or validations that prevent save. The entry is **not saved**. These are
    red/error-coloured.
  - `problems` — advisory warnings (e.g. missing fields that have defaults). The entry **was saved anyway**.
    These are yellow/warning-coloured.
  - The two must never be concatenated or merged into one list. A reader must be able to tell
    "we refused to save this" from "we saved it, but look at this".
- [ ] **Save with draft intact.** Add an entry. Introduce a validation error (e.g. an invalid JSON
      field). Attempt to save. The save is rejected and the error appears in `issues`. The user's
      drafted text stays on screen, not cleared.
- [ ] **Delete takes two clicks.** Click the delete button on an entry. The button arms (changes
      appearance, shows "confirm delete"). A second click within ~8 seconds deletes it. Wait longer
      than ~8 seconds — the button disarms and returns to normal. A second click after disarming does
      not delete.
- [ ] **Armed state does not survive navigation.** Click delete on an entry to arm it. Without
      clicking again, navigate away (back to shelf, to another story, or reload the page). Return to
      `#/catalog`. The delete button is disarmed and the entry is still there — the armed state and
      timer did not persist.
- [ ] **Reload on `#/catalog`.** Close the tab, reopen the browser, and land directly on `#/catalog`
      by pasting the URL. The catalog page comes back, not the shelf.
- [ ] **Switching entries with unsaved edits.** Open an entry and make a change without saving. Click
      another entry. A confirm dialog warns about unsaved changes. Cancel stays on the current entry;
      confirm navigates to the other one.
- [ ] **Switching kinds.** At the top of the catalog, a kind switcher shows four tabs: **characters**,
      **tags**, **styles** and **skills** — one per entry in `CATALOG_KINDS` (`server/gui/viewer/state.js`),
      which is the browser's copy of the engine's list. Clicking any of them switches the list and the
      form to that kind. With unsaved edits in the form, clicking another tab warns with a confirm
      dialog; cancel stays on the current kind, confirm switches and discards the draft.
- [ ] **Tags render grouped by facet.** When browsing tags, the list groups entries under their facet,
      not as one flat list of 24. Each facet has a visible header (`facet`), and tags are listed under
      it. The grouping updates as the list changes.
- [ ] **Editing a tag's label bumps its version and does not change the entry count.** Open a tag entry
      and change its label. Save it. Its version number increments. The total number of tags on the
      page stays the same — the entry is an update, not a new one.
- [ ] **A duplicate facet+label reports the advisory and still saves.** Add a tag entry whose facet and
      label match an existing one. Attempt to save. The save succeeds and the entry appears in the list;
      a problem (yellow-coloured advisory) notes the duplicate. The data is retained.
- [ ] **On a character, tag chips toggle on and off.** On a character's form, the tag picker (or equivalent)
      shows tag chips. Click a chip to toggle it on or off. The character's tag list updates to reflect
      the change. The chips show visually distinct on/off states.
- [ ] **A character carrying a tag that is no longer in the vocabulary still shows it, marked as off-vocabulary.**
      On a character entry that carries a tag no longer in the current tag vocabulary, that tag chip
      displays marked as off-vocabulary (distinct from both selected and unselected, not styled as an error).
      The chip reads as "still here, but not one of the current terms". On save, the tag persists — it is
      not silently lost. The author owns their data, and losing it silently is the failure being guarded against.
- [ ] **Reloading on `#/catalog?kind=tags` lands back on tags.** Reload the page while browsing tags
      at `#/catalog?kind=tags`. The page comes back with tags loaded, not silently switched to characters.

### Styles, the third kind

A style is a reusable writer voice — the half of a house style that travels between stories. The other
half, the clauses a story derives from its POV and its cast's restrictions, is deliberately NOT here.

- [ ] **Every tab round-trips.** Characters and tags still behave exactly as the checks above
      describe — the page was a binary before styles and every per-kind branch had to be widened.
- [ ] **Empty style catalog reads as an invitation.** Styles have no seed, unlike tags. A first run
      shows the create prompt, not a blank panel and not an error.
- [ ] **Create and edit.** A style takes a name, a one-line description, tags (the same chip picker
      the character form uses) and a voice. Saving lists it at v1 with its description under its name;
      editing the voice and saving again makes it v2 without changing the entry count.
- [ ] **A voice carrying a perception rule SAVES, with an advisory.** Put "nothing that is only
      visible" (or "cannot see", "is blind") in a style's voice and save. It saves, and the advisory
      appears in the `.prob` block — NOT as an error. This is the rule the preset/derived split exists
      for: such a clause is load-bearing on the page, and a preset carrying one would take it away the
      moment the author picked a different voice.
- [ ] **An empty name is refused** with `issues` in `.said.bad`, and the description and voice you
      typed are still on screen.
- [ ] **Reloading on `#/catalog?kind=styles` lands back on styles**, with the parameter still in the
      URL — not silently switched to characters.

### Skills, the fourth kind

The persisted special-skill bible. A skill takes a name, a meaning and tags; it takes no voice, no
persona and no restrictions ([`Architect.MD`](Architect.MD)'s *Skill bible* says why restrictions get
no catalog of their own).

- [ ] **The seed is there before anything is saved.** A first run on `#/catalog?kind=skills` lists the
      engine's three special skills — `lockpicking`, `climbing`, `sleight-of-hand` — with their
      meanings. This is the tag behaviour, not the style behaviour: skills seed, styles do not.
- [ ] **The first save materializes the whole seed.** Create one skill and save. The list holds four
      entries, not one — the seed was written out beside the new entry, so every seeded skill is now
      editable and deletable. Delete a seeded one and reload: it stays gone.
- [ ] **The meaning is a paragraph, not a list.** Type a multi-line meaning with blank lines and save.
      It comes back as one block of prose with its line breaks intact — it must not be split into
      separate entries the way a character's voice samples are.
- [ ] **An empty meaning is refused,** in `issues` in `.said.bad`, not reported as an advisory — the
      one field in any kind the schema will not let through. The name you typed is still on screen.
- [ ] **A name that is a general skill saves, with an advisory.** Add a skill called `sight` and save.
      It saves, and the `.prob` block says every character already has it. Same for a name containing
      `::`, and for a second spelling of a name already in the bible (`Sleight of Hand` beside
      `sleight-of-hand`) — all three are advisories, none of them refuse.
- [ ] **The character form stops calling a promoted skill unknown.** Add `telepathy :: reading minds`
      to the bible. Then open a character and give them a bare `telepathy` in their skills with no
      `:: meaning`. The advisory saying it is "not a bible skill, and it carries no `:: meaning`" is
      **gone** — this is the whole point of the kind, and it is the check most likely to regress,
      because it is the only one that crosses from one catalog kind to another.
- [ ] **Reloading on `#/catalog?kind=skills` lands back on skills**, with the parameter still in the
      URL — not silently switched to characters.

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
delivers those events, only that the screen draws them correctly once it has them. `tests/gui/` is
this trick made durable: the harness publishes the same event shapes through the real SSE bus, so
the scripted screens it renders arrive the way a run's do.

## What this list cannot tell you

It exercises the paths a person clicks. It says nothing about the ones they do not: an SSE reconnect
mid-consult, two browsers attached at once, a run stopped at the exact moment a handoff opens. Those
remain unverified in any form. The Playwright suite is one page, one client, one connection — it
shares this blindness exactly, and adds nothing for these.
