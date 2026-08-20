# GUI-SPEC — the viewer's HTTP surface

Read this before adding a route, an SSE event, or anything a run control does to the run — and before
deciding whether the GUI under [server/gui/](server/gui/) could be swapped for something else. It is
written from the server's side: what [server/server.ts](server/server.ts),
[server/run-control-routes.ts](server/run-control-routes.ts),
[server/scaffold-routes.ts](server/scaffold-routes.ts),
[server/next-chapter-routes.ts](server/next-chapter-routes.ts) and
[server/run-log-routes.ts](server/run-log-routes.ts) actually expose, independent of the one
client that happens to consume it today.

## The shape of it

One Node process drives **at most one run at a time**. `--serve` starts an HTTP server
([server.ts:46](server/server.ts#L46)) alongside it; the server does not own the run, it watches and
steers the one the CLI process is already running. There is no database and no per-request session —
state lives in three module-level objects, [live.ts](live.ts)'s `LIVE`/`RUN`, a private `SCAFFOLD` in
`scaffold-routes.ts` and a private `HANDOFF` in `next-chapter-routes.ts`, and a browser reconnecting
just resubscribes to whichever run (if any) is already in flight. **No auth, no CORS headers, no CSRF token** — anything that can reach the port can steer the
run or start a new story. That is an accepted property of a local single-user tool, not an oversight.

What keeps it accepted is that the port is **bound to `127.0.0.1`**, not to every interface —
`startServer`'s `bindAddr` parameter, which nothing currently overrides. An unauthenticated surface
that lists local directories, reads run logs and starts runs has no business being reachable from the
LAN. Widening that bind means adding auth first; there is deliberately no CLI flag for it today.

Two channels carry everything:

- **JSON request/response** — plain `POST`/`GET`, `Content-Type: application/json`, no framework
  ([http-util.ts](server/http-util.ts)). Every `POST` replies `{ ok: true, ... }` or
  `{ ok: false, reason }` with a `4xx`/`5xx` status; a handful (`/select`, `/run`, `/stories`, `/models`)
  are read/mutate calls that reply with the resource itself instead of an `ok` envelope.
  `readJsonBody()` rejects rather than resolving `{}` when a body is malformed (`400`), larger than
  1 MiB (`413`), or carries a non-JSON `Content-Type` (`400`) — a *missing* content type is fine, since
  the viewer's no-body `POST`s send none. Those rejections are `HttpError`s, and one try/catch around
  the whole request handler turns them into responses, which is why no route parses its own body
  defensively. An unexpected throw becomes a generic `500`: the real message goes to the console, not
  to the browser.
- **Server-Sent Events on `/events`** — one shared stream, fanned out to every connected client
  ([live.ts:52](live.ts#L52)). This is not a notification side-channel; it is how the client learns
  a `POST` succeeded elsewhere (its own `fetch` replies too, but every other open tab or window
  finds out only through `/events`).

Nothing under `server/*.ts` imports `engine/`. Every route reaches the engine only through the
`ServerHost` interface built once in `story-writer.ts` ([server.ts:21](server/server.ts#L21)) — all of
it read-only or side-effect-free except the two session openers, `newScaffoldSession` and
`newHandoffSession`. A route that needs something new gets a host method, never an import (CLAUDE.md).

## Static routes

```
GET  /              → server/gui/viewer.html
GET  /viewer.css     → server/gui/viewer.css
GET  /viewer.js      → server/gui/viewer.js
GET  /viewer/{name}.js  → server/gui/viewer/{name}.js   (flat filenames only, regex allowlist)
```

These four lines are the **entire** coupling between the API and the specific GUI in this repo. They
serve fixed files by fixed path — nothing about them is generated from, or aware of, engine or story
state. See "Replacing the GUI" below.

## Session / run info

```
GET /run
  → { run: RunMeta | null, awaitingContinue, events: number, running, stopping, where,
      picking, armed, paused, pausing, model, interactive }
```
The snapshot a freshly-loaded page needs before its first SSE frame arrives. `run` is the static
`RunMeta` set once at scene start (`story`, `characters[]`, `target`, `question`); everything else
mirrors the live `run_state` SSE frame (below) — polled here once, pushed there after.

```
GET /stories
  → { stories: StoryCard[], picking: boolean }

StoryCard = { dir, name, ok, error?, warnings[],
              title?, premise?, scene?: {place,question,pov,length}, scenes?: {place,question,pov,length}[],
              characters?: {name,skills[],restrictions[]}[],
              maxSteps?, defaultModel?,
              runs: { id, mtimeMs, steps?, words?, done?, stopped? }[],
              chapters: number[] }
```
`title` is the story's own, as authored — empty when it has none, and never substituted with the
folder name; what to show in its absence is the client's call, and `name` is the folder. `scene` is
`scenes[0]`, kept because the shelf and scaffold interview read it; a card from an older server has
only that one. `chapters` lists the chapter numbers already written to `chapters/<n>.md`, in numeric
order. One call gets the whole picker: every discovered story, preflighted, with its own retained runs
embedded (`RunSummary[]`, newest first, capped at `MAX_RUNS = 3` — [story-writer.ts:309](story-writer.ts#L309)).
There is no separate "list runs" route; a run only exists as a story's `runs[]` entry.

```
GET /models
  → { ids: string[], reachable: boolean, current: string | null, architect: string }
```
`ids` is whatever LM Studio currently reports loaded; `reachable: false` means LM Studio itself could
not be reached (distinct from "reachable but empty").

```
GET /log.jsonl            → the in-progress run's writing-log.jsonl, or 404 before one exists
GET /runs/log?dir=&id=    → a retained run's writing-log.jsonl, or 404/400 if dir/id don't resolve
GET /chapter?dir=&n=      → an accepted chapter's markdown, or 404 if that chapter is not written
GET /runs/llm?dir=&id=    → 200 { ok:true, logs:[{ file, agent, role, models[], calls,
                                                   promptChars, responseChars }] }
GET /runs/llm/file?dir=&id=&file=
                          → that transcript's raw NDJSON, or 404 { ok:false, reason }
```
They serve the exact on-disk files. The event shapes are listed in the SSE section below. `dir` goes
through `host.selectableStory()` first, so it accepts anything the
picker itself would accept, not a raw filesystem path. `/chapter` also validates `n` against the story's
written chapters rather than trusting it.

The two `/runs/llm` routes read `out/<id>/llm/<agent>.jsonl`, one file per agent, each line
`{ ts, role, agent, model, prompt, response }`. `models` is a list because `/model` can swap a model
mid-run. **`file` is never validated by the route** — it is passed to the engine, which serves only
what its own directory listing named, so the allowlist is what is actually on disk rather than a
pattern. A run killed before its first generation lists nothing rather than failing. Both are
read-only: unlike the run-control routes, nothing here can reach a running scene.

## Story selection

```
POST /select   { dir, chapter? }
  → 200 { ok:true, dir } | 400 { ok:false, reason }
```
Only meaningful while `picking: true` (i.e. `LIVE.awaitingPick`). There is no queue — one browser
resolves the parked `Promise<{ dir, chapter }>` the CLI's `pickStory()` is blocked on
([story-writer.ts:267](story-writer.ts#L267)), and `picking` immediately goes false for everyone. A
second click after that returns `400 the session is not waiting on a choice`, not a second run.
`chapter` is which chapter that run writes — one run writes one chapter — and anything that is not a
positive integer falls back to `1` rather than failing the pick. Out of range for *this* story is not
caught here: `runChapter` rejects it when the run starts.

## Run control

All of these require a run already in flight (`running: true`) except `/interactive`, which is a
standing preference. Every one of them pushes a fresh `run_state` SSE frame on success, so a client
never needs to poll after calling one.

```
POST /stop                       → { ok:true, already? }
POST /pause                      → { ok:true, already? }
POST /resume                     → { ok:true } | 400 "not paused"
POST /continue        { steps }  → { ok:true } | 400 "no run is waiting on a budget decision"
POST /model            { model } → { ok:true } | 400 (must be paused first; must be a loaded id)
POST /interactive      { on }    → { ok:true }
POST /consult-me                 → { ok:true, already? } | 400 "interactive is off"
POST /reader-answer    { answer }→ { ok:true } | 400 (nothing pending, or answer is empty)
```

- **`/stop`** is idempotent (`already: true` on a second call) and also releases whatever the loop is
  currently blocked on — a pending `/continue` decision, an armed reader consult, a pause — so a stop
  never leaves the process hung waiting on an answer nobody will send.
- **`/pause` / `/resume`** don't interrupt an in-flight model call; `pausing: true` until the loop
  reaches its next boundary, then `paused: true`. `/model` while paused hot-swaps the model on the
  live `writer`/`agents` agents, not just the preference for the next run.
- **`/consult-me`** arms the reader as the **director** for the next round, not as a stand-in for a
  character. It does not itself ask a question: at its next boundary the loop spends a writer round
  asking for directions instead of prose ([scene-loop.ts:152](engine/scene-loop.ts#L152)), and that
  arrives as a `reader_ask` frame — `framing` plus up to three `options` — **not** as a `consult`.
  `/reader-answer` is how the human replies, and the answer is fed back as the direction the scene
  takes from here, so it need not be one of the three offered. `armed` in `run_state` means the
  reader is armed but not yet asked; it is cleared *before* the prompt goes out, so nothing in
  `run_state` reports an outstanding reader question — a client that needs that tracks `reader_ask`
  and `reader_answer` itself.
- **`/continue`** answers the step-budget prompt (`continue_prompt` SSE frame) with how many more
  steps to allow, `0` to stop there.

## Scaffold (the `--new` story interview)

```
GET  /scaffold
  → { active:false } | { active:true, idea, busy, haveStory, pendingAsk, problems[],
                          last: ScaffoldRound | null, needsFolder, model, spec }

ScaffoldRound =
  | { kind:"proposal"; note }
  | { kind:"edits"; applied:{field:string;before:unknown;after:unknown}[]; ignored[]; flags:string[]; note }
  | { kind:"question"; ask }
  | { kind:"nothing"; why }
  | { kind:"failed"; error }

POST /scaffold/start  { idea, model? }   → only while picking; opens a session, runs the first propose
POST /scaffold/say    { text }           → free-text turn; may return edits, a question, or a proposal
POST /scaffold/set    { field, value }   → direct edit, bypassing the model — today `field` may only
                                            be `"scene.length"` ([story-spec.ts:132](engine/story-spec.ts#L132)'s
                                            `DIRECT_FIELDS`); anything else is 400 "the architect's to change"
POST /scaffold/accept { folder? }        → { ok:true, kind:"written", dir, files[], warnings[] }
                                            | { ok:false, kind:"unloadable"|"needs_folder"|"no_story", ... }
POST /scaffold/abandon                   → drops the session unconditionally, always { ok:true }
```
One session at a time (`scaffoldBusy` is a module-level lock — a second `POST` while a round is in
flight gets `409`). `accept` only resolves the parked story pick on `kind: "written"`; every other
outcome leaves the interview open for another `/scaffold/say`. Every scaffold route also republishes
a `{ t: "scaffold", state }` SSE frame (`state` is exactly the `GET /scaffold` body), so this is really
one more small state machine layered on the same "poll once, then follow SSE" pattern as the run itself.

## The handoff (preparing the next chapter)

```
GET  /next-chapter
  → { active:false } | { active:true, dir, chapter, busy, edited, pendingAsk, problems[],
                          last: ScaffoldRound | null, model, spec }

POST /next-chapter/start   { dir, model? }  → opens the handoff on a discovered story and runs the
                                               first round; 400 if the story is unknown, or has no
                                               `chapters/<n>.md` written for the handoff to read
POST /next-chapter/say     { text }         → a follow-up, in the same edits-only format
POST /next-chapter/accept                   → { ok:true, kind:"written", chapter, dir, files[], warnings[] }
                                               | { ok:false, kind:"unloadable"|"nothing", ... }
POST /next-chapter/abandon                  → drops the session unconditionally, always { ok:true }
```

The handoff re-authors the cast *between* runs and writes `story.json` — it never starts a run and
never resolves the story pick, so unlike `/scaffold` it does not care whether `picking` is true. It
does care that `running` is false: every action but `abandon` is `409 a run is in flight`, because the
run in flight is reading the file the handoff would rewrite. `handoffBusy` is the same
one-round-at-a-time lock as the scaffold's (`409` for a second `POST` mid-round), and rounds share
`ScaffoldRound` minus `proposal` — the handoff only ever returns edits, a question, nothing, or a
failure.

An edits round has four separate result lists: `applied` changes, `ignored` edits that were not
applied, `flags` advisory continuity observations, and `problems` on the surrounding state. `flags`
are non-blocking and are never resolved implicitly through edits. Scaffold edits also return
`flags: []` because the same `ScaffoldRound` shape is shared by both screens.

`accept` writes over the story that is already there, so it validates by writing and then running
`runPreflight`: on failure it **puts back exactly what was on disk** and answers `kind:"unloadable"`,
leaving the session open to keep refining. Only `kind:"written"` means the file changed. `chapter` in
that reply is the chapter now prepared — write it with `POST /select { dir, chapter }`.

Every handoff route republishes a `{ t: "handoff", state }` SSE frame (`state` is exactly the
`GET /next-chapter` body). The viewer's handoff page consumes it
([handoff.js](server/gui/viewer/handoff.js)); the screen itself is designed in
[Architect.MD](Architect.MD).

## `/events` — the SSE stream

One connection, `text/event-stream`, replayed from the top on every reconnect: `retry: 3000`, then the
full `liveHistory` backlog for the current run, then a fresh `run_state`, then live frames as they
happen, plus a 15s comment ping to hold the connection open. `liveHistory` (and its sequence numbers)
resets on `resetLive()` at the start of each new run — so reconnecting mid-run replays that run only,
never a previous one.

Every frame is `data: <json>\n\n`. The union, `LiveFrame` ([live.ts:37](live.ts#L37)):

```
{ seq, ...RunEvent }                     — see below; seq makes ordering/de-dup possible client-side
{ t:"composing"; who; secs; chars }      — an agent is mid-generation (progress ticker, not logged)
{ t:"idle" }                             — nothing composing right now
{ t:"continue_prompt"; steps; budget; suggested }  — step budget spent, needs a /continue
{ t:"run_state"; running; stopping; where; picking; armed; paused; pausing; model; awaitingContinue; interactive }
{ t:"run_reset" }                        — a new run is about to start; discard everything and refetch
{ t:"run_error"; message }               — a story failed to load or run; the picker is coming back
{ t:"scaffold"; state }                  — mirrors GET /scaffold
{ t:"handoff"; state }                   — mirrors GET /next-chapter
```

`run_error` is session-level, not a `RunEvent`: it carries no `seq`, never enters `liveHistory`, and
so is never replayed — a client that connects afterwards sees only the recovered picker. It is sent
from `main()`'s catch, which then re-enters `pickStory()`. The viewer holds it in `APP.runError`
rather than `APP.storyError` precisely because the pick window that opens a moment later clears
`storyError`, which would otherwise wipe the message before it could be read.

`RunEvent` ([scene-loop.ts:49](engine/scene-loop.ts#L49)) is the part that also gets written to
`writing-log.jsonl` — `/events`, `/log.jsonl` and `/runs/log` are three windows onto the same event
sequence, live/current/retained:

```
ConsultEvent (engine/consult.ts:80):
  { t:"consult"; character; situation; question; wants; attempt }
  { t:"need"; character; question }
  { t:"clarify"; character; question; answer }
  { t:"forced"; character }
  { t:"repair"; character; why }
  { t:"skill_flag"; character; claimed[]; unknown[] }
  { t:"answer"; character; thought; speech; action; note; skills_used[]; unverified[] }

plus, scene-loop-level:
  { t:"scene_start"; story; characters[]; target }
  { t:"draft"; step; prose; words; consulting; salvaged }
  { t:"bad_consult"; character; why }
  { t:"judge"; character; verdict; note; attempt }
  { t:"accept"; character; attempt; speech; action }
  { t:"retry"; character; attempt; situation; question }
  { t:"budget"; added; budget }
  { t:"reader_ask"; step; framing; options[] }
  { t:"reader_answer"; answer }
  { t:"model_changed"; model }
  { t:"retry_capped"; character; count }
  { t:"scene_end"; steps; words; done; stopped; retries{character:count} }
```

`wants` in `consult` is always one of `speech | action | decision | reaction` — the same four words
`prompts.ts`'s `CONSULT_WANTS` sends the writer and the character (prompts.ts's single source of truth
for that vocabulary, so the API and the model prompt can never drift apart).

## Replacing the GUI

**Yes — the API is a complete, self-describing surface, and [server/gui/](server/gui/) is not privileged
against it.** Two things make that true:

1. **The four static routes are the entire coupling.** They serve fixed files by path; nothing in
   `/run`, `/stories`, `/models`, `/select`, run control, scaffold, or `/events` reads or writes
   anything under `server/gui/`, checks a `User-Agent`, or otherwise assumes a particular client. A
   second frontend calling this same API from the same origin is indistinguishable, server-side, from
   the shipped one.
2. **Every route reaches the engine only through `ServerHost`.** No route module imports `engine/`
   directly (CLAUDE.md's own invariant), so the API's behavior is exactly the `ServerHost` methods
   plus the `LIVE`/`RUN`/`SCAFFOLD`/`HANDOFF` state machine described above — nothing lives only in
   `server/gui/*.js` that a route depends on.

What a replacement would actually need to reproduce, none of it GUI-specific:

- **Poll-then-follow.** `GET /run`, `/stories`, `/models`, `/scaffold`, `/next-chapter` for first paint; everything
  after that arrives on `/events`. A client that only polls will work but will visibly lag — there is
  no `ETag`/long-poll alternative to SSE.
- **The two parked-`Promise` handshakes.** `/select` and `/scaffold/accept(kind:"written")` are the
  only ways the CLI process's `pickStory()` ever resolves; a client that never calls one of them can
  watch a run forever but can never start the *next* one. `/consult-me` + `/reader-answer` is the same
  shape for a mid-run interjection.
- **`run_state`'s guard fields as real preconditions, not decoration** — `/resume` before `pause` has
  landed, `/model` while unpaused, `/continue` with nothing pending, and a second `/scaffold/*` while
  `busy` all `4xx` rather than queue. A replacement has to honor the same ordering, not just the same
  field names.
- **One connection assumption.** `sseClients` is a plain `Set`; nothing partitions frames by client, so
  every connected browser — original GUI, replacement, or both at once — sees the identical stream and
  can drive the identical controls. Running the shipped viewer and a new one side by side to compare
  behavior costs nothing extra on the server.

What is **not** available through this API, and would need a new route (a `ServerHost` addition, not a
GUI trick) rather than being derivable client-side: editing a story's files field by field
(`/next-chapter` rewrites `story.json`, but only what the architect proposes and the reader accepts),
reading a story's full cast — `knows`, `goal` and `persona` — for a story that is not in a scaffold or
handoff session, starting a run without going through the picker/scaffold handshake, or anything about
a run that already fell out of `MAX_RUNS` retention. The first two are proposed in
[PLANS.md](PLANS.md) (plans 1 and 2C), which is also where the routes they would add are drafted.

If "replace" means **serve the new frontend from somewhere other than this process** (a separate dev
server, a static host): the JSON/SSE routes have no CORS headers today, so a different-origin client
would 405/opaque-fail on `fetch` until `Access-Control-Allow-Origin` (and SSE's own CORS story) is
added — a small, contained change to `server.ts`, not a redesign. Same-origin (served by this process,
which is what the four static routes already do) needs nothing extra.
