# Scaffold Defaults

`defaults.json` supplies the architect's settings while a new story is being built, and the
character catalog's own assistant. The architect half is used only before a `story.json` exists;
once a story is loaded, that story's `models` and `config` apply. The catalog is global rather than
story-scoped, so its assistant always reads `defaults.json` — there is no story to fall back to.

The file is optional. If it is missing, the built-in defaults in
[`engine/story-format.ts`](../engine/story-format.ts) are used silently; if it exists but cannot be
read or parsed, the built-ins are used anyway **and a warning names the error** — otherwise a
broken file would silently swap the configured model for the built-in one. A CLI `--model` override
takes priority over both sources.

## Settings

| JSON path | Purpose | Built-in fallback |
| --- | --- | --- |
| `models.default` | model used for the scaffold conversation | `qwen3.6-35b-a3b` |
| `models.architect` | model used by the architect | `models.default` |
| `models.assistant` | model used by the character catalog's assistant | **none — see below** |
| `config.thinking` | reasoning level, and the fallback for the two below | `low` |
| `config.thinking_architect` | architect reasoning level | `config.thinking` |
| `config.thinking_assistant` | catalog assistant reasoning level | `config.thinking` |
| `config.request_timeout` | request timeout in seconds | `120` |
| `config.attempts` | total request attempts | `3` |
| `config.max_tokens` | response token cap | `2000` |
| `config.stream` | stream model output | `true` |
| `config.debug` | enable engine debug output | `false` |

**`models.assistant` does not fall back to `models.default`.** Every other model slot falls back to
one that is already configured, because leaving it unset just means "use the one model this
install runs." The catalog assistant is different: it proposes changes to a reusable character on a
model the author never chose for writing, so an unset `models.assistant` is refused outright
("no assistant model is configured") rather than silently running on the story model. Set it
explicitly — to the same model as `models.default` if that is genuinely what you want — to turn the
assistant on.

The checked-in values are intentionally suitable for the local LM Studio setup. Edit
[`defaults.json`](../defaults.json) when changing them; this file documents their meaning rather than
duplicating the values.
