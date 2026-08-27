/**
 * PROMPTS -- helpers shared between the role files, never called by the engine directly.
 *
 * Every name here was a module-private local of the pre-split prompts.ts. The barrel deliberately
 * does not re-export this file, so the surface an engine caller sees stays exactly what it was
 * before the split.
 */

// -- SHARED DOCTRINE -------------------------------------------------------
// One source of truth for rules stated to more than one agent, so the wordings cannot drift.

export const NAME_THE_FORK = `NAME THE FORK OR NAME THE COST: "Do you hold the door, or let go?", `
  + `"Do you say the name, knowing what it admits?". "What do you do?" names nothing at stake, `
  + `so the safest possible answer is always correct -- and the safest answer is the one that `
  + `stops the scene.`;

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
export const castBlock = (cast: { name: string; can: string[]; reach?: string[]; cannot: string[] }[]) =>
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
      ].filter(Boolean);
      if (!tails.length) return head;
      const pad = " ".repeat(2 + c.name.length);
      return `${head} -- ${tails[0]}${tails.slice(1).map(t => `\n${pad}${t}`).join("")}`;
    }).join("\n");

export const factsBlock = (facts: string[]) =>
  facts.length ? `THE FACTS (true of the world; reveal each only to someone who could perceive or already know it):\n`
    + `${facts.map(f => `  • ${f}`).join("\n")}\n\n` : "";
