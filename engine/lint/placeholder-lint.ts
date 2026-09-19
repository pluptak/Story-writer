/** PLACEHOLDER-LINT — the mechanical template-slot check on a character's answer.
 *
 *  A model sometimes emits a literal template slot — "My name is [Name]." — where nothing in
 *  prompts/ or the story contains one. The judge accepts it (it reads as an answer), it enters
 *  the granted ledger verbatim, and the writer then does the right thing ("My name is Mara,"),
 *  which the quote lint correctly flags: no faithful prose ever matches the granted slot. Every
 *  link behaves correctly and the result is an unwinnable redraft, so the slot must never reach
 *  the ledger in the first place.
 *
 *  Conservative by construction, because a refusal spends a retry: only a short bracketed run
 *  of letters and spaces fires — [Name], [your name], [REDACTED], [insert detail]. Anything
 *  with sentence punctuation, digits, or other marks is not a slot ([W-17], [Chapter 2]), and
 *  anything long is an aside, not a fill-in-the-blank. `{slot}` and `<slot>` are deliberately
 *  absent: brace stage directions and angle-bracketed asides are live prose shapes here, and
 *  matching them buys false refusals, not coverage. A miss is acceptable; the quote lint still
 *  stands behind it.
 *
 *  Pure: no imports, no warnings, no state.
 */

export interface PlaceholderHit {
  ok: false; why: string; character: string; field: "speech" | "action" | "thought"; match: string;
}

/** A short bracketed run of letters and spaces — a fill-in-the-blank, not an aside. */
const SLOT = /\[([A-Za-z](?:[A-Za-z ]{0,28}[A-Za-z])?)\]/;

/**
 * Whether a character's answer carries an unresolved template slot: the first hit across
 * speech, action and thought, or null. Empty fields permit silently — there is nothing to read.
 */
export function lintPlaceholderAnswer(
  reply: { speech?: unknown; action?: unknown; thought?: unknown },
  character: string,
): PlaceholderHit | null {
  if (!character.trim()) return null;
  const fields = ["speech", "action", "thought"] as const;
  for (const field of fields) {
    const text = String(reply[field] ?? "");
    if (!text.trim()) continue;
    const m = SLOT.exec(text);
    if (m) {
      return {
        ok: false,
        why: `placeholder: ${character}'s ${field} carries an unresolved slot "${m[0]}"`,
        character,
        field,
        match: m[0],
      };
    }
  }
  return null;
}
