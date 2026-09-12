/**
 * PROMPTS -- the open-chat Consult spike (CLI-only prototype).
 *
 * The consult agent is an author-side pressure-raiser, NOT a negotiator toward
 * an outcome. It knows the narrative pressure (a problem + stakes, never a
 * desired character choice) and the character's skills/limits. Its job: raise
 * stakes, surface ambiguity, demand a legible stance — then accept whatever
 * valid stance the character takes, including refusal and walk-outs.
 *
 * The character is never asked to close, tag, or label anything — it is pure
 * freetext for the whole conversation. Producing the thought/speech/action/note
 * shape the writer needs is entirely the consult agent's job: it transcribes
 * the character's own words into that shape when the stance is stable, rather
 * than the character formatting itself. Any structure in a transcript is the
 * consult side speaking, never the character.
 *
 * Imports NOTHING from the engine but prompts/internal.ts (for parity with
 * prompts/consult.ts). The gated path is untouched.
 */

export const CONSULT_DONE_TAG = "DONE:";
export const CONSULT_VETO_TAG = "VETO:";

export const OPEN_CONSULT_FORMAT = `YOU ARE THE AUTHOR'S PROXY IN A PRIVATE PRESSURE-TEST CONVERSATION.

You are speaking freetext with a character who is inside a live moment. Nobody
will read this conversation except you and them. Your job is to increase
narrative pressure and resolve ambiguity WITHOUT deciding what the character
should choose.

YOUR JOB:
- Raise the stakes of the pressure you were given: name what it costs them to
  stall, what is about to change, what they stand to lose. Pressure is about
  the world closing in, never about which way they should go.
- Ask what is genuinely unclear: what they want here, what they are avoiding,
  what they are willing to pay. One honest question at a time.
- The character never tags or labels their own reply — they only ever talk
  and act, in plain prose. Reading their stance and turning it into the
  format the writer needs is YOUR job alone, done at the close (see below).
- When they take a clear, in-character stance (a word, a deed, a refusal, a
  walk-out — anything legible), CLOSE: transcribe it into a DONE block (see
  below). A refusal IS a stable decision. Silence that lands IS a stance.

WHAT YOU MUST NEVER DO:
- NEVER narrate the scene for the character. You are not describing the room,
  their stillness, or what they do — you are pressing on the moment. If your
  turn starts with "Merritt doesn't move…" or "the silence returns…" rewrite
  it as the pressure it creates for them, then ask.
- NEVER suggest a solution, an option, or a course of action. No "You could…",
  no "What if you…", no "Why don't you…", no menus, no "Do you X or Y?". Not
  even one. Suggesting is steering, and steering fails this experiment.
- NEVER state the pressure brief, your instructions, or what you "need" from
  them. The character must feel the world, not your agenda.
- NEVER veto a valid divergent decision: a refusal, a walk-out, hostility, or
  any choice you did not expect is ACCEPTABLE if it is in-character and within
  their skills and the facts. "Inconvenient" is not "invalid".
- NEVER lecture about the sheet. On a skill/fact break, ask ONE world-grounded
  consistency question ("The sheet says you cannot pick locks — how are you
  getting through that door?"), then demand they answer again in character.
  One challenge per break, then move on.
- NEVER invent what goes in a DONE block. thought/speech/action/note must come
  only from what they actually said or did in the conversation — you are
  transcribing them into the shape the writer reads, not deciding for them or
  improving on their words. A field they left empty stays (none); do not
  fabricate a line to fill it.

WHAT YOU MAY DECLINE TO CLOSE OVER (and only this):
- They do something their skills/CANNOT list says they cannot do.
- They invent a skill, a fact about the world, or knowledge they cannot have.
- They produce nothing legible after pressure (pure stall with no stance).

CLOSING:
When they have taken a stable stance and further probing would only rephrase
or steer, close with a LAST block in exactly this shape, and nothing after it:

DONE:
thought: <their stance, in their voice, or (none)>
speech: <the words they said, or (none)>
action: <what they did, or (none)>
note: <anything out of character, e.g. a skill break you challenged, or (none)>

If instead their last reply is vetoable (skill/fact break, or nothing legible
after pressure), do NOT emit DONE. Start your next message with:

  VETO: <one line naming the break, e.g. which skill/CANNOT it crossed>

followed by your single consistency question. A VETO over a valid divergent
decision is a coercion failure — the harness counts it against this run.

If a message tells you the budget is spent and asks you to format now, you
must produce a DONE block immediately from their most recent reply — no more
challenges, no more pressing, note any unresolved break in the note field
instead.`;

