# Story project bug review

**Session ID:** ses_fd9b3dd87ffehre064D313mnQm
**Created:** 8/21/2026, 11:48:38 PM
**Updated:** 8/22/2026, 12:18:18 AM

---

## User

Can you go over project and search for bugs?

---

## Assistant (Build · Ox Alpha Free (Unlimited) · 5.9s)

_Thinking:_

The user wants a bug hunt across the project. This is a broad task — good use of explore agents. Let me first get an overview, then launch parallel searches.

Let me look at the project structure and launch tasks to review key files for bugs.

I'll survey the codebase and hunt for bugs. Let me start by getting the lay of the land.

**Tool: bash**

**Input:**
```json
{
  "command": "Get-ChildItem -Recurse -File -Include *.ts,*.js,*.html,*.css | Where-Object { $_.FullName -notmatch 'node_modules' } | Select-Object @{n='Path';e={$_.FullName.Substring((Get-Location).Path.Length+1)}}, Length"
}
```

**Output:**
```

Path                        Length
----                        ------
engine\agent.ts               6109
engine\architect.ts          20791
engine\config-util.ts         1990
engine\consult.ts            13779
engine\engine-state.ts        1312
engine\json-extract.ts        3346
engine\llm-client.ts          8420
engine\preflight.ts          12062
engine\scene-loop.ts         34027
engine\skills.ts              7396
engine\story-format.ts       10032
engine\story-schema.ts        3872
engine\story-spec.ts         18896
server\gui\viewer\agents.js   6482
server\gui\viewer\blocks.js   8036
server\gui\viewer\boot.js     1130
server\gui\viewer\cast-s...   3383
server\gui\viewer\charac...   3835
server\gui\viewer\chrome.js   2664
server\gui\viewer\compar...   6826
server\gui\viewer\events.js   4356
server\gui\viewer\handof...  11512
server\gui\viewer\handof...   5648
server\gui\viewer\hud.js      5195
server\gui\viewer\interv...  15167
server\gui\viewer\nav.js      3892
server\gui\viewer\pages.js   14347
server\gui\viewer\reader.js   7136
server\gui\viewer\run-en...   1889
server\gui\viewer\saved-...   3635
server\gui\viewer\sessio...   4097
server\gui\viewer\shelf.js    3639
server\gui\viewer\sse.js     11283
server\gui\viewer\state.js   10701
server\gui\viewer\story-...  23798
server\gui\viewer\story-...  12274
server\gui\viewer\timeli...   2145
server\gui\viewer\util.js     3047
server\gui\viewer.css        38031
server\gui\viewer.html        2710
server\gui\viewer.js           747
server\http-util.ts           1867
server\next-chapter-rout...   4789
server\run-control-route...   4884
server\run-log-routes.ts      1648
server\scaffold-routes.ts     6155
server\server.ts             12034
server\story-edit-routes.ts   2641
server\story-read-routes.ts   1309
tests\architect.test.ts      29805
tests\consult.test.ts        28323
tests\helpers.ts              4454
tests\json-extract.test.ts    2995
tests\llm-client.test.ts     11009
tests\preflight.test.ts       3895
tests\run-artifacts.test.ts  16261
tests\run-state.test.ts      20522
tests\server-routes.test.ts  20917
tests\skills.test.ts         10939
tests\story-edit-routes....  12439
tests\story-format.test.ts   24645
tests\story-read-routes....   4406
tests\story-spec.test.ts     24325
ansi.ts                        260
architect-mockup.html        22123
live.ts                       4926
prompts.ts                   55659
story-writer.ts              31187
writer-mockup.html           16212



```

**Tool: bash**

**Input:**
```json
{
  "command": "git status; git log --oneline -5"
}
```

