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
state lives in three module-level objects, [live.ts](live.ts)'s `LIVE`/`RUN` and, private to
[host.ts](host.ts), the open scaffold interview (`SCAFFOLD`) and the open handoff (`HANDOFF`) — no
route module holds either directly, only `ServerHost.scaffold*()`/`handoff*()` methods reach them —
and a browser reconnecting just resubscribes to whichever run (if any) is already in flight. **No
auth, no CORS headers, no CSRF token** — anything that can reach the port can steer the run or start a
new story. That is an accepted property of a local single-user tool, not an oversight.

What keeps it accepted is that the port is **bound to `127.0.0.1`**, not to every interface —
`startServer`'s `bindAddr` parameter, which nothing currently overrides. An unauthenticated surface
that lists local directories, reads run logs and starts runs has no business being reachable from the
LAN. Widening that bind means adding auth first; there is deliberately no CLI flag for it today.

### Headless

`--headless` starts the server without a story argument, a console picker, or a one-shot run: the
process comes up serving, the browser drives everything from the shelf, and SIGINT/SIGTERM shut it
down gracefully — a run in flight takes the same path a `/stop` takes (`releaseForStop()`, then
`stopRun()`) so `run-and-save`'s streams flush before the process exits; a second signal force-exits.
`startServer` returns a `ServerHandle` (`bound`, `close()`), which is how shutdown ends the SSE
clients, stops the keep-alive ping and frees the port — after a `close()` a fresh `startServer` may
bind again. Outside headless the console owns Ctrl-C and no signal handlers are installed. Headless
also keeps the console echo on (`ENGINE.echoConsole`): the draft prose and the characters' acts and
replies print as they land, because the console is the monitor the operator has — under plain
`--serve` the console stays quiet, the viewer being the monitor. `--no-cast-echo` trims just the
characters' replies (`acts:`/`reacts:`/consult answers) from that echo, in any mode; the prose and
the JSONL/SSE record are untouched by it.

One rule that has no other home: **operational messages stay in the console and run data stays in
the JSONL logs — the GUI never becomes a second source of truth.**

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

