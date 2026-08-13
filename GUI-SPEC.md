# GUI-SPEC — the run viewer

Spec for [gui/viewer.html](gui/viewer.html) and the `--serve` server in
[story-writer.ts](story-writer.ts). [DESIGN.md](DESIGN.md) remains authoritative for the engine.

---

## 1. What it is for

A run produces a scene and a record of how the scene was arrived at. The viewer shows **the scene
first** — it reads straight down the page like a manuscript — with each consult collapsed into the
gap it happened in. Open one and you see exactly what that character was told, what it asked back,
what it answered, and whether the writer took it.

> **Guiding principle**
> **The page is the product; the machinery is evidence about it.**
> Anything that makes the prose harder to read to make the machinery more visible is the wrong
> trade. A run you cannot read as a story is a run you cannot judge.

This is the one place the fork deliberately diverges from the engine it came from. That engine's
product was a transcript, so a chat timeline was right. Here a chat timeline would mean the finished
scene never appears as continuous prose anywhere.

### 1.1 The problem it was built for

The live console used to stream each agent's raw JSON — escaped newlines, the whole consult block,
and the same object emitted twice by models that do that — interleaved with the formatted output it
was supposed to accompany. A run was genuinely hard to follow while it happened.

Two answers, and the first matters even if the viewer is never opened:

- **The console prints a status line, not the draft** (`Agent.generate` → `progress()`): one
  rewritten line with elapsed time and characters received. On a non-TTY it prints nothing at all,
  because carriage returns in a redirected log are worse than silence.
- **The viewer** shows the same run properly.

---

## 2. The stream

The viewer consumes the **`RunEvent` union already defined in the engine** (DESIGN.md §6) — the
same objects written to `out/writing-log.jsonl`. No event exists for the viewer's benefit; the log
and the live stream are the same data, and `publish()` stamps one `seq` used by both. A saved log
and a live run therefore render identically, which is what makes the renderer debuggable against a
finished run.

`bad_consult` (DESIGN.md §4.3 — a consult the engine refused to send) has no answer and no attempts
to fold, so it renders as a standalone note in the gap where it happened, the way `budget` does. It
is deliberately visible rather than silent: a run whose writer keeps asking *"what do you do?"* looks
otherwise like a run that simply consulted less.

`reader_ask`/`reader_answer` (DESIGN.md §3.1, §6.1) are real events too, unlike the out-of-budget
prompt — a reader consult is part of the story. A `reader_ask` with no matching `reader_answer` yet
is the block that is still waiting on you; see §4.3 and §5.

`model_changed` (DESIGN.md §6.1) is a real event for the same reason — a swap made while paused
changes what the rest of the scene sounds like, so it belongs in the record rather than only
flashing over SSE. See §4.4.

### 2.1 SSE-only frames

Never written to the log, because they are UI state rather than record:

| frame | meaning |
|---|---|
| `{t:"composing", who, secs, chars}` | an agent is generating; drives the indicator |
| `{t:"idle"}` | it stopped |
| `{t:"continue_prompt", steps, budget, suggested}` | the step budget is spent (§4.1) |
| `{t:"run_state", running, stopping, where, picking, armed, paused, pausing, model}` | what the **session** is doing (§4.2, §6); `armed` is the reader-consult flag (§4.3), `paused`/`pausing`/`model` are the pause and model-override state (§4.4) |
| `{t:"run_reset"}` | a new run is starting in this process; drop what you are holding |

A run's log must stay the record of what happened, not of what a browser happened to be showing.

`run_state` exists because *"is a scene being written right now"* is not answerable from the events:
a finished log and a run that stopped ten seconds ago contain exactly the same thing. `where` is the
session's own business — `writing stories/doorway`, `choosing a story`, `building a new story` —
and it is the one thing in the viewer that describes the process rather than the story.

