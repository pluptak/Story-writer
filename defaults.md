# Scaffold Defaults

`defaults.json` supplies the architect's settings while a new story is being built. It is used only
before a `story.json` exists; once a story is loaded, that story's `models` and `config` apply.

The file is optional. If it is missing or invalid, the built-in defaults in
[`engine/story-format.ts`](engine/story-format.ts) are used. A CLI `--model` override takes priority
over both sources.

## Settings

| JSON path | Purpose | Built-in fallback |
| --- | --- | --- |
| `models.default` | model used for the scaffold conversation | `qwen3.6-35b-a3b` |
| `models.architect` | model used by the architect | `models.default` |
| `config.thinking` | reasoning level, and the fallback for the one below | `low` |
| `config.thinking_architect` | architect reasoning level | `config.thinking` |
| `config.request_timeout` | request timeout in seconds | `120` |
| `config.attempts` | total request attempts | `3` |
| `config.max_tokens` | response token cap | `2000` |
| `config.stream` | stream model output | `true` |
| `config.debug` | enable engine debug output | `false` |

The checked-in values are intentionally suitable for the local LM Studio setup. Edit
[`defaults.json`](defaults.json) when changing them; this file documents their meaning rather than
duplicating the values.
