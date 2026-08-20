# Plans

**Every unbuilt plan lives here.** Built behaviour belongs to the document that owns its surface —
[`GUI-SPEC.md`](GUI-SPEC.md) for routes and SSE, [`Architect.MD`](Architect.MD) for the architect and
the handoff, [`Writer.MD`](Writer.MD) for the writer and the live screen. When something here ships,
its behaviour moves into one of those and **the entry is deleted rather than annotated**; git history
is where implementation notes belong.

Nothing below is committed work, and the numbering is an ordering, not a schedule.

**Verification, once, for all of it:** `npx tsc --noEmit` and `npm test` are the cheap checks. Anything
touching `server/gui/` also needs the matching section of [`GUI-CHECKLIST.md`](GUI-CHECKLIST.md), since
the viewer has no automated coverage. Anything touching `prompts.ts` or model behaviour needs a live
run, which is the owner's to make, batched.

---

## 1. Reading: reader mode, story search, character sheet

Three read-only consumption features. `GET /chapter?dir=&n=` already serves an accepted chapter after
checking it against `host.writtenChapters()`, so **A and B need no server work at all.**

### A. Reader mode

A distraction-free view of a story's accepted prose — distinct from the story page's per-chapter inline
expansion, which is embedded in the run-control chrome. A separate `#/read?dir=` route alongside the
existing `#/handoff?dir=` pattern (`pages.js`/`nav.js`), fetching each entry in `chapters[]` (from
`GET /stories`) in order and rendering them under their chapter headings. No run controls, no SSE
subscription — static once loaded.

**Files:** a new `server/gui/viewer/reader.js`, following the `handoff.js`/`handoff-view.js`
split-by-concern convention, wired into `pages.js`/`nav.js`.

### B. Story-wide search

Full-text search across a story's accepted chapters. A search box that fetches every `chapters[]` entry
through the same primitive reader mode uses, does a case-insensitive substring match per chapter, and
lists matches with the surrounding line and a jump-to-chapter link. Client-side, no search route: a
story is a handful of chapters, and adding a route when the existing surface suffices is the thing this
repo avoids. N sequential fetches is acceptable at these sizes; revisit only if that stops holding.

**Files:** a small module beside (A), or an addition to it — both consume the same chapter fetch.

### C. Character sheet panel

A read-only panel on the live writer screen showing the active scene's roster with their authored
`knows`/`goal`/`skills`/`restrictions` — for the author reviewing what a consult was working from. It
does not touch the writer/character information boundary: this is already-authored data, shown to the
human, never to an agent.

