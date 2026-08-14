# STORY FORMAT — authoring a story folder

`stories/<name>/story.md`, `##` sections, `### NAME` sub-blocks under `## Characters`. Story dirs
resolve against the repo folder, not the cwd. `defaults.md` at the repo root uses the same grammar
(`## Models`, `## Config`) and is read only when no story is loaded yet
([SPEC-S-scaffold.md](SPEC-S-scaffold.md) §2); it is optional.

## Field reference (normative)

| section | key | default | absent / malformed |
|---|---|---|---|
| `## Premise` | (prose) | — | **throws** — nothing to write. Blank lines are kept (runs collapse to one, ends trimmed): paragraphing is part of the prose, and it is what lets a scaffolded story round-trip unchanged |
| `## Scene` | `place` | `""` | omitted from both prompts |
| | `question` | `""` | **warns** — the writer alone decides when it is done |
| | `pov` | `""` | not a known character ⇒ warns, ignored |
| | `length` | `700` | non-integer or `< 1` ⇒ warns, default |
| `## Writer` | `file` | — | declared but unreadable ⇒ **throws**; undeclared ⇒ no style block, silent |
| `## Characters` | `### NAME` | — | none ⇒ **throws**; duplicate name ⇒ **throws** |
| | `file` | — | missing or unreadable ⇒ **throws** |
| | `model` | `models.default` | — |
| | `skills` | `""` | `\|`-separated, each `name :: meaning`; nameless entry ⇒ warns, dropped |
| | `lacks` | `""` | `\|`-separated; a name that is not a general skill ⇒ warns, ignored |
| | `knows` | `""` | — |
| `## Config` | `retries` | `2` | every value: warns and uses the default, never throws |
| | `clarifications` | `2` | |
| | `max_steps` | `24` | |
| | `max_prose_words` | `140` | ceiling on ONE draft's prose — the pacing dial, [LOOP.md](LOOP.md#pacing) |
| | `stream` | `true` | only `true`/`false` |
| | `debug` | `false` | |
| | `thinking` | `low` | `off/low/medium/high/default` |
| | `thinking_writer` / `_character` / `_summary` | `thinking` | |
| | `request_timeout` | `120` (s) | |
| | `attempts` | `3` (total tries) | `1` = never retry |
| | `max_tokens` | `2000` | shared by the reasoning pass and the reply; higher than the engine this forked from because a draft carries prose |
| `## Models` | `default` | `qwen3.6-35b-a3b` | |
| | `writer` / `summary` | `default` | |

Inline `# comments` are stripped after `key: value` in the structured sections **only** — never inside
a character block, where `knows:` and `skills:` are prose.

## Skills syntax

`skills:` adds to the catalog, `lacks:` removes from it, and the order is fixed: `lacks:` applies to
the **catalog only**, then `skills:` are added — so a name in both ends up present, with a warning.
Names match case- and spacing-insensitively (`Lock Picking` and `lockpicking` are one skill). Why the
result is checked rather than enforced: [DESIGN.md](DESIGN.md#skills-are-checked-not-gated).

## Sharp edges

- A model id is the one field a structural load cannot check. `--preflight` asks LM Studio's
  `/v1/models` what is actually loaded; an unreachable server downgrades to a warning.
- `config.clarifications: 0` is rejected (`num` requires `>= 1`). To stop characters asking, say so in
  the persona instead.
- A `lacks:` naming something the catalog does not contain removes nothing — silently the *opposite*
  of what was asked. It warns; the scaffolder refuses it outright.
- `loadStory()` takes an optional model override beating `## Models → default:` for one run only. The
  viewer's dropdown sets it ([GUI-SPEC.md](GUI-SPEC.md) §4.4); nothing in the story format can. It
  applies before per-character and per-role fallbacks resolve, so it reaches exactly the agents that
  would have inherited the default and nothing that named its own `model:`.