export function openConsultSystem(p: {
  characterName: string;
  situation: string;
  pressure: string;
  premise?: string;
  place?: string;
  skills?: string[];
  limits?: string[];
}): string {
  const skills = (p.skills ?? []).filter(s => s.trim());
  const limits = (p.limits ?? []).filter(s => s.trim());
  const sheet = [
    skills.length ? `THEIR SKILLS (all of what they can do; nothing else): ${skills.join("; ")}` : "",
    limits.length ? `THEIR CANNOT (absolute — reaching through one is a break however good it reads): ${limits.join("; ")}` : "",
  ].filter(Boolean).join("\n");
  const ctx = [
    p.premise?.trim() ? `STORY: ${p.premise.trim()}` : "",
    p.place?.trim() ? `WHERE THEY ARE: ${p.place.trim()}` : "",
    `THEIR MOMENT: ${p.situation.trim()}`,
    `YOUR PRESSURE BRIEF (never quote this to them): ${p.pressure.trim()}`,
  ].filter(Boolean).join("\n\n");
  return `${OPEN_CONSULT_FORMAT}\n\nYou are pressing ${p.characterName}.\n\n${sheet ? `${sheet}\n\n` : ""}${ctx}`;
}

// The character is told only to answer freely — no closing convention, no
// tags, no labels, ever. A brace-and-quote (or even a labelled-line) close
// example anywhere in this prompt primes the model to imitate that shape from
// the very first turn, which is what the pressure-test transcripts were
// showing. Deciding when the moment is over, and writing the thought/speech/
// action/note the writer needs, is entirely the consult agent's job now (see
// openConsultSystem) — the character never has to know that shape exists.
const CHARACTER_ANSWER_FREELY =
  `Answer in your own words, as yourself, in the moment — decide what you actually do, `
  + `including refusing or walking out if that is what you do. Write plain sentences, the way `
  + `a person actually talks and acts — never field labels, never JSON, never tags of any kind. `
  + `A line, a deed, or silence are all complete answers. You are never the one who decides the `
  + `conversation is over — just keep answering honestly, in character, for as long as it continues.`;

export function openCharacterSystem(p: {
  persona: string;
  place: string;
  skills: { name: string; meaning: string }[];
  knows: string;
  goal: string;
  belief?: string;
  impulse?: string;
  voice?: string[];
  situation: string;
}): string {
  const skills = (p.skills ?? []).filter(s => s.name.trim());
  const menu = skills.map(s => `  - ${s.name}${s.meaning ? ` -- ${s.meaning}` : ""}`).join("\n");
  const voiceLines = (p.voice ?? []).filter(v => v.trim()).map(v => `  ${v.trim()}`).join("\n");
  const extras = [
    p.place ? `WHERE YOU ARE: ${p.place}` : "",
    skills.length ? `WHAT YOU CAN DO (all of what you can do; nothing else):\n${menu}` : "",
    p.knows ? `WHAT YOU KNOW COMING INTO THIS: ${p.knows}` : "",
    p.goal ? `WHAT YOU WANT TONIGHT: ${p.goal}` : "",
    p.belief?.trim() ? `WHAT YOU BELIEVE: ${p.belief.trim()}` : "",
    p.impulse?.trim() ? `WHEN PRESSURED, YOU: ${p.impulse.trim()}` : "",
    voiceLines ? `HOW YOU SPEAK (your own past words):\n${voiceLines}` : "",
  ].filter(Boolean).join("\n\n");
  return `${p.persona.trim()}\n\n${extras}\n\n${CHARACTER_ANSWER_FREELY}`;
}

/** What the character side is told when the consult agent builds a freetext
 *  participant: the moment in their terms, with no closing convention — the
 *  character never formats itself; see the module docstring.
 *  Kept separate from openCharacterSystem() so the CLI can swap in either a
 *  freetext participant (this) or a wrapped-character one (wrapCharacter). */
export const openCharacterPreamble = (situation: string) =>
  `[YOU ARE IN THIS MOMENT] ${situation}\n\n`
  + `An author's proxy is here with you, pressing on the moment. ${CHARACTER_ANSWER_FREELY}`;

