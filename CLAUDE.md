# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## What this is

A **story writer** engine. A writer agent drafts one scene from a premise and, whenever what happens
next turns on a character's choice, **consults** that character's agent. The character may ask for a
fact it was not given before answering; the writer accepts the answer or rewrites the question and
asks a **fresh instance** that never learns it was rejected. Everything about a particular story
lives in [stories/](stories/) — the user's own content, gitignored — and the engine knows nothing
about any of it. The one exception is [tests/fixtures/doorway/](tests/fixtures/doorway/), the single
story committed with the engine: it is the architect's worked example (`architectExample()`) and the
shared fixture the deterministic tests load, so neither depends on whatever the user keeps locally.
[tests/fixtures/recorded-run/](tests/fixtures/recorded-run/) sits beside it and is not a second such
story — it is one captured doorway run (its `story.json`, its `scene.md`, and every model reply,
prompts stripped) that `tests/replay.test.ts` plays back. Rebuild it with
`node scripts/make-replay-fixture.mjs <run-dir>` whenever a change legitimately alters which calls the
engine makes.

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
| [Writer.MD](Writer.MD) | the writer's role, the reader seat, and the live-run screen |
| [Architect.MD](Architect.MD) | the architect — both modes, the handoff's behaviour and edit surface, and its two GUI screens |
| [Character.MD](Character.MD) | the character agent — what it holds and never sees, and the consult from its side |
| [Clarifier.MD](Clarifier.MD) | the clarifier — the author's mid-scene fact answers, their bounds, and the rewind |
| [Judge.MD](Judge.MD) | any judge variant — the per-answer gate, the narration lint, the batch judge, the cast judge |
| [GUI-CHECKLIST.md](GUI-CHECKLIST.md) | you changed anything under `server/gui/` — the manual pass that stands in for the GUI tests this repo does not have |
| [PLANS.md](PLANS.md) | anything not built yet — every proposal, follow-up and known weak spot |
| [defaults.md](defaults.md) | what `defaults.json` settles before a story exists |

The repository has no separate protocol, story-format, run-record, or scaffold specifications — the
Zod schema in `engine/story-schema.ts` is the story format's own definition. Keep the route contract in
`GUI-SPEC.md`, the live writer screen in `Writer.MD`, the architect and the handoff in `Architect.MD`,
and everything unbuilt in `PLANS.md` rather than copying those details into this file.

**That table is the whole set — resist adding a row to it.** A plan goes in `PLANS.md`, never in a
file of its own; when it ships, its behaviour moves into whichever surface document owns it and **its
entry in `PLANS.md` is deleted**, because git history is where implementation notes belong. That is
the rule the `SPEC-*.md` sprawl broke.

## Working process

Change is delivered in **small, independently-pausable blocks**, not whole features at once.

- **Split each feature into named blocks** and finish one before starting the next. Prefer the
  smaller self-contained slice even when it is not the most efficient path.
- **Keep the owner in the loop**: present the block plan and surface real design forks *before*
  coding; report at each block boundary.
- **Test once per block, not per step.** Do not run the model after every edit.
- **Live runs are the owner's to run**, batched. Hand off after the cheap static checks
  (`npx tsc`, `npm test`, `npm run lint`, `npm run preflight`) with the exact commands.
- Engine changes and story-authoring changes are separate blocks — the engine must stay
  story-independent.

## Commands

```bash
npx tsx story-writer.ts stories/doorway --chapter=1
```

One run writes **one chapter**. Between chapters, the viewer's handoff panel (started with `--serve`)
re-authors the cast for the next one ([Architect.MD](Architect.MD)). The new-story interview and the
handoff are browser-only; passing their old console flags (`--new`, `--oneshot`, `--idea`,
`--next-chapter`) is rejected with a pointer at `--serve`. `--headless` starts the server alone — no
story argument, no console picker, no one-shot — with the browser driving from the shelf and Ctrl-C
stopping any run in flight gracefully before exit.

Requires **LM Studio running locally** at `http://localhost:1234/v1` with the story's models loaded.

## Architecture

