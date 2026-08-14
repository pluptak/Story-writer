# VIEWER UI — what the page shows

The browser half of the viewer ([gui/viewer.js](gui/viewer.js)). What the controls *do to a run*, and
every route they post to, is [GUI-SPEC.md](GUI-SPEC.md); this file is what you read when the page
looks wrong.

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
- **A model swap** renders as a plain note in the gap where it happened, like `bad_consult` and
  `budget` — a fact about how the rest of the scene was produced, not a whole block.
- **The rail** carries progress and the counts that indicate trouble: retries amber, skill flags red.

**Re-render is whole, debounced on a timer.** A scene is a few dozen events; rebuilding is far cheaper
than keeping incremental DOM state correct across retries and late-arriving verdicts. Open consults
are remembered by `seq` across renders, and the view sticks to the bottom only if it was already near
it. The chosen **theme is kept** across reloads, which a page watched across reconnects otherwise
forgets every time.

Three traps, all found by driving a real stopped run, all of which a rewrite would fall into again:

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

## Control states

**The run controls hide while nothing is running**, rather than sitting there disabled — the idle
screen belongs to the picker, and three greyed buttons on it are furniture, not information. What each
one *does* is [GUI-SPEC.md](GUI-SPEC.md#4-ending-a-run-early); this is only how it presents.

| control | live-only | extra state |
|---|---|---|
| **stop** | yes | **a second, confirming click** — the same deliberate-second-press rule the scaffolder uses for accepting over a complaint (SPEC-S §4.2); disarms after four seconds |
| **consult me** | yes | disabled and relabelled while the one it just armed is still pending |
| **pause** | yes | a third label for the request-vs-effective gap: *"pause" → "pausing…" → "resume"* |
| **model dropdown** | no — idle is exactly when it picks what the next run loads with | disabled whenever the run is going and not paused: enabled exactly when a choice would do something, never when it would 400 |
| **interactive** | no — same reason as the model dropdown: idle is when you set it for the run about to start | never disabled, since the route never refuses; relabels `interactive` ↔ `hands off` and switches amber while off. **consult me** disables alongside it |

A refusal from the engine surfaces as **one error line in the source bar**, clearing itself after a few
seconds. Two of them need more, because the page has already moved ahead of the server: a refused
`POST /model` **puts the dropdown back** (a wrong id fails every call, so a silently-wrong label is
expensive), and a refused `POST /select` releases the pick so the shelf is clickable again. The
interview keeps its own copy inside the modal, where the refusal is about what you are looking at
rather than about the session.

## The picker

**The picker is a panel at the top of the reading column, not a screen that replaces it.** A session
that has just finished a scene must not have that scene shoved off the page by the question of what to
write next — the guiding principle applies to the chrome as much as to the machinery. With nothing
written yet, the panel is simply the whole page.

Keeping the scene needs an escape hatch, though, or the only way to a clean shelf is a reload — which
brings it straight back, because the server still holds it. So the picker offers **clear the last
scene**, and it clears the *view* only: the log on disk and `/log.jsonl` are the record and are never
touched by a reading pane.

A card carries the story's **retained runs** ([RUN-RECORD.md](RUN-RECORD.md)) as `runs`, newest first
— when it happened, how far it got, how it ended. The card itself is a `<button>` that starts a NEW
run, so those render as a row of small `read ·` buttons *beside* it: a button cannot nest another
button, and each past run needs its own click target. Clicking one is the same view-only load `?src=`
and drag-drop already are — a fetch of `GET /runs/log` straight into `ingest()`. It is not a form of
picking: the session stays wherever it already was, and reading a past run never touches `/select`.

## The interview screen

`new story…` opens the interview as a **modal** over whatever is already on the page. Closing it (the
×, a backdrop click, or Escape) only **hides** it; the `ScaffoldSession` on the server does not know it
happened, so reopening it (the same card, now reading *"continue new story…"*) lands exactly where you
left it — the same guarantee a reload gives. Only **abandon** ends the interview. This is deliberately
not the picker's own escape hatch (clear the last scene, above): that clears a *finished* run's view,
while hiding the modal loses nothing, because the interview was never the page under it.

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
Works from `file://` too. A past run's **read** button is this same chain's `ingest()`, fed by
`GET /runs/log` instead of a dropped file.

**"open a saved log" lives in the empty state, not the topbar** — beside `stop run` it read as a run
control while duplicating drag-drop, and a story's retained runs already have `read ·` buttons on
their cards. The empty state is where someone with nothing loaded is already looking.

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
- Per-step timing, cost, and any editing of the scene from the page. This is a viewer.