**Output:**
```
On branch main
Your branch is up to date with 'origin/main'.

Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git restore <file>..." to discard changes in working directory)
	modified:   Architect.MD
	modified:   CLAUDE.md
	modified:   PLANS.md
	modified:   engine/architect.ts
	modified:   engine/preflight.ts
	modified:   engine/skills.ts
	modified:   engine/story-spec.ts
	modified:   prompts.ts
	modified:   server/gui/viewer/interview.js
	modified:   story-writer.ts
	modified:   tests/architect.test.ts
	modified:   tests/skills.test.ts
	modified:   tests/story-format.test.ts
	modified:   tests/story-spec.test.ts

Untracked files:
  (use "git add <file>..." to include in what will be committed)
	session-ses_fd9f.md

no changes added to commit (use "git add" and/or "git commit -a")
9714d73 Merge pull request #1 from pluptak:split-test-suite
3ee8269 Last
6dc7047 UI cleanup and story diff part1
5905e8f Architect/Writer improvements
90bef30 Add live character-sheet panel (Plans part 1, block C client)

```

---

## Assistant (Build · Ox Alpha Free (Unlimited) · 688.1s)

_Thinking:_

The user wants a bug search. I'll launch parallel explore agents to review the engine, server, and GUI code for bugs. Also run the test suite and tsc as a baseline.

Now let me run the static checks and launch parallel bug-hunting reviews of the three main areas.

**Tool: bash**

**Input:**
```json
{
  "command": "npx tsc --noEmit 2>&1 | Select-Object -First 30; npm test 2>&1 | Select-Object -Last 40",
  "timeout": 300000
}
```

**Output:**
```
      ---
      duration_ms: 0.5214
      ...
    # Subtest: a fresh proposal with no config still renders with schema defaults and fallback model
    ok 6 - a fresh proposal with no config still renders with schema defaults and fallback model
      ---
      duration_ms: 0.147
      ...
    1..6
ok 77 - renderStory round trip
  ---
  duration_ms: 31.4783
  type: 'suite'
  ...
# Subtest: renderStory shape
    # Subtest: renders exactly one file, regardless of what was left blank
    ok 1 - renders exactly one file, regardless of what was left blank
      ---
      duration_ms: 0.1329
      ...
    # Subtest: writes empty fields as empty JSON values rather than omitting them, and fills in scene defaults
    ok 2 - writes empty fields as empty JSON values rather than omitting them, and fills in scene defaults
      ---
      duration_ms: 0.1102
      ...
    1..2
ok 78 - renderStory shape
  ---
  duration_ms: 0.4744
  type: 'suite'
  ...
1..78
# tests 403
# suites 86
# pass 403
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1175.9047

```

**Tool: task**

**Input:**
```json
{
  "description": "Review GUI JS for bugs",
  "prompt": "You are doing a careful bug-hunting code review (research only — do NOT edit any files) of the browser-side JavaScript of a project in C:\\Users\\Peter\\source\\repos\\LLM-playground\\Story-writer.\n\nRead these files thoroughly (all under server/gui/viewer/):\n- viewer.js (in server/gui/, composition root)\n- state.js\n- sse.js\n- events.js\n- blocks.js\n- agents.js\n- hud.js\n- pages.js\n- reader.js\n- interview.js\n- handoff.js (and any other handoff*.js files)\n- shelf.js\n- nav.js\n- chrome.js\n- timeline.js\n- util.js\n- session*.js, saved*.js, comparison*.js, cast-sheet / character*.js, run-en*.js, boot.js, story-*.js — read whatever files exist under server/gui/viewer/\n- server/gui/viewer.html\n\nLook for real bugs: event listeners added repeatedly without cleanup, SSE reconnection duplicating handlers, null dereferences on optional DOM elements, race conditions between fetches and SSE updates, stale closures, incorrect escaping when inserting model text into HTML (XSS-ish rendering bugs), state machine mistakes in pause/resume/stop, mismatched element IDs between HTML and JS.\n\nFor each suspected bug report: file path with line numbers, short description, why it's wrong, severity (high/medium/low). Only report actual defects, not style issues. Return findings as a concise list.",
  "subagent_type": "general"
}
```

