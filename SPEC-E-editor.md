# SPEC-E: Story Editor

**Status: proposed, not built.** The engine stores authored stories in one validated `story.json`.
The viewer currently reads stories and can create a new one through the scaffold interview, but it
cannot edit an existing story.

## Goals

- Edit an existing story without silently dropping fields or applying partial writes.
- Use the same Zod-backed loader and preflight checks as a normal run.
- Keep architect suggestions provisional until the user accepts and saves them.
- Leave run output and accepted chapter prose outside the editable story definition.

## Proposed editor model

The server loads a story into an in-memory draft. The browser edits that draft and sends the complete
`story.json` back for validation. A save is allowed only when the full draft loads successfully.
Warnings remain visible but do not block saving. The server writes the file atomically, or not at all.

The editor should expose the authored fields represented by the current schema:

- story metadata: `title`, `premise`, and `writerStyle`
- chapters: `scenes[]`, including `place`, `question`, `pov`, `length`, and `roster`
- characters: `name`, `model`, `persona`, `knows`, `goal`, `skills`, and `restrictions`
- runtime settings: `config` and `models`

The editor must not expose `chapters/<n>.md` or `out/` as editable story-definition files. Chapter
prose is produced by a run and is durable content, not configuration.

## Proposed routes

These routes are a contract for a later implementation. Route modules must continue to use
`ServerHost`; they must not import `engine/` directly.

```text
GET  /story/edit?dir=...
  -> { dir, story, warnings[] }

POST /story/check
  body: { dir, story }
  -> { ok, warnings[], error? }

POST /story/save
  body: { dir, story }
  -> { ok: true, warnings[] } | { ok: false, reason }
```

`/story/check` must validate the complete draft in memory. `/story/save` must repeat that validation
server-side and must not write on failure. It should also reject saving while a run for the story is
active, because a run reads the same definition while it is executing.

## GUI blocks

1. Add an editor route and load the complete `story.json` draft.
2. Add schema-aware fields for metadata, chapters, characters, models, and run settings.
3. Debounce validation and preserve textarea selection and scroll position across SSE-triggered renders.
4. Add save, revert, and unsaved-change indicators.
5. Add an architect panel whose accepted suggestions modify the draft only; saving remains explicit.
   This is the editor's own panel, not the scaffold or handoff screen — those belong to
   [`Architect.MD`](Architect.MD).
6. Add browser coverage for malformed drafts, warnings, concurrent runs, and preservation of fields
   not changed by an edit.

## Non-goals

- Supporting the removed `story.md`/persona-file format.
- Editing retained run logs or generated chapter prose.
- Concurrent collaborative editing. Last successful save wins.
- A second story parser in the browser. The engine remains the validation authority.
