Chapter-summary review step in the handoff
Context
Today, NextChapterSession.propose() (engine/architect.ts:656-672) sends the architect the full markdown text of every accepted chapter on the handoff's one opening round, via P.architectNextChapter(premise, specJson, this.chapters) (prompts.ts:544-631). The user wants a step inserted before that round: the architect reads the most recently accepted chapter, produces a structured summary (story progression / scene changes / characters), and the summary is shown to the user to review and confirm — only then does the existing re-authoring round run, using the summary in place of that chapter's full prose so the architect (and the round's prompt) doesn't have to carry the raw chapter text again.

Confirmed design decisions (from the user):

Scope: only the single most recently accepted chapter is summarized. Earlier chapters (if any) keep going into the prompt as full text, unchanged.
Refinement: plain confirm-or-abandon. No "say"-style follow-up loop on the summary itself.
Shape: three fixed structured fields — progression, scene changes, characters — not free prose.
This is a genuinely new phase in a flow that today has none (NextChapterSession has no round/stage enum at all, unlike ScaffoldSession.stage). The closest existing precedent for "session-only, prompt-steering state that never reaches story.json" is ScaffoldSession.tension. The closest precedent for "a fresh, stateless, purpose-built agent" is newCastAsymmetryJudge (engine/architect.ts:52-56).

Per CLAUDE.md's working process, this ships as four independently-pausable blocks — engine, server routes, GUI, docs — each tested/reviewed before the next starts.

Block 1 — Engine: the summarizer call and the substitution
Files: prompts.ts, engine/architect.ts, tests/architect.test.ts

prompts.ts — new section before // -- THE HANDOFF -- (line 541):

CHAPTER_SUMMARY_SYSTEM: a lightweight system prompt (reads for comprehension, not authorship) instructing: compress faithfully, don't invent, leave a field "" rather than pad it, reply JSON only with {"progression": "...", "sceneChanges": "...", "characters": "..."}.
chapterSummaryRequest(premise, specJson, n, chapterText): builds the one-shot summarization prompt from the premise, current story state, and the chapter's full text.
renderChapterSummary(summary): renders a confirmed summary into the same textual shape a chapter's own prose occupies inside architectNextChapter's [WHAT HAPPENED] block — the substitution is purely "which text this one chapter entry carries," not a second prompt shape the handoff request has to know about.
architectNextChapter gains an optional summarized?: boolean on each chaptersSoFar entry; the per-chapter header switches between "as written" and "summarized (compressed by an earlier pass, not the full prose)"; when any entry is summarized, one additional sentence is appended inside the existing CONTINUITY FLAGS paragraph noting that a flag depending on that chapter's exact wording is tentative. This is purely additive and defaults to today's behavior when summarized is never set — no existing call site or test needs to change.
engine/architect.ts:

New types near ScaffoldRound: ChapterSummary = { progression: string; sceneChanges: string; characters: string } and SummaryRound = { kind: "summary"; summary: ChapterSummary } | { kind: "failed"; error: string } — kept separate from ScaffoldRound, not shoehorned in.
newChapterSummarizer(d: Defaults): Agent next to newCastAsymmetryJudge: same pattern — fresh Agent, CHAPTER_SUMMARY_SYSTEM, JUDGE_TEMPERATURE. Built fresh per call so the full chapter text never enters the architect's own conversation history that propose()/say() share for the rest of the handoff.
NextChapterSession constructor gains an optional 6th param newSummarizer?: () => Agent (mirrors ScaffoldSession's injectable judge, for the same testability reason).
New fields: summary: ChapterSummary | null = null, summaryConfirmed = false.
New method summarizeLastChapter(): Promise<SummaryRound> — finds the chapter at this.chapter - 1, runs the same contextShortfall preflight check propose() already does, calls architectRound with the new summarizer agent and prompt, validates the three fields aren't all empty, stores this.summary on success.
New method confirmSummary(): boolean — sets summaryConfirmed = true once, returns false if there's no summary yet or it's already confirmed.
propose()'s first line changes to build its chapter list from this.chapters, substituting only the entry where n === this.chapter - 1 with { n, text: renderChapterSummary(this.summary), summarized: true } only when summaryConfirmed && summary are both set — otherwise behavior is byte-for-byte identical to today. This keeps every existing caller of propose()/say()/accept() and every existing test green untouched.
Tests (tests/architect.test.ts): new describe block covering summarizeLastChapter() (success, all-empty-fields failure, erroring agent), confirmSummary()'s once-only semantics, and propose()'s prompt after confirmation — asserting the most recent chapter shows summarized/the three bracketed labels while an earlier chapter (2+ chapter session) still shows full prose unchanged. Plus a small check on chapterSummaryRequest/renderChapterSummary.

Verify: npx tsc, npx tsx --test tests/architect.test.ts.

Block 2 — Server routes
Files: server/next-chapter-routes.ts, tests/server-routes.test.ts

New module state handoffSummaryLast: SummaryRound | null = null, alongside handoffLast.
handoffState() (next-chapter-routes.ts:25-40) gains two published fields: summary: handoffSummaryLast, summaryConfirmed: HANDOFF.summaryConfirmed.
Allowed-action list gains "confirm-summary".
start (lines 93-126) is restructured to stop after summarization instead of running propose(): after building the session and setting the story lock (unchanged), it calls HANDOFF.summarizeLastChapter() instead of HANDOFF.propose(...), storing the result in handoffSummaryLast and publishing — the existing handoffGen stale-check pattern applies identically around this new await.
New branch confirm-summary: 400s if there's no pending summary or it's already confirmed; otherwise calls session.confirmSummary() then session.propose(...) exactly as start does today (same busy-lock, same onStage callback, same handoffGen guard, same result stored in handoffLast).
abandon and accept both additionally clear handoffSummaryLast = null, matching how they already clear handoffLast.
Tests (tests/server-routes.test.ts): the existing "opens, proposes, and publishes the chapter it is preparing" test splits into two assertions — start now returns a pending summary and no last; a subsequent POST /next-chapter/confirm-summary produces the last.kind === "edits" result the test used to check directly. New tests: confirm-summary with no/already-confirmed summary → 400; an all-empty-fields summarizer reply → summary.kind === "failed" published from start, and confirm-summary still 400s. Extend the existing abandon-mid-round race coverage to also land between summarizeLastChapter()/confirm-summary's propose() and their handoffGen rechecks.

Verify: npx tsc, npm test.

Block 3 — GUI
Files: server/gui/viewer/handoff-view.js, server/gui/viewer/handoff.js, server/gui/viewer/state.js (comment only)

handoffPageHtml()'s current "optimistic busy, no spec yet" screen (handoff-view.js:75-84) is replaced by three screens in the same slot, gated on the new published s.summary/s.summaryConfirmed fields — everything before (no-dir, done, accepting, nothing-open) and everything from the existing failed/main-body screens onward is untouched in position and content:
!s.summary — "the architect is reading the chapter it will summarize" thinking screen, #h-abandon only. Covers both the client-only optimistic gap and the real wait on summarizeLastChapter().
s.summary.kind === "failed" — same "retry = abandon + restart" idiom as today's failed-opening-round screen: #h-retry, #h-abandon, #h-back.
!s.summaryConfirmed — the review screen: three .divider-separated sections (progression / scene changes / characters, each showing "nothing noted" when empty), #h-confirm-summary (primary), #h-abandon, #h-back. No edit surface — matches decision #2.
handoff.js: new confirmSummary() action (postHandoff("confirm-summary", {}), no arm-twice — it commits nothing to disk), wired in wireHandoff() as on("h-confirm-summary", confirmSummary). Existing #h-retry/#h-abandon/#h-back handlers are reused as-is by the new screens.
state.js: comment-only update noting APP.handoff now also carries summary/summaryConfirmed — no new APP.* field needed, since both ride in through the existing APP.handoff = f.state/= j assignment paths exactly like edited/pendingAsk/problems already do. sse.js needs no change — its handoff frame handler already assigns the whole state object wholesale.
Verify: npm run lint, then the manual pass below.

Block 4 — Docs
Files: Architect.MD, GUI-SPEC.md, GUI-CHECKLIST.md

Architect.MD: new "### Chapter summary" subsection before "### Handoff" describing the scope/shape/refinement decisions above; update the flow diagram to start → summary → confirm → edits → say/refine → accept → ... with abandon reachable from the summary step; update the round-shapes section to document SummaryRound as its own field (summary, not folded into last); update "Handoff panel" from four states to five; update the HTTP surface line to include confirm-summary.
GUI-SPEC.md: add summary/summaryConfirmed to GET /next-chapter's documented response shape; add the POST /next-chapter/confirm-summary route block; update /next-chapter/start's description (it now opens the handoff and summarizes, it no longer runs the opening edits round itself); note SummaryRound's two kinds alongside the ScaffoldRound-minus-proposal note.
GUI-CHECKLIST.md: extend the handoff section with steps for the new summary-review screen, the two distinct "try again" failure points (summary call vs. edits round), and the summary screen's abandon path.
Verify: cross-reference proofread only — no automated check covers doc prose.

Full verification plan
Static (batched, after all four blocks land): npx tsc, npm test, npm run lint.

Manual, live-run (owner's to run, per CLAUDE.md):

npx tsx story-writer.ts --serve, LM Studio running, context length raised (a summary call plus the opening edits round both draw on the same budget check).
Open a story with ≥1 accepted chapter, click "prepare chapter N" — confirm the summary-review screen (three sections) appears before any proposed-chapter card.
Abandon from the summary screen — confirm the session fully closes and the story lock releases (try an editor save right after).
Reopen, click "use this summary" — confirm it transitions into the existing proposed-chapter/edits UI, unchanged in appearance.
With a 2+ chapter story, check the request log (or architect debug logging) to confirm the opening-round prompt shows only the most recently accepted chapter as summarized, with earlier chapters still as written in full.
Repeat the existing "Try again" panel check twice: unload the model before opening the handoff (exercises the summary-failure screen), and unload it after the summary lands but before confirming (exercises the existing edits-round failure screen) — both must offer a retry, never a dead screen.
Reload mid-flow at each new phase (summarizing, summary pending confirmation) and confirm it lands back on the right screen rather than the old busy/edits screen.