`run_reset` is sent when a run begins, **after** `RUN_META` is set. Replay only helps clients that
connect afterwards; a viewer already attached has to be told, or the next scene renders glued onto
the last one. It re-reads `GET /run` for the new cast.

---

## 3. Server

Node built-ins, no framework, no build step. Started by `--serve` (`--port=NNNN`, default 8080) from
`main()`, **before** the picker — so the viewer is up while you are still choosing, and survives the
run it was opened for.

| route | |
|---|---|
| `GET /` | the viewer, `no-cache` |
| `GET /events` | SSE. **Replays `liveHistory` first, then attaches** — a viewer opened halfway through sees the whole scene, not the rest of it — then one `run_state` for what is happening now |
| `GET /run` | `{ run: {story, characters, target, question}, awaitingContinue, events, running, stopping, where, picking, armed, paused, pausing, model }` |
| `POST /continue` | `{steps}` — grants budget (§4.1); 400 when nothing is waiting |
| `POST /stop` | end the current run (§4.2); 400 when none is in progress |
| `POST /consult-me` | arm the reader-consult flag (§4.3); 400 when no run is in progress; a second arm before the first fires is a no-op |
| `POST /reader-answer` | `{answer}` — resolve the pending `[ASK READER]` (§4.3); 400 when nothing is waiting |
| `GET /models` | `{ ids, reachable, current, architect }` — the model ids LM Studio has loaded (§4.4), memoized the same way pre-flight's ping is; `architect` is the resolved default an interview would use if you chose nothing (§6.1) |
| `POST /pause` | request a pause at the run's next boundary (§4.4); 400 when none is in progress; a second request before the first takes effect is a no-op |
| `POST /resume` | clear a pause, requested or in effect (§4.4); 400 when neither is true |
| `POST /model` | `{model}` — set the model override; `""` clears it. Idle: applies to the next run. Paused: swaps every live agent immediately. Running-and-not-paused: 400 (§4.4) |
| `GET /stories` | every discovered story, pre-flighted, as picker cards (§6) |
| `POST /select` | `{dir}` — choose the next story (§6); 400 when the session is not waiting, or the story was not discovered |
| `GET /scaffold` | the open interview, or `{active:false}` (§6.1) |
| `POST /scaffold/start` | `{idea, model?}` — open an interview and propose. `model` outranks `--model=` and defaults.md; an id LM Studio does not have loaded is 400 here rather than a failure a minute in (§6.1) |
| `POST /scaffold/say` | `{text}` — a change, or an answer to what it asked |
| `POST /scaffold/set` | `{field, value}` — the one change made without the architect: `scene.length`, through `applyEdits` (§6.1). 400 for any other field, for a length outside 100–10000, or before a story exists |
| `POST /scaffold/accept` | `{folder?}` — write it; on success this resolves the parked pick |
| `POST /scaffold/abandon` | drop the interview, back to the shelf |
| `GET /log.jsonl` | the current run's saved log; 404 until one exists |
| `GET /runs/log?dir=&id=` | a past run's saved log, read-only (§6); `dir` is checked against `discoverStories()` (`selectableStory`), `id` against that story's own `runDirs()` — 400/404 rather than trusted as a path |

A failed `listen` (port in use) **warns and lets the run continue** rather than killing it. Losing
the viewer should never cost a scene. The message names the next port to try.

A 15s keep-alive ping doubles as what holds the process open after the scene ends, so a finished run
stays readable instead of the server dying under it.

---

## 4. Ending a run early

### 4.1 The out-of-budget prompt

When `max_steps` is spent without the scene finishing, `askMoreSteps` asks, in this order:

1. **the viewer**, if any client is attached — `continue_prompt` frame, answered by `POST /continue`
2. **the console**, on a TTY
3. **nobody** — the run stops, which is honest rather than blocking forever

