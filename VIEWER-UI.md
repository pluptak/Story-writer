# VIEWER UI — what the page shows

The browser half of the viewer ([gui/viewer.js](gui/viewer.js)). What the controls *do to a run*, and
every route they post to, is [GUI-SPEC.md](GUI-SPEC.md); this file is what you read when the page
looks wrong.

## Pages and navigation

Three pages, one file, no build step, no framework router — just a hash and a `view` variable that
picks which of three render functions fills `#page`.

| page | hash | shown when | is |
|---|---|---|---|
| **story** | `#/shelf` | the session is parked waiting for a pick (`session.picking`) | the shelf: story cards, `new story…`, the interview modal, the play confirmation |
| **run** | `#/live` | always offered while an engine is attached | the scene itself — prose, consults, the rail, the run controls |
| **saved runs** | `#/read` | always offered | a story's retained runs, or a dropped/opened `writing-log.jsonl` |

**The shelf tab only exists while picking.** It is not a page you navigate to so much as a page the
session parks you on — there is nothing to choose outside that window, so showing the tab the rest of
the time would be an invitation to a 400. **Both other tabs are hidden entirely when no engine is
attached** (`live === false` — a `file://` load, a plain static host, or `?src=` mode): the run page
has nothing to show and the shelf has no session to pick for, so only **saved runs** — the one page
that never needed a server behind it — is offered.

**Auto-switching happens on edges only**, never on every `run_state` frame that merely repeats
something already true — VIEWER-UI's own [rendering traps](#rendering) below list why a frame that
fires several times a run must not carry a side effect that only makes sense the first time:

- picking starts (`false → true`) → the shelf.
- a run starts (`run_reset`, or `running: false → true`) → the run page.

Anything else leaves `view` exactly where the user put it. A page you deliberately navigated to must
not get yanked out from under you by a frame that arrives for reasons that have nothing to do with
where you are looking.

**Navigation locks to the run page while a scene is actively generating** (`running && !paused`) —
the tabs disable, with a tooltip naming why, and a drag-drop or `open a saved log` while locked is
refused the same way. Leaving always means a deliberate pause or stop first, never an accidental page
flip mid-sentence; pausing (GUI-SPEC §4.4) unlocks navigation without touching the run.

**The hash survives a reload**, via `history.replaceState` rather than `location.hash =`, so normal
navigation never fires a synthetic `hashchange` for the page's own transitions to chase. A `#/read`
hash that already carries `?dir=&id=` for a specific saved run keeps that query string across a
reload — the path is only ever replaced when it names a *different* page than the one about to render,
so a bookmarked or reloaded deep link lands back on the same run rather than the bare browser.

## Rendering

Events are flat and ordered; the page is not. `build()` groups a `consult` and everything it produced
— clarifications, repairs, retries, the answer, the verdict — into **one foldable block**. A retry
arrives as another `consult` with `attempt > 1`, so it joins the block it belongs to rather than
starting a new one. That grouping is the whole renderer; everything else is presentation.

- **Prose** blocks render as paragraphs in a serif reading column. A `salvaged` draft is marked, so a
  piece that arrived through truncation recovery is never silently indistinguishable. Two consecutive
  drafts are separated like the paragraphs they are — a seam tighter than the paragraphs inside one
  draft is backwards on a page whose whole point is that the scene reads straight down.
- **A consult**, collapsed, is a rule across the page carrying the character's name, the question, and
  tags for what is worth knowing without opening it: `asked back`, `N retry`, `flagged`. **Opened**,
  each attempt shows the situation given, the question, any clarification exchange, any notes (forced
  answer, repair, skill flag), the answer, and the verdict. Attempt 2+ is labelled *"fresh instance,
  no memory of the last"* — that is the whole point of the retry design, and the viewer should say so
  rather than leaving it as trivia in a spec.
