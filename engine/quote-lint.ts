/** QUOTE-LINT — the mechanical half of the narration lint.
 *
 * The narration judge (LLM) checks deeds, restricted senses, and consult-situation quality. It used
 * to also check dialogue against the granted ledger, but a model that always returns {"ok": true}
 * let unmatched quotations reach the page — run 2 carried two quoted lines against an empty ledger
 * and passed. Quotation matching is therefore mechanical: extract quoted strings in code and match
 * each against the granted-so-far ledger. An unmatched quotation flags without a model call, empty
 * ledger included, which is exactly the case the LLM used to pass as a "free assertion".
 *
 * This file imports nothing from the engine: it is pure text matching, so it stays a leaf. */

// Re-declared locally to keep this file a leaf (it only needs the two fields it reads).
export interface GrantedLine { character: string; speech: string; }

export interface QuoteLintHit { ok: false; why: string; quote: string; character: string; }

/** Pull every quoted span out of a piece of prose, with its start offset. Double quotes are
 *  unambiguous; single quotes are scanned apostrophe-aware so "I'll" does not split on the
 *  apostrophe. Empty spans are dropped. */
export function extractQuotations(prose: string): { text: string; index: number }[] {
  const out: { text: string; index: number }[] = [];

  const dq = /"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = dq.exec(prose))) {
    if (m[1].trim()) out.push({ text: m[1], index: m.index + 1 });
  }

  const n = prose.length;
  let i = 0;
  while (i < n) {
    // An opening single quote sits at the start or after whitespace; an apostrophe mid-word does not.
    if (prose[i] === "'" && (i === 0 || prose[i - 1] === " " || prose[i - 1] === "\t")) {
      let j = i + 1;
      let closed = -1;
      while (j < n) {
        if (prose[j] === "'") {
          // Close only when the quote ends on a word boundary: the char before is a letter/digit and
          // the char after is not (end, space, or punctuation). An apostrophe like the one in "I'll"
          // is followed by a letter, so it is read as part of the word, not a close.
          const prevWord = j > 0 && /[A-Za-z0-9]/.test(prose[j - 1]);
          const nextNonWord = j + 1 >= n || !/[A-Za-z0-9]/.test(prose[j + 1]);
          if (prevWord && nextNonWord) { closed = j; break; }
        }
        j++;
      }
      if (closed > i + 1) {
        const text = prose.slice(i + 1, closed);
        if (text.trim()) out.push({ text, index: i + 1 });
        i = closed + 1;
        continue;
      }
    }
    i++;
  }
  return out;
}

const norm = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

/** True when `inner`'s tokens appear as a contiguous run inside `outer` (either order). Catches a
 *  quote that is a verbatim phrase of a granted line, or a granted line that is a fragment of a
 *  longer quote — without the substring trap where "no" matches inside "know". */