The pending state is exposed on `GET /run`, so a viewer that connects *while* a prompt is
outstanding still learns about it. Without that, a reload would strand a blocked run. It also rides
on **every `run_state` frame** (`awaitingContinue`), which is the other half of the same problem:
`continue_prompt` is one-shot, so a viewer that did not answer it — because the console did, or
because a stop cleared it — went on showing a live-looking prompt whose buttons could only 400. A
frame saying nobody is waiting takes the prompt down.

### 4.2 Stopping

A scene you can see going wrong is a scene you should be able to abandon without killing the
process. `POST /stop` (the topbar button) sets `RUN.stopped` and fires `RUN.abort`.

**Two halves, because a run spends nearly all of its wall time inside one model call.** The flag is
what `writeScene` checks at every boundary; the AbortController is what cuts the request already in
flight. With only the first, "stop" would mean "stop in up to `request_timeout` seconds" — and the
whole point is that you have stopped wanting the answer.

What a stop must never be mistaken for:

- **a failure to retry** — `withRetry` throws `StoppedError` instead of backing off, and refuses to
  start a call at all once the flag is set;
- **a truncated-but-complete reply** — the streaming salvage in §4.1 of DESIGN.md would otherwise
  hand the loop one more usable draft and buy another consult out of an abandoned run;
- **a character that misbehaved** — a consult cut mid-flight records no answer and leaves the
  character's history untouched, exactly as a rejected attempt does.

`scene_end` carries `stopped`, so the log says which of the three ways a scene ended it was:
finished, ran out, or was abandoned. Both artifacts are already on disk — they are written as the
run goes — so a stop costs the rest of the scene and nothing already written.

Then the session **returns to the picker** rather than exiting: the viewer stays up, the models stay
loaded, and the next story starts from the same prompt. One-shot invocations are unchanged — a story
named on the command line, `--consult`, or any run without a terminal still runs once and exits, so
`--steps=3` remains a scripted smoke test.

### 4.3 The reader consult

The topbar's **consult me** button is a one-shot arm, not a mode: `POST /consult-me` sets a flag the
loop checks once, at the top of its next step, then clears whether or not anything came of it. There
is no console equivalent — arming requires a viewer, and DESIGN.md §4/§6.1 has the reasoning.

When it fires, the writer is sent `[ASK READER]` (DESIGN.md §3.1) instead of `[WRITE]` for that step:
no prose, three proposed directions instead. That becomes a `reader_ask` event, rendered as an open
question with a button per option and a free-text box under it — the same either-or-your-own choice
the scaffolding interview already offers. Picking one, or typing your own, is `POST /reader-answer`
`{answer}`; the resulting `reader_answer` event closes the block and the writer continues informed by
whatever was sent, verbatim.

Two edges, both already covered by the loop rather than the viewer:

- **The viewer disconnects between arming and firing.** The flag is only acted on while a client is
  attached; an arm that goes stale is dropped silently, same principle as a lost viewer never costing
  a scene (§3).
- **The run is stopped while a reader consult is outstanding.** `POST /stop` resolves it with an
  empty answer, which the loop discards rather than folding in — see §4.2.

### 4.4 Pausing and changing the model

The topbar carries a model dropdown (populated from `GET /models`) and a **pause** button, browser-
only like the reader consult — there is no console equivalent for either.

**Picking a model while idle** sets the override for the *next* run (`POST /model`); it has no effect
on one already in progress. **Picking one while running-and-not-paused is refused** (400) — the
dropdown is disabled for exactly that state, so the refusal should never actually be seen, only
guarded against a stale tab or a race.

**Pause** is a request, not an instant: `POST /pause` sets a flag the loop checks at its next
boundary, same as everything else in §4, and — unlike stop — it never aborts the call already in
flight. The point is to let the piece being generated finish cleanly before the model underneath it
changes. Between the click and the loop actually reaching that boundary the button reads
*"pausing…"*; only once it is actually sitting there (`paused`, not merely `pausing`) does the model
dropdown become editable, because that is also exactly what the server enforces on `POST /model`.