Nothing under `server/*.ts` imports `engine/` — not even as a type, for `engine/architect.ts` or
`engine/story-spec.ts` specifically ([tests/boundaries.test.ts](tests/boundaries.test.ts) checks
both claims). Every route reaches the engine only through the `ServerHost` interface built once in
`story-writer.ts` ([server.ts:21](server/server.ts#L21)). The scaffold and handoff domains are
entirely behind it: no route module holds a `ScaffoldSession` or a `NextChapterSession`, only
`ServerHost.scaffold*()`/`handoff*()` methods, each wire-shaped in and returning a plain result type
declared in `server.ts`. A route that needs something new gets a host method, never an import
(CLAUDE.md).

## Static routes

```
GET  /              → server/gui/viewer.html
GET  /viewer.css     → server/gui/viewer.css
GET  /viewer.js      → server/gui/viewer.js
GET  /viewer/{name}.js  → server/gui/viewer/{name}.js   (flat filenames only, regex allowlist)
GET  /studio           → mockups/studio/index.html        (static dev/preview route — not part of the product surface)
```

These four lines are the **entire** coupling between the API and the specific GUI in this repo. They
serve fixed files by fixed path — nothing about them is generated from, or aware of, engine or story
state. See "Replacing the GUI" below.

## The viewer's navigation

The page is a persistent shell — topbar, srcbar breadcrumb, sidenav, run rail — over one `#page` the
current view replaces. The sidenav's three groups are the author's mental model, not the schema's:
**Stories** (`shelf` — My stories, `scaffold` — + New story), **Workspace** (`scaffold`/`handoff` —
Architect, whichever session is live; `story` — Story map; `live` — Write; `readstory` — Manuscript;
`read` — Saved runs), and **Libraries** (the character catalog's four kinds, one entry each:
`characters`, `styles`, `tags`, `skills`). The principle the grouping follows: **the GUI exposes the
author's mental model, while the schema remains the engine's executable model** — nothing in the nav
names a `story.json` top-level object.

The view strings are a URL contract, not UI labels: `#/shelf`, `#/story?dir=`, `#/live`, `#/read?dir=&id=`,
`#/readstory?dir=`, `#/compare?dir=&a=&b=`, `#/scaffold`, `#/handoff?dir=`, `#/edit?dir=` or `#/edit?new=1`,
and `#/catalog?kind=`. Sub-page targets ride along — `&block=` names a consult to open, `&modal=` the
character card to reopen — so the URL a bug report pastes is the pinpoint. Views are renamed in the
labels only; the strings behind the hash never change, because bookmarks and pasted URLs outlive any
rendering.

Reachability has one rule, in `go()`: with no engine attached, every view but `read`, `readstory` and
`compare` is rewritten to `read`. The nav does not restate that rule — it reads it. An item whose
destination is unreachable hides rather than landing somewhere other than where it says, and a group
whose every item is hidden hides with its children. A hidden view is not a removed one: `live`,
`read`, `compare` and `edit` have no nav entries of their own beyond those five, and are reached from
the pages that own them (a story card, a run list, the story page's buttons). The catalog's kind is
seeded from the URL on arrival; inside the page the kind switcher owns it (below, *Character catalog*).

## Session / run info

```
GET /run
  → { run: RunMeta | null, awaitingContinue, events: number, running, stopping, where,
      picking, loading, armed, paused, pausing, model, interactive }
```
The snapshot a freshly-loaded page needs before its first SSE frame arrives. `run` is the static
`RunMeta` set once at scene start (`story`, `characters[]`, `target`, `question`); everything else
mirrors the live `run_state` SSE frame (below) — polled here once, pushed there after. `loading`
is the window between a story being chosen (`picking` going false) and its run actually starting:
every route that writes `story.json` refuses with `409` while it holds.

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
embedded (`RunSummary[]`, newest first, capped at `MAX_RUNS = 10` — [run-and-save.ts:15](run-and-save.ts#L15)).
There is no separate "list runs" route; a run only exists as a story's `runs[]` entry.

```
GET /models
  → { ids: string[], reachable: boolean, current: string | null, architect: string }
```
`ids` is whatever the configured provider reports as AVAILABLE (with just-in-time loading, LM
Studio lists downloaded models too — this is the pick-from list, not a residency report);
`reachable: false` means the provider itself could not be reached (distinct from "reachable but
empty").

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
`{ ts, role, agent, model, prompt, response, durationMs, usage, finish_reason }` — plus `reasoning`
(the model's chain-of-thought) when the server delivered it as a field separate from the answer,
`reasoningOnly: true` when the whole reply arrived through that channel instead, and
`broken_off: true` when the reply was salvaged from a stream that broke mid-flight. `models` is a
list because `/model` can swap a model
mid-run. **`file` is never validated by the route** — it is passed to the engine, which serves only
what its own directory listing named, so the allowlist is what is actually on disk rather than a
pattern. A run killed before its first generation lists nothing rather than failing. Both are
read-only: unlike the run-control routes, nothing here can reach a running scene.

## Saved-run comparison

The viewer's comparison screen is a client-side view, not an additional HTTP route:

```
#/compare?dir=...&a=...&b=...
```

`dir` identifies the story and `a`/`b` identify two retained runs from that story. The picker only
allows runs with known chapter numbers from the same chapter. Each selected run is fetched separately
through `GET /runs/log?dir=&id=` and `GET /runs/llm?dir=&id=`. The two panes use the same event and block
renderer as the single-run reader, with independent agent and transcript state.

The prose diff above the panes is assembled from `draft.prose` events in event order. Consult answers,
diagnostics and other non-draft events are not part of the prose. The diff is a client-side,
dependency-free word comparison: unchanged words are plain, additions are highlighted, and removals
are struck through.

## Story selection

```
POST /select   { dir, chapter?, replace? }
  → 200 { ok:true, dir } | 400 { ok:false, reason }
```
Only meaningful while `picking: true` (i.e. `LIVE.awaitingPick`). There is no queue — one browser
resolves the parked `Promise<{ dir, chapter }>` the CLI's `pickStory()` is blocked on
([app.ts:129](app.ts#L129)), and `picking` immediately goes false for everyone. A
second click after that returns `400 the session is not waiting on a choice`, not a second run.
`chapter` is which chapter that run writes — one run writes one chapter — and anything that is not a
positive integer falls back to `1` rather than failing the pick. Out of range for *this* story is not
caught here: `runChapter` rejects it when the run starts.

`replace: true` authorizes writing over an existing chapter or skipping past an unwritten one —
the viewer's counterpart of the CLI's `--replace`. The story page confirms both with the user
before sending it; without it, the run refuses before starting (`chapters/` is the durable record).
The handoff's start button does not send it, so a collision there surfaces as a refusal, not a
silent overwrite.

## Story editor

```
GET  /story/edit?dir=...     → { ok:true, story: StoryJson, warnings[] }
                               | { ok:false, error, raw? }
GET  /story/edit-config      → { defaults, thinkingLevels, caps }
POST /story/check  { story } → { ok:true, warnings[] }
                               | { ok:false, error, issues[] }
POST /story/save   { dir, story } → { ok:true, warnings[] }
                                     | { ok:false, reason }
POST /story/discard { dir, n }    → { ok:true, chapter, scenes }
                                     | { ok:false, reason }
POST /story/suggest { spec, text } → { ok:true, kind:"edits",
                                       spec, applied, ignored, problems, note }
                                     | { ok:true, kind:"question", ask }
                                     | { ok:false, error }
```

`/story/edit` loads the full Zod-parsed `StoryJson` from disk for editing, plus engine-level
warnings. Returns `{ ok: false, raw }` when the file is on disk but will not parse, so the editor
can show the error and the raw content.

`/story/edit-config` is story-independent: schema-derived run-config defaults, the five thinking
levels, and the voice-sample cap, for the editor and the new-story form to render without
hand-copying `story-schema.ts`'s own defaults. Never blocked by the story-write lock — it names
nothing about any one story.

Every mutating action here (`edit`, `save`, `discard`, `suggest`) refuses with `409` while
something else is reading or writing `story.json`: a run in flight, the loading window after a
pick (`loading: true`), or an open handoff holding the file it will rewrite on accept. The refusal
reason names which — editing the definition a live run is reading would be a race.

`/story/check` validates a modified draft in memory against the Zod schema and engine-level checks
(empty premise, no characters, scenes without questions). Never writes.

`/story/save` validates, atomically writes via `.tmp` rename, then re-loads to confirm. Refuses
with `409` under the same story-write lock as `/story/edit`.

`/story/discard` drops the last authored scene from `story.json` — the undo for an
accepted-but-never-written chapter the handoff added. Refuses any scene but the last, the sole
scene (`scenes` is `min(1)`), a chapter already written (its prose would be orphaned), and anything
holding the story-write lock. Writes through the same atomic path as `/story/save`. The story page
offers it only on the trailing unwritten scene's row.

`/story/suggest` is a stateless architect call: given the current story spec and the author's
instruction in `text`, creates a fresh architect agent, sends the change prompt, and returns the
proposed edits together with the edited `spec`. On an `edits` reply the editor adopts that spec into
its draft as unsaved changes (the reply was computed from the draft it was sent, so manual edits
travel with it) and re-validates; nothing reaches disk until a save — the engine never writes from a
suggestion.

The story editor renders each scene's `reach` — the scene-scoped capability grants
([Architect.MD](Architect.MD), I1) — as one textarea per scene, one
`NAME: thing :: meaning` per line. Reach round-trips through `/story/check` and `/story/save`
inside `StoryJson`'s scenes; it is character-in-place data and never appears on a character card in
the editor.

## Character catalog

```
GET  /catalog?kind=characters        → { ok:true, entries[] }
                                       | { ok:false, reason }
GET  /catalog/config                 → { tagFacets, caps }
GET  /catalog/usage                  → { ok:true, usage }   (read-only derivation, below)
GET  /catalog/entry?kind=&id=        → { ok:true, entry }
                                       | { ok:false, reason }        (400 no id · 404 no such entry)
POST /catalog/check  { entry }       → { ok:true, problems[] }
                                       | { ok:false, issues[] }      (both 200)
POST /catalog/save   { kind?, entry }→ { ok:true, entry, problems[] }
                                       | { ok:false, reason, issues? }
POST /catalog/delete { kind?, id }   → { ok:true }
                                       | { ok:false, reason }        (400 no id/kind · 404 no such entry)
```

A catalog is **global**: it lives beside `defaults.json`, not inside a story. So unlike the story
editor these routes take no `dir`, and none of them consults the story-write lock — a run reading one
story's `story.json` has no bearing on a shelf of reusable characters. `/catalog/config` is the
catalog's own schema-derived shape — the tag facet enum and the character voice-sample cap — for the
catalog editor to render without hand-copying `catalog-schema.ts`. `kind` selects which catalog —
`characters`, `tags`, `styles` or `skills` — and decides the filename; an unknown kind is `400`,
validated in the host because it arrives from a query string. Every route above is
kind-parameterised, so a new kind is a registry entry in `engine/catalog.ts` and never a new route.

A **character** entry is the **portable half** of a character: `id`, `version`, `name`, `tags[]`,
`portablePersona`, `belief`, `impulse`, `voice[]`, `skills[]`, `restrictions[]`. There is
deliberately no `goal` and no `knows` — those are story-positional — and no `model` or `maxRetries`,
which are run configuration. What a catalog entry is and how it composes into a `CharacterDef` is
[Architect.MD](Architect.MD)'s *Character catalog*. The other three: a **tag** is `id`, `version`,
`facet`, `label`; a **style** is `id`, `version`, `name`, `tags[]`, `description`, `voice`; a
**skill** is `id`, `version`, `name`, `meaning`, `tags[]`, and its `meaning` is the one prose field
in any kind the schema refuses rather than reports missing ([Architect.MD](Architect.MD)'s *Skill
bible* says why).

`tags` and `skills` **seed** — a `GET` against a catalog whose file does not exist yet answers with
the engine's starting vocabulary rather than an empty list, and the first save writes that whole seed
out beside the edit. Once the file exists it wins entirely; a seeded entry the author deleted does
not come back.

**`issues` and `problems` are different answers and never merge.** `issues` are schema failures and
nothing was written; `problems` are advisory (no belief, no voice samples, a skill carrying no
`:: meaning`, a portable persona that names something story-specific) and the entry **was** written.
`/catalog/check` returns either at `200`, because a validation verdict is an ordinary answer rather
than an HTTP error; `/catalog/save` returns `issues` with `400`, since that one really did refuse.

`/catalog/save` upserts on `id` and assigns `version` itself — 1 for a new entry, the stored version
plus one for a replacement. A version sent by a caller is overwritten, so it is never a way to
choose one. Both writes go
through the same atomic `.tmp` rename as `/story/save`, then re-read and assert what they expected to
find: that the entry is present at its new version, or that a deleted id is gone.

`GET /catalog/usage` derives what the other catalogs reference — the "used by 4 characters" line and
the tag page's grouping. **Derived, not authored**: a tag's counts come from the characters, styles
and skills whose `tags[]` fold to its label; a skill's count from the characters whose `skills`
lines name it, matched the way every identity comparison is. The tag page's STORY/STYLE split is the
same derivation — a tag is **STYLE** when some style carries it, **STORY** when none does — so the
editor gains no "used for" checkbox, and the grouping moves the moment a style picks the tag up. It
reads the catalogs it was asked for and nothing else; a failure to derive is the caller's to
decorate away, which the viewer does by keeping its last known counts.

## Read-only cast view

```
GET /cast?dir=...  → { ok:true, characters[], scenes[] }
                   | { ok:false, error }
```

Available while a run is in flight (the live rail needs it exactly then). Each character carries
`name`, `persona`, `knows`, `goal`, `belief`, `impulse`, `voice`, `skills` (as `{text, meaning}`),
and `restrictions`; `model` is omitted. `scenes` carries the per-scene reach grants as
`{ n: number, reach: { NAME: ["thing :: what they can do through it"] } }`. **Reach never merges into
a character's `skills`** ([Architect.MD](Architect.MD) I4): the GUI labels each grant with its scene,
so it can never read as intrinsic.

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

## Scaffold (the new-story interview)

```
GET  /scaffold
  → { active:false } | { active:true, idea, mode, busy, stage, gate, tension, concept, haveDraft, haveStory,
                          pendingAsk, problems[], bibleCandidates[], last: ScaffoldRound | null,
                          needsFolder, model, spec, storyDraft }

bibleCandidates = { name: string, meaning: string, heldBy: string[] }[]

concept =
  { tags: string[], castSize: number, unknownTags: string[], tagsSteer: boolean, castSizeSteers: boolean,
    imported: { libraryId: string, version: number, name: string }[],   // the import tray
    missingImports: string[],                                            // ids the catalog no longer holds
    importsSteer: boolean,
    styleId: string, styleName: string,                                  // the chosen voice preset, "" for none
    missingStyle: string,                                                // an id the catalog no longer holds
    styleSteers: boolean }

ScaffoldRound =
  | { kind:"proposal"; note; stage? }        — staged rounds carry the gate they belong to
  | { kind:"edits"; applied:{field:string;before:unknown;after:unknown}[]; ignored[]; flags:string[]; note; stage? }
  | { kind:"question"; ask; stage? }
  | { kind:"nothing"; why; stage? }
  | { kind:"failed"; error }

POST /scaffold/start    { idea, model?, mode?, tags?, castSize?, importIds? }
                                                → only while picking; opens a session and runs the
                                                  first proposal. `mode` picks the walk:
                                                  "staged" (the default) runs the gated checklist —
                                                   story → cast → settings → technical → scene → world,
                                                  an author approval between stages — and "oneshot" is
                                                  the whole-story proposal. The state's `gate` names the
                                                  open stage ("story"…"world"), null on a one-shot session.
POST /scaffold/say      { text }           → free-text turn; may return edits, a question, or a proposal.
                                             In staged mode it refines within the open gate (back-edits
                                             to earlier stages included) or answers `pendingAsk`.
POST /scaffold/approve                     → staged mode only: pass the open gate and propose the next
                                             stage's content. Refused as a round (not an HTTP error):
                                             on a one-shot session (`kind:"failed"`), while a question
                                             stands, when the gate's content never landed
                                             (`kind:"nothing"`, "has not landed"), or past the last gate
                                             ("checklist is complete").
POST /scaffold/concept  { tags?, castSize?, styleId? }
                                           → revises the author's concept on the open session.
                                             Same bounds as `start`, and `400` on either. Every
                                             field is read: one the client omits is not "unchanged",
                                             it is empty, and the pick it names is cleared. Never
                                             re-runs a gate: it changes what the NEXT build of a
                                             stage prompt says, which for a stage already passed
                                             is nothing — the `*Steer` flags are what say whether
                                             that is still any stage at all.
POST /scaffold/import   { importIds }      → replaces the import tray on the open session, wholesale
                                             rather than incrementally: the author's pick is a set,
                                             and a partial update would need a second answer for what
                                             absence means. At most 4 (the cast stage's ceiling);
                                             `400` past that. Ids the catalog cannot resolve come back
                                             in `concept.missingImports` rather than failing the call.
POST /scaffold/promote  { name }           → puts one of `bibleCandidates` into the author's skill
                                             bible. Only a name the session is currently offering is
                                             accepted (`400` otherwise), so the wire cannot name an
                                             arbitrary skill and have it written to the catalog. The
                                             open session is handed a lookup over the new bible, and
                                             the candidate is gone from the reply because the list is
                                             re-derived, not edited.
POST /scaffold/set      { field, value }   → direct edit, bypassing the model — today `field` may only
                                             be `"scene.length"` (`DIRECT_FIELDS`); alternatively
                                             `{ story }` replaces the in-memory draft from the full
                                             schema-aware editor. Neither form writes a story directory.
POST /scaffold/accept   { folder? }        → { ok:true, kind:"written", dir, files[], warnings[] }
                                            | { ok:false, kind:"unloadable"|"needs_folder"|"no_story", ... }
POST /scaffold/abandon                     → drops the session unconditionally, always { ok:true }
```

`stage` is `""` while the main proposal/edit round itself is running, then briefly `"fillGaps"` or
`"verify"` while each automatic follow-up pass runs after a successful round, and `""` again once the
whole exchange settles. A one-shot session runs both passes after its proposal; a staged session asks
for roster and facts in its own stages, so only `"verify"` ever appears there, once after the scene
stage lands. Do not confuse it with `gate`, which is the checklist position and persists between rounds.

`tension` is the load-bearing conflict sentence the staged story stage coins. It is session state, never
a `story.json` field, so it reaches the GUI only through this state object — read-only, for display; the
architect edits it by field name (see `/scaffold/say`) but it never lands on disk. Empty on a one-shot
session and until the story stage names it.

`concept` is the author's half of the same kind of state, and the mirror of `tension`: chosen before
the architect runs rather than coined by it, session-only, discarded at accept. `tags` reach the story
stage's prompt and `castSize` the cast stage's, and neither is read anywhere else — a one-shot session
has no gate for either, so both `*Steer` flags are false there. `unknownTags` are the ones the tag
catalog does not hold; they are sent to the architect anyway, because that catalog is a seed the author
edits rather than a gate. **The bounds are enforced at the route, not trusted from the client** — at
most 8 tags, 40 characters each, and a `castSize` of 0 (meaning "architect decides") through 4, which
is the cast stage's own ceiling. This is the one place author text reaches a prompt without passing
through the architect first.

The four `*Steer` flags answer one question each: *would the next build of that stage's prompt read
this?* Tags are live while the story gate is open; the cast size and the tray are live until a cast
exists — which means both are at their most live during the STORY gate, before the cast prompt has
ever been built. The style is live until the settings gate has put a voice on the spec, so it survives
the story and cast rounds for the same reason. Once false, revising that half changes a string nothing
will read again, and the viewer stops offering to.

`imported` is the tray: the characters the author cast out of the catalog, carried as provenance and
name only, because that is all a page needs. A non-empty tray forces `castSizeSteers` false — the tray
IS the opening cast's size — and switches the cast gate to a different stage prompt with an enforced
adaptation contract ([Architect.MD](Architect.MD), *Casting from the library*). It is session state
that ends at accept: no part of it reaches `story.json`, and the handoff never learns a character came
from a template. `missingImports` are ids the catalog no longer holds; they are reported rather than
fatal, because the catalog is the author's and a tray that silently shrank is worse than one that says
what it lost.

`styleId` / `styleName` are the voice preset the author picked out of the style catalog, resolved by
the host so a page never has to. Chosen, it narrows the settings gate to this story's own narration
rules and its `voice` becomes `writerStyle` verbatim; unchosen (`""`), that gate writes the whole house
style as it always did. `missingStyle` is an id the catalog no longer holds — reported, not fatal, for
the same reason `missingImports` is. Like the tray, none of it reaches `story.json`: the voice does,
but which preset it came from does not.

`bibleCandidates` are the bespoke skills this cast holds that the author's skill bible does not:
a skill carrying its own `:: meaning` whose name is neither a general skill nor already in the bible.
They are **derived from the spec on every read**, never stored — a candidate stops being one the
moment it is promoted or the cast stops holding it, and a stored list would go stale both ways.
Writing `name :: meaning` on a character IS the proposal, so nothing is asked of the model for this;
reach is never a candidate (I4). Promotion is a gate distinct from accepting the story: accepting
never writes a bible entry.

`haveDraft` becomes true as soon as any authored story field lands, so the first staged story gate can
be reviewed before a cast exists. `spec` is present whenever `haveDraft` is true. `haveStory` keeps its
stricter meaning: a cast exists and the draft is eligible for the edit and accept flows.

`storyDraft` is present under the same `haveDraft` condition as `spec`, but StoryJson-shaped rather
than specView's GUI-facing shape (no `scene` alias, skills not exploded into `{text, meaning}`) — it
is what the "review new story" screen loads as its editor draft directly, the same shape
`/story/edit` hands the ordinary story editor. `spec` stays specView-shaped for the interview's own
read-only proposal card, which wants the exploded skills and the `scene` alias.

One session at a time (`scaffoldBusy` is a module-level lock — a second `POST` while a round is in
flight gets `409`). `accept` only resolves the parked story pick on `kind: "written"`; every other
outcome leaves the interview open for another `/scaffold/say`. Every scaffold route also republishes
a `{ t: "scaffold", state }` SSE frame (`state` is exactly the `GET /scaffold` body), so this is really
one more small state machine layered on the same "poll once, then follow SSE" pattern as the run itself.

**Abandon is stronger than any round in flight.** It drops the session immediately and always answers
`{ ok: true }`; the abandoned round keeps its busy lock until its own work finishes, but finds the
session gone when it returns — it commits nothing, publishes nothing, and its own caller gets
`409 the interview was abandoned`. The same holds for an `accept` overtaken by an abandon: the write
may already have created the story folder (the refusal says so), but the pick stays parked and no run
starts.

## The handoff (preparing the next chapter)

```
GET  /next-chapter
  → { active:false } | { active:true, dir, chapter, busy, stage, edited, pendingAsk, problems[],
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
does care that nothing else holds `story.json`: from opening (`start`) until it ends (accept,
abandon, or failure) the handoff holds the same story-write lock the editor's routes refuse under,
and every action but `abandon` is `409` with that lock's reason while a run is in flight or a picked
story is still loading — the thing in flight is reading the file the handoff would rewrite.
`handoffBusy` is the same one-round-at-a-time lock as the scaffold's (`409` for a second `POST`
mid-round), and rounds share `ScaffoldRound` minus `proposal` — the handoff only ever returns edits,
a question, nothing, or a failure.

Abandon during a round behaves exactly as the scaffold's: the session drops at once and the round,
on returning, commits and publishes nothing — its caller gets `409 the handoff was abandoned`, and
an accept overtaken mid-write also warns that `story.json` may have been rewritten while releasing
the editor's lock either way.

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
{ t:"agent_stats"; who; model; durationMs; promptTokens; completionTokens }
                                          — one completed model call; token fields are null when unavailable
{ t:"continue_prompt"; steps; budget; suggested }  — step budget spent, needs a /continue
{ t:"run_state"; running; stopping; where; picking; loading; armed; paused; pausing; model; awaitingContinue; interactive }
{ t:"run_reset" }                        — a new run is about to start; discard everything and refetch
{ t:"run_error"; message }               — a story failed to load or run; the picker is coming back
{ t:"provider_state"; provider; baseUrl; inFlight; depth; current; lastFailure }
                                           — the inference server's request line changed: a call took
                                           or released the slot, a caller queued or gave up, or a call
                                           failed. `current` names the holder ("" when idle) and
                                           `lastFailure` is the transport's classification of the
                                           most recent failure (null before one). Sent on change only,
                                           never on a timer — the srcbar chip paints it
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
  { t:"clarify_failed"; character; question }    — the call to answer this never came back;
                                                   no slot spent, nothing fabricated
  { t:"prose_reply"; character }                 — the reply was read through the labelled-prose
                                                   fallback rather than as JSON
  { t:"forced"; character }
  { t:"repair"; character; why }
  { t:"answer"; character; thought; speech; action; note }

plus, scene-loop-level (`chapter` is present on every one of them except `model_changed`):
  { t:"scene_start"; story; characters[]; target }
  { t:"draft"; step; prose; words; consulting; salvaged }
  { t:"bad_consult"; character; why }
  { t:"schema_mismatch"; call:"judge"|"clarify"|"lint"; character }
  { t:"judge_failed"; character; why }            — the judge call itself threw; the answer was
                                                   accepted with no judgement made, not defaulted-to-accept
  { t:"judge"; character; verdict; note; attempt }
  { t:"accept"; character; attempt; speech; action }
  { t:"retry"; character; attempt; situation; question; was; wantsRefused }
                                                 — `was` is the question this one replaces, and
                                                   `wantsRefused` the shape the judge asked to change
                                                   to and did not get; together they are the record of
                                                   how far a judge moved the fork it re-asked
  { t:"budget"; added; budget }
  { t:"forced_end"; words; target }              — hard length cap hit; the prose was cut off
  { t:"lint_failed"; why }                        — the narration lint call itself threw; the piece
                                                   was accepted unchecked
  { t:"narration_flag"; why; retried }           — narration lint fired; `retried` says whether
                                                    the one redraft happened or it was logged and kept.
                                                    `why` may carry three findings joined by ". " —
                                                    the two mechanical checks (quotations, restricted
                                                    senses) and the LLM half run together
  { t:"repeat_strip"; chars; words; whole }      — the piece opened by re-emitting the page's tail
                                                   (engine/repeat-lint.ts, no model call); the repeated
                                                   prefix was stripped before the append, so the draft
                                                   event that follows carries only the new text.
                                                   `whole` true means the entire piece was already on
                                                   the page and nothing was written this turn
  { t:"reader_ask"; step; framing; options[] }
  { t:"reader_answer"; answer }
  { t:"model_changed"; model }
  { t:"reaction_fanout"; reactors[]; situation } — group reactions fanned out to these consults
  { t:"fanout_skip"; character; why }            — one reactor in a fan-out was skipped: unknown,
                                                   gone from the scene, or its consult call threw
  { t:"context_risk"; model; needs; has }        — a call went out whose prompt plus reply reserve
                                                   does not fit the model's loaded context;
                                                   expect empty completions or truncation
  { t:"reaction"; character; thought; action }   — an isolated per-reactor consult's answer
  { t:"batch_judge_failed"; why }                 — the reaction batch judge call itself threw;
                                                   no volunteered deed from this beat was promoted
  { t:"promote"; character; action }             — at most one deed promoted into the writer's draft
  { t:"exit"; character; pov }                   — a character left the cast mid-scene;
                                                   `pov` true means they were POV and the chapter ends
  { t:"exit_refused"; character }                — an exit named on a reply that wrote nothing;
                                                   nobody has left and the cast is unchanged
  { t:"world_beat"; beat; hold; step }           — a world beat injected into the `[WRITE]` as
                                                   already true (no model call): `beat` is the event,
                                                   `hold` the held form it stood down. Nothing
                                                   checks that it reached the page
  { t:"beat_stranded"; beat; at }                — the scene ended without this beat ever firing:
                                                   its trigger was never reached. Logged at scene
                                                   close, one per unfired beat aimed at this chapter
  { t:"memory_surfaced"; character }             — a fired beat implanted a memory into that
                                                   character's system prompt; the wording itself
                                                   reaches nobody but that character
  { t:"retry_capped"; character; count }
  { t:"done_deferred" }                          — the scene was about to end — `scene_done` declared,
                                                   or the hard length cap reached without declaring
                                                   it — while an accepted answer was still missing
                                                   from the page; the scene is held open exactly one
                                                   more turn
  { t:"answer_unwritten"; characters[]; stopped } — the scene ended anyway with those answers never
                                                   written in: the consults were accepted, the
                                                   chapter does not carry the choices they made
  { t:"scene_end"; steps; words; done; stopped; retries{character:count} }
```

`wants` and `question` in `consult` are **`""` on an open beat**, which is every consult the writer
itself sends. They carry values only after a judge's retry has escalated the ask by naming the fork
in words. When `wants` is set it is one of `speech | action | decision | reaction` — the same four
words `prompts.ts`'s `CONSULT_WANTS` sends the judge and the character (prompts.ts's single source of
truth for that vocabulary, so the API and the model prompt can never drift apart). A client rendering
a consult has to handle both: `blocks.js` falls back to the situation as the header when there is no
question.

`schema_mismatch` says an author-side agent replied in a shape that is not the one its call asked for
— a judge that wrote prose, a clarifier that returned a verdict, a narration lint that came back with
no `ok` in it (`character` is then `(narration)`, the call having no character of its own). The call is
made once more before falling back to a default, so the event is a warning about model behaviour, not
a failed run. It is also the only thing separating a piece the lint passed from a piece the lint never
ruled on: nothing but an explicit `ok` counts as a verdict.

`clarify_failed`, `judge_failed`, `lint_failed`, `batch_judge_failed` and `fanout_skip` are the other
half of that same signal: the call didn't come back wrong-shaped, it didn't come back at all — LM
Studio unreachable, timed out, or the model errored outright. Each names exactly where an
author-side helper's silent fail-open default was taken, so a run can be told apart from one where
every judgement actually happened; see [Writer.MD](Writer.MD).

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
reading a story's full cast — `knows`, `goal`, `belief`, `impulse`, `voice` and `persona` — for a story that is not in a scaffold or
handoff session, starting a run without going through the picker/scaffold handshake, or anything about
a run that already fell out of `MAX_RUNS` retention. The first two are proposed in
[PLANS.md](PLANS.md) (plans 1 and 2C), which is also where the routes they would add are drafted.

If "replace" means **serve the new frontend from somewhere other than this process** (a separate dev
server, a static host): the JSON/SSE routes have no CORS headers today, so a different-origin client
would 405/opaque-fail on `fetch` until `Access-Control-Allow-Origin` (and SSE's own CORS story) is
added — a small, contained change to `server.ts`, not a redesign. Same-origin (served by this process,
which is what the four static routes already do) needs nothing extra.
