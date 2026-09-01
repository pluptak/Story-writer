/**
 * PROMPTS -- shared scaffolding: agent history windowing and the skill catalogs.
 *
 * Imports NOTHING from the engine: every function takes plain strings. This file holds only what
 * an engine caller consumes through the barrel; helpers shared between role files live in
 * prompts/internal.ts, which the barrel skips.
 */

// -- AGENT SCAFFOLDING -----------------------------------------------------

export const digestHeader = (digest: string) =>
  `[SO FAR -- your memory of earlier exchanges]\n${digest}`;

// -- HISTORY WINDOWING -----------------------------------------------------

export const SUMMARIZER_SYSTEM =
  "You compress transcripts faithfully and briefly. Output only the summary.";

export function summarizePrompt(name: string, digest: string, exchanges: string): string {
  return (digest ? `Existing summary:\n${digest}\n\n` : "")
    + `Earlier exchanges to fold in:\n${exchanges}\n\n`
    + `Rewrite ONE concise summary (<=180 words) from ${name}'s perspective, preserving: established facts, `
    + `what ${name} knows or has decided, unresolved threads, and current intentions. Output only the summary.`;
}

// -- SKILL CATALOG ---------------------------------------------------------

export function catalogBlock(catalog: Readonly<Record<string, string>>): string {
  return `THE GENERAL SKILL LIST -- every character has all of these unless "restrictions" removes them:\n`
    + Object.entries(catalog).map(([n, m]) => `  ${n} -- ${m}`).join("\n");
}

/** The special-skill bible: prefer these by name; bespoke skills are allowed but must carry a meaning. */
export function bibleBlock(bible: Readonly<Record<string, string>>): string {
  return `THE SKILL BIBLE -- special skills beyond the general list. PREFER one of these by its exact `
    + `name; it already carries its meaning. Write a bespoke "name :: meaning" only when nothing here fits:\n`
    + Object.entries(bible).map(([n, m]) => `  ${n} -- ${m}`).join("\n");
}
