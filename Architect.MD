# Architect

**Status: built — both modes and both screens.** What is left is listed under
[Remaining work](#remaining-work).

This document owns the architect: its role, the between-chapters handoff behaviour, and the two
screens that drive it (the scaffold interview and the handoff panel). The route contract stays in
[`GUI-SPEC.md`](GUI-SPEC.md), which is the single source of truth for request bodies, replies and SSE
state. The proposed `story.json` form editor ([`GUI-SPEC.md`](GUI-SPEC.md) §Story editor) is a different
screen — its architect panel edits an in-memory draft and is not the handoff.

## Role

The architect is a planning and continuity agent. It does not write chapter prose and it does not
make character decisions inside a scene.

It has two modes:

- **Scaffold**: turn a rough idea into a new `story.json` through questions, a proposal, refinements,
  and an explicit accept action. The scaffold itself has two walks: **staged** — the default — runs
  the idea through a gated checklist (story → cast → settings → technical → scene) where each stage is proposed
  only after the author approved the last; **oneshot** proposes the whole story in one round.
- **Handoff**: run between chapters, read the accepted chapter prose, and re-author the story
  definition for the next chapter.

The architect is a normal `Agent` with its own prompt, history, model, thinking level, and temperature
(`0.9`). The surrounding engine extracts JSON, normalizes it into a `StorySpec`, applies only supported
edits, and reports non-fatal problems separately from model errors.

For diagnostics, `--architect-debug` writes every architect prompt, raw reply, extracted JSON object,
and stage decision to stderr. `--architect-debug-log=<path>` enables the same diagnostics and also
appends them to the named file; it does not need `--architect-debug` alongside it. These logs contain
the author's complete scaffold or handoff conversation and should be treated as story content.

## Skills, restrictions, and reach

The architect's system prompt carries two in-code catalogs from `engine/skills.ts`:

- **`SKILL_CATALOG`** — the eight general skills every character has unless a restriction removes them.
- **`SPECIAL_SKILL_CATALOG`** — the skill bible: special skills with canonical spellings and meanings
  (`lockpicking`, `climbing`, `sleight-of-hand`). A resolved skill is tagged `bible` when its name
  matches; an entry not in the bible stays **custom** and keeps its authored `name :: meaning`.
  Bespoke per-story skills are first-class — but one that is neither a bible skill nor carries a
  `:: meaning` is reported back to the author as a non-fatal problem rather than silently kept.

Restrictions are a plain list of names — a general skill, a bible skill, or one of that character's
own skills. A restriction is a **source-independent prohibition**: it names a capability unavailable
to this character whatever its origin would have been (the general catalog, their own `skills`, or
the scene's `reach`), matched by canonical name. It never removes by resemblance. Precedence in
`resolveSkills`: a skill named directly in both `skills` and `restrictions` is handed back (the
character HAS it). Normalization accepts restriction names from those sources plus what the scene's
reach grants — anything else is dropped with a problem line.

### The invariants

These are settled semantics; `engine/skills.ts`'s module docstring carries them too.

**I1 — A skill is intrinsic; reach is granted.** A skill travels with the character between scenes.
A **reach** entry exists only while the scene that granted it is being written; the default is no
reach. Reach exists for character-in-place abilities — "check the camera feed" is a property of what
the world offers AURA in the lobby, not of AURA — which is why it lives on the scene, not on the
character: put it on the character and every later scene has to explicitly negate it.

```json
"reach": { "AURA": ["cameras :: perceiving through the building's active security cameras",
                    "doors :: locking and unlocking the automatic doors"] }
```

**I2 — A restriction negates over the whole capability set**, including reach, by canon name — but
never by resemblance. Corollary, the blind-AI case: `restrictions: ["sight"]` does not remove
`reach: ["cameras :: …"]`; they are different capabilities. The authoring rule that makes this hold:
**name the interface, never the sense it substitutes for.**

**I3 — Intrinsic beats granted on collision.** A reach entry may not reuse a canon name the general
catalog or that character's own skills already use; on collision the character's meaning stands and
the reach entry is dropped with a warning.

**I4 — Reach never leaks into a character-level representation.** Every surface showing a character
outside a scene — `/cast`, preflight cards, the story editor, the handoff — shows `skills` and
restrictions only. Only per-scene resolution (`sceneReach` in `engine/scene-loop.ts`) ever sees it.

**I5 — Reach grants access, not existence.** Its meaning describes what the character can do *through*
the thing; that the thing is there comes from the scene's `place` or story-level `facts`. Enforced
softly on purpose: I5 has no loader or schema check and lives only in the verify pass, where a model
can weigh it, warning rather than blocking. Whether "a modern office building" establishes security
cameras is not a validator's call.

Resolution order: general catalog → the character's own `skills` → the scene's `reach`, with
restrictions applied across all three.

Authoring rules the engine enforces mechanically (normalizeSpec): every reach entry must carry its
own `:: meaning` — reach is never in the bible — and a grant keyed to a non-character is dropped with
a problem. The loader additionally warns when a scene grants reach to someone not in its roster,
since the grant would never reach a run.

Promotion of bespoke skills into a shared, approvable bible is planned work ([`PLANS.md`](PLANS.md)).

## Operating principle

Agent history does not carry between chapters. Agents are rebuilt for every chapter and no character
remembers the last one. **The story definition is the only continuity mechanism**, which is what makes
the handoff a real step rather than bookkeeping.

The handoff turns consequences in accepted prose into durable story state:

- New knowledge becomes `characters[].knows`.
- Changed motivations become `characters[].goal`.
- Lasting personality changes become `characters[].persona`.
- Lost capabilities become `characters[].restrictions`.
- Characters who are absent from the next chapter are removed from that scene's `roster`. A character
  who died can leave the roster while remaining in `characters[]` for historical context or later use.
- New dramatic pressure becomes a new or revised scene definition.
- World truths nobody in particular owns become story-level `facts`.
- **Reach is re-authored per chapter.** Whatever an earlier scene granted is gone — reach never
  travels with a person (I1). If where a character stands in the next chapter still offers an
  interface, it is re-granted on the new scene with `scene_<n>.reach`; if not, nothing is granted.

The architect must not invent an unsupported consequence. If the chapters do not establish whether a
character changed, it should ask rather than put an unverified fact into the story.

## Handoff behaviour

The handoff prepares the next chapter between runs. It is a user-invoked action, not another step
inside a scene run.

- One run writes one chapter, selected by `--chapter=<n>` or `POST /select { dir, chapter }`.
- A successful run writes prose to `chapters/<n>.md`, and the `story.json` it was written from to
  `chapters/<n>.json`. The snapshot lives beside the prose because `out/` is rotated at `MAX_RUNS`,
  and it is a verbatim copy so it records the authored story rather than a normalized one. Failing to
  write it costs the snapshot, never the chapter. Chapter discovery still keys on `<n>.md` alone.
- A stopped or incomplete run does not replace an existing accepted chapter file.
- The handoff reads the highest numbered accepted chapter and prepares the next number.
- The architect proposes edits; it never writes directly during a conversation.
- Accept writes `story.json`, validates it with preflight, and restores the previous file if
  validation fails.
- The handoff does not start a run. The user starts the prepared chapter separately.

### Edit surface

The architect can edit the fields supported by `engine/story-spec.ts`:

- story metadata: `title`, `premise`, and `writerStyle`
- scenes: `scene_<n>.place`, `question`, `pov`, `length`, `roster`, and `reach`
  (an object: `{"NAME": ["thing :: what they can do through it"]}`)
- scene structure: `add_scene` and `remove_scene`
- characters: `persona`, `knows`, `goal`, `belief`, `impulse`, `voice` (a list), `skills`, and `restrictions`
- cast membership: `add_character` and `remove_character`
- story facts: `add_fact`, `remove_fact`, and an indexed update of `facts[n]`

Every character carries the three psychology fields — a possibly-false `belief`, one conditional
`impulse` ("when X → Y"), and up to three quoted `voice` samples — alongside `persona`, `knows`,
and `goal`. They are required: `normalizeSpec` reports their absence as problems, so a handoff that
adds a character without them is flagged back. The engine renders them into the character's system
prompt (`WHAT YOU BELIEVE` / `WHEN PRESSURED, YOU` / past-words voice lines); it never resolves them
through the skill system, which stays purely about capabilities. The handoff also treats a disproved
belief as carry-forward state: when the chapters break what someone believed, the architect is asked
to re-author the belief, not leave the slot empty.

The field docs steer the architect toward friction rather than harmony: `goal` carries the zero-sum
test (at least one pair of goals must pass — each being the obstacle of the other), `belief` is
authored to make surrendering the goal unthinkable to that character specifically, `impulse` is
keyed to the pressure this scene will actually apply, and at least one `voice` sample should show
the character refusing. These exist because agreeable small-model characters otherwise price
capitulation at zero; the character-side counterpart is `CHARACTER_FORMAT`'s "WHAT YOU WANT IS THE
POINT" clause.

Removing the last scene is refused. Two things are refused because they would rewrite history:
removing a scene that already has accepted prose, since renumbering would make existing
`chapters/<n>.md` files refer to different scenes; and editing any field of such a scene, since the
prose on disk answers the older question. An unnumbered `scene.<field>` means scene 1 and is refused
on the same terms once chapter 1 exists.

A refusal is reported as an ignored edit, not an error — the round still applies everything else.
The next `[CHANGE]` round also carries the refusals back to the architect in a
`[REFUSED LAST TIME]` block, so a field the engine will not take is corrected or dropped instead of
being re-proposed verbatim every round; any round that refuses nothing clears it. The automatic
fill-gaps/verify passes do not carry refusals — each is a one-shot instruction with no refusal
history to correct.

### Drift warning

Opening a handoff also compares each written chapter against its `chapters/<n>.json` snapshot and
reports a **warning** when the scene has since changed. That path exists for edits made by hand,
which the refusals above cannot reach; revising your own story is legitimate, so it is said rather
than undone. Chapters written before snapshots existed have nothing to compare and pass quietly.

### Continuity flags are advisory

A handoff round can return `flags` — plain observations that the accumulated prose contradicts itself,
or contradicts `facts`/`knows`. The architect already reads every accepted chapter in one call, so a
continuity check needs no new agent and no new information-boundary decision.

**Flags must never be resolved through `edits`.** A contradiction is exactly the kind of thing the
architect must not silently fix by rewriting character state; it surfaces the problem and the author
resolves it. Flags block nothing, and they are not `problems` — `problems` are validation warnings
about the story that resulted, flags are observations about the prose that already exists.

## Conversation rules

### Scaffold

The session runs one of two walks, chosen when it opens.

**Staged (the default) — a gated checklist.** The five gates:

- **story** — title, premise, the load-bearing *tension*, story-level facts.
- **cast** — full character objects, authored against that tension, as they walk into scene 1.
  Character development is never authored forward; the handoff owns it once real prose exists.
- **settings** — `writer_style`.
- **technical** — run configuration, per-character retry limits, and scene writer thinking levels;
  model ids continue to come from `defaults.json` or the author.
- **scene** — scene 1 fully (place, question sharpened against the finished cast, pov, length,
  roster); later scenes may be sketched as question-only provisional entries.

`propose()` opens the first gate; `approve()` passes the open gate and proposes the next stage's
content in one call; refinement (`say`) applies edits within the open gate — back-edits to earlier
stages included — and never moves the pointer. **The engine holds the gate**: approve refuses while
a question stands (`pendingAsk`), when the open gate's content never landed ("has not landed"), and
past the last gate ("checklist is complete"). A question pins its gate; answering it feeds
`[THE AUTHOR ANSWERS]` into history and re-runs that stage's prompt. Three asks within one gate get
an OVERRIDE line; passing a gate resets the ask budget.

**The cast gate judges what landed.** Every other gate only asks whether its stage produced anything;
the cast gate additionally asks whether the cast is worth building a story on. Passing it consults a
**stateless judge** — 0.3, no history, built fresh per verdict, and deliberately *not* the architect,
which wrote the cast and audits its own work badly. It is given the tension and the cast sheet (names,
goals, skills, restrictions — no reach, since no scene exists this early) and answers one question:
does this cast's asymmetry bite on the thing the tension turns on? A `false` verdict comes back as a
round of its own kind, `blocked`, distinct from `nothing` — the stage *did* land, and the author may
overrule it with `approve(onStage, true)`, which the viewer sends as a confirming second click. The
judge **fails open**: an outage or a reply carrying no verdict passes the gate, because every other
model-in-the-loop check in this engine accepts on failure and an outage must not strand an author
mid-checklist. `normalizeSpec`'s "nobody has any restrictions" problem is unchanged and still
advisory — it is the only asymmetry signal on the surfaces that have no gate at all (the story
editor, one-shot mode, the handoff). The judge agent itself — its contract, its verdict shapes, and
the family it belongs to — is specified in [`Judge.MD`](Judge.MD).

The idea's FIRST DECIDE gate lives at the story stage: if it does not explain who is in the scene
and what is at stake between them, the architect asks instead of proposing.

Each stage's reply merges into the draft so far — fields it names win, everything landed earlier
survives. The scene stage owns every scene at once: scene 1 in full, later ones as sketches, because
whatever the chapters actually do re-authors them. After the scene lands, the **verify** pass runs
once — pov among the roster, a restriction that bites: checks that only mean anything once every
side of the story exists. The fill-gaps pass has no job here; its roster and facts are asked by their
own stages. Problems a half-built draft always has ("no characters at all", "scene 1 has no
question") are suppressed until their owning stage has run.

The load-bearing **tension** sentence coined at the story stage is session state, not a story.json
field: it steers the cast stage's prompt, sharpens the scene stage's, and change rounds may edit it
by field name without it ever reaching the file.

**Oneshot** keeps the original single-round behaviour: one whole-story proposal followed immediately
by the two automatic passes below, then conversational refinement. Chosen with `mode: "oneshot"`
on `/scaffold/start` (the viewer's interview offers the choice).

A proposal that lands (either walk) is not the end of the round. Two automatic passes run before the
author sees it, as far as each walk needs them: **fill the gaps** (the scene's `roster` and the
story's `facts` are never part of the whole-story proposal's own format, so a dedicated pass asks for
them) and **verify** (the architect re-reads its own draft for a fact that just restates one
character's private `knows`, a restriction that never bites, a cast with no restrictions at all, and
— for reach — entries named after a sense instead of an interface (I2's corollary), and interfaces
nothing in `place` or `facts` establishes; that last one is a judgement only the verify pass makes,
never a loader check). The checks that are pure string work are not in that prompt at all: a roster
name that doesn't match the cast, a POV outside the roster, a reach grant to someone off the roster,
and a reach entry colliding with a general, bible or own-skill name are `normalizeSpec` checks, and
arrive already decided under `[ALREADY FLAGGED]` rather than as something for the model to re-derive.
Either pass may ask instead of editing — that aborts the sequence and surfaces as this round's
question exactly like any other ask, with whatever the earlier passes already applied kept on the
spec.

### Handoff

The architect receives the premise, all accepted `chapters/<n>.md` files, and the current normalized
story definition. It prepares the chapter after the highest written chapter. It may update the cast,
scene roster, scene definition, and story structure, but it must not write the next chapter's prose.

The same fill-the-gaps and verify passes run automatically here too, immediately after the handoff's
own proposal, targeting the scene being prepared (`scene_<n>`, never an earlier written one).

The author can refine the proposal conversationally. Accepting writes `story.json`; it does not start
the next run. The GUI must offer the prepared chapter as a separate action.

## Round shapes

Which rounds each mode can produce — the bodies and the state each route publishes are
[`GUI-SPEC.md`](GUI-SPEC.md)'s *Scaffold* and *The handoff* sections:

| mode | `last.kind` |
| --- | --- |
| scaffold | `proposal` \| `edits` \| `question` \| `nothing` \| `failed` |
| handoff | `edits` \| `question` \| `nothing` \| `failed` |

A staged scaffold round also carries `stage` — the checklist gate the round belongs to
(`"story"` | `"cast"` | `"settings"` | `"technical"` | `"scene"`), so callers can label it without
tracking state.

The handoff never returns `proposal`. Its first round is already an edit list against the story on
disk, so the proposed-next-chapter panel renders from `spec` and `last.applied`, never from a
proposal round.

A round reaching either mode's caller may also carry an optional `auto` array — one entry per
automatic fill-gaps/verify pass that ran, each with the same `applied`/`ignored`/`note` shape as an
edits round plus `stage` (`"fillGaps"` | `"verify"`) and `outcome` (`"edits"` | `"nothing"` |
`"failed"`). It is additive: a round with no `auto` field behaved exactly as before. A staged
session's rounds only ever carry the verify entry, once, after the scene stage.

```text
staged:   start → story → approve → cast → approve → settings → approve → scene (+verify)
          any gate: say/refine ↺ · a question pins its gate until answered · accept (folder) → run
oneshot:  start → proposal → say/refine → accept (folder) → run
handoff:  start → edits    → say/refine → accept → select prepared chapter → run
                                       ↘ abandon
```

## The screens

The visual prototype is the [`mockups/architect`](mockups/architect) set — interactive static pages
covering both modes, question and edit rounds, the accept flow, the theme toggle and the responsive
layout, without calling the API. **It is the picture; this section is the rules.**

Use the existing viewer language: shelf cards for story selection, `.picker.story` for story-level
actions, `.iv` panels for interview content, `.thinking` for an in-flight model call, `.said.bad` for
errors, `.prob` for warnings, and the existing `btn`, `primary`, `tab` and `divider` styles.

Do not make the architect a full-screen chat application. The conversation is a tool for changing a
visible story proposal, not the primary artifact. The layout keeps three things visible at all times:

1. What story or chapter is being prepared.
2. What the current proposed definition looks like.
3. What the architect most recently asked, changed, or failed to do.

On mobile the proposal comes *before* the conversation, because the proposal is the artifact being
reviewed; the architect input stays sticky at the bottom while the proposal scrolls.

### Scaffold interview

Built as its own `#/scaffold` route in [`interview.js`](server/gui/viewer/interview.js), reached from
the shelf's "start a new story" card — which relabels itself "continue new story…" while a session is
open on the server. The idea step is a modal over an empty scaffold shell; once the first proposal
lands the page keeps three things visible at all times: the proposed story (a card), the current round
(a card), and a **scaffold-state sidebar** — walk, open gate, tension, "on disk: nothing yet" — that
owns **accept** and **abandon**. The view drops the run-controls rail and breaks out of the page column
the other screens sit in, so the wide proposal-and-sidebar layout has room.

The full schema-aware editor in [`story-edit.js`](server/gui/viewer/story-edit.js) is no longer the
review surface — it is an optional **edit in full** action from the sidebar, backed by the same
in-memory session (it syncs field changes back through `/scaffold/set`, and its confirm still calls
scaffold accept). Neither walk routes there on its own any more; both stay on the scaffold page.

Behaviour:

- The idea field is shown only before the first proposal. Beside the model choice, the idea step offers
  **how it proposes** as two radio cards: "stage by stage" (the staged checklist) or "the whole story
  at once" (oneshot).
- A staged session renders the checklist — story / cast / settings / technical / scene chips with the open gate
  highlighted and passed gates ticked. A one-shot session has no checklist; the status bar and round
  narration carry its state.
- While `/scaffold/start`, `/scaffold/say` or `/scaffold/approve` is running, the composer is replaced
  by `.thinking` and the status dot pulses.
- A `question` round shows the architect's question distinctly, focuses and relabels the answer field
  ("your answer" / "send answer →"), and hides the approve button while it stands.
- The **approve & continue** button, in the composer, passes the open gate and proposes the next
  stage's content. It is hidden at the last gate and while a question stands. Refinement never advances
  a gate: only this button does. When the cast gate comes back `blocked`, the verdict renders as a
  judgement (not a failure) and the same button becomes **approve anyway** for 8 seconds — the first
  click is what discovered the block, so unlike accept the confirmation is armed by the reply rather
  than checked before sending. Any later scaffold frame that is not `blocked` disarms it, so an armed
  override cannot survive to overrule a different gate.
- A `proposal` or `edits` round updates the proposal card in place; the conversation context is never
  cleared. The first story-stage proposal is visible immediately, before the cast makes the draft
  acceptable. The open gate is the first, highlighted section of the card, with earlier stages kept
  below it; settings and technical therefore show the house style and run settings beside the controls
  used to refine or approve them rather than burying those values below the cast.
  Provisional later scenes from the scene stage render as questions under "later scenes · provisional".
- Round labels carry their gate (`[cast] changed: …`) so refinement reads apart from stage proposals.
- `problems` are shown inside the proposal card; warnings do not prevent further refinement.
- Accept lives in the sidebar. It opens a folder-name step in the main column when the server returns
  `needs_folder`, and does not disappear until the server returns `kind: "written"` — at which point
  the resolved pick starts the run and the page follows it to the live screen. Accepting over unsent
  text or a `problems` flag takes a confirming second click.

### Handoff panel

Built as [`handoff.js`](server/gui/viewer/handoff.js) and
[`handoff-view.js`](server/gui/viewer/handoff-view.js) on its own `#/handoff?dir=` route, reached from
the story page's "prepare chapter N" button. Four states:

- **Preparing** — `busy` renders as `.thinking`; Accept and Send are disabled, Abandon stays available.
- **Question** — `pendingAsk` is visually distinct from an ordinary suggestion. It blocks a meaningful
  proposal until answered, but writes nothing.
- **Edits available** — `last.applied`, `last.ignored`, `flags` and `problems` are **four different
  lists and belong in four separate blocks**. An edit the architect asked for and the engine refused
  is not a validation warning about the resulting story, and neither is a continuity flag. Applied
  entries carry `field`, `before` and `after`, so each one renders as a labelled before → after line;
  `add_scene`/`remove_scene`/`add_character`/`remove_character` are structural and show the added or
  removed object rather than a value diff.
- **Accepted** — offers to write the prepared chapter. That button calls `POST /select { dir, chapter }`
  and is disabled unless the session is parked at the picker; the handoff itself never starts a run.

The proposed chapter renders from `spec.scenes[chapter - 1]`, and the story page names the chapter a
handoff would prepare from `/stories`'s `scenes[]` and `chapters: number[]` — which is also what hides
the action for a story with nothing written.

Beside it, a **chapters-written list** shows each accepted chapter as `✓ ch N · place · NNN words`,
closed by a `· ch N — being prepared` row for the chapter in flight. The word counts mean one
`GET /chapter?dir=&n=` fetch each, so the list loads lazily once a round carries a spec and arrives
shortly after the round itself; it is cached per story and prepared-chapter, since accepting rewrites
`story.json` rather than any prose already on disk. Chapter numbers come from the story card filtered
below the prepared chapter, so a gap in the written chapters never becomes a 404.

### Viewer modules

Split the way the scaffold's are:

- `handoff.js`: posting, action wiring, and the arm-to-confirm timers.
- `handoff-view.js`: the four states' markup.
- `state.js`: `APP.handoff`, `handoffDir`, `handoffError`, `handoffDone`, the two armed timers, and
  `hdraft` — a separate draft from the scaffold's, so text typed in one screen cannot surface in the
  other.
- `sse.js`: consumes `{ t: "handoff" }` frames, and re-fetches `/next-chapter` on load so a reload
  mid-round lands back in it.
- `pages.js` / `nav.js` / `viewer.js`: the `#/handoff?dir=` route, which reads as the shelf in the tab
  bar exactly as the story page does.

The posting and error behaviour follows `interview.js` deliberately, but none of its state is shared:
the two have similar round shapes and different lifecycle rules.

## HTTP surface

```bash
npx tsx story-writer.ts stories/example --chapter=2
```

Both conversations are viewer-only: the new-story interview is driven from the shelf through
`GET /scaffold`, `POST /scaffold/{start,say,approve,set,accept,abandon}`, and the handoff from
`#/handoff?dir=` through `GET /next-chapter` and `POST /next-chapter/{start,say,accept,abandon}`,
specified in [`GUI-SPEC.md`](GUI-SPEC.md). The server reaches the engine through `ServerHost` and
never imports engine modules directly. The old console walkthrough (`--new`, `--oneshot`,
`--next-chapter`) was removed; those flags are rejected with a pointer at `--serve`.

## Remaining work

- `specView` omits `config`, `models` and per-character `model` — needed only if a panel shows them.
- A **scaffold** architect receives a hard-coded worked example from `tests/fixtures/doorway`
  (~1,870 estimated tokens) — the one story committed with the engine, since everything under
  `stories/` is the user's own content and gitignored. A **handoff** architect no longer gets it —
  the handoff prompt names every edit field inline and resends the real story each round, so the
  example was the format said twice.

## Safety and product constraints

- At most one scaffold session and one handoff session exist per process, each behind its own lock.
  Nothing forbids both being open at once, so neither screen may assume the other is closed.
- Only one architect round may be in flight per session; a second round gets `409`.
- A handoff cannot run while a chapter run is active — the run is reading the file the handoff rewrites.
- Accepting a handoff rewrites `story.json`, so the GUI shows the target story and chapter clearly.
- A failed preflight at accept time puts things back: the handoff restores the previous `story.json`,
  and the scaffold removes the folder it had just created, so nothing unloadable is left on disk.
- The GUI does not expose raw filesystem paths; it uses the story directories the API discovered.

## Out of scope

- Carrying agent histories across chapters.
- Starting a chapter automatically after accepting a handoff.
- Deciding what to do with later chapters when an earlier chapter is rewritten.
- Auto-resolving a continuity flag into an edit — flags are advisory by design.
