# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## What this is

A **story writer** engine. A writer agent drafts one scene from a premise and, whenever what happens
next turns on a character's choice, **consults** that character's agent. The character may ask for a
fact it was not given before answering; the writer accepts the answer or rewrites the question and
asks a **fresh instance** that never learns it was rejected. Everything about a particular story
lives in [stories/](stories/); the engine knows nothing about any of it.

This is a **fork** of the "Multimodel AI roleplay" game-master engine. The transport, JSON
extraction, agent/history windowing, markdown parsing and config-validation policy were carried over
as source; the Director / Warden / Ledger / WorldState machinery was not. **Nothing here imports or
references that repo** — keep it that way.

## Documentation

One concept per file. Read the relevant one before an architectural change, and keep it in sync
afterwards.

| doc | read it when |
| --- | --- |
| [GUI-SPEC.md](GUI-SPEC.md) | a route, an SSE event, or what a run control does to the run |
| [Writer.MD](Writer.MD) | the writer's role and the live-run screen — what the API already supports and what's still missing |
| [Architect.MD](Architect.MD) | the architect's role and its two GUI screens — the scaffold interview and the handoff panel |
| [SPEC-E-editor.md](SPEC-E-editor.md) | *proposed, not built* — the story editor: making the GUI write an existing story, not just read one |
| [SPEC-H-handoff.md](SPEC-H-handoff.md) | one run per chapter, and the architect handoff that re-authors the cast between them — `runChapter`, `chapters/<n>.md`, `NextChapterSession`, `--next-chapter` and `/next-chapter/*` |
| [SPEC-GUI-MULTISCENE.md](SPEC-GUI-MULTISCENE.md) | current multi-chapter viewer gaps and proposed UI work |
| [SPEC-consult-tuning.md](SPEC-consult-tuning.md) | *proposed, not built* — a chapter-wide per-character retry ceiling, retry analytics on `scene_end`, and the GUI consult timeline strip that reads them |
| [SPEC-run-inspection.md](SPEC-run-inspection.md) | *proposed, not built* — a live per-agent cost/latency HUD and a run comparison view (the latter depends on the Run inspector item in `next-steps1.md`) |
| [SPEC-authoring-reuse.md](SPEC-authoring-reuse.md) | *proposed, not built* — named restriction/skill bundles and per-scene writer model/thinking overrides |
| [SPEC-continuity.md](SPEC-continuity.md) | *proposed, not built* — a story-level fact bible, advisory continuity flags in the handoff round, and a before/after diff for handoff edits |
| [SPEC-reading.md](SPEC-reading.md) | *proposed, not built* — reader mode, story-wide search, and a character sheet panel on the live writer screen |

The repository has no separate protocol, story-format, run-record, or scaffold specifications. Keep
the route contract in `GUI-SPEC.md`, the live writer screen in `Writer.MD`, the handoff design in
`SPEC-H-handoff.md`, the architect's GUI screens in `Architect.MD`, and proposed editor work in
`SPEC-E-editor.md` rather than copying those details into this file.

## Working process

Change is delivered in **small, independently-pausable blocks**, not whole features at once.

- **Split each feature into named blocks** and finish one before starting the next. Prefer the
  smaller self-contained slice even when it is not the most efficient path.
- **Keep the owner in the loop**: present the block plan and surface real design forks *before*
  coding; report at each block boundary.
- **Test once per block, not per step.** Do not run the model after every edit.
- **Live runs are the owner's to run**, batched. Hand off after the cheap static checks
  (`npx tsc`, `npm test`, `npm run preflight`) with the exact commands.
- Engine changes and story-authoring changes are separate blocks — the engine must stay
  story-independent.

## Commands

```bash
npx tsx story-writer.ts stories/doorway --chapter=1
```

One run writes **one chapter**. Between chapters, `--next-chapter` opens the architect handoff that
re-authors the cast for the next one ([SPEC-H-handoff.md](SPEC-H-handoff.md)).

Requires **LM Studio running locally** at `http://localhost:1234/v1` with the story's models loaded.

## Architecture

The engine (everything `story-writer.ts` used to hold in one file) lives under [engine/](engine/),
split leaf-first: `engine-state.ts`, `config-util.ts`, `json-extract.ts`, `skills.ts` and
`story-schema.ts` have no engine dependencies; `llm-client.ts`, `agent.ts`, `story-format.ts` and
`story-spec.ts` build on those; `preflight.ts`, `consult.ts`, `architect.ts` and `scene-loop.ts`
build on those in turn;
`story-writer.ts` (root) is the composition root that imports all of them and wires up the CLI and
the `HOST` object. Separately, `story-writer.ts` → [server/server.ts](server/server.ts) →
{`run-control-routes.ts`, `scaffold-routes.ts`, `next-chapter-routes.ts`} → `http-util.ts` → (nothing), all under
[server/](server/) — nothing in that chain imports `story-writer.ts` or any `engine/` module at run
time. `prompts.ts`, `ansi.ts` and `live.ts` stay at the repo root because both chains import them;
where `live.ts` needs an engine type (`Agent`, `RunEvent`) it reaches into `engine/agent.ts` /
`engine/scene-loop.ts` with `import type`, which is erased and creates no runtime cycle, while
`engine/agent.ts`, `engine/llm-client.ts` and `engine/scene-loop.ts` import `live.ts`'s runtime
values (`RUN`, `sseWrite`, ...) the ordinary way. **There are no import cycles here. Keep it that
way.**

