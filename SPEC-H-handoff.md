# SPEC-H: Architect Handoff

**Status: built.** The handoff prepares the next chapter between runs. It is a user-invoked action,
not another step inside a scene run. The handoff screen is designed in
[`Architect.MD`](Architect.MD); the rest of the remaining viewer work is in
[`SPEC-GUI-MULTISCENE.md`](SPEC-GUI-MULTISCENE.md).

## Why it exists

Agents are rebuilt for every chapter. No character history carries from one run to the next. The
architect therefore reads the accepted chapter files and rewrites the next chapter's story
definition: character knowledge, goals, personas, skills, restrictions, roster, and scene setup.
That definition is the continuity mechanism.

A character who died can be removed from the next scene's `roster` while remaining in the story's
`characters[]` list for historical context or later use.

## Behavior

- One run writes one chapter selected by `--chapter=<n>` or `POST /select { dir, chapter }`.
- A successful run writes prose to `chapters/<n>.md`.
- A stopped or incomplete run does not replace an existing accepted chapter file.
- `--next-chapter` opens the console handoff. The HTTP equivalent is `/next-chapter/*`.
- The handoff reads the highest numbered accepted chapter and prepares the next number.
- The architect proposes edits; it never writes directly during a conversation.
- Accept writes `story.json`, validates it with preflight, and restores the previous file if validation
  fails.
- The handoff does not start a run. The user starts the prepared chapter separately.

## Architect edit surface

The architect can edit the fields supported by `engine/story-spec.ts`:

- story metadata: `title`, `premise`, and `writerStyle`
- scenes: `scene_<n>.place`, `question`, `pov`, `length`, and `roster`
- scene structure: `add_scene` and `remove_scene`
- characters: `persona`, `knows`, `goal`, `skills`, and `restrictions`
- cast membership: `add_character` and `remove_character`

Removing the last scene is refused. Removing a scene that already has accepted prose is refused,
because renumbering would make existing `chapters/<n>.md` files refer to different scenes.

## Console and HTTP surfaces

Console:

```text
npx tsx story-writer.ts stories/example --next-chapter
npx tsx story-writer.ts stories/example --chapter=2
```

HTTP:

```text
GET  /next-chapter
POST /next-chapter/start    { dir, model? }
POST /next-chapter/say      { text }
POST /next-chapter/accept
POST /next-chapter/abandon
```

The HTTP response and SSE state shapes are maintained in [`GUI-SPEC.md`](GUI-SPEC.md), which is the
single route contract. The server reaches the engine through `ServerHost` and never imports engine
modules directly.

## Out of scope

- Carrying agent histories across chapters.
- Starting a chapter automatically after accepting a handoff.
- Deciding what to do with later chapters when an earlier chapter is rewritten.
- The handoff screen's own design and remaining GUI work, which belong to
  [`Architect.MD`](Architect.MD). The viewer has the panel; this document stays about the behaviour
  behind it.