The engine (everything `story-writer.ts` used to hold in one file) lives under [engine/](engine/),
split leaf-first: `engine-state.ts`, `config-util.ts`, `json-extract.ts`, `warnings.ts`,
`quote-lint.ts`, `skills.ts` and
`story-schema.ts` have no engine dependencies; `llm-client.ts`, `agent.ts`, `sense-lint.ts`,
`story-format.ts` and `story-spec.ts` build on those; `preflight.ts`, `consult.ts`, `architect.ts` and `scene-loop.ts`
build on those in turn;
`story-writer.ts` (root) is the composition root that imports all of them and wires up the CLI and
the `HOST` object, and [app.ts](app.ts) (root) is the application layer above both — run setup, the
story pick, and the pick → run → pick loop. Separately, `app.ts` → [server/server.ts](server/server.ts) →
{`run-control-routes.ts`, `scaffold-routes.ts`, `next-chapter-routes.ts`, `run-log-routes.ts`, `story-read-routes.ts`, `story-edit-routes.ts`} →
`http-util.ts` → (nothing), all under
[server/](server/) — nothing in that chain imports `story-writer.ts`, `app.ts` or any `engine/` module at run
time. `prompts.ts`, `ansi.ts` and `live.ts` stay at the repo root because both chains import them;
where `live.ts` needs an engine type (`Agent`, `RunEvent`) it reaches into `engine/agent.ts` /
`engine/scene-loop.ts` with `import type`, which is erased and creates no runtime cycle, while
`engine/agent.ts`, `engine/llm-client.ts` and `engine/scene-loop.ts` import `live.ts`'s runtime
values (`RUN`, `sseWrite`, ...) the ordinary way. **There are no import cycles here. Keep it that
way.**

| file | what is in it |
| --- | --- |
| [story-writer.ts](story-writer.ts) | the composition root: import-time engine wiring and the console entry points (`--preflight`, `--consult`) — everything else starts from `app.ts` |
| [app.ts](app.ts) | the application layer: run setup (`startChapterRun`), the story pick (browser-driven or console), the pick → run → pick loop, and the headless bootstrap (`--headless`) with its graceful-shutdown signal |
| [cli-flags.ts](cli-flags.ts) | the one place that reads `process.argv` — `SERVE`/`HEADLESS`/`PORT`/`STORY_DIR`, the `flag()` reader, and the retired-flag rejection |
| [run-and-save.ts](run-and-save.ts) | everything one chapter run does around the scene loop: the out/ directory and its logs, incremental scene.md, retained-run rotation, and the chapter snapshot |
| [run-manifest.ts](run-manifest.ts) | which engine wrote a run — a source fingerprint taken at import time (so a stale `--serve` process is caught rather than mislabelled), the git revision beside it, and `out/<id>/manifest.json` |
| [host.ts](host.ts) | the `ServerHost` object handed to `server/server.ts`, plus its story.json read/persist helpers and the architect session factories |
| [engine/engine-state.ts](engine/engine-state.ts) | mutable run knobs shared across the engine — stream/debug/token-cap, the console echo, the per-run LLM log handles, the terminal status line |
| [engine/config-util.ts](engine/config-util.ts) | the shared filename `slugify` |
| [engine/json-extract.ts](engine/json-extract.ts) | pulling a structured reply (or a prose fallback) out of raw model output |
| [engine/warnings.ts](engine/warnings.ts) | the engine's warning sink — `WARN.sink` is swapped, never `console` |
| [engine/quote-lint.ts](engine/quote-lint.ts) | the mechanical half of the narration lint: quoted lines matched against the granted ledger, no model call |
| [engine/sense-lint.ts](engine/sense-lint.ts) | the other mechanical half: a restricted sense narrated anyway, matched by verb against the character's own CANNOT list, no model call |
| [engine/skills.ts](engine/skills.ts) | the general skill catalog, the special-skill bible, restriction and reach resolution (I1–I5), and a story's `skills:`/`restrictions:` overrides |
| [engine/story-schema.ts](engine/story-schema.ts) | the Zod schema for `story.json` (`SceneDef`, `CharacterDef`, `ThinkingConfig`, `ModelsConfig`, ...) |
| [engine/llm-client.ts](engine/llm-client.ts) | the LM Studio HTTP client: request shaping, retry/backoff, streaming, and `SITE_HEADER` — the call site's stable name (`writer.draft`), sent as a header so the model never sees it and a fake or a replay can tell callers apart without matching drifting prompt text |
| [engine/agent.ts](engine/agent.ts) | the `Agent` class — windowed history, generation, its LLM interaction log |
| [engine/story-format.ts](engine/story-format.ts) | loading and validating `story.json` (against `story-schema.ts`), building a `StoryConfig`, discovering stories on disk |
| [engine/story-spec.ts](engine/story-spec.ts) | the architect's proposed `StorySpec` — normalizing, editing, and rendering it to `story.json` |
| [engine/preflight.ts](engine/preflight.ts) | checking a story loads and its models are available; the story-card listing |
| [engine/consult.ts](engine/consult.ts) | the writer↔character consult protocol |
| [engine/architect.ts](engine/architect.ts) | building the architect agent, the interactive story-building conversation, and the between-chapters handoff that re-authors the cast |
| [engine/scene-loop.ts](engine/scene-loop.ts) | wrapping the writer/character agents and the scene-writing loop itself |
| [prompts.ts](prompts.ts) | every word said to a model — a thin barrel re-exporting the [prompts/](prompts/) role files (common, architect, consult, writer, judge, clarify), which match one engine caller each |
| [server/server.ts](server/server.ts) | the `--serve` viewer's HTTP surface: static files (from `server/gui/`), SSE, and dispatch to the route modules |
| [server/run-control-routes.ts](server/run-control-routes.ts) | routes that steer a scene in flight: stop, pause/resume, model override, interactive mode, the reader's consult seat |
| [server/scaffold-routes.ts](server/scaffold-routes.ts) | `/scaffold` and `/scaffold/*` — the new-story interview, server side |
| [server/next-chapter-routes.ts](server/next-chapter-routes.ts) | `/next-chapter` and `/next-chapter/*` — the architect handoff, server side |
| [server/run-log-routes.ts](server/run-log-routes.ts) | `/runs/llm`, `/runs/llm/file`, `/runs/log`, `/log.jsonl` — a run's logs (per-agent LLM transcripts, the retained and the in-progress writing logs), read-only by construction |
| [server/story-read-routes.ts](server/story-read-routes.ts) | `/stories`, `/cast` (GET), `/chapter` (GET) — read-only story views: the shelf's story-card listing, the live screen's full cast (models omitted), and an accepted chapter's markdown; all available while a run is in flight |
| [server/story-edit-routes.ts](server/story-edit-routes.ts) | `/story/edit` (GET), `/story/check`, `/story/save`, `/story/discard`, `/story/suggest` (POST) — the `story.json` form editor; load, validate, save, discard the last unwritten scene, and a stateless architect suggestion call. Refuses with `409` while something holds `story.json`: a run, the post-pick loading window, or an open handoff |
| [server/http-util.ts](server/http-util.ts) | the `json()` response helper, `readJsonBody()` and `HttpError`, shared by server.ts and the route modules |
| [server/gui/](server/gui/) | the viewer's static assets — `viewer.html`, `viewer.css`, and `viewer.js`, a composition root that wires together the ES modules under `server/gui/viewer/` (state, SSE, event grouping, block rendering, the shelf, the scaffold interview, the handoff panel) |
| [live.ts](live.ts) | session state shared by the loop and the server, plus the SSE bus and the stop signal |
| [ansi.ts](ansi.ts) | terminal colours |

