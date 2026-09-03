# Story Writer

A story-writing engine where a **writer agent** drafts prose and **consults character agents** whenever a scene turns on a character's choice. A character answers from its own persona — and only what the writer told it. A rejected answer is re-asked of a **fresh instance** that never learns it was rejected.

[Website](https://opencode.ai) · [CLAUDE.md](CLAUDE.md)

## Quick start

```bash
# Ensure your inference server is running (LM Studio by default, http://localhost:1234/v1) with the story's models loaded
npx tsx story-writer.ts stories/doorway --chapter=1

# Or launch the browser viewer
npx tsx story-writer.ts --serve
```

## How it works

1. **Pick a story** — `stories/` holds every story's content (gitignored). The engine knows nothing about them except what's in `story.json`.
2. **Draft a scene** — the writer agent writes one chapter of prose from the POV of a single character, bounded by the scene's place, question, length, and roster.
3. **Consult the cast** — when what happens next turns on a character's choice, the writer consults that character's agent. The character responds from its own `persona`, `knows`, `skills`, and `restrictions` only.
4. **Reject and retry** — if a character's answer is rejected, the question is re-asked of a fresh instance. The rejected instance learns nothing.
5. **Lint as you go** — every draft passes through quotation-lint, sense-lint, and repeat-lint before it's appended, plus a narration judge.

## Project layout

```
stories/           # Every story's content (gitignored) — story.json + chapters/
engine/            # The engine, split leaf-first (see CLAUDE.md)
server/            # HTTP surface for --serve mode (viewer + API routes)
tests/             # Engine tests, route tests, replay fixture
prompts/           # Every word said to a model
stories/doorway/   # The committed architect example and shared test fixture
```

## Commands

```bash
npx tsx story-writer.ts stories/<name> --chapter=N   # run a specific chapter
npx tsx story-writer.ts --serve                       # launch the browser viewer
npx tsx story-writer.ts --preflight                   # list story cards and check models
npx tsx story-writer.ts --consult                     # run the writer↔character consult protocol

npm test          # engine + route modules
npm run test:gui  # viewer mechanical pass (Playwright)
npm run lint      # ESLint
npm run typecheck # tsc
npm run preflight # story-card listing against LM Studio
```

## Requirements

- **Node.js** (ESM, TypeScript)
- A **local inference server** with the story's models loaded. The provider is selected from the
  environment, never per story:
  - `LLM_PROVIDER` — `lmstudio` (default) | `ollama` | `llamacpp`
  - `LLM_BASE_URL` — the server's base URL ending in `/v1` (default `http://localhost:1234/v1` for
    LM Studio; the old `LM_STUDIO_URL` full-chat-URL form still works)
  - `LLM_API_KEY` — only for servers that want one
- The default models in `defaults.json` are `gemma-4-12b-it-qat-uncensored-heretic`; override per-story in `story.json` → `models.default`

## Architecture

The engine is split leaf-first under `engine/`. Key invariants:

- **The writer never sees a persona**; **a character never sees the premise, the draft, or anyone else's replies.**
- `consult()` never touches `agent.history` — the caller folds in only the accepted answer, which is what makes `agent.fork()` a genuinely clean retry.
- **Reach never leaks into a character-level representation (I4)** — a skill is intrinsic, a scene's reach grant exists only while that scene is being written.
- `server/` and its route modules never import `engine/` — everything a route needs arrives as a `ServerHost` object.

See [CLAUDE.md](CLAUDE.md) for the full architecture, agent roles, and documentation table.

## Writing a story

Every story lives in its own directory under `stories/` with a `story.json` at its root:

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