**Picking a model while paused swaps it immediately**, on the writer and on every character agent
already in the scene — including one authored with its own `model:` line, since pausing is a live
override of what is actually running, not a rewrite of how the story was authored (DESIGN.md §6.1).
Existing history and persona on each agent are untouched; only which model answers their next call
changes. The swap becomes a `model_changed` event — real record, not UI trivia, per §2.

**Resuming** (`POST /resume`) clears the pause, requested or in effect, and lets the loop continue
from wherever it was blocked.

Two edges, both handled the same way the reader consult's are — in the loop, not the viewer:

- **The run is stopped while paused.** `POST /stop` releases the pause gate too, so a stop can never
  leave the loop blocked on a promise nobody will resolve.
- **"Story default" is picked while paused.** Clearing the override changes what the *next* run
  starts from; it cannot revert the agents already swapped, since nothing records what they were
  before — there is no "back" to a live swap, only forward to another one.

---

### 4.5 When the engine says no

Every control on this page posts, and the engine refuses for reasons the page cannot see from its own
state: a run that has already stopped, a session no longer waiting on a choice, a model LM Studio
does not have loaded, a round already in flight. All of it used to land in `catch {}` — the click did
nothing at all, which reads as a broken page rather than as an answered question.

So there is **one error line, in the source bar**, carrying the engine's own `reason` and clearing
itself after a few seconds. Two refusals need more than a message, because the page has already moved
ahead of the server: a refused `POST /model` **puts the dropdown back** (a wrong id fails every call,
so a silently-wrong label is expensive), and a refused `POST /select` releases the pick so the shelf
is clickable again. The interview keeps its own copy inside the modal (§6.1), where the refusal is
about what you are looking at rather than about the session.

---

## 5. Rendering

Events are flat and ordered; the page is not. `build()` groups a `consult` and everything it
produced — clarifications, repairs, retries, the answer, the verdict — into **one foldable block**.
A retry arrives as another `consult` with `attempt > 1`, so it joins the block it belongs to rather
than starting a new one. That grouping is the whole renderer; everything else is presentation.

- **Prose** blocks render as paragraphs in a serif reading column. A `salvaged` draft is marked, so
  a piece that arrived through truncation recovery is never silently indistinguishable.
- **A consult**, collapsed, is a rule across the page carrying the character's name, the question,
  and tags for what is worth knowing without opening it: `asked back`, `N retry`, `flagged`.
- **Opened**, each attempt shows the situation given, the question, any clarification exchange, any
  notes (forced answer, repair, skill flag), the answer, and the verdict. Attempt 2+ is labelled
  *"fresh instance, no memory of the last"* — that is the whole point of the retry design and the
  viewer should say so rather than leaving it as trivia in a spec.
- **The rail** carries progress and the counts that indicate trouble: retries amber, skill flags red.
- **The stop button** appears only on a live source, is disabled when nothing is running, and takes
  a **second, confirming click** — the same deliberate-second-keypress rule the scaffolder uses for
  accepting over a complaint (SPEC-S §4.2). It disarms itself after four seconds.
- **A reader consult** (§4.3) renders as its own block, not a collapsed one — it is a question aimed
  at you, not a record to fold away. Pending, it shows the framing, a button per option, and a
  free-text box; answered, it collapses to the framing and what was chosen. The **consult me** button
  mirrors stop's live-only, disabled-when-nothing-running rule, plus a third state — disabled and
  relabelled while the one it just armed is still pending.
- **A model swap** (§4.4) renders as a plain note in the gap where it happened, the same treatment as
  `bad_consult`/`budget` — it is a fact about how the rest of the scene was produced, not something
  worth a whole block. The **pause** button follows stop's live-only/disabled-when-nothing-running
  rule and adds a third label for the request-vs-effective gap (§4.4): *"pause" → "pausing…" →
  "resume"*. The **model dropdown** is disabled whenever the run is going and not paused — enabled
  exactly when a choice would do something, never when it would 400.

