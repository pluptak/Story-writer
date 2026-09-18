/** QUOTE-LINT — the mechanical half of the narration lint.
 *
 * The narration judge (LLM) checks deeds, restricted senses, and consult-situation quality. It used
 * to also check dialogue against the granted ledger, but a model that always returns {"ok": true}
 * let unmatched quotations reach the page — run 2 carried two quoted lines against an empty ledger
 * and passed. Quotation matching is therefore mechanical: extract quoted strings in code and match
 * each against the granted-so-far ledger. An unmatched quotation flags with no model call, empty
 * ledger included — the exact case the LLM used to pass as a "free assertion".
 *
 * This file imports nothing from the engine: pure text matching, so it stays a leaf. */

// Re-declared locally to keep this file a leaf (it only needs the three fields it reads).
export interface GrantedLine { character: string; speech: string; thought?: string; action?: string; }

// The declared pronoun set, re-declared locally for the same reason — the shape already on
// the schema and already consumed by pronoun-lint.ts, so no new authoring is needed.
export interface SpeakerPronouns { subject: string; object: string; possessive: string; reflexive: string; }

/** Who a quote may be attributed to: a bare name (as before), or a name with declared
 *  pronouns so a pronominal speech tag can resolve against exactly one member. */
export type SpeakerRef = string | { name: string; pronouns?: SpeakerPronouns };

export interface QuoteLintHit { ok: false; why: string; quote: string; character: string; }

export const isAdvisoryQuoteHit = (h: QuoteLintHit) => h.why.startsWith("possible misattribution");

/** Pull every quoted span out of a piece of prose, with its start offset. Double quotes are
 *  unambiguous; single quotes are scanned apostrophe-aware so "I'll" does not split on the
 *  apostrophe. Empty spans are dropped. */
