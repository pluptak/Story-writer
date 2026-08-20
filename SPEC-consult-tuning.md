# SPEC-consult-tuning: Retry Ceiling, Retry Analytics, Consult Timeline

**Status: implemented.** `consult.ts`/`scene-loop.ts` retry a rejected consult reply through a fresh
character-agent fork, bounded by `config.retries` (default 2). An optional chapter-wide per-character
ceiling now limits cumulative retries across consult calls, and the same counter is emitted in the
`scene_end` analytics payload. The live viewer renders a consult timeline that can jump between consult
points and marks blocks that hit the ceiling.

This groups three ideas that all center on the writer↔character retry loop: a chapter-wide
per-character retry ceiling, retry analytics (built from the same counter), and a GUI timeline strip
that consumes both.

## Implemented behavior

- `RunConfig.retries` (default 2, `engine/story-schema.ts`) remains the per-consult retry bound.
  `RunConfig.maxCharacterRetries` is an optional chapter-wide default ceiling, while
  `CharacterDef.maxRetries` overrides it for one character. When neither is set, behavior is unchanged.
- `writeScene` keeps `retryCounts` for the chapter. A retry is counted only when a fresh attempt is
  actually taken. Reaching a character's effective ceiling force-accepts the current reply and logs one
  `retry_capped` event for that character.
- A rejected reply causes the next attempt to run on `persistent.fork()` — a fresh character agent
  instance that never learns it was rejected, per the writer/character asymmetry.
- Every attempt already logs `judge` (verdict/note) and `retry` (attempt/situation/question) events
  into `writing-log.jsonl`, alongside `consult`/`need`/`clarify`/`forced`/`repair`/`skill_flag`/
  `answer` from `consult.ts`. `scene_end.retries` now contains the cumulative retry counts by
  character, built directly from the same `retryCounts` map.
- In the viewer, `server/gui/viewer/events.js`'s `build()` groups a character's consult attempts into
  one block (new block on `attempt === 1`), and `blocks.js`'s `renderConsult()` derives a "N retry" tag
  from `attempts.length - 1`. `build()` also handles `retry_capped` and attaches `capped: true` to the
  open consult block.

## Engine implementation

**Schema — `engine/story-schema.ts`**
- `RunConfig` has `maxCharacterRetries: z.number().int().min(0).optional()` — `undefined` means no
  chapter-wide ceiling (today's behavior, unchanged by default).
- `CharacterDef` has `maxRetries: z.number().int().min(0).optional()` — `undefined` falls back to
  `config.maxCharacterRetries`. This mirrors `ModelsConfig`'s default/override shape.

**`engine/scene-loop.ts` — `writeScene`**
- `writeScene` creates `const retryCounts = new Map<string, number>()`, scoped to one call (one chapter),
  alongside the existing per-character maps (`agents`, `lastAsked`).
- At the accept/retry decision, it computes the effective ceiling as `def.maxRetries ??
  maxCharacterRetries`. Once a character is at or over that ceiling, it treats the reply as accepted
  immediately regardless of the per-consult `attempt`/`retries` count.
- `retryCounts` is incremented for the character on each retry actually taken.
- The first time a character's cumulative count reaches its ceiling, it logs `{ t: "retry_capped",
  character, count }` once. Add this shape to the `RunEvent` union.
- The `scene_end` payload includes `retries: Record<string, number>`, from
  `Object.fromEntries(retryCounts)` — the analytics is the same counter the ceiling logic already
  maintains, not a separate aggregation pass.

No `prompts.ts` change: capping is engine bookkeeping. The writer simply receives an ordinary accepted
reply and is not told a ceiling was hit.

**Documentation updated in the same change** — `GUI-SPEC.md`'s `ConsultEvent`/`RunEvent` list includes
`retry_capped`, and its `scene_end` payload shape includes `retries`.

## GUI implementation

**`server/gui/viewer/events.js`** — `build()` has a case for `retry_capped` that attaches
`capped: true` to the character's currently-open consult block, the same way `judge`/`accept` already
close a block out.

**`server/gui/viewer/timeline.js` (new)** — a compact horizontal strip, one marker per consult block,
reading the same grouped blocks `events.js`/`blocks.js` already produce from `LIVEV.events` (no new
state). Each marker shows the character, a retried indicator (`attempts.length > 1`, the same
condition `renderConsult()` already uses), and the new capped flag. Clicking a marker scrolls to that
block's `[data-seq="..."]` element and adds it to the existing `open` Set (`state.js`) so it
auto-expands.

The strip is mounted by `pages.js` alongside the existing live-run rendering, following the
module-per-concern split used by `hud.js` and `blocks.js`.

## Implementation blocks

1. **Engine: retry ceiling + analytics — implemented.** Schema fields, the `retryCounts` map and
   ceiling check in `writeScene`, the `retry_capped` event, the `scene_end.retries` field, and
   `GUI-SPEC.md` updates are present. Tests cover schema parsing and `writeScene` plumbing. Verified
   with `npx tsc` and `npm test` (263 tests passing). A live model-driven retry-ceiling integration
   test has not been automated.
2. **GUI: consult timeline strip — implemented.** `events.js` handles `retry_capped`; `timeline.js`
   renders consult markers and wires marker clicks to expansion and scrolling; `pages.js` mounts it;
   `viewer.html` and `viewer.css` provide the container and styling. The browser/live-run check remains
   pending and requires LM Studio: `npx tsx story-writer.ts stories/<name> --chapter=<n> --serve`.

## Out of scope

- Persisting `retries` into retained `RunSummary` (multi-run history) — waits on `RunSummary` gaining a
  `chapter` field, already tracked as a gap in `Writer.MD`.
- A per-run or story-wide retry dashboard. This covers one live/retained chapter's timeline only.