function seqContains(outer: string[], inner: string[]): boolean {
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

/** A quote matches a granted speech when it is near-verbatim: a contiguous token run in either
 *  direction, or (failing that) a Dice-coefficient overlap of at least 0.8 — a lightly edited quote
 *  (one word swapped in six) still passes, a wholly invented one does not. Dice rather than Jaccard
 *  because it does not punish a single substitution as harshly. */
function matchQuote(q: string, speeches: string[]): boolean {
  const qn = norm(q);
  if (!qn) return true;
  const qt = qn.split(" ");
  for (const sp of speeches) {
    const sn = norm(sp);
    if (!sn) continue;
    const st = sn.split(" ");
    if (seqContains(st, qt) || seqContains(qt, st)) return true;
    const set = new Set(st);
    let inter = 0;
    for (const t of qt) if (set.has(t)) inter++;
    const dice = (qt.length + st.length) > 0 ? (2 * inter) / (qt.length + st.length) : 0;
    if (dice >= 0.8) return true;
  }
  return false;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Best-effort attribution of an unmatched quote: the character name nearest it in the text just
 *  before. Returns "unknown" when none is found — the flag still carries the offending quote. */
function attribute(prose: string, index: number, names: readonly string[]): string {
  const before = prose.slice(Math.max(0, index - 120), index);
  let best = -1, bestName = "unknown";
  for (const name of names) {
    const re = new RegExp(`\\b${escapeRe(name)}\\b`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(before))) {
      // Keep the occurrence closest to the quote (largest start offset within the window).
      if (m.index > best) { best = m.index; bestName = name; }
    }
  }
  return bestName;
}

/** A quoted span of one bare word is a label, not a line: a lever thrown to the 'Shutdown' position,
 *  a status that reads "Fatal", a switch turned "off". A story set at a dashboard produces a steady
 *  stream of them, and each cost twice over — flagged as a fabricated line, and (before the callers
 *  stopped short-circuiting) taking the LLM half of the lint down with it, so THE ONE RULE went
 *  unchecked on that piece entirely. Two live runs carried six such flags between them, every one a
 *  machine label. Missing an invented one-word line is the cheap failure beside that, and the same
 *  trade sense-lint makes: inventing a violation costs the scene its redraft. */
const isMachineLabel = (text: string) => !/\s/.test(text.trim());

/** A quote introduced by a named display or broadcast source is world furniture, not a line: the
 *  sign, the notice, the PA. Nothing a cast member said, so no grant could ever cover it, and
 *  before this exemption every such quote flagged. The check is a positive exculpating pattern,
 *  the same shape as sense-lint's DETERMINER and NOUN_TAIL tails and the machine-label rule above:
 *  an enumerable list grown only on live evidence, with the reason for each addition written down.
 *  It deliberately does NOT exempt on the absence of a speech verb — unattributed dialogue is the
 *  house style's dominant form, and exempting that would leave the check running only for the
 *  tagged minority while "the PA said ..." (a broadcast, not a character) went on flagging. The
 *  accepted trade: fabricated dialogue framed as display ("the note read 'I never signed anything'")
 *  escapes the mechanical half. */
const SOURCE_FRAMES = [
  "read", "reads", "printed", "stencilled", "handwritten", "taped",
  "sign", "notice", "placard", "label", "screen", "display",
  "pa", "tannoy", "loudspeaker", "intercom", "announcement",
  "recording", "voicemail", "answerphone",
];
const SOURCE_FRAME_RE = new RegExp(`\\b(?:${SOURCE_FRAMES.join("|")})\\b`, "i");

/** True when the window just before the quote names a display or broadcast source. The same
 *  120-character look-back the attribution guess uses: near enough to catch the introducing
 *  clause, bounded so a source word in an earlier sentence does not launder a later quote. */
const hasSourceFrame = (prose: string, index: number) =>
  SOURCE_FRAME_RE.test(prose.slice(Math.max(0, index - 120), index));

/** The mechanical quotation check. Returns null when there is nothing to check (no quotes, only
 *  labels, only sourced furniture, or every quote matched a granted line) — the caller then runs
 *  the LLM lint for deeds/senses/situation. Returns a hit the moment one unmatched quote is found. */
export function lintQuotations(
  prose: string,
  granted: ReadonlyArray<GrantedLine>,
  names: readonly string[] = [],
): QuoteLintHit | null {
  const speeches = granted.map(g => g.speech).filter(Boolean);
  const quotes = extractQuotations(prose);
  if (!quotes.length) return null;
  for (const q of quotes) {
    if (isMachineLabel(q.text)) continue;
    if (hasSourceFrame(prose, q.index)) continue;
    if (!matchQuote(q.text, speeches)) {
      const character = attribute(prose, q.index, names);
      return {
        ok: false,
        why: `unmatched quotation: "${q.text}"`
          + (character !== "unknown" ? ` (near ${character})` : "")
          + " — no character was granted that line",
        quote: q.text,
        character,
      };
    }
  }
  return null;
}