- **A reader consult** renders as its own block, not a collapsed one — it is a question aimed at you,
  not a record to fold away. Pending, it shows the framing, a button per option, and a free-text box;
  answered, it collapses to the framing and what was chosen. It is **scrolled to** when it arrives,
  and its buttons disable on the click that answers it: the run is blocked on you at that moment,
  reading further up the scene is the normal thing to be doing when it appears, and a question nobody
  scrolls to is a run that looks hung. One answer per consult — a second click is not a second choice.
  On the **saved runs** page a still-pending one renders with no buttons at all — there is no live loop
  on the other end of `POST /reader-answer` for a saved log's questions to reach, so it shows as a fact
  about how the run went (*"left unanswered in this run"*) rather than as a live control that would 400.
- **A model swap** renders as a plain note in the gap where it happened, like `bad_consult` and
  `budget` — a fact about how the rest of the scene was produced, not a whole block.
- **The rail** carries progress and the counts that indicate trouble: retries amber, skill flags red.

**Re-render is whole, debounced on a timer.** A scene is a few dozen events; rebuilding is far cheaper
than keeping incremental DOM state correct across retries and late-arriving verdicts. Open consults
are remembered by `seq` across renders, and the view sticks to the bottom only if it was already near
it. The chosen **theme is kept** across reloads, which a page watched across reconnects otherwise
forgets every time.

Five traps, all found by driving a real stopped run or a real page split, all of which a rewrite would
fall into again:

- **A timer, not `requestAnimationFrame`.** rAF does not fire in a hidden or non-compositing tab, so a
  run watched in a background tab stopped updating entirely — and because the handle latched in
  `pending`, nothing rescheduled either.
- **Events are de-duplicated by `seq`.** `/events` replays the whole run before attaching and
  `EventSource` reconnects itself after any blip, so without this the page grew by one whole scene per
  reconnect, which reads as a story that will not close. `seq` is stamped once by `publish()`, so it
  is the event's identity in both the log and the stream.
- **`run_state` always re-renders**, not only when `picking` changes value. Rendering on a state
  *edge* is one missed transition away from a page with no route back to the shelf; these frames
  arrive a handful of times per run, so rendering on all of them costs nothing.
