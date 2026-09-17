/**
 * PROMPTS -- the smoothing pass: rendering a recorded scene's structured decisions into prose.
 *
 * Imports NOTHING from the engine.
 */

export type SmoothItem =
  | { kind: "situation"; character: string; text: string }
  | { kind: "grant"; character: string; speech: string; action: string; thought?: string }
  | { kind: "world"; text: string };

/**
 * System prompt for the smoothing pass. Composes the boundaries, the protocol, the cast, POV,
 * scene question, and the house style block.
 */
export function smoothSystem(p: {
  style: string;
  pov: string;
  question: string;
  cast: string[];
}): string {
  const styleBlock = p.style.trim()
    ? `[HOUSE STYLE]\n${p.style}`
    : "[HOUSE STYLE]\n(none given)";

  const castBlock = p.cast.length > 0 ? `[CAST]\n${p.cast.join(", ")}` : "[CAST]\n(none)";

  return `You are rendering an already-decided scene into prose. Every choice in it has been made by
the people who made it. Rendering is the whole job — nothing is being decided here.

GRANT items are the record of what characters actually said and did. Speech goes on the page as the
words they said — you may punctuate and attribute, you may not rewrite the words or add new ones.

An action arrives in first person because the character wrote it as themselves. Transpose it into the
house style's grammatical person and tense. Transposition only: do not add a deed, a gesture, a pause,
a hesitation, a glance, or a change of expression that is not in the record. If the record says they
stepped closer, they stepped closer and did nothing else.

Connective behaviour is the temptation, and it is forbidden: "she hesitated", "he paused before
answering", "they looked away" is invention, however natural it reads, because a hesitation is a
choice and nobody made it.

SITUATION items are circumstance — where people are, what is physically true, what has just changed.
They are the writer's own record of the world and are yours to render freely. They were addressed to
one character as "you"; that "you" must not reach the page.

WORLD items are events nobody chose. Render them as they fall.

Keep the record's order. Reordering changes who is responding to what.

If the material does not reach the target length, the scene is short. Do not pad. Padding invents
behaviour, and a short faithful scene is a correct outcome.

Output is prose only — no headings, no labels, no JSON.

${castBlock}

[POINT OF VIEW]
${p.pov || "(none given)"}

[SCENE QUESTION]
What the scene was written to answer, given so you know where its weight falls. It is not a task.
Whether the record answers it was settled before you were called: if the answer is in the record,
render it; if it is not, the scene ends without one. Do not write an ending the record does not have.
${p.question || "(none given)"}

${styleBlock}`;
}

/**
 * Request prompt for the smoothing pass. Renders the items into a readable, labelled block with
 * sub-lines for each item's components, followed by the target word count.
 */
export function smoothRequest(items: SmoothItem[], targetWords: number): string {
  const lines: string[] = [];

  for (const item of items) {
    if (item.kind === "situation") {
      lines.push(`[SITUATION -> ${item.character}]`);
      lines.push(item.text);
      lines.push("");
    } else if (item.kind === "grant") {
      lines.push(`[GRANT ${item.character}]`);
      if (item.speech) {
        lines.push(`said: ${item.speech}`);
      }
      if (item.action) {
        lines.push(`did: ${item.action}`);
      }
      if (item.thought) {
        lines.push(`felt: ${item.thought}`);
      }
      lines.push("");
    } else if (item.kind === "world") {
      lines.push("[WORLD]");
      lines.push(item.text);
      lines.push("");
    }
  }

  lines.push(`Target: ${targetWords} words`);

  return lines.join("\n");
}
