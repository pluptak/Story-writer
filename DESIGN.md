# DESIGN — principles and map

Why this engine is shaped the way it is. The mechanisms live in their own files, one concept each, so
that fixing a consult never means reading the story format — [CLAUDE.md](CLAUDE.md) maps which is
which. Cross-file links are by heading, not section number.

---

## The asymmetry

A **writer** agent drafts one scene from a premise. Whenever what happens next turns on a choice a
character makes, it stops and **consults** that character's agent. The character answers as itself
and may first **ask for a fact** it was not given. The writer either accepts the answer or rewrites
the question and asks again — and a retry goes to a **fresh instance** that never learns it was
rejected.

> **Governing rule**
> **The writer owns the page. The characters own themselves.**
> An answer is evidence about the scene, not a suggestion the writer may overrule for being
> inconvenient.

What makes this more than prompt-chaining is what each side is *denied*:

| party | is given | is NOT given |
|---|---|---|
| writer | premise, scene, house style, cast names + **capabilities** | any character's persona, memory or interiority |
| character | own persona, own skills, own `knows:`, own `goal:`, the situation the writer wrote, its own accepted answers | the premise, the draft, the scene's purpose, anyone else's replies |

A writer holding everyone's interiority writes them from the inside and stops asking; a character
holding the draft answers the story instead of the moment. Both directions are enforced by what
`wrapWriter()` and `wrapCharacter()` put in the prompt, and by `consult()` never seeing the draft.
**Every other rule in these files exists to protect one of those two columns.**

`goal` follows the same rule as persona: it shapes the character's own agent and nothing else. Only
the character can weigh whether they are closer to what they want, so `goal` reaches neither the
writer nor the architect, and no code scores progress toward it. It earns its keep at *design* time —
two characters whose goals genuinely collide (what one needs is what blocks the other) produce
friction a scene doesn't have to be told to have.

---

## Skills are checked, not gated

Every character starts from one engine-level catalog (`SKILL_CATALOG`): `movement, speech, hearing,
sight, touch, taste, smell, recall`, each with a one-line meaning. The **effective set** is
`catalog − lacks: + skills:`, resolved by `resolveSkills()`; it becomes the character's whole menu of
possible action, and the writer sees each character's `can:` / `CANNOT:` list so it never writes a
blind man watching someone. Syntax and warnings: [STORY-FORMAT.md](STORY-FORMAT.md).

A reply names `skills_used`. Unknown names trigger one re-ask naming the actual set; if the second
reply still claims them, the answer reaches the writer **flagged** (`[FLAGGED] They used "x", which
they cannot do.`) — never silently accepted, never silently dropped. Best-effort by design: a
deterministic gate would need a rule layer with world-state predicates, which this does not have.

---

## Deliberately not built

Multi-scene stories and outlining · a declarative rule layer gating skills on world state and
possessions · any dependency on the roleplay engine this was forked from.

Tests cover code-enforced invariants only ([CLI.md](CLI.md) lists them). Whether the writer asks
*good* questions, whether the architect designs an interesting scene, and whether the prose is any
good are judgements: they belong in a live run, not a pass/fail gate. The one place code ventures an
opinion is `normalizeSpec`, which flags a cast where **nobody lacks anything** — it cannot tell
whether a design is interesting, but it can notice the single absence that reliably makes it dull.
