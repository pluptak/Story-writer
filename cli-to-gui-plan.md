# CLI-to-GUI Transition Plan

**Status: proposal.** The current application still supports both the console workflows and the
local viewer. This plan describes a possible future transition; it is not an implementation status
document.

## Current boundary

- `--serve` starts the local HTTP viewer on `127.0.0.1`.
- `--preflight` is the maintenance and CI check.
- A run writes one chapter and accepts `--chapter=<n>`.
- `--new`, `--next-chapter`, and `--consult` remain interactive console workflows.
- The viewer controls selection, scaffold, handoff, run control, reader consultation, and SSE updates.

The route contract is maintained in [`GUI-SPEC.md`](GUI-SPEC.md). Do not duplicate its request and
event tables here.

## Possible phases

1. **Complete the viewer.** Add the handoff screen and the multi-chapter reader described in
   [`SPEC-H-handoff.md`](SPEC-H-handoff.md), [`SPEC-GUI-MULTISCENE.md`](SPEC-GUI-MULTISCENE.md), and
   [`SPEC-E-editor.md`](SPEC-E-editor.md).
2. **Extract application services.** Move run setup, persistence, and cleanup out of the CLI-specific
   parts of `story-writer.ts`, while keeping the existing `ServerHost` dependency boundary.
3. **Add a headless bootstrap.** Start the server without requiring a story argument or terminal
   picker, print the local URL, and handle graceful shutdown.
4. **Deprecate console interaction.** Keep `--preflight` and scripted runs, direct interactive users
   to the viewer, and remove console flows only after equivalent browser workflows are verified.
5. **Harden the boundary.** Add tests for startup without a TTY, cleanup after failures, SSE reconnects,
   route preconditions, and shutdown.

## Constraints and risks

- The process currently supports one active run. Do not imply multi-user or concurrent-run support.
- The viewer is intentionally localhost-only and unauthenticated. A wider bind requires authentication,
  authorization, and CSRF protection first.
- Preserve the engine/server rule: route modules receive behavior through `ServerHost` and do not
  import engine modules directly.
- Keep operational messages in the console and run data in the existing JSONL logs; do not make the
  GUI a second source of truth.