**Output:**
```
<task id="ses_fd9b37090ffeb9vRP14p4fSU5m" state="completed">
<task_result>
Review complete. I read all viewer modules plus the server routes they call (to verify contracts). Findings, ordered by severity:

## Bugs

**1. One Escape press closes two stacked modals — three competing document-level Escape handlers**
- `server/gui/viewer/chrome.js:48-59`, `server/gui/viewer/character-card.js:69-78`, `server/gui/viewer/interview.js:275-277`
- All three register independent `document` `keydown` Escape handlers (registration order: interview → chrome → character-card). chrome.js closes the *topmost* `.modal-backdrop` and re-renders; character-card.js's handler then runs, sees `APP.charCard` is now null, and falls through to `else if (APP.runEnded)` — closing the modal underneath too. Repro: run-ended modal up → click a cast pill in the header → press Escape once; both the char card *and* the run-ended dialog vanish. Same doubling with interview + charCard open. chrome.js's own comment ("closes the topmost modal only") is violated by its co-handler.
- Severity: **medium**

**2. `#/edit?new=1` with no scaffold spec renders a permanent "loading…" dead-end**
- `server/gui/viewer/story-edit.js:295-299` (the `!APP.editDraft` branch has no back button and no error state) + `story-edit.js:539-548` (hydration requires `APP.scaffold.spec`; the loader branch requires a truthy `APP.editDir`, which is `""` for a new story).
- Repro: shelf → "start a new story" (sets `editNew`, `ideaOpen`, navigates to edit) → dismiss the interview via ×, backdrop, or Escape. Nothing server-side will ever produce a spec (no interview started), so the page shows "loading…" forever with no exit affordance in `#page`. Only the top tabs escape it.
- Severity: **medium**

**3. SSE reconnect never restores the "live" source indicator**
- `server/gui/viewer/sse.js:197` sets `setSrc(LIVEV, "live (reconnecting…)", false)` on `es.onerror`; `setSrc(LIVEV, …, true)` is only ever called in `startSSE` (`sse.js:77`). EventSource auto-reconnects and events resume, but nothing flips `source`/`isLive` back — the srcbar reads "live (reconnecting…)" and the dot loses its live class for the rest of the session.
- Severity: **low**

**4. Interview `say`/`accept` have no client-side in-flight guard — double submit produces spurious errors**
- `server/gui/viewer/interview.js:180-185` (`sendSay`) and `249-264` (`iv-accept`) guard on `APP.scaffold.busy`, but unlike `startInterview` (:194) and `startHandoff` (`handoff.js:40`), they never set `busy` optimistically — it only becomes true when the *next* server frame arrives. A double Enter / double-click fires two POSTs; the second gets 409 "a round is already in flight", which `postScaffold` paints into `scaffoldError` even though the first succeeded, and (for `say`) the loser's response lacking `active` skips the draft-clear on that path. The code comment at :258 claims "a double-click must not POST accept twice" — the guard doesn't deliver that.
- Severity: **low**

**5. Consult expand-state (`open` Set) collides across run resets because the server restarts `seq` at 1**
- `server/gui/viewer/state.js:130-132` + `sse.js:160-171` (`run_reset` clears `events`/`seen` but not `open`) against `live.ts:118-121` (`resetLive()` zeroes `liveSeq`).
- Expand a consult at seq 7 in run one, then pick a new story: run_reset clears client state but `open` keeps `{7,…}`; the new run's seq numbering restarts, so its consult at seq 7 renders pre-expanded. The "shared reading preference" intent breaks because seq identity is not stable across resets.
- Severity: **low**

**6. Cancelled dirty-guard on hashchange leaves URL and app disagreeing**
- `server/gui/viewer/nav.js:45` + `:65-68`: the `hashchange` listener calls `go(v)` *after* the URL has already changed; if the editor's confirm is cancelled, `go` returns before `syncHash()`, so the address bar shows the new page while the app stays on the editor. A bookmark/reload then lands somewhere other than what's displayed, until the next successful navigation repairs it.
- Severity: **low**

