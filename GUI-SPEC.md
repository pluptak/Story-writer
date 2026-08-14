# GUI-SPEC — the run viewer

The `--serve` server in [server.ts](server.ts), whose shared session state lives in
[live.ts](live.ts): the events it streams, the routes it answers, and what each control does to a run.
What the page *shows* is [VIEWER-UI.md](VIEWER-UI.md); the engine is [DESIGN.md](DESIGN.md) and the
files it maps.

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
  because carriage returns in a redirected log are worse than silence. The text is still buffered and
  parsed exactly as before; only the display changed.
- **The viewer** shows the same run properly.

---

## 2. The stream

The viewer consumes the **`RunEvent` union already defined in the engine** — the same objects written
to `out/writing-log.jsonl`, under the same `seq` ([RUN-RECORD.md](RUN-RECORD.md)). No event exists
for the viewer's benefit. A saved log and a live run therefore render identically, which is what
makes the renderer debuggable against a finished run.

Three events are worth naming because their handling is not obvious from the union:

- `bad_consult` (a consult the engine refused to send, [LOOP.md](LOOP.md#pacing)) has no answer and
  no attempts to fold. It is published rather than swallowed because a run whose writer keeps asking
  *"what do you do?"* looks otherwise like a run that simply consulted less.
- `reader_ask`/`reader_answer` ([PROTOCOL.md](PROTOCOL.md#ask-reader)) are real events, unlike the
  out-of-budget prompt — a reader consult is part of the story. A `reader_ask` with no matching
  `reader_answer` yet is the block still waiting on you; §4.3.
- `model_changed` ([RUN-RECORD.md](RUN-RECORD.md)) is real for the same reason: a swap made while
  paused changes what the rest of the scene sounds like. §4.4.

### 2.1 SSE-only frames

Never written to the log, because they are UI state rather than record. A run's log must stay the
record of what happened, not of what a browser happened to be showing.

| frame | meaning |
|---|---|
| `{t:"composing", who, secs, chars}` | an agent is generating; drives the indicator |
| `{t:"idle"}` | it stopped |
| `{t:"continue_prompt", steps, budget, suggested}` | the step budget is spent (§4.1) |
| `{t:"run_state", running, stopping, where, picking, armed, paused, pausing, model, interactive}` | what the **session** is doing (§4.2, §5); `armed` is the reader-consult flag (§4.3), `paused`/`pausing`/`model` the pause and override state (§4.4), `interactive` the hands-off toggle (§4.6) |
| `{t:"run_reset"}` | a new run is starting in this process; drop what you are holding |

`run_state` exists because *"is a scene being written right now"* is not answerable from the events:
a finished log and a run that stopped ten seconds ago contain exactly the same thing. `where` is the
session's own business — `writing stories/doorway`, `choosing a story`, `building a new story` — and
it is the one thing in the viewer that describes the process rather than the story.

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
| `GET /run` | `{ run: {story, characters, target, question}, awaitingContinue, events, running, stopping, where, picking, armed, paused, pausing, model, interactive }` |
| `POST /continue` | `{steps}` — grants budget (§4.1); 400 when nothing is waiting |
| `POST /stop` | end the current run (§4.2); 400 when none is in progress |
| `POST /consult-me` | arm the reader-consult flag (§4.3); 400 when no run is in progress; a second arm before the first fires is a no-op |
| `POST /reader-answer` | `{answer}` — resolve the pending `[ASK READER]` (§4.3); 400 when nothing is waiting |
| `GET /models` | `{ ids, reachable, current, architect }` — the model ids LM Studio has loaded (§4.4), memoized the same way pre-flight's ping is; `architect` is the resolved default an interview would use if you chose nothing (§5.1) |
| `POST /pause` | request a pause at the run's next boundary (§4.4); 400 when none is in progress; a second request before the first takes effect is a no-op |
| `POST /resume` | clear a pause, requested or in effect (§4.4); 400 when neither is true |
| `POST /model` | `{model}` — set the model override; `""` clears it. Idle: applies to the next run. Paused: swaps every live agent immediately. Running-and-not-paused: 400 (§4.4) |
| `POST /interactive` | `{on}` — the hands-off toggle (§4.6). Never refuses; switching off retracts a pending reader-consult arm |
| `GET /stories` | every discovered story, pre-flighted, as picker cards (§5) |
| `POST /select` | `{dir}` — choose the next story (§5); 400 when the session is not waiting, or the story was not discovered |
| `GET /scaffold` | the open interview, or `{active:false}` (§5.1) |
| `POST /scaffold/start` | `{idea, model?}` — open an interview and propose. `model` outranks `--model=` and defaults.md; an id LM Studio does not have loaded is 400 here rather than a failure a minute in (§5.1) |
| `POST /scaffold/say` | `{text}` — a change, or an answer to what it asked |
| `POST /scaffold/set` | `{field, value}` — the one change made without the architect: `scene.length`, through `applyEdits` (§5.1). 400 for any other field, for a length outside 100–10000, or before a story exists |
| `POST /scaffold/accept` | `{folder?}` — write it; on success this resolves the parked pick |
| `POST /scaffold/abandon` | drop the interview, back to the shelf |
| `GET /log.jsonl` | the current run's saved log; 404 until one exists |
| `GET /runs/log?dir=&id=` | a past run's saved log, read-only (§5); `dir` is checked against `discoverStories()` (`selectableStory`), `id` against that story's own `runDirs()` — 400/404 rather than trusted as a path |

A failed `listen` (port in use) **warns and lets the run continue** rather than killing it, naming the
next port to try. Losing the viewer should never cost a scene.

A 15s keep-alive ping doubles as what holds the process open after the scene ends, so a finished run
stays readable instead of the server dying under it.

---

## 4. Ending a run early

### 4.1 The out-of-budget prompt

When `max_steps` is spent without the scene finishing, `askMoreSteps` asks, in this order:

0. **nobody, if `interactive` is off** (§4.6) — checked first, before either of the below
1. **the viewer**, if any client is attached — `continue_prompt` frame, answered by `POST /continue`
2. **the console**, on a TTY
3. **nobody** — the run stops, which is honest rather than blocking forever

The pending state is exposed on `GET /run`, so a viewer connecting *while* a prompt is outstanding
still learns about it; without that, a reload would strand a blocked run. It also rides on **every
`run_state` frame** (`awaitingContinue`), which is the other half of the same problem: `continue_prompt`
is one-shot, so a viewer that did not answer it — because the console did, or because a stop cleared
it — went on showing a live-looking prompt whose buttons could only 400. A frame saying nobody is
waiting takes the prompt down.

### 4.2 Stopping

A scene you can see going wrong is a scene you should be able to abandon without killing the process.
`POST /stop` (the topbar button) sets `RUN.stopped` and fires `RUN.abort`.

**Two halves, because a run spends nearly all of its wall time inside one model call.** The flag is
what `writeScene` checks at every boundary; the AbortController is what cuts the request already in
flight. With only the first, "stop" would mean "stop in up to `request_timeout` seconds" — and the
whole point is that you have stopped wanting the answer.

What a stop must never be mistaken for:

- **a failure to retry** — `withRetry` throws `StoppedError` instead of backing off, and refuses to
  start a call at all once the flag is set;
- **a truncated-but-complete reply** — the streaming salvage in
  [LOOP.md](LOOP.md#failure-handling) would otherwise hand the loop one more usable draft and buy
  another consult out of an abandoned run;
- **a character that misbehaved** — a consult cut mid-flight records no answer and leaves the
  character's history untouched, exactly as a rejected attempt does.

Both artifacts are already on disk — they are written as the run goes — so a stop costs the rest of
the scene and nothing already written. The session then **returns to the picker** rather than exiting:
the viewer stays up, the models stay loaded, and the next story starts from the same prompt. One-shot
invocations are unchanged (CLI.md).

### 4.3 The reader consult

The topbar's **consult me** button is a one-shot arm, not a mode: `POST /consult-me` sets a flag the
loop checks once, at the top of its next step, then clears whether or not anything came of it. There
is no console equivalent — arming requires a viewer.

When it fires, the writer is sent `[ASK READER]` ([PROTOCOL.md](PROTOCOL.md#ask-reader)) instead of
`[WRITE]` for that step: no prose, three proposed directions instead. That becomes a `reader_ask`
event, rendered as an open question with a button per option and a free-text box under it — the same
either-or-your-own choice the scaffolding interview already offers. Picking one, or typing your own,
is `POST /reader-answer` `{answer}`; the resulting `reader_answer` event closes the block and the
writer continues informed by whatever was sent, verbatim.

Two edges, both covered by the loop rather than the viewer: a viewer that **disconnects between
arming and firing** drops the arm silently (§3's principle), and a **stop while one is outstanding**
resolves it with an empty answer the loop discards (§4.2). A third, the same shape: **`interactive`
switched off while armed** (§4.6) retracts the arm at the route and disables the button; the loop's
own check at the top of the branch is what stops an arm that predates the toggle from firing anyway.

### 4.4 Pausing and changing the model

The topbar carries a model dropdown (populated from `GET /models`) and a **pause** button, browser-only
like the reader consult.

**Pause is a request, not an instant**: `POST /pause` sets a flag the loop checks at its next boundary,
same as everything else in §4, and — unlike stop — it never aborts the call already in flight. The
point is to let the piece being generated finish cleanly before the model underneath it changes.
Between the click and the loop reaching that boundary the button reads *"pausing…"*; only once it is
actually sitting there (`paused`, not merely `pausing`) does the dropdown become editable, because
that is exactly what the server enforces on `POST /model`. **Resuming** (`POST /resume`) clears a
pause, requested or in effect.

The dropdown means three different things by state:

| state | picking a model |
|---|---|
| idle | sets the override for the *next* run |
| paused | swaps it immediately on the writer and every character agent already in the scene ([RUN-RECORD.md](RUN-RECORD.md)), leaving history and persona untouched; logged as `model_changed` |
| running, not paused | 400 — the dropdown is disabled for exactly this state, so the refusal guards a stale tab, not a user |

Two edges, handled in the loop like the reader consult's:

- **The run is stopped while paused.** `POST /stop` releases the pause gate too, so a stop can never
  leave the loop blocked on a promise nobody will resolve.
- **"Story default" is picked while paused.** Clearing the override changes what the *next* run starts
  from; it cannot revert agents already swapped, since nothing records what they were before. There is
  no "back" to a live swap, only forward to another one.

### 4.5 When the engine says no

Every control on this page posts, and the engine refuses for reasons the page cannot see from its own
state: a run that has already stopped, a session no longer waiting on a choice, a model LM Studio does
not have loaded, a round already in flight. A refusal swallowed in `catch {}` reads as a broken page
rather than as an answered question.

Every refusal therefore carries a `reason` the page can show, and two of them need the page to roll
back state it had already assumed — [VIEWER-UI.md](VIEWER-UI.md#control-states).

### 4.6 Going hands-off

A run started unattended, or one you no longer want to babysit, needs a way to guarantee it never
parks waiting for a click that is not coming. The topbar's **interactive** button
(`interactive` ↔ `hands off`) is that guarantee: `POST /interactive {on}` sets `LIVE.interactive`,
carried on `run_state` and `GET /run`, defaulting to `true` so an unattended `--serve` behaves as it
always has.

Off disarms both of §4's blocking paths, checked ahead of everything else in each:

- **The out-of-budget prompt** (§4.1) is never sent — `askMoreSteps` returns `0` before it would ask
  the viewer or the console, so `max_steps` becomes a hard budget and the run ends the same honest
  way it would with nobody attached at all.
- **The reader consult** (§4.3) cannot arm — `POST /consult-me` is 400 while off — and an arm from
  before the toggle flipped cannot fire, checked again at the top of the loop's next step.

Unlike `pause` and `model`, this route never refuses: there is no run state it is unsafe to flip in.
It is also visible **idle**, alongside the model dropdown, because setting it before a run starts —
so the run that follows never blocks at all — is the ordinary use. Not carried into `resetLive()`:
it is a session preference, not a fact about any one run, so a second story in the same session keeps
whatever you last set it to.

---

## 5. Choosing a story

**When `--serve` is on and nothing on the command line has already decided what to run, the browser
drives the session.** The console prints status and never blocks on stdin. One driver, not two —
racing a console prompt against a browser is fine for a single question like §4.1's, and wrong for
anything with state behind it.

A run without a terminal is **never** browser-driven, whatever flags are passed: *"no terminal means
run once and exit"* is a guarantee scripts already depend on, and a headless session parked forever
waiting for a browser nobody opened would break it.

`awaitPick()` parks the session and `POST /select` resolves it. Deliberately no timeout and no console
fallback: in a browser-driven session there is nothing to fall back *to*, and quietly choosing a story
for you would be worse than waiting. Ctrl-C is the way out.

**`GET /stories` is pre-flighted** — the same real `loadStory()` check `--preflight` runs, so a story
that cannot load says so on its card instead of failing after you pick it, and the card can never
disagree with what a run would do. The model-id ping behind it is memoized for a few seconds, or an
unreachable LM Studio would cost the full timeout once per story. The route is answered whether or not
the session is picking — the browser's saved-run page reads the same cards for their retained runs,
which is not a form of picking and never touches `awaitPick()`
([VIEWER-UI.md](VIEWER-UI.md#saved-runs)).

**A directory that arrives over HTTP is a request to read one, not a path.** `selectableStory()`
resolves it against what `discoverStories()` actually found and returns null otherwise — no
normalizing, no prefix test, nothing a `..` survives. This is the read-side twin of `slugify()` owning
where scaffolds may be written (SPEC-S §4.3).

The browser's own picking screen is one page among three, shown only for the span this section
describes (`awaitPick()` parked, until `POST /select` or an accepted interview resolves it) — how it
and the play confirmation in front of it render: [VIEWER-UI.md](VIEWER-UI.md#the-shelf).

### 5.1 The interview's server side

The server holds **one `ScaffoldSession`** and nothing else; every decision is the session's
(SPEC-S §4.2). The screen driving it is [VIEWER-UI.md](VIEWER-UI.md#the-interview-screen).

The load-bearing detail: **the session stays parked in `awaitPick()` for the whole interview**, so
accepting simply resolves that pick with the directory it just wrote. There is no second parking
mechanism and no separate "scaffolding" mode in the main loop — it asked for a story and got one.
Everything short of `written` leaves the interview open: a folder still to name, or a story on disk
that does not load and can be refined and accepted again.

`scaffold` frames push the whole state on every transition. A round is a minute of model call and the
POST response only ever reaches whoever sent it, so a reload or a second tab has to be able to catch
up; `GET /scaffold` covers a viewer that loads mid-round. Neither is ever logged: an interview is not
part of any run's record.

Two guards worth naming. **One architect at a time** (409 while a round is in flight): two overlapping
rounds would interleave on one agent's history, which is the state the whole "it kept the parts I
liked" property rests on. And **an unknown action is 404 whatever the session is doing**, checked
before the state guards — a typo'd route name reported as a state problem sends you debugging the
wrong thing.
