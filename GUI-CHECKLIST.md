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
- [ ] `npm run checkgui` clean. Neither of the above touches `server/gui/viewer/*.js` — it's
      browser-loaded, not part of the TS build — so a plain syntax error there (an `await` outside
      `async` broke every screen on 2026-08-21, `6dc7047`) ships silently otherwise: ES module
      linking fails for the whole viewer and every page renders as the bare shell, nothing in `#page`.
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
a CSS selector like `[data-tid="live.consult"][data-seq="3"] .attempt[data-n="1"]` pins one element.

**Locator mode** makes this a click instead of a query: press **ctrl/⌘+shift+L** anywhere (or load a
page with `?locators=1` on its hash — note `syncHash()` drops unknown params on the next navigation,
so that switch is per-load). While on, hovering outlines the nearest tid-bearing ancestor and badges
its locator; clicking copies the full string to the clipboard and swallows the click, so pointing at
a button is never pressing it:

```
#/read?dir=the-final-meal&id=r7 :: prose.consult[seq=3] > consult.attempt[n=2]
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
- [ ] **Chapters written.** Under the proposed chapter, expect a `chapters written` list: one
      `✓ ch N · place · NNN words` row per accepted chapter (a brief "counting words…" first while the
      counts fetch), closed by a `· ch 3 — being prepared` row. The word counts match the prose on
      disk, and the list does not reappear-and-recount on every refinement round.
- [ ] **History guard.** Tell the architect something like *"change scene 1's question to whether the
      cook ever intended to serve it"*. Expect the edit reported as **ignored**, reading
      `scene_1.question — chapter 1 is already written`, and expect the round to still apply everything
      else it proposed. It is an ignored edit, not an error.
- [ ] **Accept.** No stale flash on accept. `story.json` is rewritten, and the story page now shows a
      scene 3 row offering to write chapter 3.
- [ ] **Discard the unwritten chapter.** On that same scene 3 row (accepted but not yet written), a
      red **discard chapter 3** button sits beside **write chapter 3**. It appears only on the last
      scene while unwritten — written chapters and any earlier scene have none. Click it, confirm the
      dialog, and the scene 3 row disappears; the row for the last *written* chapter is untouched, and
      **prepare chapter 3** can add it back. The button is disabled while a run is in flight.
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
- [ ] **Character editor.** Change a character's persona, knows, or goal. Set a belief, an impulse, and one or two voice lines (one per line in the voice box). Add a skill. Verify after save.
- [ ] **Character card warnings.** Clear a character's belief, impulse, and voice. After ~400ms `/story/check` shows the three "has no …" warnings; refilling them clears them again.
- [ ] **Config editor.** Expand the config section. Change `retries` to 5, save, reload, confirm it stuck.
- [ ] **Models editor.** Expand the models section. Change `default` model, save, reload.
- [ ] **Story facts.** Add a fact, save, reload, confirm it appears.
- [ ] **Architect suggestion.** Expand "Ask the architect". Type a change request, click **suggest**. The button shows "thinking…" then returns results showing applied fields and any problems, and applied edits land in the form as unsaved changes (Save enabled). *(Requires LM Studio with the architect model loaded.)*
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

## 12. Live character sheet

Needs a run, so pair it with section 2. A read-only panel in the live rail.

- [ ] **It appears while a run is live.** Below the rail's stats, a **cast** panel with a card per
      character in the run, each showing persona / knows / goal / belief / impulse / voice samples
      and the character's `+skill` / `no restriction` tags.
- [ ] **It carries authored data the pills do not.** The header cast pills know only skills and
      restrictions; this panel shows `knows`, `goal`, `belief`, `impulse` and the quoted voice lines
      too — proof it is the `/cast` fetch, not the
      `scene_start` names. (Pick a story whose characters have a non-empty `knows`.)
- [ ] **Read-only.** No inputs, no buttons, nothing to click — it is for the human reviewing what a
      consult was working from, never an edit surface.
- [ ] **Live only.** Switch to the read tab: no cast panel there. It belongs to a running scene.
- [ ] **It survives a model swap and a pause** without refetching visibly or vanishing — the panel is
      keyed by story, not by run state.
- [ ] **Cast unavailable is graceful.** If `/cast` cannot answer, the panel reads *could not load
      cast*; the rest of the rail — steps, words, stop — still works. (Force it by loading the live
      screen with no engine behind it, per the section below.)
- [ ] **The boundary holds.** This data is shown to you only. It must never appear in any agent's
      transcript on the per-agent panel (section 8) — the sheet is a GUI read of already-authored
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
- [ ] **Staged walk.** After **propose →**, the story stage lands (title, premise, tension, facts — no
      cast yet). Its proposal card immediately shows those fields, and the composer says *what should
      change?*, not *say more about it*. The checklist shows *story* open, the rest upcoming; the sidebar
      reads walk *staged* · open gate *story* · on disk *nothing yet*. **approve & continue →** opens
      *cast*, then *settings*, *technical*, and *scene*, ticking each passed gate. House style and run
      settings appear in a highlighted current-stage section at the top of the proposal as their gates
      land; the earlier stages remain below it. The button is gone at the *scene* gate.
- [ ] **A question pins the gate.** When a round asks instead of proposing, the answer field relabels
      to *your answer* / **send answer →**, the approve button disappears, and the draft is unchanged.
      Answering re-runs that stage.
- [ ] **Refinement stays put.** Type a change and **send**: it applies within the open gate and the
      checklist pointer does not move. Round labels carry the gate (`[cast] changed: …`).
- [ ] **One-shot.** Start again choosing **the whole story at once**. One proposal, **no checklist**,
      sidebar walk *one-shot*.
- [ ] **Edit in full.** The sidebar's **edit in full →** opens the schema editor on the same draft;
      a change there is reflected on the proposal card when you come **back to interview**.
- [ ] **Accept.** The sidebar's **accept & choose folder** opens the folder step in the main column
      (**write story.json →**). On success the run starts and the page follows to the live screen.
      Accepting over unsent text or a `problems` flag takes a confirming second click.
- [ ] **Abandon** (second click) drops the session and returns to the shelf.
- [ ] **Reload mid-session** on `#/scaffold` lands back in the same session — the state lives on the
      server, not the tab.
- [ ] **Responsive.** Below 900px the sidebar stacks under the proposal; at 375px there is **no
      horizontal scrollbar**.

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