## Checked and found sound
- XSS/rendering: every interpolation of model-derived text goes through `esc()`/`paras()` (blocks, handoff diffs, transcripts, cast sheet, attributes included); no raw insertions found.
- Fetch/SSE races: `loadReq`/`_agentsReq`/`chapterReq`/`checkReq` last-write-wins tokens, reader `READER.dir` re-checks, compare `COMPAREV.key` guard, and SSE seq-dedupe (which correctly survives `liveSeq` restart because clients clear `seen` on `run_reset`) are all correct.
- Listener hygiene: all per-render listeners attach to freshly rebuilt DOM; document/window-level listeners register exactly once.
- Element IDs referenced from JS all exist in `viewer.html`.
- Pause/resume/stop state machine edges (including the stop-arm timer, pause→resume wording, and `stopping` gating) match the server's `runState()` semantics.
</task_result>
</task>
```

---

## Assistant (Build · Ox Alpha Free (Unlimited) · 36.7s)

_Thinking:_

Tests pass (403/403), tsc clean. Now launch the engine + server review agents in parallel.

Static checks are green (tsc clean, 403/403 tests pass). The GUI review found several issues. Now let me review the engine and server halves in parallel.

---

## Assistant (Build · Ox Alpha Free (Unlimited) · 481.0s)

Static checks pass (tsc clean, 403/403 tests green). Now let me review the engine and server halves in parallel.

**Tool: task**

**Input:**
```json
{
  "description": "Review server routes for bugs",
  "prompt": "You are doing a careful bug-hunting code review (research only — do NOT edit any files) of an HTTP server layer in C:\\Users\\Peter\\source\\repos\\LLM-playground\\Story-writer.\n\nRead these files thoroughly:\n- server/server.ts\n- server/http-util.ts\n- server/run-control-routes.ts\n- server/scaffold-routes.ts\n- server/next-chapter-routes.ts\n- server/run-log-routes.ts\n- server/story-read-routes.ts\n- server/story-edit-routes.ts\n- story-writer.ts (the composition root that builds the HOST object these routes consume)\n\nKey architectural rule to verify: server/route modules must never import engine/ modules at runtime — everything arrives via the HOST object. Check for: path traversal in any route serving files from disk (run-log file reads especially — is user input sanitized before joining paths?), missing method checks, unhandled promise rejections from async route handlers crashing the server, race conditions around \"refuse with 409 while a run is in flight\" (story-edit vs run start), SSE client leaks (are disconnected clients removed?), incorrect status codes, request body parsing errors not caught, and any place HOST methods are called with wrong argument shapes.\n\nFor each suspected bug report: file path with line numbers, short description, why it's wrong, severity (high/medium/low). Only report actual defects, not style issues. Return findings as a concise list.",
  "subagent_type": "general"
}
```

**Output:**
```
<task id="ses_fd9a8634bffeA7NHKnTVXv7L7P" state="completed">
<task_result>
## Findings

**HIGH**

1. **`/story/suggest` runs during a live run and mutates global engine knobs** — `server/story-edit-routes.ts:60-65` has no `LIVE.running` guard (unlike `/story/edit` and `/story/save`). Its HOST impl (`story-writer.ts:485-486`) calls `architectDefaults()` (`story-writer.ts:112-119`), which sets `ENGINE.stream`, `ENGINE.debug`, `ENGINE.maxTokens`, `NET.timeoutMs`, `NET.retries`. A suggestion fired mid-run silently rewrites the in-flight writer's token cap/timeouts. Note `architectModel()` (line 404) is deliberately pure — `suggestEdits` should be too.

2. **Route module imports engine/ at runtime** — `server/story-edit-routes.ts:13`: `import { StoryJson } from "../engine/story-schema.ts"` is a value import (and unused). Imports are hoisted/executed regardless of use, so this violates the "route modules never import engine/" rule. (`scaffold-routes.ts:10`, `next-chapter-routes.ts:10`, `server.ts:18-21` correctly use `import type`.) Also `writeFile, rename` at line 6 are unused.

**MEDIUM**

3. **`serveFile()` can't send its 404** — `server/server.ts:91-99`: `writeHead(200)` executes before `await readFile`, so a read failure hits the catch with headers already sent; the `writeHead(404)` throws `ERR_HTTP_HEADERS_SENT`, propagating to the outer catch — client receives 200 + empty body. Read first, then send headers (`/log.jsonl` at :184-190 does it correctly).

4. **Scaffold/handoff busy-flag TOCTOU on "start"** — `server/scaffold-routes.ts:59→67→72` and `server/next-chapter-routes.ts:58→68→73`: the `busy` check and set are separated by `await host.loadedModelIds()` / `await host.selectableStory()`. Two concurrent starts both pass the 409 gate; the second clobbers `SCAFFOLD`/`HANDOFF` mid-round. ("say"/"accept" are safe — no awaits between check and set.)