- **A pending reader consult is scrolled to** when it arrives, and its buttons disable on the click
  that answers it. The run is blocked on you at that moment, reading further up the scene is the
  normal thing to be doing when it appears, and a question nobody scrolls to is a run that looks
  hung. One answer per consult: a second click is not a second choice.
- **The run controls hide while nothing is running**, rather than sitting there disabled — the idle
  screen belongs to the picker, and three greyed buttons on it are furniture, not information. The
  model dropdown is the exception and stays: idle is exactly when it picks the model the next run
  loads with. The chosen **theme is kept** across reloads, which a page watched across reconnects
  otherwise forgets every time.
- **Two consecutive drafts are separated like paragraphs**, because they are. At 6px the seam between
  drafts read *tighter* than the paragraphs inside one, which is backwards on a page whose whole
  point is that the scene reads straight down.

**Re-render is whole, debounced on a timer.** A scene is a few dozen events; rebuilding is far
cheaper than keeping incremental DOM state correct across retries and late-arriving verdicts. Open
consults are remembered by `seq` across renders, and the view sticks to the bottom only if it was
already near it.

Three things this got wrong, all found by driving a real stopped run:

- **A timer, not `requestAnimationFrame`.** rAF does not fire in a hidden or non-compositing tab, so
  a run watched in a background tab stopped updating entirely — and because the handle latched in
  `pending`, nothing rescheduled either.
- **Events are de-duplicated by `seq`.** `/events` replays the whole run before attaching and
  `EventSource` reconnects itself after any blip, so without this each reconnect appended a second
  copy of the scene. The page grew by one whole scene per reconnect, which reads as a story that
  will not close. `seq` is stamped once by `publish()`, so it is the event's identity in both the
  log and the stream.
- **`run_state` always re-renders**, not only when `picking` changes value. Rendering on a state
  *edge* is one missed transition away from a page with no route back to the shelf; these frames
  arrive a handful of times per run, so rendering on all of them costs nothing.

---

## 6. Choosing a story

**When `--serve` is on and nothing on the command line has already decided what to run, the browser
drives the session.** The console prints status and never blocks on stdin. One driver, not two —
racing a console prompt against a browser is fine for a single question like §4.1's, and wrong for
anything with state behind it.

A run without a terminal is **never** browser-driven, whatever flags are passed: *"no terminal means
run once and exit"* is a guarantee scripts already depend on, and a headless session parked forever
waiting for a browser nobody opened would break it.

`awaitPick()` parks the session and `POST /select` resolves it. Deliberately no timeout and no
console fallback: in a browser-driven session there is nothing to fall back *to*, and quietly
choosing a story for you would be worse than waiting. Ctrl-C is the way out.

**`GET /stories` is pre-flighted** — the same real `loadStory()` check `--preflight` runs, so a story
that cannot load says so on its card instead of failing after you pick it, and the card can never
disagree with what a run would do. The model-id ping behind it is memoized for a few seconds, or an
unreachable LM Studio would cost the full timeout once per story.

**A directory that arrives over HTTP is a request to read one, not a path.** `selectableStory()`
resolves it against what `discoverStories()` actually found and returns null otherwise — no
normalizing, no prefix test, nothing a `..` survives. This is the read-side twin of `slugify()`
owning where scaffolds may be written (SPEC-S §4.3).

Where it renders is the interesting part. **The picker is a panel at the top of the reading column,
not a screen that replaces it.** A session that has just finished a scene must not have that scene
shoved off the page by the question of what to write next — §1's principle applies to the chrome as
much as to the machinery. With nothing written yet, the panel is simply the whole page.

Keeping the scene needs an escape hatch, though, or the only way to a clean shelf is a reload — which
brings it straight back, because the server still holds it. So the picker offers **clear the last
scene**, and it clears the *view* only: the log on disk and `/log.jsonl` are the record and are never
touched by a reading pane.

