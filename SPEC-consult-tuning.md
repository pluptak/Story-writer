# SPEC-consult-tuning: Retry Ceiling, Retry Analytics, Consult Timeline

**Status: proposed, not built.** `consult.ts`/`scene-loop.ts` already retry a rejected consult reply
through a fresh character-agent fork, bounded by `config.retries` (default 2) — but that cap resets on
every single consult call, so a stubborn persona can burn `retries` attempts again and again across a
whole chapter with no chapter-wide ceiling. Nothing today aggregates how much retrying happened, and
the live viewer already renders a "N retry" tag per consult block but has no way to jump between
consult points or see which ones hit a ceiling.

This groups three ideas that all center on the writer↔character retry loop: a chapter-wide
per-character retry ceiling, retry analytics (built from the same counter), and a GUI timeline strip
that consumes both.

## Current behavior

- `RunConfig.retries` (default 2, `engine/story-schema.ts`) is read once per consult, at the
  accept/retry decision in `writeScene` (`engine/scene-loop.ts`, `attempt > retries`). The `attempt`
  counter is a local `let` scoped to that one consult call — it does not persist across consults or
  characters.
- A rejected reply causes the next attempt to run on `persistent.fork()` — a fresh character agent
  instance that never learns it was rejected, per the writer/character asymmetry.
- Every attempt already logs `judge` (verdict/note) and `retry` (attempt/situation/question) events
  into `writing-log.jsonl`, alongside `consult`/`need`/`clarify`/`forced`/`repair`/`skill_flag`/
  `answer` from `consult.ts`. None of this is aggregated anywhere.
- In the viewer, `server/gui/viewer/events.js`'s `build()` groups a character's consult attempts into
  one block (new block on `attempt === 1`), and `blocks.js`'s `renderConsult()` derives a "N retry" tag
  from `attempts.length - 1`. The wire-level `retry` event itself is parsed but not used for this —
  `build()` has no `case "retry"`.

## Proposed engine changes

**Schema — `engine/story-schema.ts`**
- `RunConfig`: add `maxCharacterRetries: z.number().int().min(0).optional()` — `undefined` means no
  chapter-wide ceiling (today's behavior, unchanged by default).
- `CharacterDef`: add `maxRetries: z.number().int().min(0).optional()` — `undefined` falls back to
  `config.maxCharacterRetries`. This mirrors `ModelsConfig`'s default/override shape rather than
  introducing a new pattern.

**`engine/scene-loop.ts` — `writeScene`**
- Add `const retryCounts = new Map<string, number>()`, scoped to one `writeScene` call (one chapter),
  alongside the existing per-character maps (`agents`, `lastAsked`).
- At the accept/retry decision, compute the effective ceiling as `def.maxRetries ??
  cfg.maxCharacterRetries`. Once a character is at or over that ceiling, treat the reply as accepted
  immediately regardless of the per-consult `attempt`/`retries` count.
- Increment `retryCounts` for the character on each retry actually taken.
- The first time a character's cumulative count reaches its ceiling, log `{ t: "retry_capped",
  character, count }` once. Add this shape to the `RunEvent` union.
- Add `retries: Record<string, number>` to the `scene_end` payload, from
  `Object.fromEntries(retryCounts)` — the analytics is the same counter the ceiling logic already
  maintains, not a separate aggregation pass.

No `prompts.ts` change: capping is engine bookkeeping. The writer simply receives an ordinary accepted
reply and is not told a ceiling was hit.

**Docs to update in the same change** — `GUI-SPEC.md`'s `ConsultEvent`/`RunEvent` list (add
`retry_capped`) and its `scene_end` payload shape (add `retries`).

## Proposed GUI changes

**`server/gui/viewer/events.js`** — give `build()` a case for `retry_capped` that attaches
`capped: true` to the character's currently-open consult block, the same way `judge`/`accept` already
close a block out.

**`server/gui/viewer/timeline.js` (new)** — a compact horizontal strip, one marker per consult block,
reading the same grouped blocks `events.js`/`blocks.js` already produce from `LIVEV.events` (no new
state). Each marker shows the character, a retried indicator (`attempts.length > 1`, the same
condition `renderConsult()` already uses), and the new capped flag. Clicking a marker scrolls to that
block's `[data-seq="..."]` element and adds it to the existing `open` Set (`state.js`) so it
auto-expands.

Mount it in `story-page.js` alongside the existing live-run rendering, following the module-per-concern
split `hud.js`/`blocks.js` already use.

## Implementation blocks

1. **Engine: retry ceiling + analytics.** Schema fields, the `retryCounts` map and ceiling check in
   `writeScene`, the `retry_capped` event, the `scene_end.retries` field, `GUI-SPEC.md` updates. Tests
   in `tests/consult.test.ts` and `tests/run-state.test.ts` (both already exercise
   `writeScene`/`runChapter`): a stub character that always returns a "retry" verdict hits the ceiling
   and gets force-accepted after N retries, `retry_capped` logs exactly once, `scene_end.retries`
   reports the right count, and the no-ceiling-set case is unchanged. Verify: `npx tsc`, `npm test`.
2. **GUI: consult timeline strip.** `events.js`'s `retry_capped` handling, the new `timeline.js`,
   wiring into `story-page.js`. Verify: browser check against the dev server, driving a chapter with
   several consults (including a deliberately low `maxCharacterRetries` in a scratch story to force a
   capped marker) — this needs LM Studio running locally with the story's models loaded, so the live-run
   part is the owner's to run: `npx tsx story-writer.ts stories/<name> --chapter=<n> --serve`.

## Out of scope

- Persisting `retries` into retained `RunSummary` (multi-run history) — waits on `RunSummary` gaining a
  `chapter` field, already tracked as a gap in `Writer.MD`.
- A per-run or story-wide retry dashboard. This covers one live/retained chapter's timeline only.