- **One event store per page, not one shared between them.** `LIVEV` and `READV` each keep their own
  `events`/`seen`/`meta` ([Pages and navigation](#pages-and-navigation)) precisely because a single
  shared store used to mean that opening a past run's log overwrote the live scene's own copy of the
  data — reading something finished silently destroyed the view of something still being written.
- **Auto-switching a page is an edge, not a level.** The same `run_state`/`run_reset` frames that must
  always re-render (above) must *not* always renavigate — `wasPicking`/`wasRunning` are compared
  against the incoming frame precisely so a page you chose on purpose survives every frame that
  repeats a fact you already knew.

## Control states

**The run controls only render on the run page**, and hide there too while nothing is running, rather
than sitting disabled — the idle run page belongs to whatever prose is already on it, and three greyed
buttons on the shelf or the saved-run browser would be furniture that also lies about what they act
on. What each one *does* is [GUI-SPEC.md](GUI-SPEC.md#4-ending-a-run-early); this is only how it
presents.

| control | run-page-only | live-only | extra state |
|---|---|---|---|
| **stop** | yes | yes | **a second, confirming click** — the same deliberate-second-press rule the scaffolder uses for accepting over a complaint (SPEC-S §4.2); disarms after four seconds |
| **consult me** | yes | yes | disabled and relabelled while the one it just armed is still pending |
| **pause** | yes | yes | a third label for the request-vs-effective gap: *"pause" → "pausing…" → "resume"* |
| **model dropdown** | yes | no — idle is exactly when it picks what the next run loads with | disabled whenever the run is going and not paused: enabled exactly when a choice would do something, never when it would 400 |
| **interactive** | yes | no — same reason as the model dropdown: idle is when you set it for the run about to start | never disabled, since the route never refuses; relabels `interactive` ↔ `hands off` and switches amber while off. **consult me** disables alongside it |

Navigating to the shelf or the saved-run browser while a control is mid-state (`armed`, `pausing…`)
does not cancel it — the state lives on `session`/`armed`, not on whether the run page happens to be
showing, so switching back to it mid-run shows exactly where things were left.

A refusal from the engine surfaces as **one error line in the source bar**, clearing itself after a few
seconds. Three of them need more, because the page has already moved ahead of the server: a refused
`POST /model` **puts the dropdown back** (a wrong id fails every call, so a silently-wrong label is
expensive), a refused `POST /select` releases the pick so the shelf is clickable again, and a refused
`POST /select` sent from the play confirmation **also shows the reason inside the modal** rather than
only in the source bar — the same reason the interview keeps its own copy, below. Closing and
reopening the confirmation clears it.

## The shelf

**Choosing what gets written next is its own page**, shown only while the session is actually parked
waiting for a pick ([Pages and navigation](#pages-and-navigation)). It used to be a panel stacked over
whatever scene was already on screen, with its own **clear the last scene** escape hatch and each
card's own retained-run buttons — both existed only because the panel and the reading column were the
same piece of DOM. Once picking has its own page, there is no scene under it to protect and no reason
for a run-browsing feature to live on a page about starting the next one; both moved off.

A card shows a story's premise, scene question, cast, and rough length — the same pre-flighted check
`--preflight` runs, so a story that cannot load says so on its card instead of failing after it is
picked, and the card can never disagree with what a run would do. Clicking a live card does not start
anything by itself; it opens **the play confirmation**.

### The play confirmation

A modal showing exactly what the card already showed — premise, scene question, cast, length, any
pre-flight warnings — with three ways forward: **play**, which is the actual `POST /select` and
therefore where a refusal shows up (above); **edit scenario**, rendered disabled with a tooltip, not
built yet; and **cancel**, which sends nothing. The × button, a backdrop click, and cancel all do the
same thing. `play` starting the run flips the session to `running`, which is what carries the page
itself over to `#/live` ([Pages and navigation](#pages-and-navigation)) — the modal does not navigate
on its own.

## Saved runs

**A story's retained runs** ([RUN-RECORD.md](RUN-RECORD.md)) live here now, not hung off the shelf's
cards — one row per discovered story, its runs newest-first as small `read ·` buttons naming when it
happened, how far it got, how it ended. Clicking one is a view-only fetch of `GET /runs/log` straight
into `ingest()`, exactly like `?src=` and drag-drop are; it is **never** a form of picking, and the
live scene (if one is running) is untouched — reading something finished must not cost the view of
something still being written, which is the whole reason this page keeps its own event store
([rendering traps](#rendering)). `open a saved log` and the drag-drop target live here too now, since
this is where someone with something to read is already looking, whether or not something is loaded
already.

## The interview screen

`new story…` opens the interview as a **modal** over the shelf, the same way the play confirmation
does. Closing it (the ×, a backdrop click, or Escape) only **hides** it; the `ScaffoldSession` on the
server does not know it happened, so reopening it (the same card, now reading *"continue new
story…"*) lands exactly where you left it — the same guarantee a reload gives. Only **abandon** ends
the interview.

It is **conversation only**: each change is a patch through the architect, the same round the console
sends, because both drive the same object. Every decision is the session's (SPEC-S §4.2); the page is
wires. Direct field editing is deliberately not here (below) — with **one exception, a closed list of
one**.

**Two dials, because neither is a design decision.**

- **`built by`**, on the idea screen: which model builds the story, and — since the engine writes the
  same id into the new story's `## Models` — which one then writes it. Before a story exists there is
  only one model in play (SPEC-S §2), so it is one choice and not two. It is offered *only* before the
  interview starts: the architect agent is built at `start`, and swapping it mid-interview would mean
  a new agent with none of the history that "it kept the parts I liked" rests on. Once one is open the
  model is **reported** in the modal's subtitle, from `scaffoldState()`, so a reloaded tab learns it
  too.
- **Scene length**, typed over in the proposal card, sent as `POST /scaffold/set` and applied through
  `applyEdits` — so the closed vocabulary keeps one enforcement point, and the next round sends the
  *engine's* spec, meaning the architect sees the new number rather than the one it proposed. A word
  count is a dial, and spending a minute-long round on one is how you end up never changing it.
  `directEdit()` refuses anything outside 100–10000 rather than letting `normalizeSpec` silently
  substitute 700 — right for a model's reply, wrong for a person watching the number change under
  them. Same busy guard as a round, because `say()` serializes the spec before its call and patches it
  after, so an edit landing in between would be invisible to the architect for that round.

The proposal renders as a card with the premise, the scene question and each character's can / cannot
/ knows / persona; `personas in full` is the `?` of the console loop. Because re-render is whole, what
you are typing is kept in a draft outside the DOM and written back, and focus is read off the document
*as the render begins* — tracking it through focus/blur fails, since removing a focused node does not
reliably fire blur. When nothing had focus it goes to the box the interview is currently asking about
(the folder question if one is open, else the say box): a modal that opens with focus on the page
behind it makes the keyboard useless until you click.

**Nothing may silently discard what you wrote.** One rule with four halves, each of which was a way to
lose a change:

- **`↵` sends** (`⇧↵` is a newline; on the idea box, which is a paragraph, it is the other way round,
  and `ctrl/⌘↵` proposes). There was no keyboard path to *send* at all, which is what made the
  primary-styled button the apparent default for a box whose entire purpose is a change.
- **The draft is cleared only once the round lands.** Clearing before the POST lost the text to a 409
  or a dropped connection, with nothing said.
- **Accepting over unsent text arms first**, the same confirming second click accepting over a flagged
  problem takes — the story is written from the *spec*, so anything still in the box is thrown away by
  it. The armed label says which of the two it is.
- **Every refusal is shown.** `/scaffold/*` answers either the whole session state or a refusal, and a
  refusal is a state the page cannot infer from its own optimism. A refused `start` also drops the
  optimistic "thinking…" back to the idea box, or the modal hangs there until a reload.

The row is ordered by what a button costs you — `send · accept & write it · personas in full`, then a
gap, then **`abandon`, which arms too**: it throws away every round of an interview at once and the
server keeps no copy. Mid-round only the two that are safe there remain (`personas` is local, and the
server allows abandoning a round in flight). The **folder question is a question, not a mode**: the
ordinary row still renders under it, so "actually, change one more thing first" and "abandon" stay
reachable — at the console a blank answer goes back to refining, and the browser had no equivalent.

## Sources

`?src=URL` → `/run` + SSE (live) → `/log.jsonl` → drag-drop / **open a saved log** → empty state.
Works from `file://` too — every one of these lands on the **saved runs** page, since none of them
are a live run. A story's retained-run **read ·** button is this same chain's `ingest()`, fed by
`GET /runs/log` instead of a dropped file — all four write into `READV`, never `LIVEV`
([rendering traps](#rendering)), so none of them can cost the live scene's own view.

**"open a saved log" and drag-drop both live on the saved-run page**, not the topbar — beside
`stop run` a topbar button read as a run control, and a story's retained runs already have `read ·`
buttons right there beside it. This is where someone with something to read is already looking,
loaded or not.

## Not built

- **"Read as MERRITT"** — showing only what one character was actually told. The `situation` handed to
  each consult is already in the log, so this is a pure filter over existing data whenever it is
  wanted. Nothing in the engine needs to change for it; that is why the events carry the situation
  verbatim rather than a summary.
- **Direct editing of a proposal's prose fields** — forms bound to `applyEdits`' closed vocabulary, so
  a single word in a persona could be fixed without spending a model call. Deferred because the
  interview is conversation-only precisely so the console and the browser stay the same interview over
  one `ScaffoldSession`, and a persona edited behind the architect's back is one it will contradict on
  the next round. `scene.length` is the standing exception (above). **That is the line for anything
  proposed next: if the architect would have to be told about it to keep the story coherent, it stays
  a conversation.**
- **The play confirmation's "edit scenario"** — renders disabled with a tooltip. Same open question as
  a proposal's prose fields, above, one level earlier: a story already on disk edited from the play
  modal is a story the architect never saw change.
- Per-step timing, cost, and any editing of the scene from the page. This is a viewer.