| file | what is in it |
| --- | --- |
| [story-writer.ts](story-writer.ts) | the composition root: CLI flags, the story picker, the scaffold console UI, `runAndSave`, the `HOST` object handed to `server/server.ts` |
| [engine/engine-state.ts](engine/engine-state.ts) | mutable run knobs shared across the engine — stream/debug/token-cap, the per-run LLM log handles, the terminal status line |
| [engine/config-util.ts](engine/config-util.ts) | kv-map config parsing (`num`/`bool`/`enumOf`, currently exercised only by `tests/writer.test.ts`) and the shared `slugify` |
| [engine/json-extract.ts](engine/json-extract.ts) | pulling a structured reply (or a prose fallback) out of raw model output |
| [engine/skills.ts](engine/skills.ts) | the general skill catalog and a story's `skills:`/`restrictions:` overrides |
| [engine/story-schema.ts](engine/story-schema.ts) | the Zod schema for `story.json` (`SceneDef`, `CharacterDef`, `ThinkingConfig`, `ModelsConfig`, ...) |
| [engine/llm-client.ts](engine/llm-client.ts) | the LM Studio HTTP client: request shaping, retry/backoff, streaming |
| [engine/agent.ts](engine/agent.ts) | the `Agent` class — windowed history, generation, its LLM interaction log |
| [engine/story-format.ts](engine/story-format.ts) | loading and validating `story.json` (against `story-schema.ts`), building a `StoryConfig`, discovering stories on disk |
| [engine/story-spec.ts](engine/story-spec.ts) | the architect's proposed `StorySpec` — normalizing, editing, and rendering it to `story.json` |
| [engine/preflight.ts](engine/preflight.ts) | checking a story loads and its models are available; the story-card listing |
| [engine/consult.ts](engine/consult.ts) | the writer↔character consult protocol |
| [engine/architect.ts](engine/architect.ts) | building the architect agent, the interactive story-building conversation, and the between-chapters handoff that re-authors the cast |
| [engine/scene-loop.ts](engine/scene-loop.ts) | wrapping the writer/character agents and the scene-writing loop itself |
| [prompts.ts](prompts.ts) | every word said to a model |
| [server/server.ts](server/server.ts) | the `--serve` viewer's HTTP surface: static files (from `server/gui/`), SSE, and dispatch to the route modules |
| [server/run-control-routes.ts](server/run-control-routes.ts) | routes that steer a scene in flight: stop, pause/resume, model override, interactive mode, the reader's consult seat |
| [server/scaffold-routes.ts](server/scaffold-routes.ts) | `/scaffold` and `/scaffold/*` — the new-story interview, server side |
| [server/next-chapter-routes.ts](server/next-chapter-routes.ts) | `/next-chapter` and `/next-chapter/*` — the architect handoff, server side |
| [server/http-util.ts](server/http-util.ts) | the `json()` response helper, `readJsonBody()` and `HttpError`, shared by server.ts and the route modules |
| [server/gui/](server/gui/) | the viewer's static assets — `viewer.html`, `viewer.css`, and `viewer.js`, a composition root that wires together the ES modules under `server/gui/viewer/` (state, SSE, event grouping, block rendering, the shelf, the scaffold interview, the handoff panel) |
| [live.ts](live.ts) | session state shared by the loop and the server, plus the SSE bus and the stop signal |
| [ansi.ts](ansi.ts) | terminal colours |

**The asymmetry is the product.** The writer never sees a persona; a character never sees the premise,
the draft, or anyone else's replies. Every other rule follows from protecting that.

**Agents** are all the same generic `Agent` class (windowed history + rolling `digest`), differing
only by system prompt, model and temperature: **writer** (0.8) and one **character** (0.9) per entry
in `story.json`'s `characters[]`.

The one invariant to hold while editing the engine: **`consult()` never touches `agent.history`** —
the caller folds in only the accepted answer, which is what makes `agent.fork()` a genuinely clean
retry.

**`server/server.ts` and the route modules never import `engine/`.** Everything a route needs arrives
as a `ServerHost` object built in `story-writer.ts` (`HOST`). Adding a route that needs something new
means adding a host method, not an import.

**`live.ts` exists because the two halves genuinely write the same variables** — `/pause` sets
`pausing`, the loop reads it at its next boundary; `writeScene()` sets `writer`/`agents` and `/model`
reaches through them to swap a model mid-run. ESM cannot share a writable `let` across modules, so
they are fields on one exported `LIVE` object. `RUN`/`stopRun`/`armRun`/`StoppedError` live there too.
`engine-state.ts` follows the same pattern for the engine's own run knobs (stream/debug/token-cap, the
LLM log handles) — kept separate from `LIVE` because those are engine-internal, not loop↔server shared
state.

**Every word said to a model lives in [prompts.ts](prompts.ts), and nothing else does.** The test is
whether a model ever sees the string; console output, log lines and warnings are not prompts and stay
in the engine. `prompts.ts` imports **nothing** from `story-writer.ts` — each function takes plain
strings, numbers and lists, so shapes like a character's capabilities arrive already flattened.