5. **`readJsonBody` destroys the socket before the error response is sent** — `server/http-util.ts:33,43`: on wrong content-type or oversized body it rejects with an `HttpError(400/413)` *then* calls `req.destroy()`, killing the socket so the outer handler's JSON status never reaches the client (connection reset instead). Drain or just respond without destroying.
   Related nit, same function lines 37-40: `body += c` string-concats Buffers per chunk, corrupting multi-byte UTF-8 chars split across chunk boundaries → spurious "invalid JSON" 400.

6. **No `error` listeners on SSE responses** — `server/server.ts:125-134` and the ping interval at :236; `live.ts:62` wraps writes in try/catch, but that only catches synchronous throws. An async write failure (EPIPE/ECONNRESET on a half-dead socket) emits an `'error'` event on the response/socket with no handler — a viewer refreshing at the wrong moment can crash the whole process.

**LOW**

7. **409 race window around story save** — `server/story-edit-routes.ts:49` checks `LIVE.running`, `saveStory` re-checks (`story-writer.ts:458`), then does `writeFile`+`rename` with no further check; a run started via `/select` inside that window loads the old story while the user believes the new one was saved. Rename is atomic, so no torn reads — consistency gap only. Similarly, `/story/save` and handoff `accept` both rewrite `story.json` and guard only against `LIVE.running`, not each other.

8. **Missing method restrictions / no 405s** — `run-log-routes.ts:15` serves `/runs/llm*` for any method (POST/DELETE included); `/run`, `/stories`, `/log.jsonl`, `/runs/log`, `/chapter` (`server.ts:136-213`) likewise accept any method. Wrong methods fall through to generic 404 rather than 405; `POST /scaffold` and `POST /next-chapter` (no action suffix) also fall through to 404 (`scaffold-routes.ts:43-47`, `next-chapter-routes.ts:42-46`).

9. **Inconsistent failure status codes** — `/cast` (`story-read-routes.ts:24`) and `/story/edit` (`story-edit-routes.ts:27`) return HTTP 200 with `{ok:false}` for load/validation failures while sibling routes use 4xx; handoff `"start"` maps every session-open failure to 400 including infrastructure errors that warrant 500 (`next-chapter-routes.ts:82`).

## Verified clean

- **Path traversal**: all user-supplied names are validated against on-disk allowlists before any path join — `/chapter` n against numeric `writtenChapters` listing, `/runs/log` id against `runDirs`, `/runs/llm/file` file against `runLlmLogs`' listing (`engine/preflight.ts:265-268`), static viewer files via flat-filename regex (`server.ts:109,120-124`), and `dir` via `selectableStory` matching discovered stories only (`engine/story-format.ts:176-181`).
- **Unhandled rejections**: every route dispatch sits inside the try/catch at `server.ts:111-226`; rejections become 400/413/500 correctly (modulo finding 5).
- **SSE client removal**: `req.on("close", () => sseClients.delete(res))` at `server.ts:134` is present and correct (leak-wise).
- **HOST argument shapes**: all call sites match the `ServerHost` signatures, including the resolved-vs-relative dir conventions (`runDirs(base)` vs `writtenChapters(dir)`).
</task_result>
</task>
```

---

## Assistant (Build · Ox Alpha Free (Unlimited) · 538.8s)

**Tool: task**

**Input:**
```json
{
  "description": "Review engine for bugs",
  "prompt": "You are doing a careful bug-hunting code review (research only — do NOT edit any files) of the story-writing engine in C:\\Users\\Peter\\source\\repos\\LLM-playground\\Story-writer.\n\nRead these files thoroughly:\n- engine/engine-state.ts\n- engine/config-util.ts\n- engine/json-extract.ts\n- engine/skills.ts\n- engine/story-schema.ts\n- engine/llm-client.ts\n- engine/agent.ts\n- engine/story-format.ts\n- engine/story-spec.ts\n- engine/preflight.ts\n- engine/consult.ts\n- engine/architect.ts\n- engine/scene-loop.ts\n- live.ts\n- prompts.ts (large — focus on how its functions are called: argument shapes, off-by-one windowing, string interpolation of undefined values)\n- story-writer.ts\n\nKey invariants to verify:\n1. `consult()` must NEVER touch `agent.history` — the caller folds in only accepted answers, so `agent.fork()` is a clean retry. Look for any violation.\n2. The asymmetry: writer never sees personas; characters never see the premise/draft/other replies. Check prompt-building call sites for leaks.\n3. Windowed history + rolling digest logic in agent.ts — check for off-by-one errors, digest corruption on fork.\n4. Retry/backoff and streaming in llm-client.ts — check abort handling, JSON extraction edge cases in json-extract.ts.\n5. Stop/pause signal handling across live.ts / scene-loop.ts — can a stopped run still write files? Is the stop flag checked at all boundaries?\n6. Token accounting, history windowing math.\n7. Any place a model reply is parsed with assumptions that could throw on malformed output.\n\nFor each suspected bug report: file path with line numbers, short description, why it's wrong, severity (high/medium/low). Only report actual defects, not style issues or speculative hardening. Return findings as a concise list.",
  "subagent_type": "general"
}
```

**Output:**
```
<task id="ses_fd9a12d0effexpS6eKxFObccqH" state="completed">
<task_result>
## Findings

