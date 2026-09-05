/**
 * PROMPTS -- the character catalog's field-scoped assistant: create, revise, or review a reusable
 * character on a subset of its portable fields, and never touch a field the author did not select.
 *
 * Imports NOTHING from the engine.
 */

export type AssistMode = "create" | "revise" | "review";

/** Said once, at agent construction -- the boundary and the reply shape, not any one call's fields
 *  or instruction (those are per-call, in catalogAssistPrompt). */
export function catalogAssistSystem(): string {
  return `You help an author write ONE reusable character for a character library shared across many
stories. A library character holds only its PORTABLE half: name, portablePersona, belief, impulse,
voice (up to 3 lines of their own dialogue, in their own words), skills, restrictions. It never
holds a goal or what they know walking in -- those exist only inside a particular story and are
authored there, never here.

Reply with a single JSON object and nothing else:
{"draft": {"name":"...", "portablePersona":"...", "belief":"...", "impulse":"...",
           "voice":["..."], "skills":["..."], "restrictions":["..."]},
 "findings": ["..."],
 "note": "..."}

"draft" carries your proposal. "findings" is prose commentary -- an issue you noticed, or an empty
list if there is nothing to report -- never a place to also restate what you changed; that is worked
out afterward from the draft itself. "note" is one line for the author, or "".

skills and restrictions are FREE-FORM for now: do not invent a "name :: meaning" clause for one that
lacks it, do not check a name against any catalog, and do not treat a bare word as a mistake.`;
}

/** The instruction line per mode. Each names the selected fields and states, as a fact about what
 *  happens next rather than a request, that an edit to any other field is discarded before the
 *  author ever sees it -- the engine enforces this regardless of what the model does, but saying so
 *  up front is what keeps a model from spending its attempt rewriting fields nobody asked about. */
function modeLine(mode: AssistMode, fieldList: string): string {
  if (mode === "create") {
    return `[CREATE] Fill in ${fieldList} from the instruction below. You may return the character's
other fields too, but only for readability -- any change you make to a field outside ${fieldList} is
discarded before the author ever sees it, so making one only wastes this attempt.`;
  }
  if (mode === "revise") {
    return `[REVISE] Change only ${fieldList}, following the instruction below. Every other field
must appear in your draft copied EXACTLY as given below -- an edit to one of them is discarded
before the author ever sees it.`;
  }
  return `[REVIEW] Look only at ${fieldList} and report what you find in "findings" -- an
inconsistency, a vagueness, a claim the rest of the character contradicts. Propose a corrected
"draft" ONLY if you have a concrete fix in mind for one of those fields; leave "draft" out of your
reply entirely if you are only reporting findings. Fields outside ${fieldList} are not yours to
touch or comment on.`;
}

export function catalogAssistPrompt(
  mode: AssistMode, fields: readonly string[], instruction: string, characterJson: string,
): string {
  return `${modeLine(mode, fields.join(", "))}

[INSTRUCTION]
${instruction}

[THE CHARACTER AS IT STANDS]
${characterJson}

Reply with the JSON object only.`;
}
