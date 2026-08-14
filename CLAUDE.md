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

## Docs — open the one, not the set

One concept per file, so a bug in the loop never means reading the story format. Read the relevant
one before an architectural change, and keep it in sync afterwards.

| doc | read it when |
| --- | --- |
| [DESIGN.md](DESIGN.md) | you need the *why*: the asymmetry, skills, what is deliberately not built |
| [PROTOCOL.md](PROTOCOL.md) | an agent returned something the engine could not use |
| [LOOP.md](LOOP.md) | a scene stalled, ended early, or spent its budget on narration |
| [STORY-FORMAT.md](STORY-FORMAT.md) | authoring a story folder, or adding a config key |
| [RUN-RECORD.md](RUN-RECORD.md) | anything under `out/` — log events, retention, what the viewer is fed |
| [GUI-SPEC.md](GUI-SPEC.md) | a route, an SSE event, or what a run control does to the run |
| [VIEWER-UI.md](VIEWER-UI.md) | the page looks wrong — rendering, button states, picker, interview |
| [SPEC-S-scaffold.md](SPEC-S-scaffold.md) | `--new`: the architect, the interview, acceptance |
| [CLI.md](CLI.md) | flags, checks, output layout |
| [GOTCHAS.md](GOTCHAS.md) | **before loosening any rule** — the run that earned each one |

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
npx tsx story-writer.ts stories/doorway
```

Requires **LM Studio running locally** at `http://localhost:1234/v1` with the story's models loaded.
Full flag reference in [CLI.md](CLI.md).

## Architecture

The engine (everything `story-writer.ts` used to hold in one file) lives under [engine/](engine/),
split leaf-first: `engine-state.ts`, `config-util.ts`, `json-extract.ts` and `skills.ts` have no
engine dependencies; `llm-client.ts`, `agent.ts`, `story-format.ts` and `story-spec.ts` build on
those; `preflight.ts`, `consult.ts`, `architect.ts` and `scene-loop.ts` build on those in turn;
`story-writer.ts` (root) is the composition root that imports all of them and wires up the CLI and
the `HOST` object. Separately, `story-writer.ts` → [server/server.ts](server/server.ts) →
{`run-control-routes.ts`, `scaffold-routes.ts`} → `http-util.ts` → (nothing), all under
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
| [engine/config-util.ts](engine/config-util.ts) | `story.md` config-value parsing (`num`/`bool`/`enumOf`) and `slugify` |
| [engine/json-extract.ts](engine/json-extract.ts) | pulling a structured reply (or a prose fallback) out of raw model output |
| [engine/skills.ts](engine/skills.ts) | the general skill catalog and a story's `skills:`/`lacks:` overrides |
| [engine/llm-client.ts](engine/llm-client.ts) | the LM Studio HTTP client: request shaping, retry/backoff, streaming |
| [engine/agent.ts](engine/agent.ts) | the `Agent` class — windowed history, generation, its LLM interaction log |
| [engine/story-format.ts](engine/story-format.ts) | parsing `story.md`, loading a `StoryConfig`, discovering stories on disk |
| [engine/story-spec.ts](engine/story-spec.ts) | the architect's proposed `StorySpec` — normalizing, editing, and its renderings |
| [engine/preflight.ts](engine/preflight.ts) | checking a story loads and its models are available; the story-card listing |
| [engine/consult.ts](engine/consult.ts) | the writer↔character consult protocol |
| [engine/architect.ts](engine/architect.ts) | building the architect agent and running the interactive story-building conversation |
| [engine/scene-loop.ts](engine/scene-loop.ts) | wrapping the writer/character agents and the scene-writing loop itself |
| [prompts.ts](prompts.ts) | every word said to a model |
| [server/server.ts](server/server.ts) | the `--serve` viewer's HTTP surface: static files (from `server/gui/`), SSE, and dispatch to the route modules |
| [server/run-control-routes.ts](server/run-control-routes.ts) | routes that steer a scene in flight: stop, pause/resume, model override, interactive mode, the reader's consult seat |
| [server/scaffold-routes.ts](server/scaffold-routes.ts) | `/scaffold` and `/scaffold/*` — the new-story interview, server side |
| [server/http-util.ts](server/http-util.ts) | the `json()` response helper and `readJsonBody()`, shared by server.ts and the route modules |
| [server/gui/](server/gui/) | the viewer's static assets — `viewer.html`, `viewer.css`, `viewer.js` |
| [live.ts](live.ts) | session state shared by the loop and the server, plus the SSE bus and the stop signal |
| [ansi.ts](ansi.ts) | terminal colours |

**The asymmetry is the product.** The writer never sees a persona; a character never sees the premise,
the draft, or anyone else's replies. Every other rule follows from protecting that
([DESIGN.md](DESIGN.md)).

**Agents** are all the same generic `Agent` class (windowed history + rolling `digest`), differing
only by system prompt, model and temperature: **writer** (0.8) and one **character** per `### NAME`
(0.9).

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