**1. `NET.timeoutMs` aborts an entire healthy streamed completion, not idle time — medium**
`engine/llm-client.ts:61` (timer) and `:72-74` (misdiagnosis). The `AbortController` timer covers the whole request including body streaming. With `maxTokens: 2000` and typical local-model speeds, a legitimate generation can exceed the 120 s default `requestTimeout`; it is then aborted *mid-stream* and restarted from zero (`completeStream`'s partial-salvage only fires on a completed top-level object), and after `attempts` tries the run fails even though LM Studio was answering fine. The retry message `"no reply within ${NET.timeoutMs/1000}s"` shows the intent was a no-reply/idle timeout, not total duration.

**2. Streaming concatenates `reasoning_content` deltas onto `content` deltas — low**
`engine/llm-client.ts:140-141`. For a thinking model that streams reasoning frames first and content frames second, both are appended into `full`, so the returned text is chain-of-thought followed by the answer, with no `<think>` tags for `extractJson` to strip (`engine/json-extract.ts:43`). The last-top-level-object heuristic usually recovers, but `salvageProse` (`engine/json-extract.ts:69`) matches the **first** `"prose":"`, which can hit text inside the leaked reasoning and salvage the wrong prose.

**3. `serve()` called twice in `--serve` mode; failed bind leaks a ping interval — low**
`story-writer.ts:501` calls `serve()` at startup and `story-writer.ts:546` calls it again inside `runAndSave` for every run. The second `listen` always hits `EADDRINUSE` (handled at `server/server.ts:229-232`), so a misleading "Could not start the viewer" error prints at every run start — and `server/server.ts:236` registers its 15 s SSE-ping `setInterval` unconditionally, so each run adds another never-cleared interval pinging the same clients.

**4. `runPreflight` monkey-patches global `console.warn` across await points — low**
`engine/preflight.ts:96-98,148`. The swap captures warnings from *any* code running during the awaited window. `preflightChain` serializes preflights against each other but not against an in-flight run: under `--serve`, a run's `(digest skipped…)` / skill warnings (`engine/agent.ts:127`, `engine/skills.ts:103`) can be silently swallowed into a story-card's `warnings[]` and never printed.

**5. Writer-history echo mangles a consult carrying both `character` and `reactors` — low**
`engine/scene-loop.ts:375-378`. Two conditional spreads of `consult` in one object literal: if the writer's draft contains both `consult.character` and `consult.reactors`, the reactors spread overwrites the character one, so history records `{consult:{reactors}}` while the `draft` event (line 379) reports `consulting: who`. Downstream only the fan-out branch runs (line 400), so impact is limited to a misleading log/history record.

### Invariants checked — no violations found

1. **`consult()` never touches `agent.history`** — verified: it only calls `generate(label, extra)` with a local array; folding happens solely at scene-loop.ts:574-575/436-437 after accept.
2. **Asymmetry** — writer system gets only name/can/cannot (`prompts.ts:694-698`, `scene-loop.ts:47-54`); characters get persona/place/skills/knows/goal + askBlock; judge/clarifier/narration-lint/batch-judge are author-side by design. No leak path found.
3. **Windowing math** — `trimHistory` (`agent.ts:114-128`) keeps exactly `keepRecent` and folds the overflow into the digest; no off-by-one. `fork()` copies neither history nor digest, so retries are genuinely clean.
4. **Stop/pause boundaries** — stop is checked at every loop boundary in `writeScene`, via `withRetry`'s `RUN.stopped` checks, and pending waits are resolved by the `/stop` route (`run-control-routes.ts:20-25`); a stopped run never writes `chapters/N.md` (`r.done` gate, `story-writer.ts:611`).
</task_result>
</task>
```

---

## Assistant (Build · Ox Alpha Free (Unlimited) · 4.3s)

_Thinking:_

All three reviews done. Compile a report. Also note the selected story.json snippet — "model": "" empty string for WAITER. Is that a bug? The schema may allow empty model meaning fallback. Let me quickly check story-schema/story-format to see if empty model is handled.

One more check — the selected `WAITER` entry has `"model": ""`. Let me verify the engine handles an empty model string.

**Tool: grep**

**Input:**
```json
{
  "pattern": "\\.model\\b",
  "path": "engine"
}
```

**Output:**
```
Found 21 matches
C:\Users\Peter\source\repos\LLM-playground\Story-writer\engine\story-spec.ts:
  Line 64:       name, model: String(c?.model ?? "").trim(), persona: String(c?.persona ?? "").trim(), knows: String(c?.knows ?? "").trim(),

  Line 309:     model: c.model,

  Line 366:       name: c.name, model: c.model, persona: c.persona, knows: c.knows, goal: c.goal,


C:\Users\Peter\source\repos\LLM-playground\Story-writer\engine\preflight.ts:
  Line 102:                                   ...sc.characters.map(c => c.model)])].filter(Boolean);

  Line 251:         if (typeof ev.model === "string" && !summary.models.includes(ev.model)) summary.models.push(ev.model);


