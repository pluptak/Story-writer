/** REPEAT-LINT — the mechanical guard against a piece re-emitting what is already on the page.
 *
 *  The doorway run's draft #2 re-emitted draft #1 verbatim — 386 identical characters, the whole
 *  opening paragraph — and appended one new sentence; both were accepted and both were appended,
 *  so the scene opened with the same paragraph twice. Nothing between an accepted draft and the
 *  append compared the new piece against the tail of the page. This is that comparison: the
 *  piece's leading sentences are matched against the page's tail, and a repeated prefix is
 *  stripped so only the genuinely new text is appended. The writer restating is model behaviour;
 *  the page corruption is not.
 *
 *  Scope, deliberately narrow:
 *  - Leading sentences only. A phrase repeated mid-piece (the same run's draft #3 re-saying
 *    Riven's one line) is out of scope: stripping mid-prose would mangle what it touches, and
 *    the cheap failure direction here is under-stripping, never mangling.
 *  - The page's tail only. A callback to an older beat is legitimate prose; re-emitting what the
 *    page just ended with is the defect. The caller bounds the tail (the last piece or two).
 *  - Whole sentences only, cut at raw sentence boundaries. An ambiguous or partial match
 *    declines the strip entirely rather than guessing where the repeat ended.
 *
 *  Calibration, from the two reference points the plan names: the doorway 386-character case (a
 *  multi-sentence paragraph, ~55+ words — must fire) and quote-lint.ts:94's near-verbatim bar
 *  (Dice >= 0.8, kept identical so the engine has one answer to "how close is verbatim").
 *  MIN_REPEAT_WORDS sits just under the smallest repeat observed in a live run (54 characters,
 *  ~9-10 words) and far above the coincidental short opening ("He nods." — 2 words, never
 *  stripped). The strip is reported as an event by the caller, so a wrong call is visible in the
 *  run record and cheap to tighten later.
 *
 *  This file imports nothing from the engine: pure text matching, so it stays a leaf. */

/** A sentence matched verbatim (its normalized token run occurs in the tail) or near-verbatim
 *  (Dice >= this against the best same-length window of the tail — one word swapped in six still
 *  matches, a wholly different sentence does not) counts as a repeat. */
export const NEAR_VERBATIM_DICE = 0.8;

/** The strip acts only when the matched leading run totals at least this many words. Below it a
 *  repeat is a tolerated echo, not a paragraph re-emission; acting on one would spend the guard's
 *  trust on phrasing callbacks the prose is allowed to make. */
export const MIN_REPEAT_WORDS = 8;

export interface RepeatStrip {
  kept: string;      // the piece with its repeated leading sentences removed ("" if wholly repeated)
  chars: number;     // raw characters removed from the head of the piece
  words: number;     // words removed
  whole: boolean;    // true when the entire piece was already on the page
}

// Identical to quote-lint's: lowercase, punctuation to spaces, whitespace collapsed. The repeat
// only has to read as such normalized — case and punctuation are not content.
const norm = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

/** Sentence spans with raw offsets. A sentence ends at a terminator run (`.` `?` `!` `…`) followed
 *  by whitespace or the end of the piece — the same terminators salvageProse cuts on. A close
 *  quote between the terminator and the whitespace (`… the ledger." He`) does not split, which
 *  merges two sentences into one unit; merged units match less often, so this errs toward not
 *  stripping. A prose tail with no terminator is one sentence. */
function sentences(prose: string): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  const re = /[.?!…]+(?=\s|$)/g;
  let from = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prose))) {
    const end = m.index + m[0].length;
    out.push({ text: prose.slice(from, end), start: from, end });
    from = end;
    while (from < prose.length && /\s/.test(prose[from])) from++;
    re.lastIndex = from;
  }
  if (from < prose.length) out.push({ text: prose.slice(from), start: from, end: prose.length });
  return out;
}

/** True when `inner`'s tokens appear as a contiguous run inside `outer` — quote-lint's seqContains,
 *  the verbatim half: a copied sentence, not a substring accident. */
function runInTokens(outer: string[], inner: string[]): boolean {
  if (inner.length === 0) return true;
  if (inner.length > outer.length) return false;
  for (let s = 0; s <= outer.length - inner.length; s++) {
    let ok = true;
    for (let k = 0; k < inner.length; k++)
      if (outer[s + k] !== inner[k]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

/** The best Dice coefficient between the sentence's tokens and any same-length window of the tail —
 *  quote-lint.ts:94's computation (Set intersection, 2|A∩B|/(|A|+|B|)), slid along the tail so a
 *  lightly edited sentence still matches wherever the page carries the original. */
function bestDice(tail: string[], s: string[]): number {
  const m = s.length;
  if (!m || tail.length < m) return 0;
  const set = new Set(s);
  let best = 0;
  for (let i = 0; i + m <= tail.length; i++) {
    let inter = 0;
    for (let k = 0; k < m; k++) if (set.has(tail[i + k])) inter++;
    const dice = inter / m;   // (2*inter)/(m+m)
    if (dice > best) best = dice;
    if (best === 1) break;
  }
  return best;
}

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Strip the piece's repeated leading sentences against the page's tail. Returns null when the
 *  piece does not open with a repeat of at least `minWords` words — the common case, ordinary
 *  continuation — and otherwise the kept remainder with the size of what was removed. */
export function stripRepeatedPrefix(
  prose: string, pageTail: string, minWords = MIN_REPEAT_WORDS,
): RepeatStrip | null {
  const trimmed = prose.trim();
  if (!trimmed || !pageTail.trim()) return null;
  const tail = norm(pageTail).split(" ").filter(Boolean);
  const parts = sentences(trimmed);

  // Walk the leading sentences; the first one that is neither verbatim nor near-verbatim in the
  // tail ends the run. A tokenless fragment (bare punctuation) cannot be judged — stop rather
  // than guess.
  let matched = 0;
  while (matched < parts.length) {
    const tokens = norm(parts[matched].text).split(" ").filter(Boolean);
    if (!tokens.length) break;
    if (!runInTokens(tail, tokens) && bestDice(tail, tokens) < NEAR_VERBATIM_DICE) break;
    matched++;
  }
  if (!matched) return null;

  // Cut at the raw start of the first unmatched sentence — a sentence boundary, never mid-sentence.
  const cutStart = matched === parts.length ? trimmed.length : parts[matched].start;
  const stripped = trimmed.slice(0, cutStart);
  const words = wordCount(stripped);
  if (words < minWords) return null;
  const kept = trimmed.slice(cutStart);
  return { kept, chars: cutStart, words, whole: kept === "" };
}
