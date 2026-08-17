# SPEC-GUI — multi-scene viewer changes

Read this before touching the GUI viewer for multi-scene support. Engine side is done (Block 1-4):
`RunEvent` now carries `chapter: number` on every event, `story_end` fires after the final scene,
and `StoryConfig.scenes[]` is the source of truth.

## What changes, file by file

### `server/gui/viewer/events.js` (2 changes)

1. **`scene_start` handler (line 8)** — store `e.chapter` in the meta:
   ```js
   if (!store.meta) store.meta = { story: e.story, target: e.target, characters: ... };
   store.meta.chapter = e.chapter;
   store.meta.totalScenes = ...;  // not yet known; can be set from story_end or left null
   ```
   Single-scene stories get `chapter: 1`, so this is always set.

2. **`story_end` handler (new)** — add a case after `scene_end`:
   ```js
   case "story_end": blocks.push({ kind: "story_end", seq: e.seq, scenes: e.scenes, steps: e.steps, words: e.words }); break;
   ```
   Rendered as a summary block showing total scenes, steps, words.

### `server/gui/viewer/sse.js` (1 change)

- **`run_state` ended detection (lines 82-83)** — currently finds the last `scene_end` to
  extract `{ done, stopped, words, steps }`. With multi-scene, the last `scene_end` is still
  the right per-scene value, but when `story_end` exists prefer it for total-story stats:
  ```js
  const storyEnd = LIVEV.events.findLast(e => e.t === "story_end");
  const end = storyEnd || LIVEV.events.findLast(e => e.t === "scene_end");
  if (end) APP.runEnded = { done: end.done, stopped: end.stopped, words: end.words, steps: end.steps };
  ```

### `server/gui/viewer/pages.js` (1 change)

- **`renderHeader()` (lines 49-52)** — show chapter indicator when multi-scene:
  ```js
  const ch = m.chapter ? ` (Chapter ${m.chapter} of ${m.totalScenes || "?"})` : "";
  $("question").textContent = (m.question || "") + ch;
  ```

### `server/gui/viewer/blocks.js` (1 addition)

- **`renderBlock()`** — add a branch for `"story_end"` kind:
  ```js
  if (b.kind === "story_end") return `<div class="note end">Story finished · ${b.scenes} scene(s) · ${b.words} words · ${b.steps} steps</div>`;
  ```
  Already has `"end"` for per-scene `scene_end`; this is the total-story counterpart.

### `server/gui/viewer/util.js` (optional, 1 line)

- `verdictText(e)` — currently says `"scene finished"`. For multi-scene stories the last
  scene's `scene_end` verdict is still correct per-scene; `story_end` block handles the
  total-story message. No change strictly needed.

## Files with no change needed

| file | reason |
|------|--------|
| `shelf.js` | reads `APP.stories` (shelf cards), not RunEvent data |
| `nav.js` | URL routing only |
| `session.js` | reads `APP.session.*` (from `run_state` SSE), no RunEvent fields |
| `character-card.js` | reads character data from chip data attributes |
| `interview.js` | works with `APP.scaffold` only |
| `chrome.js` | theme toggle, file picker, drag-drop |
| `boot.js` | startup orchestration |
| `viewer.css` | no new layout needed |
| `hud.js` | rail counts drafts and events globally — correct for total-story stats |
| `state.js` | `APP.runEnded` shape (`{ done, stopped, words, steps }`) unchanged |
| `run-ended.js` | reads `APP.runEnded` — works same for multi-scene |

## Summary of required changes

| File | Change | Lines |
|------|--------|-------|
| `events.js` | Store `chapter` on `scene_start` meta; add `story_end` case | 4 |
| `sse.js` | Prefer `story_end` over `scene_end` for total stats | 3 |
| `pages.js` | Show chapter indicator in header | 4 |
| `blocks.js` | Render `story_end` summary block | 3 |

**4 files, ~14 lines.** No CSS, no new modules.
