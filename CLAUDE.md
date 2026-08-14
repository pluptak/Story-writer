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

Dependency arrows point one way only — `story-writer.ts` → `server.ts` → {`run-control-routes.ts`,
`scaffold-routes.ts`} → {`http-util.ts`, `live.ts`} → (nothing). Nothing imports `story-writer.ts` at
run time; where a module needs one of its types it uses `import type`, which is erased — that is also
how the two route modules take a `ServerHost` from `server.ts` without creating a runtime cycle back
into it. **There are no import cycles here. Keep it that way.**

| file | what is in it |
| --- | --- |
| [story-writer.ts](story-writer.ts) | the engine: parsing, agents, the consult, the scene loop, the CLI |
| [prompts.ts](prompts.ts) | every word said to a model |
| [server.ts](server.ts) | the `--serve` viewer's HTTP surface: static files, SSE, and dispatch to the route modules |
| [run-control-routes.ts](run-control-routes.ts) | routes that steer a scene in flight: stop, pause/resume, model override, interactive mode, the reader's consult seat |
| [scaffold-routes.ts](scaffold-routes.ts) | `/scaffold` and `/scaffold/*` — the new-story interview, server side |
| [http-util.ts](http-util.ts) | the `json()` response helper and `readJsonBody()`, shared by server.ts and the route modules |
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

**`server.ts` and the route modules never import the engine.** Everything a route needs arrives as a
`ServerHost` object built in `story-writer.ts` (`HOST`). Adding a route that needs something new means
adding a host method, not an import.

**`live.ts` exists because the two halves genuinely write the same variables** — `/pause` sets
`pausing`, the loop reads it at its next boundary; `writeScene()` sets `writer`/`agents` and `/model`
reaches through them to swap a model mid-run. ESM cannot share a writable `let` across modules, so
they are fields on one exported `LIVE` object. `RUN`/`stopRun`/`armRun`/`StoppedError` live there too
and are re-exported from `story-writer.ts` for the tests.

**Every word said to a model lives in [prompts.ts](prompts.ts), and nothing else does.** The test is
whether a model ever sees the string; console output, log lines and warnings are not prompts and stay
in the engine. `prompts.ts` imports **nothing** from `story-writer.ts` — each function takes plain
strings, numbers and lists, so shapes like a character's capabilities arrive already flattened.