**This one needs a new read path.** `specView()` has exactly the per-character shape a sheet needs, but
it is only ever called on a scaffold or handoff session's in-memory `StorySpec`, never on a story
loaded for live writing — and `GET /stories`' `StoryCard.characters` carries `{ name, skills,
restrictions }` only.

- A `ServerHost` method that loads the story and returns the full cast, shaped like `specView()`'s
  character mapping (`{ name, persona, knows, goal, skills, restrictions }`).
- A route, e.g. `GET /cast?dir=`, mirroring `GET /chapter`'s per-request scoping rather than folding
  full cast data into `GET /stories` — that returns a card for *every* story, and only the open
  story's cast is ever shown.
- The roster filter is client-side, from `scenes[chapter - 1].roster` or the live `scene_start` event.

> **Overlaps plan 1.** `GET /cast?dir=` and `GET /story/edit?dir=` both amount to "return this story's
> full authored definition for a story that is not in an architect session." Whichever is built first
> should be shaped so the other can reuse it instead of adding a second load path.

**Out of scope.** Editing character fields from the panel (that is plan 1); a server-side search
index; showing a character's `model` — `specView()` drops it for the same reason the handoff panel
does not show it.

---

## 2. Run inspection: cost/latency HUD and run comparison

The read tab already renders a retained `writing-log.jsonl` through `/runs/log`, and
[`agents.js`](server/gui/viewer/agents.js) renders each agent's raw transcripts through `/runs/llm`.
What is missing is measurement, and a second pane.

### A. Live per-agent cost/latency HUD

**New instrumentation is required — nothing today captures duration or tokens per call.** Each
`out/<runId>/llm/<slug>.jsonl` entry is `{ ts, role, agent, model, prompt, response }`, where `ts` is
captured *before* generation starts; `complete()`/`completeStream()` parse only the completion text and
discard an OpenAI-style `usage` field if one is present.

- **`engine/llm-client.ts`** — return `data.usage` (`prompt_tokens`/`completion_tokens`) alongside the
  completion text instead of dropping it, in both the buffered and streaming paths.
  **Open question, to verify against the local LM Studio before implementing:** whether a streamed
  response carries `usage` at all — the OpenAI convention gates it behind `stream_options.include_usage`,
  which is not sent today. If it does not, duration is still capturable and token counts may have to be
  shown as unavailable for streamed calls specifically.
- **`engine/agent.ts`** — record the completion time, compute `durationMs`, extend `llmLogEntry` with
  `durationMs` and `usage: { promptTokens, completionTokens } | null`, and emit a new
  `{ t: "agent_stats", who, model, durationMs, promptTokens, completionTokens }` frame through the same
  `sseWrite` path the `composing` event already uses, so the live screen needs no log polling.
- **`server/gui/viewer/hud.js`** — a per-agent stat table accumulating `agent_stats` across the run,
  additive to `renderRail()`, following the same `store.events`-filtering pattern the rail counts use.
- **`GUI-SPEC.md`** — document `agent_stats` in the `/events` contract.

**Blocks.** (1) Capture and log: usage parsing, duration, the extended `llmLogEntry`; extend the
existing `agent.ts` coverage to assert the new fields are present and non-negative. (2) Live surfacing:
the SSE event, the GUI-SPEC entry, the panel — and a live run that settles the streaming-usage question
above one way or the other.

### B. Run comparison view

**GUI only — no new route.** `/runs/log?dir=&id=` already returns everything two runs of the same
chapter need.

- A run picker over the story's retained `runs[]`, using existing shelf/story-page conventions.
- Two read-tab panes side by side, each fed by its own `/runs/log` fetch through the existing rendering
  path — that component used twice, not a second renderer. Each pane brings the per-agent panel with
  it, which answers "what did changing the model actually do" better than the diff below does.
- A word-level diff of the two runs' assembled prose (concatenated `draft`/`accept` text, in order)
  above the panes. Client-side, no dependency — chapter-length text does not need a diff library.

**Out of scope.** A cost/latency rollup across runs or the whole story — the HUD is one live run. A
structural diff of the consult sequence — the two panes already let a reader compare that.

---

## Smaller viewer work

- **The chapters-written column on the handoff panel.** `GET /chapter?dir=&n=` serves the prose, so
  nothing is blocked at the API, but the word counts mean one fetch per chapter. Designed in
  [`Architect.MD`](Architect.MD).
- **Keep current-run rendering scoped to one chapter.** Aggregate story-level totals only when the UI
  is explicitly showing more than one run.

## Architect follow-ups

- **The worked example still costs the scaffold a quarter of its prompt.** `architectExample()`
  hard-codes `stories/doorway/story.json`, ~1,870 estimated tokens. The handoff no longer carries it
  (`buildArchitect(d, false)`), which is where the context pressure actually was; the scaffold still
  does, because it has no story yet to demonstrate the format with. Making it story-independent is
  what is left.
- **Refused edits are never told to the model.** `applyEdits` and `refuse()` report ignored fields to
  the author, but `architectChange` sends only the author's text and the spec — so an architect that
  invents a field (`scene_1` rather than `scene_1.question`, observed) can repeat it every round.
  Feeding refusals into the next prompt is the fix; it touches `prompts.ts`, so it is its own block.
- **Scaffold acceptance is not transactional.** A new story that writes but fails preflight is left on
  disk as `kind: "unloadable"`. The handoff restores the previous file in the same situation; the
  scaffold should match it.
- **The handoff prompt grows with the story.** It resends every written chapter, roughly 1,100 tokens
  each. The round now refuses with the numbers rather than letting the model return nothing, but a
  long story needs a correspondingly large context window loaded.

## Reliability follow-ups

- **The viewer has no automated coverage at all.** `npm test` covers the engine and the route modules;
  everything under `server/gui/` is verified by reading it and by running
  [`GUI-CHECKLIST.md`](GUI-CHECKLIST.md). Any change there is only as good as the live check that
  followed it.
- Four routes are handled inline in `server.ts` rather than in a route module (`/stories`, `/chapter`,
  `/log.jsonl`, `/runs/log`), so `callRoute` in the tests cannot reach them. Their engine-side helpers
  are tested instead. `tests/helpers.ts` has `callGet` for query-string GET routes, so moving them into
  a module is all that stands between them and coverage.
- Add coverage for `runAndSave` write-failure paths if that logic is extracted from the composition root.
- Keep `liveHistory` growth within a run under observation; it is reset between runs but is currently
  not bounded during a very long run.
- Do not add a bind-address option until the local server has an authentication design.

## The CLI-to-GUI transition

**A direction, not a commitment.** The application supports both the console workflows and the local
viewer today: `--serve` starts the viewer, `--preflight` is the maintenance and CI check, and `--new`,
`--next-chapter` and `--consult` remain interactive console workflows.

Should that change, the order is:

1. **Complete the viewer** — plans 1-3 above.
2. **Extract application services.** Move run setup, persistence, and cleanup out of the CLI-specific
   parts of `story-writer.ts`, keeping the existing `ServerHost` dependency boundary.
3. **Add a headless bootstrap.** Start the server without a story argument or terminal picker, print
   the local URL, handle graceful shutdown.
4. **Deprecate console interaction.** Keep `--preflight` and scripted runs; remove console flows only
   after equivalent browser workflows are verified.
5. **Harden the boundary.** Test startup without a TTY, cleanup after failures, SSE reconnects, route
   preconditions, and shutdown.

Constraints that hold whether or not that happens: the process supports **one active run** and must
not imply otherwise; the viewer is localhost-only and unauthenticated, and a wider bind needs
authentication before anything else; route modules receive behaviour through `ServerHost` and never
import `engine/`; operational messages stay in the console and run data stays in the JSONL logs, so
the GUI never becomes a second source of truth.