**The asymmetry is the product.** The writer never sees a persona; a character never sees the premise,
the draft, or anyone else's replies. Every other rule follows from protecting that.

**Agents** are all the same generic `Agent` class (windowed history + rolling `digest`), differing
only by system prompt, model and temperature: **writer** (0.8) and one **character** (0.9) per entry
in `story.json`'s `characters[]`, plus author-side helpers that share the writer's voice but hold one
response schema each — the **clarifier** (one per scene) and, at 0.3 with no history, four judge
variants (`newJudge`, `newBatchJudge`, `newNarrationJudge`, `newDoneJudge`). Each role owns a doc of its own — [Writer.MD](Writer.MD), [Character.MD](Character.MD),
[Clarifier.MD](Clarifier.MD) and [Judge.MD](Judge.MD), the last one covering all five judge
variants, cast judge included. Why they are separate agents rather than
sections of the writer's prompt is in [Judge.MD](Judge.MD).

Two invariants to hold while editing the engine. **`consult()` never touches `agent.history`** —
the caller folds in only the accepted answer, which is what makes `agent.fork()` a genuinely clean
retry. And **reach never leaks into a character-level representation (I4)** — a skill is intrinsic,
a scene's `reach` grant exists only while that scene is being written, and every surface showing a
character outside a scene (`/cast`, preflight cards, the story editor, the handoff) shows `skills`
and restrictions only; only per-scene resolution in `engine/scene-loop.ts` ever resolves reach
(`engine/skills.ts`'s module docstring carries all five invariants). Both are the same kind of rule:
cheap to state, expensive to rediscover.

**`server/server.ts` and the route modules never import `engine/`.** Everything a route needs arrives
as a `ServerHost` object built in `story-writer.ts` (`HOST`). Adding a route that needs something new
means adding a host method, not an import.

**`live.ts` exists because the two halves genuinely write the same variables** — `/pause` sets
`pausing`, the loop reads it at its next boundary; `writeScene()` sets `writer`/`agents` and `/model`
reaches through them to swap a model mid-run. ESM cannot share a writable `let` across modules, so
they are fields on one exported `LIVE` object. `RUN`/`stopRun`/`armRun`/`releaseForStop`/`StoppedError` live there too.
`engine-state.ts` follows the same pattern for the engine's own run knobs (stream/debug/token-cap, the
LLM log handles) — kept separate from `LIVE` because those are engine-internal, not loop↔server shared
state.

**Every word said to a model lives in [prompts.ts](prompts.ts) and its [prompts/](prompts/)
submodules, and nothing else does.** The test is whether a model ever sees the string; console
output, log lines and warnings are not prompts and stay in the engine. `prompts.ts` and every file
under `prompts/` import **nothing** from `story-writer.ts` — each function takes plain strings,
numbers and lists, so shapes like a character's capabilities arrive already flattened.