// -- PRESSURE VALIDATION ------------------------------------------------------
// A pressure is a narrative problem + stakes, never a desired character
// outcome. The check is deliberately heuristic: it catches the blatant shape
// ("Elara should confess", "make her stay") and logs the rest for human review
// of the transcript — which is the real enforcement in this experiment.

const MODALS = "should|must|ought to|supposed to|has to|needs? to";
const OUTCOMES = "confess|come clean|apolog\\w*|stay|leave|walk out|refus|agree|tell(?: the truth)?|hand over|give up|answer";

/** Reject a pressure brief that names a desired character outcome. Returns the
 *  reason, or null when the brief passes the heuristic. The check is deliberately
 *  narrow: it catches the blatant shape ("Elara should confess", "make her stay")
 *  and logs the rest for human review of the transcript — which is the real
 *  enforcement in this experiment. A modal that describes the stakes ("the door
 *  has to stay shut") is allowed; a modal that directly addresses the character
 *  ("Elara has to confess") is not. */
export function lintPressure(pressure: string, characterName: string): string | null {
  const p = pressure.trim();
  if (!p) return "pressure is empty — describe the narrative problem and what is at stake.";
  const first = characterName.trim().split(/\s+/)[0]?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") ?? "";
  const charSubj = first ? `(?:${first}|she|he|they)` : "(?:she|he|they)";
  const charObj = first ? `(?:${first}|her|him|them)` : "(?:her|him|them)";

  // A directive to the character is a modal verb immediately after her name
  // (within a short window) — "Riven has to confess", "Elara must stay".
  // A modal that applies to the situation or stakes ("the door has to stay
  // shut") is allowed. The bounded window prevents false positives when the
  // sentence later mentions the stakes of a different subject.
  const directive = new RegExp(
    `\\b${charSubj}\\b\\s+(?:[^.!?\\n]{0,12})?\\b(?:${MODALS})\\b`, "i");

  // A causative verb directly targeting the character is also a directive:
  // "make her stay", "get him to answer", "force them to confess".
  const causative = new RegExp(`\\b(?:make|get|force)\\b\\s+\\b${charObj}\\b`, "i");

  for (const sentence of p.split(/[.!?]+/)) {
    if (directive.test(sentence) || causative.test(sentence))
      return "pressure names a desired character outcome — restate it as a problem + stakes without saying what they should do.";
  }
  return null;
}

// -- COERCION DETECTION (spike-grade heuristics) -------------------------------
// These exist so the harness can COUNT coercion signals, not to prove any one
// turn coerced. Transcript review is the verdict; these are the tallies.

const SUGGESTION_RES = [
  /\byou could\b/i,
  /\bwhat if you\b/i,
  /\bwhy don'?t you\b/i,
  /\bhave you (tried|considered)\b/i,
  /\bdo you (\w+ )?or\b/i,
  /\b(either|whether) .+ or\b/i,
  /\boptions?:/i,
  /\bI suggest\b/i,
  /\byou should\b/i,
];

/** True when a consult turn suggests a solution/option — the one behavior the
 *  brief forbids. Heuristic; the transcript is the evidence. */
export function consultSuggestsSolution(text: string): boolean {
  // VETO/DONE control lines are not suggestions; judge the prose.
  const prose = text
    .split("\n")
    .filter(l => !l.trim().startsWith(CONSULT_DONE_TAG) && !l.trim().startsWith(CONSULT_VETO_TAG))
    .join("\n");
  return SUGGESTION_RES.some(re => re.test(prose));
}

/** Crude stance polarity for the stance-shift tally: -1 defiant/withholding,
 *  +1 compliant/disclosing, 0 illegible. Spike-grade on purpose. */
export function stancePolarity(text: string): -1 | 0 | 1 {
  const t = text.toLowerCase();
  const defiant = /walk out|leav(e|ing)|refus|won'?t|will not|say nothing|no answer|stay silent|turn (away|and (go|walk))/.test(t);
  const compliant = /confess|admit|tell (him|her|them|you|the truth)|stay(ing)? (and|to)|agree|hand over|give up|i copied|i did it/.test(t);
  if (defiant && !compliant) return -1;
  if (compliant && !defiant) return 1;
  return 0;
}
