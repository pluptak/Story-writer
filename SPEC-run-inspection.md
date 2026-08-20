# SPEC-run-inspection: Cost/Latency HUD and Run Comparison

**Status: proposed, not built.** This groups two run-debugging ideas. A third — offline chapter
replay — turned out, on inspection, to already be the **Run inspector** item at the top of
[next-steps1.md](next-steps1.md) ("Render retained `writing-log.jsonl` and per-agent `llm/*.jsonl`
data through the existing `/log.jsonl` and `/runs/log` routes"). That document owns it; this one does
not restate it, and **run comparison below depends on it** rather than duplicating it.

## What exists today

- Per-agent raw transcripts: one `out/<runId>/llm/<slug>.jsonl` per agent (`engine/agent.ts`
  `writeLlmRecord`, ~line 85). Each entry is `{ ts, role, agent, model, prompt, response }` — `ts` is
  captured before generation starts, and there is **no duration and no token-usage field at all**.
- `engine/llm-client.ts`'s `complete()`/`completeStream()` parse only the completion text out of LM
  Studio's response; an OpenAI-style `usage` field, if present, is never read.
- `writing-log.jsonl` (one line per `RunEvent`, `story-writer.ts` `runAndSave`) is retained for the
  last 3 runs (`MAX_RUNS = 3`, story-writer.ts:392) and served unmodified by `GET /runs/log?dir=&id=`
  (server.ts:134-144, `Content-Type: application/x-ndjson`).
- `server/gui/viewer/hud.js`'s `renderRail()` shows only story-level aggregates (word progress, step
  count, consult/retry/skill-flag counts) computed by filtering `store.events`. The one per-agent live
  element is a transient "composing…" line (`who` + elapsed seconds), not accumulated, no token data.

Both features below build on real data gaps, not missing plumbing: cost/latency needs new capture at
the source; comparison needs only a second load of what `/runs/log` already returns.

## A. Live per-agent cost/latency HUD

New instrumentation is required — nothing today captures duration or tokens per call.

**`engine/llm-client.ts`**
- In `complete()`, read `data.usage` (`prompt_tokens`/`completion_tokens`) if LM Studio's response
  includes it, and return it alongside the completion text rather than discarding it.
- In `completeStream()`, capture the same from the final SSE frame if present. **Open question to
  verify against the local LM Studio before implementing:** whether a streamed response includes
  `usage` at all — the OpenAI streaming convention gates this behind `stream_options.include_usage`,
  which may not be sent today. If usage is unavailable while streaming, duration is still capturable;
  token counts may need to come from a follow-up non-streaming call or be shown as unavailable for
  streamed calls specifically.

**`engine/agent.ts`**
- Record `Date.now()` at completion (today only the start `ts` is kept) and compute `durationMs`.
- Extend `llmLogEntry`'s shape with `durationMs` and `usage: { promptTokens, completionTokens } |
  null`, threaded into `writeLlmRecord`.
- After each `generate()` call, emit a new SSE event — `{ t: "agent_stats", who, model, durationMs,
  promptTokens, completionTokens }` — via the same `sseWrite` path the existing `composing` event
  uses (`agent.ts` ~line 51), so the live screen gets per-call stats without polling logs.

**`server/gui/viewer/hud.js`**
- Add a small per-agent stat table (writer + each active character) accumulating `agent_stats` events
  across the run, following the same `store.events`-filtering pattern the existing rail counts use —
  this is additive to `renderRail()`, not a replacement.

**`GUI-SPEC.md`** — document the new `agent_stats` event in the `/events` SSE contract.

**Blocks**
1. Capture + log: `llm-client.ts` usage parsing, `agent.ts` duration + extended `llmLogEntry`. Verify:
   `npx tsc`, `npm test` (agent.ts has coverage today; extend it to assert the new fields are present
   and non-negative).
2. Live surfacing: the `agent_stats` SSE event, `GUI-SPEC.md` update, the `hud.js` panel. Verify:
   `npx tsc`, then a browser check against a live run (owner-run, needs LM Studio) confirming the panel
   accumulates per-agent stats and the streaming-usage open question above is resolved one way or the
   other.

## B. Run comparison view

**Depended on the Run inspector** (next-steps1.md item 1), which is now built, so this is unblocked.
That work is what turns a retained `writing-log.jsonl` into the same grouped, rendered blocks the live
screen already shows (`events.js`/`blocks.js`), just fed from `/runs/log` instead of `/events`.
Comparison reuses that rendering path twice rather than building its own.

Note the inspector also added a per-agent panel (`server/gui/viewer/agents.js`) reading
`/runs/llm`. A comparison view gets that for free per pane, which is worth more than the prose diff
below for the "what did changing the model actually do" question — the panel already carries each
run's call counts and volumes side by side.

Once the inspector exists:

**GUI changes only — no new route.** `/runs/log?dir=&id=` already returns everything needed for two
runs of the same chapter.

- A run picker (two retained runs for one chapter, from the story's `runs[]` list) using existing
  shelf/story-page conventions.
- Two inspector panes side by side, each independently fed by its own `/runs/log` fetch through the
  inspector's rendering path — reusing that component twice, not writing a second renderer.
- A simple word-level diff between the two runs' assembled final prose (concatenated `draft`/`accept`
  event text, in order) shown above the two panes. Small, client-side, no dependency — chapter-length
  text does not need a real diff library.

**Block**
1. Run picker + dual inspector panes + text diff, entirely in the viewer. Verify: `npx tsc`, then a
   browser check with two retained runs of the same chapter (e.g. before/after a `story.json` edit) —
   confirm both panes render correctly and the diff highlights the actual divergence point.

## Out of scope

- Offline chapter replay as a distinct feature — see the note at the top; it is the Run inspector.
- A cost/latency rollup across multiple runs or the whole story — this HUD is scoped to one live run.
- Diffing anything other than final prose (e.g. a structural diff of the consult sequence itself)
  between two runs — the dual inspector panes already let a reader compare that manually.
