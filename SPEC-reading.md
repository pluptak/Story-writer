# SPEC-reading: Reader Mode, Story Search, Character Sheet

**Status: proposed, not built.** Three read-only consumption features for the viewer.

## What already exists (checked directly, not assumed)

[`SPEC-GUI-MULTISCENE.md`](SPEC-GUI-MULTISCENE.md) previously blocked on "no route returns chapter
prose yet" — that has since shipped: `GET /chapter?dir=&n=` (`server/server.ts` ~line 146) reads
`chapters/<n>.md` after checking `host.writtenChapters(storyDir)` includes `n`, and the story page
already opens a written chapter's prose inline. **Reader mode and story-wide search build on this
existing route — neither needs new server work for chapter access.**

The character sheet panel is different: `specView()` (`engine/story-spec.ts` ~line 261) has exactly the
per-character shape a sheet needs (`persona`, `knows`, `goal`, `skills`, `restrictions`), but it's only
ever called from the scaffold/handoff sessions' in-memory `StorySpec`, not from a story loaded for live
writing. The live story page's own data (`GET /stories` → `StoryCard.characters`, `engine/preflight.ts`
~line 105) is `{ name, skills, restrictions }[]` only — no `knows`/`goal`/`persona`. **This one needs a
new read path.**

## A. Reader mode

A dedicated, distraction-free view of a story's accepted prose — not the same as the story page's
existing per-chapter inline expansion, which is embedded in the run-control chrome. Reader mode is a
separate route that concatenates every entry in `chapters[]` (from `GET /stories`) into one continuous
read, fetching each via the existing `GET /chapter?dir=&n=`.

- New page/route, e.g. `#/read?dir=`, alongside the existing `#/handoff?dir=` pattern
  (`pages.js`/`nav.js`).
- Sequentially fetch each written chapter's prose and render them in order under their chapter
  headings; no run-control elements, no SSE subscription — this is a static read once loaded.
- No server changes.

**Files:** new `server/gui/viewer/reader.js` (or similarly named, following the `handoff.js`/
`handoff-view.js` split-by-concern convention), wiring into `pages.js`/`nav.js`.

## B. Story-wide search

Full-text search across a story's accepted chapters. Given chapters are already individually
fetchable and a story is at most a handful of chapters, this does not need a server-side search
route — fetching each chapter (same calls reader mode makes) and searching client-side is simpler and
consistent with [`SPEC-GUI-MULTISCENE.md`](SPEC-GUI-MULTISCENE.md)'s own out-of-scope note against
adding routes when the existing surface already suffices.

- A search box (on the story page or reader mode) that, on submit, fetches every `chapters[]` entry via
  `GET /chapter?dir=&n=`, does a plain substring/case-insensitive match per chapter, and lists matches
  with the surrounding line and a jump-to-chapter link.
- For a very long story this means N sequential fetches; acceptable given the retained-chapter counts
  in play here, and avoidable later with a dedicated route if that stops being true — not needed now.

**Files:** a small new module or an addition to `reader.js` from (A), since both consume the same
chapter-fetch primitive.

## C. Character sheet panel

Read-only panel on the live writer screen showing the active scene's roster with their authored
`knows`/`goal`/`skills`/`restrictions` — for the human author reviewing what a consult was working
from, not for any agent (doesn't touch the writer/character information boundary; it's a UI convenience
over already-authored, non-secret-to-the-author data).

- **New host method + route**, since nothing today exposes full character defs for a story loaded live
  (only the thin `StoryCard.characters` shape does). Add a `ServerHost` method that loads the story
  (reusing whatever `story-format.ts` load path `preflight.ts`/`specView`-adjacent code already uses)
  and returns the full cast — same shape as `specView()`'s character mapping
  (`{ name, persona, knows, goal, skills, restrictions }`) so the panel and the handoff panel can share
  one render component later if useful.
- New route, e.g. `GET /cast?dir=`, mirroring `GET /chapter?dir=&n=`'s per-request-scoped pattern rather
  than folding full cast data into `GET /stories` for every story on the shelf (which returns cards for
  *all* stories at once — full persona/knows/goal for every character in every story would bloat that
  response for no reason since only the open story's cast is ever shown).
- The GUI already knows the active chapter's roster from `scenes[chapter - 1].roster` (via `/stories`)
  or from the live `scene_start` event's `characters: string[]` — filter the full cast fetched from
  `/cast` down to that roster client-side; no server-side filtering needed.

**Files:** a new `ServerHost` method (`story-writer.ts`'s `HOST` object) and route
(`server/server.ts`), a new small `server/gui/viewer` panel module, wiring into `story-page.js`.

## Blocks

1. **Reader mode** (A) — GUI only, no server changes. Verify: `npx tsc`, browser check against a story
   with at least two written chapters.
2. **Story-wide search** (B) — GUI only, builds on (A)'s chapter-fetch code; do after (A) since it
   reuses that primitive rather than duplicating it. Verify: browser check, search for a term known to
   appear in one chapter and confirm the jump-to-chapter link lands correctly.
3. **Character sheet panel** (C) — the only block touching the server: new host method, new route, new
   panel. Independent of (A)/(B). Verify: `npx tsc`, `npm test` (a route test in
   `tests/server-routes.test.ts` for `GET /cast?dir=`, covering an unknown `dir` the same way existing
   route tests do), then a browser check confirming the panel shows the right roster per chapter.

## Out of scope

- Editing character fields from this panel — read-only; editing is
  [`SPEC-E-editor.md`](SPEC-E-editor.md)'s concern.
- A server-side search index/route — client-side fetch-and-match is enough at current story sizes;
  revisit only if that stops holding.
- Showing character `model` in the sheet — `specView()` already drops it for the same reason the
  handoff panel doesn't show it (`Architect.MD`'s "known gaps that block neither" list); no reason to
  diverge here.
