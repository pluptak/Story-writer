/** NARRATION LINT — the three checks on a drafted piece, run ALONGSIDE each other: the mechanical
 *  quotation match, the mechanical restricted-sense match, and the narration judge's read. One
 *  redraft only, so every finding must arrive in one message. Extracted from the scene loop; the
 *  caller owns the redraft itself. */
import * as P from "../prompts.ts";
import { C } from "../ansi.ts";
import { type Agent } from "./agent.ts";
import { extractJson } from "./json-extract.ts";
import { parseLintVerdict } from "./consult.ts";
import { lintQuotations } from "./quote-lint.ts";
import { lintRestrictedSenses } from "./sense-lint.ts";
import type { Msg } from "./llm-client.ts";
import type { GrantedEntry } from "./fanout.ts";

/** Everything the lint can report, as one tagged event each — the RunEvent members it emits,
 *  declared here so this module needs no scene-loop import. */
export type LintEvent =
  | { t: "narration_quote_flag"; why: string; quote: string; character: string; chapter: number }
  | { t: "schema_mismatch"; call: "lint"; character: string; chapter: number }
  | { t: "lint_failed"; why: string; chapter: number };

export interface LintPieceOpts {
  prose: string;
  /** Every line/deed the writer has actually been granted this scene, including any deed this same
   *  reply promotes — without it in evidence the lint flags the writer for using exactly what it
   *  was entitled to. */
  granted: GrantedEntry[];
  cast: ReadonlyArray<{ name: string; cannot: readonly string[] }>;
  pov: string;
  consult: { character?: string; reactors?: string[]; situation: string; question?: string } | null;
  newNarrationJudge: () => Agent;
  log: (e: LintEvent) => void;
  chapter: number;
}

/** Check one drafted piece. Returns what to tell the writer, or null when it is clean. */
export async function lintPiece(o: LintPieceOpts): Promise<string | null> {
  const { log, chapter } = o;
  // Both mechanical checks run ALONGSIDE the LLM lint, never before it. There is one redraft
  // only, so reporting serially spends it on the first finding and leaves the second unfixed —
  // a piece with an invented line AND an invented deed must get both in one message. The
  // quotation check used to short-circuit here: every hit, false positives included, silently
  // skipped the deed and stillness checks. Two live runs skipped six pieces that way and put
  // three unasked-for stillnesses on the page. The extra model call is only spent on pieces
  // already in trouble.
  const quoteLint = lintQuotations(o.prose, o.granted, o.cast.map(c => c.name));
  if (quoteLint && !quoteLint.ok) {
    log({ t: "narration_quote_flag", why: quoteLint.why, quote: quoteLint.quote,
          character: quoteLint.character, chapter });
  }
  const senseLint = lintRestrictedSenses(o.prose, o.cast);
  let lintWhy: string | null = null;
  try {
    const lintJudge = o.newNarrationJudge();
    const lintExtra: Msg[] = [{ role: "user", content: P.narrationLintRequest({
      pov: o.pov, prose: o.prose, granted: o.granted, consult: o.consult }) }];
    for (let tries = 0; ; tries++) {
      const lintRaw = await lintJudge.generate(`${C.magenta}NARRATION-JUDGE${C.reset}`, "judge.narration", lintExtra);
      const verdict = parseLintVerdict(extractJson(lintRaw));
      if (verdict) {
        if (!verdict.ok) lintWhy = verdict.why || "narration was flagged";
        break;
      }
      // Asked twice with no verdict: the piece goes to the page unchecked, as on an outage,
      // and the log says which of the two happened.
      if (tries) break;
      log({ t: "schema_mismatch", call: "lint", character: "(narration)", chapter });
      lintExtra.push({ role: "assistant", content: lintRaw.trim() },
                     { role: "user", content: P.LINT_ONLY });
    }
  } catch (e) {
    log({ t: "lint_failed", why: (e as Error).message, chapter });
    console.log(`${C.yellow}(narration lint call failed: ${(e as Error).message} — accepting)${C.reset}`);
  }
  // A mechanical hit still stands when the LLM half fails or returns no verdict: neither check
  // needed a model, so an outage cannot take them down with it.
  return [quoteLint?.why, senseLint?.why, lintWhy].filter((w): w is string => !!w).join(". ") || null;
}