**Each story keeps its last three runs** (DESIGN.md §6), and `GET /stories`' cards carry them as
`runs`, newest first — when it happened, how far it got (`words`/`steps`), and how it ended
(`done`/`stopped`, or neither for one killed mid-scene). A story's card is itself a `<button>` that
starts a NEW run, so its retained runs render as a row of small `read ·` buttons *beside* the card, not
inside it — a button cannot nest another button, and each past run needs its own click target rather
than the card's. Clicking one is the same view-only load `?src=` and drag-drop already are (§7): a
fetch of `GET /runs/log`, straight into the same `ingest()` that reads a dropped file, changing only
what the reading pane shows. It is not a form of picking — the session stays wherever it already was
(waiting on a choice, mid-interview, whatever), and reading a past run never touches `/select`.

### 6.1 The interview

`new story…` opens the interview as a **modal** over whatever is already on the page — the picker, a
finished scene, or both. Closing it (the × in its corner, a click on the backdrop, or Escape) only
**hides** it; the `ScaffoldSession` on the server does not know it happened, so reopening it (the same
"new story…" card, now reading *"continue new story…"*) lands exactly where you left it — the same
guarantee a reload already gave you (below). Only **abandon** actually ends the interview. This is
deliberately not the picker's own escape hatch (clear the last scene, above): that clears a *finished*
run's view; hiding the modal loses nothing because the interview was never the page under it.

The server holds **one `ScaffoldSession`** and nothing else. Every decision is the session's
(SPEC-S §4.2); these are the wires. It is **conversation only**: each change is a patch through the
architect, the same round the console sends, because both drive the same object. Direct field
editing is deliberately not here (§8) — with **one exception, a closed list of one**.

**Two dials, because neither is a design decision.**

- **`built by`**, on the idea screen: which model builds the story, and — since the engine writes the
  same id into the new story's `## Models` — which one then writes it. Before a story exists there is
  only one model in play (SPEC-S §2), so it is one choice and not two. It is offered *only* before
  the interview starts: the architect agent is built at `start`, and swapping it mid-interview would
  mean a new agent with none of the history that "it kept the parts I liked" rests on. Once one is
  open the model is **reported** in the modal's subtitle, not offered — and reported from
  `scaffoldState()`, so a reloaded tab learns it too.
- **Scene length**, typed over in the proposal card, sent as `POST /scaffold/set` and applied through
  `applyEdits` — so the closed vocabulary still has exactly one enforcement point, and the next round
  sends the *engine's* spec, meaning the architect sees the new number rather than the one it
  proposed. A word count is a dial, not a design decision, and spending a minute-long round on one is
  how you end up never changing it. `directEdit()` refuses anything outside 100–10000 rather than
  letting `normalizeSpec` silently substitute 700 — right for a model's reply, wrong for a person
  watching the number change under them. Same busy guard as a round, because `say()` serializes the
  spec before its call and patches it after, so an edit landing in between would be invisible to the
  architect for that round.

The load-bearing detail: **the session stays parked in `awaitPick()` for the whole interview**, so
accepting simply resolves that pick with the directory it just wrote. There is no second parking
mechanism and no separate "scaffolding" mode in the main loop — it asked for a story and got one.
Everything short of `written` leaves the interview open: a folder still to name, or a story on disk
that does not load and can be refined and accepted again.

`scaffold` frames push the whole state on every transition. A round is a minute of model call, and
the POST response only ever reaches whoever sent it — a reload or a second tab has to be able to
catch up. `GET /scaffold` covers a viewer that loads mid-round. Neither is ever logged: an interview
is not part of any run's record.

Two guards worth naming. **One architect at a time** (409 while a round is in flight): two
overlapping rounds would interleave on one agent's history, which is the state the whole "it kept
the parts I liked" property rests on. And **an unknown action is 404 whatever the session is doing**,
checked before the state guards — a typo'd route name reported as a state problem sends you
debugging the wrong thing.