export function extractQuotations(prose: string): { text: string; index: number }[] {
  const out: { text: string; index: number }[] = [];

  for (let i = 0; i < prose.length; i++) {
    const open = prose[i];
    if (!['"', "“", "'", "‘"].includes(open)) continue;
    const single = open === "'" || open === "‘";
    if (single && i > 0 && /[\p{L}\p{N}’']/u.test(prose[i - 1])) continue;
    const close = open === "“" ? "”" : open === "‘" ? "’" : open;
    for (let j = i + 1; j < prose.length; j++) {
      if (prose[j] !== close) continue;
      if (single && j + 1 < prose.length && /[\p{L}\p{N}]/u.test(prose[j + 1])) continue;
      const text = prose.slice(i + 1, j);
      if (text.trim()) out.push({ text, index: i + 1 });
      i = j;
      break;
    }
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

/** A quote matches a granted line when it is near-verbatim: a contiguous token run in either
 *  direction, or (failing that) a Dice-coefficient overlap of at least 0.8 — a lightly edited quote
 *  (one word swapped in six) still passes, a wholly invented one does not. Dice rather than Jaccard
 *  because it does not punish a single substitution as harshly. */
function matchQuote(q: string, lines: string[]): boolean {
  const qn = norm(q);
  if (!qn) return true;
  const qt = qn.split(" ");
  for (const sp of lines) {
    const sn = norm(sp);
    if (!sn) continue;
    const st = sn.split(" ");
    if (seqContains(st, qt)) return true;
    if (qt.length >= 8 && qt[0] === "i" && st[0] === "i"
      && !st.some(t => /^(?:not|no|never|neither|nor|without|cannot|t)$/.test(t))
      && seqContains(st, qt.slice(1))) return true;
    if (qt.length < 5) continue;
    for (let i = 0; i + qt.length <= st.length; i++) {
      let edits = 0;
      for (let j = 0; j < qt.length; j++) {
        if (qt[j] === st[i + j]) continue;
        if (!/^(?:a|an|the|this|that)$/.test(qt[j])
          || !/^(?:a|an|the|this|that)$/.test(st[i + j])) { edits = 2; break; }
        edits++;
      }
      if (edits <= 1) return true;
    }
  }
  return false;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The paragraph separator the engine writes between pieces — the boundary the attribution
 *  fallbacks stop at, since no speech tag reaches across one. */
const PARA = "\n\n";

/** Best-effort attribution of an unmatched quote. Post-dialogue attribution (`"..." NAME says`) is
 *  the ordinary form in the prose this engine asks for, so the name immediately following the quote
 *  is checked first; only when nothing follows is the nearest preceding name used. Returns "unknown"
 *  when neither direction finds one — the flag still carries the offending quote.
 *
 *  Two guards against reading a name that is not the speaker, both grown on live false positives
 *  (the-healer-s-cell 2026-09-18T06-24-52-772Z, four of five flags):
 *
 *  - **Quoted spans are masked from the fallback scan.** A vocative inside another character's
 *    line (`"Tell me, Mara," he said ... "When the shadows lengthened..."`) used to count as
 *    the nearest preceding name, attributing Rowan's own line to MARA. The explicit tag pass
 *    still reads the unmasked prose; only the nearest-name fallback reads the masked copy.
 *  - **A pronoun speech tag resolves against declared pronouns.** A name in a possessive or
 *    object role (`Mara held Rowan's gaze ... "The herbs were for the weary, Father," she
 *    said`) used to win the fallback while the true speaker sat in a `she said` the explicit
 *    pass cannot use. When exactly one cast member declares that subject pronoun, the tag
 *    names them for the own-grants check; a pronoun shared by two members identifies nobody
 *    and the existing fallback stands. Best-effort, not explicit: the tag is no more certain
 *    than the fallback, so the label and source-frame skips still apply.
 *  - **Both fallback windows stop at a paragraph break.** A speaker is never named across one,
 *    and a granted line split into two quoted fragments leaves the second without a tag, so the
 *    scan would otherwise take the next paragraph's opening name as its speaker. */
function attribute(prose: string, quote: { index: number; text: string }, speakers: readonly SpeakerRef[]): { character: string; explicit: boolean } {
  const entries = speakers.map(s => typeof s === "string" ? { name: s } : s);
  const names = entries.map(e => e.name);
  const end = quote.index + quote.text.length;
  const after = prose.slice(end + 1, Math.min(prose.length, end + 100));
  const before = prose.slice(Math.max(0, quote.index - 120), quote.index - 1);
  const tags = "said|says|say|asked|asks|replied|replies|whispered|whispers|shouted|shouts|muttered|mutters|told|tells";
  for (const name of names.filter(n => n.trim())) {
    const who = escapeRe(name.trim());
    if (new RegExp(`\\b${who}\\s+(?:${tags})(?:\\s+\\w+ly)?\\s*[,：:]?\\s*$`, "i").test(before)
      || new RegExp(`^\\s*[,—]?\\s*(?:${who}\\s+(?:${tags})|(?:${tags})\\s+${who})\\b`, "i").test(after)) {
      return { character: name, explicit: true };
    }
  }
  // A pronominal tag adjacent to the quote ("she said", "said she"), resolved only when the
  // subject pronoun names exactly one cast member — the speech-tag subject is always the
  // subject form, so only pronouns.subject is read. Best-effort like the fallback, not
  // certain like a name tag: prose does not always follow the bible (a generic singular
  // "they" for a he/him character), so certainty here would both defeat the machine-label
  // skip and escalate a misresolution to blocking.
  const bySubject = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const e of entries) {
    const subject = e.pronouns?.subject?.trim().toLowerCase();
    if (!e.name.trim() || !subject) continue;
    if (bySubject.has(subject)) { ambiguous.add(subject); bySubject.delete(subject); }
    else if (!ambiguous.has(subject)) bySubject.set(subject, e.name);
  }
  if (bySubject.size) {
    const alt = [...bySubject.keys()].map(escapeRe).join("|");
    const beforeRe = new RegExp(`\\b(${alt})\\s+(?:${tags})(?:\\s+\\w+ly)?\\s*[,：:]?\\s*$`, "i");
    const afterRe = new RegExp(`^\\s*[,—]?\\s*(?:(${alt})\\s+(?:${tags})|(?:${tags})\\s+(${alt}))\\b`, "i");
    const mb = beforeRe.exec(before);
    if (mb) return { character: bySubject.get(mb[1].toLowerCase())!, explicit: false };
    const ma = afterRe.exec(after);
    if (ma) return { character: bySubject.get((ma[1] ?? ma[2]).toLowerCase())!, explicit: false };
  }
  // The fallback windows also stop at a paragraph break, because a speaker is never named
  // across one. Without this, a line split into two quoted fragments loses its tag on the
  // second of them, and the scan reaches past the blank line into the next paragraph's opening
  // name — the last of the four live false positives, and the only one still standing once
  // vocatives were masked.
  const masked = maskQuotations(prose);
  const paraBefore = prose.lastIndexOf(PARA, Math.max(0, quote.index - 1));
  const paraAfter = prose.indexOf(PARA, end + 1);
  const afterMasked = masked.slice(end + 1,
    Math.min(masked.length, end + 100, paraAfter < 0 ? masked.length : paraAfter));
  const beforeMasked = masked.slice(
    Math.max(0, quote.index - 120, paraBefore < 0 ? 0 : paraBefore + PARA.length), quote.index - 1);
  let bestAfter = Infinity, afterName = "unknown";
  for (const name of names) {
    const m = new RegExp(`\\b${escapeRe(name)}\\b`, "i").exec(afterMasked);
    // Keep the occurrence closest to the quote (smallest start offset within the window).
    if (m && m.index < bestAfter) { bestAfter = m.index; afterName = name; }
  }
  if (afterName !== "unknown") return { character: afterName, explicit: false };
  let best = -1, bestName = "unknown";
  for (const name of names) {
    const re = new RegExp(`\\b${escapeRe(name)}\\b`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(beforeMasked))) {
      // Keep the occurrence closest to the quote (largest start offset within the window).
      if (m.index > best) { best = m.index; bestName = name; }
    }
  }
  return { character: bestName, explicit: false };
}

/** The prose with every quoted span blanked to spaces, offsets preserved — so the fallback
 *  name scan never reads a vocative (or any other name) inside someone else's line as the
 *  speaker. The explicit tag pass does not use this: speech tags live in narration. */
function maskQuotations(prose: string): string {
  const spans = extractQuotations(prose);
  if (!spans.length) return prose;
  const chars = prose.split("");
  for (const q of spans) {
    const start = Math.max(0, q.index - 1);
    const stop = Math.min(chars.length - 1, q.index + q.text.length);
    for (let i = start; i <= stop; i++) chars[i] = " ";
  }
  return chars.join("");
}

/** A quoted span of one bare word is a label, not a line: a lever thrown to the 'Shutdown' position,
 *  a status that reads "Fatal", a switch turned "off". A dashboard-set story produces a steady
 *  stream of them, and each cost twice over — flagged as a fabricated line, and (before the callers
 *  stopped short-circuiting) taking the LLM half of the lint down with it, so THE ONE RULE went
 *  unchecked on that piece entirely. Two live runs carried six such flags between them, every one
 *  a machine label. Missing an invented one-word line is the cheap failure beside that — the same
 *  trade sense-lint makes: inventing a violation costs the scene its redraft. */
const isMachineLabel = (text: string) => !/\s/.test(text.trim());

/** A quote introduced by a named display or broadcast source is world furniture, not a line: the
 *  sign, the notice, the PA. Nothing a cast member said, so no grant could cover it, and before
 *  this exemption every such quote flagged. A positive exculpating pattern, the same shape as
 *  sense-lint's DETERMINER and NOUN_TAIL tails and the machine-label rule above: an enumerable
 *  list grown only on live evidence, each addition's reason written down. It deliberately does NOT
 *  exempt on the absence of a speech verb — unattributed dialogue is the house style's dominant
 *  form, and exempting that would leave the check running only for the tagged minority while
 *  "the PA said ..." (a broadcast, not a character) went on flagging. The accepted trade:
 *  fabricated dialogue framed as display ("the note read 'I never signed anything'") escapes the
 *  mechanical half. */
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

const sameCharacter = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Every renderable line a set of grants offers to match against: what was said, and what was
 *  felt — a quoted rendering of granted interiority is exempted the same way granted dialogue is
 *  (Judge.MD, "a felt entry"), so the mechanical check must see both. */
const hasWritingFrame = (prose: string, index: number): boolean =>
  /\b(?:write|writes|wrote|written|writing|scribble|scribbles|scribbled|print|prints|printed|type|types|typed|inscribe|inscribes|inscribed)\b[^.!?;:\n"“”‘’]{0,80}$/i
    .test(prose.slice(Math.max(0, index - 100), index - 1));

const linesOf = (entries: ReadonlyArray<GrantedLine>, written: boolean): string[] =>
  entries.flatMap(g => [g.speech, g.thought,
    ...(written && g.action ? extractQuotations(g.action)
      .filter(q => hasWritingFrame(g.action!, q.index)).map(q => q.text) : []),
  ].filter((s): s is string => !!s));

/** The mechanical quotation check. Returns null when there is nothing to check (no quotes, only
 *  labels, only sourced furniture, or every quote matched a granted line) — the caller then runs
 *  the LLM lint for deeds/senses/situation. Returns a hit the moment one unmatched quote is found.
 *
 *  When the quote can be attributed, it is checked against THAT character's own grants first — a
 *  line granted to one character rendered in another's mouth is a distinct failure ("granted to a
 *  different character") from a line granted to nobody at all, and the earlier all-speeches match
 *  could not tell them apart. An unattributed quote still matches against every grant, as before:
 *  there is nobody to restrict the check to. */
export function lintQuotations(
  prose: string,
  granted: ReadonlyArray<GrantedLine>,
  names: readonly SpeakerRef[] = [],
): QuoteLintHit | null {
  const quotes = extractQuotations(prose);
  if (!quotes.length) return null;
  let advisory: QuoteLintHit | null = null;
  for (const q of quotes) {
    const { character, explicit } = attribute(prose, q, names);
    if (!explicit && isMachineLabel(q.text)) continue;
    if (!explicit && hasSourceFrame(prose, q.index)) continue;
    const written = !explicit && hasWritingFrame(prose, q.index);
    if (character === "unknown") {
      const lines = linesOf(granted, written);
      if (!matchQuote(q.text, lines)) {
        return { ok: false, quote: q.text, character,
          why: `unmatched quotation: "${q.text}" — no character was granted that line` };
      }
      continue;
    }

    const own = linesOf(granted.filter(g => sameCharacter(g.character, character)), written);
    if (matchQuote(q.text, own)) continue;

    const others = linesOf(granted.filter(g => !sameCharacter(g.character, character)), written);
    const reassigned = matchQuote(q.text, others);
    const hit: QuoteLintHit = {
      ok: false,
      quote: q.text,
      character,
      why: `${reassigned && !explicit ? "possible misattribution" : "unmatched quotation"}: "${q.text}" (near ${character})`
        + (reassigned ? " — granted to a different character" : " — no character was granted that line"),
    };
    if (!isAdvisoryQuoteHit(hit)) return hit;
    advisory ??= hit;
  }
  return advisory;
}
