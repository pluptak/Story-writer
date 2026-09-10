/**
 * PROMPTS -- helpers shared between the role files, never called by the engine directly.
 *
 * Every name here was a module-private local of the pre-split prompts.ts. The barrel deliberately
 * does not re-export this file, so the surface an engine caller sees stays exactly what it was
 * before the split.
 */

// -- SHARED DOCTRINE -------------------------------------------------------
// One source of truth for rules stated to more than one agent, so the wordings cannot drift.

export const NAME_THE_CONTRADICTION = `NAME THE CONTRADICTION, NOT THE DISAPPOINTMENT: one question, `
  + `open, naming the established fact the answer broke and what it would take to repair -- "Do you turn `
  + `it, knowing the cylinder you just felt give?" names the felt give against the turning; "What do you `
  + `do?" names nothing broken and repairs nothing. Refused on sight: any question carrying "or" ("Do `
  + `you hold the door, or let go?" -- a pre-written menu is answered by picking, and there is nothing `
  + `left for them to ask for), and any question that shrugs ("What do you do?", "What do you choose `
  + `regarding X?" -- names nothing that broke, so the safest possible answer is always correct, and `
  + `the safest answer is the one that stops the scene). The contradiction is yours to name; the repair `
  + `is theirs; what was already established is what makes either worth asking.`;

// -- THE FOUR THINGS A CONSULT CAN ASK FOR ----------------------------------
// Shared by the writer's WANTS field, by the judge's, and by what the character is told it is
// being asked for, so no two sides learn different meanings for the same word. The canonical
// word list itself, CONSULT_WANTS, is derived from this in prompts/consult.ts -- engine/consult.ts
// takes it from there rather than keeping its own copy.
export const WANTS_MENU = [
  ["speech",   "the words they say"],
  ["action",   "what they physically do"],
  ["decision", "which way they go, when there are two ways"],
  ["reaction", "their immediate internal or emotional response to what they perceive -- not a "
              + "deliberate act, not spoken words"],
] as const;

export const wantsMenuLines = WANTS_MENU.map(([w, d]) => `                    ${w.padEnd(10)}-- ${d}`).join("\n");

// -- CAST AND FACTS BLOCKS -------------------------------------------------
// Shared rendering of a cast's abilities/CANNOTs and of the world's facts, for every author-side
// system prompt that shows either.

/** What every author-side agent gets to know about the cast: what each can do, what they can reach
 *  only through where they are standing, and what they cannot. Only the DELTA from the human baseline
 *  is listed under `can:` — every general skill is assumed present unless a CANNOT names it, so the
 *  header states the baseline and glosses the three labels explicitly (they are confusable):
 *  `can:` is intrinsic, beyond the baseline; `REACH:` is situational, granted by this scene only;
 *  `CANNOT:` is unavailable whatever its source would have been (I2). */
export const castBlock = (cast: { name: string; can: string[]; reach?: string[]; cannot: string[]; presence?: string }[]) =>
  `THE CAST -- every character below has the ordinary human abilities (moving their body, speaking,\n`
  + `hearing, seeing, touching, tasting, smelling, recalling) unless their CANNOT removes one. Each\n`
  + `character's line lists ONLY what is beyond that baseline or taken from it -- can: is an ability\n`
  + `they carry with them; REACH: is available to them ONLY through where they are standing right now;\n`
  + `CANNOT: is unavailable whatever its source would have been:\n`
  + cast.map(c => {
      const head = `  ${c.name}`;
      const tails = [
        c.can.length ? `can: ${c.can.join(", ")}` : "",
        c.reach?.length ? `REACH: ${c.reach.join(", ")}` : "",
        c.cannot.length ? `CANNOT: ${c.cannot.join(", ")}` : "",
        c.presence?.length ? `PRESENCE: ${c.presence}` : "",
      ].filter(Boolean);
      if (!tails.length) return head;
      const pad = " ".repeat(2 + c.name.length);
      return `${head} -- ${tails[0]}${tails.slice(1).map(t => `\n${pad}${t}`).join("")}`;
    }).join("\n");

export const factsBlock = (facts: string[]) =>
  facts.length ? `THE FACTS (true of the world; reveal each only to someone who could perceive or already know it):\n`
    + `${facts.map(f => `  • ${f}`).join("\n")}\n\n` : "";
