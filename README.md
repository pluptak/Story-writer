# Story Writer

A story-writing engine where a **writer agent** drafts prose and **consults character agents** whenever a scene turns on a character's choice. A character answers from its own persona — and only what the writer told it. A rejected answer is re-asked of a **fresh instance** that never learns it was rejected.

[CLAUDE.md](CLAUDE.md)

## Quick start

```bash
# Ensure your inference server is running (LM Studio by default, http://localhost:1234/v1) with the story's models loaded
npx tsx story-writer.ts data/stories/doorway --chapter=1

# Or launch the browser viewer
npx tsx story-writer.ts --serve
```

## How it works

1. **Pick a story** — `data/stories/` holds your stories' content (gitignored). The engine knows nothing about them except what's in `story.json` (plus the shared `data/catalogs/`). The one committed example is `tests/fixtures/doorway/`.
2. **Draft a scene** — the writer agent writes one chapter of prose from the POV of a single character, bounded by the scene's place, question, length, and roster.
3. **Consult the cast** — when what happens next turns on a character's choice, the writer consults that character's agent. The character responds from its own character definition (`persona`, `knows`, `goal`, `belief`, `impulse`, `voice`, `skills`, `restrictions`) only.
4. **Reject and retry** — if a character's answer is rejected, the question is re-asked of a fresh instance. The rejected instance learns nothing.
5. **Lint as you go** — every draft passes through quotation-lint, sense-lint, and the narration judge (run together in `engine/narration-lint.ts`) plus the repeat-lint guard before it's appended.

## Project layout

```
data/stories/            # Your stories' content (gitignored) — story.json + chapters/
data/catalogs/           # Persisted reusable assets (gitignored)
tests/fixtures/doorway/  # The committed example and shared test fixture
tests/fixtures/recorded-run/ # One captured doorway run, played back by tests/replay.test.ts
engine/                  # The engine, split leaf-first (see CLAUDE.md)
server/                  # HTTP surface for --serve mode (viewer + API routes in server/*.ts, assets in server/gui/)
prompts/                 # Every word said to a model (prompts.ts at the root re-exports them)
docs/                    # One concept per file (see the table in CLAUDE.md)
story-writer.ts          # Composition root: engine wiring + console entry points
app.ts / host.ts / cli-flags.ts  # Application layer / route-host object / the one place that reads process.argv
```

## Commands

```bash
npx tsx story-writer.ts data/stories/<name> --chapter=N  # run a specific chapter (bare name works too)
npx tsx story-writer.ts --serve                          # launch the browser viewer
npx tsx story-writer.ts --headless                       # serve only; the browser drives, Ctrl-C stops gracefully
npx tsx story-writer.ts --preflight                      # list story cards and check models
npx tsx story-writer.ts --consult <Name>                 # run the writer↔character consult protocol

npm test          # engine + route modules (node:test)
npm run check     # typecheck + test + lint in one pass (the pre-handoff gate)
npm run test:gui  # viewer mechanical pass (Playwright)
npm run lint      # ESLint
npm run typecheck # npx tsc
npm run preflight # story-card listing against the inference server
npm run capture   # refresh docs/mockups/current/ (viewer screens as standalone HTML)
```

## Requirements

- **Node.js** (ESM, TypeScript)
- A **local inference server** with the story's models loaded. The provider is selected from the
  environment, never per story:
  - `LLM_PROVIDER` — `lmstudio` (default) | `ollama` | `llamacpp`
  - `LLM_BASE_URL` — the server's base URL ending in `/v1` (default `http://localhost:1234/v1` for
    LM Studio)
  - `LLM_API_KEY` — only for servers that want one
- Request coordination: `LLM_MAX_IN_FLIGHT` (default 1 — one model request on the wire at a time;
  the engine holds the line itself because a local server may drop the in-flight prompt when a
  second one arrives) and `LLM_QUEUE_TIMEOUT_MS` (default 600000 — how long a queued call waits
  before giving up)
- Before a chapter starts, the engine refuses when the server is unreachable or does not know one
  of the story's models; a model that exists but is not loaded only draws a warning (the first
  call waits out the just-in-time load)
- The models in `defaults.json` (`models.default` / `models.architect` / `models.assistant`) are `gemma-4-12b-it-qat-uncensored-heretic`; override per-story in `story.json` → `models.default`

## Architecture

The engine is split leaf-first under `engine/`. Key invariants:

- **The writer never sees a persona**; **a character never sees the premise, the draft, or anyone else's replies.**
- `consult()` never touches `agent.history` — the caller folds in only the accepted answer, which is what makes `agent.fork()` a genuinely clean retry.
- **Reach never leaks into a character-level representation (I4)** — a skill is intrinsic, a scene's reach grant exists only while that scene is being written.
- `server/` and its route modules never import `engine/` at runtime (only `import type`, which is erased) — everything a route needs arrives through a narrow host interface (server/route-hosts.ts).

See [CLAUDE.md](CLAUDE.md) for the full architecture, agent roles, and documentation table.

## Writing a story

Every story lives in its own directory under `data/stories/` with a `story.json` at its root.
The Zod schema in `engine/story-schema.ts` is the format's definition; `tests/fixtures/doorway/story.json`
is the canonical example. Minimal shape (fields like `knows`, `goal`, `belief`, `impulse`, `voice`,
`roster`, `writerStyle`, and `config` default when omitted):

```json
{
  "title": "My Story",
  "premise": "The world the story lives in...",
  "scenes": [{ "place": "...", "question": "...", "pov": "CHAR_NAME", "length": 700 }],
  "characters": [{ "name": "CHAR_NAME", "persona": "...", "skills": [...], "restrictions": [...] }]
}
```

Run `npx tsx story-writer.ts --preflight` to validate and list your story cards before you start.

## License

ISC