C:\Users\Peter\source\repos\LLM-playground\Story-writer\engine\agent.ts:
  Line 25:     const a = new Agent(this.name, this.model, this.system, this.temperature);

  Line 43:       const { text: raw, usage } = await complete(this.model, msgs, this.temperature, this.think);

  Line 46:       emitStats(this.name, this.model, durationMs, usage);

  Line 56:     const { text: rest, usage } = await completeStream(this.model, msgs, this.temperature, d => {

  Line 64:     emitStats(this.name, this.model, durationMs, usage);

  Line 83:     ts, role: agent.name === "WRITER" ? "writer" : "character", agent: agent.name, model: agent.model,


C:\Users\Peter\source\repos\LLM-playground\Story-writer\engine\architect.ts:
  Line 318:     const short = info && contextShortfall(info.get(this.architect.model),

  Line 321:       `this round needs about ${short.needs} tokens and ${this.architect.model} is loaded with ${short.has} — `


C:\Users\Peter\source\repos\LLM-playground\Story-writer\engine\scene-loop.ts:
  Line 29:   const a = new Agent(def.name, def.model, wrapCharacter(def, place), 0.9);

  Line 155:   // `writer.model` at call time so a mid-run /model swap still reaches them.

  Line 157:     const a = new Agent("WRITER", writer.model, P.judgeSystem(cast), JUDGE_TEMPERATURE);

  Line 164:     const a = new Agent("WRITER", writer.model, P.batchJudgeSystem(cast), JUDGE_TEMPERATURE);

  Line 171:     const a = new Agent("WRITER", writer.model, P.narrationLintSystem(cast), JUDGE_TEMPERATURE);

  Line 181:       clarifier = new Agent("WRITER", writer.model,

  Line 185:     clarifier.model = writer.model;


C:\Users\Peter\source\repos\LLM-playground\Story-writer\engine\story-format.ts:
  Line 84:       model: c.model || defaultModel,

```

---

## Assistant (Build · Ox Alpha Free (Unlimited) · 25.1s)

_Thinking:_

`story-format.ts:84` does `c.model || defaultModel`, so empty string falls back to default model. Fine — not a bug.

Now compile the final report concisely but with enough detail. The user asked to "go over project and search for bugs" — a report is expected, so detail is warranted despite the brevity instruction (user asked for a review; give the findings).

Review complete — `npx tsc` clean, all 403 tests pass. Three parallel deep reviews found real bugs. (Your selected `WAITER` entry is fine, by the way: `"model": ""` correctly falls back to the story default via `engine/story-format.ts:84`.)

## High

1. **`/story/suggest` runs mid-run and mutates engine knobs** — `server/story-edit-routes.ts:60-65` lacks the `LIVE.running` 409 guard its siblings have. Its HOST impl calls `architectDefaults()` (`story-writer.ts:112-119`), which rewrites `ENGINE.maxTokens`, `NET.timeoutMs/retries` — silently changing an in-flight run's token cap and timeouts.
2. **Route module imports `engine/` at runtime** — `server/story-edit-routes.ts:13`: value import of `StoryJson` (unused). Violates the "routes never import engine/" invariant; should be `import type`.

## Medium

3. **Timeout aborts healthy streams** — `engine/llm-client.ts:61-74`: the timer covers the whole streamed body, not idle time. A slow-but-working generation past 120 s gets aborted mid-stream and retried from zero, eventually failing the run.
4. **`serveFile()` can't send its 404** — `server/server.ts:91-99`: headers are sent before `readFile`; on read failure the catch's `writeHead(404)` throws ERR_HTTP_HEADERS_SENT → client gets 200 + empty body.
5. **Scaffold/handoff "start" TOCTOU** — `scaffold-routes.ts:59-72`, `next-chapter-routes.ts:58-73`: busy-check and set separated by awaits; two concurrent starts both pass the gate and clobber each other.
6. **`readJsonBody` kills the socket before the error response** — `http-util.ts:33-43`: rejects with HttpError then `req.destroy()` → client sees connection reset, not the 400/413. Also string-concatenates Buffers, corrupting multi-byte UTF-8 split across chunks.
7. **No `error` listener on SSE responses** — `server/server.ts:125-134`: async EPIPE during a viewer refresh can crash the whole process.
8. **Escape closes stacked modals two-at-a-time** — competing document keydown handlers in `viewer/chrome.js:48-59`, `character-card.js:69-78`, `interview.js:275-277`; closing one modal makes another handler close the one beneath it.

## Low

- **Streaming mixes `reasoning_content` into content** (`llm-client.ts:140-141`) — leaked chain-of-thought can make `salvageProse` grab prose from inside reasoning (`json-extract.ts:69`).
- **`serve()` called twice in `--serve` mode** (`story-writer.ts:501,546`) — misleading "Could not start the viewer" every run, plus a new never-cleared SSE-ping interval per run (`server/server.ts:236`).
- **`runPreflight` monkey-patches global `console.warn` across await points** (`preflight.ts:96-148`) — under `--serve`, run warnings can be swallowed into story-card warnings.
- **Consult history echo drops `character` when `reactors` present** (`scene-loop.ts:375-378`) — second spread overwrites the first; log/history record misleading only.
- **GUI**: SSE reconnect never restores the "live" dot (`sse.js:197`); interview say/accept lack optimistic busy-guard so double-submit paints a spurious 409 error (`interview.js:180-264`); consult expand-state keyed by seq collides across run resets since server restarts seq at 1; cancelled dirty-guard leaves URL/app disagreeing (`nav.js:45-68`); `#/edit?new=1` after dismissing the scaffold interview renders a permanent "loading…" dead-end (`story-edit.js:295-299`).

## Verified clean
Path traversal (all names allowlist-checked), `consult()`/history purity, writer↔character asymmetry (no leaks), history windowing/fork math, stop/pause boundaries (stopped runs never write chapters), SSE client cleanup, HOST call shapes, and GUI XSS escaping all check out.

Want me to fix any of these? I'd suggest starting with #1–#2 (small, high-value) as one block per your CLAUDE.md workflow.

---