In the page: the proposal renders as a card with the premise, the scene question and each character's
can / cannot / knows / persona; `personas in full` is the `?` of the console loop.
Because re-render is whole, what you are typing is kept in a draft outside the DOM and written back,
and focus is read off the document *as the render begins* — tracking it through focus/blur fails,
since removing a focused node does not reliably fire blur. When nothing had focus, it goes to the box
the interview is currently asking about (the folder question if one is open, else the say box): a
modal that opens with focus on the page behind it makes the keyboard useless until you click.

**Nothing may silently discard what you wrote.** This is one rule with four halves, and every one of
them was a way to lose a change:

- **`↵` sends** (`⇧↵` is a newline; on the idea box, which is a paragraph, it is the other way round
  and `ctrl/⌘↵` proposes). There was no keyboard path to *send* at all, which is what made the
  primary-styled button the apparent default for a box whose entire purpose is a change.
- **The draft is cleared only once the round lands.** Clearing before the POST lost the text to a
  409 or a dropped connection, with nothing said.
- **Accepting over unsent text arms first**, the same confirming second click accepting over a
  flagged problem takes (and a keypress at the console) — the story is written from the *spec*, so
  anything still in the box is thrown away by it. The armed label says which of the two it is.
- **Every refusal is shown.** `/scaffold/*` answers either the whole session state or a refusal, and
  a refusal is a state the page cannot infer from its own optimism: a round already in flight, a
  session no longer waiting for a story, a story written that will not load. A refused `start` also
  drops the optimistic "thinking…" back to the idea box, or the modal hangs there until a reload.

The row is ordered by what a button costs you — `send · accept & write it · personas in full`, then a
gap, then **`abandon`, which arms too**: it throws away every round of an interview at once and the
server keeps no copy. Mid-round only the two that are safe there remain (`personas` is local, and the
server allows abandoning a round in flight). The **folder question is a question, not a mode**: the
ordinary row still renders under it, so "actually, change one more thing first" and "abandon" stay
reachable — at the console a blank answer goes back to refining, and the browser had no equivalent.

---

## 7. Sources

`?src=URL` → `/run` + SSE (live) → `/log.jsonl` → drag-drop / **open a saved log** → empty state.
Works from `file://` too. A past run's **read** button (§6) is this same chain's `ingest()`, fed by
`GET /runs/log` instead of a dropped file.

**"open a saved log" lives in the empty state, not the topbar.** As `load run` it sat one button from
`stop run`, reading like a run control while duplicating drag-drop, and since a story's retained runs
became `read ·` buttons on its card (§6) the topbar slot bought nothing. The empty state is where
someone with nothing loaded is already looking.

---

## 8. Not built

- **"Read as MERRITT"** — showing only what one character was actually told. The `situation` handed
  to each consult is already in the log, so this is a pure filter over existing data whenever it is
  wanted. Nothing in the engine needs to change for it; that is why the events carry the situation
  verbatim rather than a summary.
- **Direct editing of a proposal's fields** — forms bound to `applyEdits`' closed vocabulary, so a
  single word in a persona could be fixed without spending a model call. Still deferred for the
  *prose* fields: the browser interview (§6.1) is conversation-only precisely so the console and the
  browser stay the same interview over one `ScaffoldSession`, and a persona edited behind the
  architect's back is a persona it will contradict on the next round. **`scene.length` is the
  exception and is now direct** (§6.1) — it is a dial rather than a design decision, nothing else in
  the spec has to agree with it, and it still goes through `applyEdits`, so the closed vocabulary
  keeps one enforcement point. That is the line for anything proposed next: if the architect would
  have to be told about it to keep the story coherent, it stays a conversation.
  *(The interview itself stayed at the console for a while, on the reasoning that a two-way design
  chat is a different UI from watching a run — until the browser started driving the session, at
  which point "now go back to the terminal to make one" was the seam that moved it here.)*
- Per-step timing, cost, and any editing of the scene from the page. This is a viewer.
