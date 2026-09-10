/** CONSULT — the writer<->character protocol: what a consult must contain, and running one. */
import * as P from "../prompts.ts";
import { C } from "../ansi.ts";
import { type Agent } from "./agent.ts";
import { extractJson } from "./json-extract.ts";
import { type Msg } from "./llm-client.ts";
import { lintRestrictedSituation } from "./sense-lint.ts";
import { nameKey, sameName } from "./config-util.ts";

/** The cast shape the consult gate needs: each character's resolved CANNOT list, so a situation can
 *  be checked against its addressee, plus their structured presence (when the scene sets one) for
 *  the same gate's dynamic half — a "remote" addressee refused a situation their position rules out.
 *  `presenceState` is inline-typed rather than imported so this module gains no dependency on the
 *  engine above it; it is named for the state, not `presence`, which the writer's cast block already
 *  uses for the rendered string. Scene-loop resolves the same thing for the narration lint. */
export type CannotCast = ReadonlyArray<{ name: string; cannot: readonly string[];
  presenceState?: { mode: "remote" | "partial"; via: string } }>;

/** What the writer sends when it wants a character's take: who, the situation as given to them, the question, and what shape of answer is wanted. */
export interface ConsultRequest {
  character: string;
  situation: string;
  question: string;
  wants: ConsultWants | "";
}

// -- WHAT A CONSULT MUST CONTAIN TO BE WORTH SENDING -----------------------
/** The four shapes of answer a consult can ask for, in the writer's closed vocabulary. */
export const CONSULT_WANTS = P.CONSULT_WANTS;
export type ConsultWants = (typeof CONSULT_WANTS)[number];

const WANTS_HINTS: [RegExp, ConsultWants][] = [
  [/\b(speech|speak|say|says|said|tell|tells|reply|replies|answer|answers|word|words|aloud)\b/i, "speech"],
  [/\b(decision|decide|decides|choose|chooses|choice|whether|refuse|refuses|agree|agrees|allow)\b/i, "decision"],
  [/\b(reaction|react|reacts|respond|responds)\b/i, "reaction"],
  [/\b(action|act|acts|do|does|doing|move|moves)\b/i, "action"],
];

/** Canonicalize the writer's `wants` to one of the four, or null when it carries no shape. */
export function canonWants(raw: unknown): ConsultWants | null {
  const v = String(raw ?? "").trim();
  if (!v) return null;
  const exact = CONSULT_WANTS.find(w => w === v.toLowerCase());
  if (exact) return exact;
  for (const [re, w] of WANTS_HINTS) if (re.test(v)) return w;
  return null;
}

const DEGENERATE_QUESTIONS = [
  /^what (do|does|will|would|should|is|are)\s+\S+(\s+\S+)?\s+(do|doing|going to do)\b/i,
  /^what happens?\b/i,
  /^what next\b/i,
  /^(your|their|his|her)\s+(move|turn|call)\b/i,
  // The vagueness dodge: with menus refused, the first live run under the gate sent "What do
  // you choose regarding the lock?" — "What do you do?" wearing a subject. A choose/decide
  // question with no cost named is the same shrug; a rare cost-bearing one ("...knowing he is
  // armed?") is refused once and rewritten, a cheap failure beside the step the dodge was
  // already burning.
  /^what do you (choose|decide)\b/i,
];

/** A question that carries both branches of its fork pre-written — "Do you concede, or do you double
 *  down?" — is answered by picking, and picking is all it leaves the character to do. The rule the
 *  evidence got, not a guess: the retained runs' writing logs hold 133 consult questions, 113 with
 *  " or ", and every one is a menu. One word-bounded "or" is the whole detector; anything finer
 *  ("or" followed by a verb, say) misses "or with Hale and Marsh (pull the lever now)". The
 *  character names the options; the writer names what hangs on the choice. */
const QUESTION_CARRIES_ANSWERS = /\bor\b/i;

const MIN_SITUATION_WORDS = 5;

// With no question, the situation is the entire ask, and the floor that was enough beside one is
// not enough alone: a five-word situation the question used to point into now points nowhere.
const MIN_OPEN_SITUATION_WORDS = 15;

/** The outcome of checking a proposed consult: sendable, or refused with a reason the writer can act on. */
export type ConsultCheck = { ok: true; req: ConsultRequest } | { ok: false; why: string };

/**
 * Which door a consult comes through. **open** is the writer's own ask — a situation and nothing
 * else; **directed** is the judge's escalation, which names a fork in words and must pass every
 * check a consult was held to before questions were withheld from characters.
 *
 * The question gates do not apply to a situation: a situation has no question grammar for
 * `DEGENERATE_QUESTIONS` to match, and `\bor\b` over descriptive prose flags "the heat or the
 * noise". What a situation must not do — pre-write the options — is a reading rather than a match,
 * and lives with the narration lint, which already reads the outgoing situation.
 */
export type ConsultMode = "open" | "directed";

/** Validate and canonicalize a consult before it is sent, so a bad one is refused instead of wasting a step.
 *
 *  With the cast given, the situation is also linted against the addressee's own CANNOT list — and,
 *  when the scene sets one, their presence: a "remote" addressee is refused a situation phrased
 *  around a sense their position rules out. The situation is the only author-side string that enters
 *  a character as ground truth, and one phrased around a sense they have lost would be received as
 *  fact. This runs here, not in the scene loop,
 *  so every situation-entry path passes the same door: the writer's first ask, the judge's `revised`
 *  on a retry (reviseConsult), and each reactor of a fan-out (normalizeReactionConsult). */
export function normalizeConsult(raw: {
  character: string; situation?: unknown; question?: unknown; wants?: unknown;
}, cast?: CannotCast,
   mode: ConsultMode = "open"): ConsultCheck {
  const character = String(raw.character ?? "").trim();
  const situation = String(raw.situation ?? "").trim();
  const question  = String(raw.question ?? "").trim();
  const words = situation.split(/\s+/).filter(Boolean).length;
  const floor = mode === "open" ? MIN_OPEN_SITUATION_WORDS : MIN_SITUATION_WORDS;

  if (!situation)
    return { ok: false, why: P.badConsult.emptySituation(character) };
  if (words < floor)
    return { ok: false, why: mode === "open"
      ? P.badConsult.thinOpenSituation(character, words, floor)
      : P.badConsult.shortSituation(character, words) };

  let wants: ConsultWants | "" = "";
  if (mode === "directed") {
    if (!question)
      return { ok: false, why: P.badConsult.noQuestion(character) };
    if (DEGENERATE_QUESTIONS.some(re => re.test(question)))
      return { ok: false, why: P.badConsult.degenerate(question) };
    if (QUESTION_CARRIES_ANSWERS.test(question))
      return { ok: false, why: P.badConsult.carriesAnswers(question) };
    // "wants" is inert: the judge no longer names an output shape, so whatever arrives (or does
    // not) is carried as a record, never a requirement. A hallucinated wants must not silently
    // reinstate the shape-dictation the retry rules removed.
    wants = canonWants(raw.wants) ?? "";
  }

  const member = cast?.find(c => sameName(c.name, character));
  if (member && (member.cannot?.length || member.presenceState?.mode === "remote")) {
    const hit = lintRestrictedSituation(situation, character, member.cannot ?? [], member.presenceState);
    if (hit) {
      return { ok: false, why: hit.cause === "presence"
        ? P.badConsult.restrictedByPresence(character, hit.sense, hit.match, member.presenceState!.via)
        : P.badConsult.restrictedSense(character, hit.sense, hit.match) };
    }
  }

  return { ok: true, req: { character, situation, question: mode === "open" ? "" : question, wants } };
}

/** The outcome of checking a reaction fan-out: one sendable request per reactor, or a single refusal. */
export type ReactionCheck = { ok: true; reqs: ConsultRequest[] } | { ok: false; why: string };

/**
 * Validate a reaction fan-out: a shared situation/question asked of several reactors at once. Each
 * reactor resolves to an ordinary `ConsultRequest` through `normalizeConsult`'s gate, so a reactor
 * with too thin a situation is refused just as a lone consult would be. A per-reactor `situation`
 * overrides the shared one (someone who only heard it).
 *
 * A name listed twice is a slip, not a second character — the fan-out asks one shared moment, and
 * asking it twice would let the second answer see the first — so duplicates collapse
 * case-insensitively and the first wins, keeping its own per-reactor situation. Refusing the whole
 * fan-out over one duplicated name would punish every reactor for it.
 *
 * With the cast given, the gate is strict per reactor: the shared situation is ground truth for
 * everyone present, so it is checked against EACH reactor's CANNOT list, and a per-reactor
 * override is checked against its owner only. One restricted reactor turns the whole fan-out back.
 */
export function normalizeReactionConsult(raw: {
  reactors?: unknown; situation?: unknown; question?: unknown;
}, cast?: CannotCast): ReactionCheck {
  const shared = String(raw.situation ?? "").trim();
  const list = Array.isArray(raw.reactors) ? raw.reactors : [];
  if (!list.length) return { ok: false, why: P.badReaction.noReactors() };

  const reqs: ConsultRequest[] = [];
  const seen = new Set<string>();
  for (const r of list) {
    const name = String((r as any)?.name ?? (typeof r === "string" ? r : "")).trim();
    if (!name) return { ok: false, why: P.badReaction.namelessReactor() };
    if (seen.has(nameKey(name))) continue;
    seen.add(nameKey(name));
    const situation = String((r as any)?.situation ?? "").trim() || shared;
    // A fan-out is the several-at-once form of the writer's own ask, so it comes through the same
    // open door: one shared situation, no question, and no `wants` — what the moment lands on them
    // as is what a shared moment asks for without being told to.
    const check = normalizeConsult({ character: name, situation }, cast, "open");
    if (!check.ok) return { ok: false, why: check.why };
    reqs.push(check.req);
  }
  return { ok: true, reqs };
}

/** A checked revision, plus the shape the judge asked for and did not get ("" when it kept it). */
export type Revision =
  | { ok: true; req: ConsultRequest; wantsRefused: string }
  | { ok: false; why: string };

/**
 * The judge's `revised` folded over the request it replaces, and checked by exactly the same gate a
 * first consult goes through — a field the judge left out keeps its previous value.
 *
 * `wants` is inert — carried, never changed: the judge names no output shape, so there is no shape
 * to reframe and no drift to record. `wantsRefused` survives on the type as always-"" so the run
 * record stays structurally comparable across branches.
 *
 * The cast, when given, travels with it: the judge's `revised.situation` passes the same CANNOT
 * gate the first ask did.
 */
export function reviseConsult(prev: ConsultRequest, rev: Record<string, unknown>,
  cast?: CannotCast): Revision {
  // An open beat carries no question, so a judge retrying one is escalating: it may name the
  // contradiction in words for the first time. Once named the record holds — a revision that drops
  // the question again would decay an escalated ask back into an open beat. Every
  // revision is checked as directed whichever it was, so an ask that has been escalated can never
  // decay back into an open beat by omitting the fields again.
  const checked = normalizeConsult({
    character: prev.character,
    situation: String(rev.situation ?? "").trim() || prev.situation,
    question: String(rev.question ?? "").trim() || prev.question,
    wants: prev.wants,
  }, cast, "directed");
  if (!checked.ok) return checked;
  // The character is shown the situation and not the question, so a revision that sharpens the
  // wording of the fork and leaves the situation alone re-sends a fresh instance the byte-identical
  // message the last one just answered. Prompting against it did not hold — the first live run
  // under the withheld question produced two retries, both re-asking an unchanged situation, one
  // with an unchanged question as well. Refusing here costs the attempt nothing and keeps the
  // answer already in hand, which is what the caller does with every other unusable revision.
  if (checked.req.situation.trim() === prev.situation.trim())
    return { ok: false, why: P.badConsult.noNewSituation() };
  return { ok: true, req: checked.req, wantsRefused: "" };
}
/**
 * The only shape floor left now that the judge names no output shape: a thought from outside the
 * POV reaches the writer as nothing — the scene never receives it — so an answer with neither
 * speech nor action from a non-POV character is refused. Reported as "reaction" because that is
 * the repair the character needs: let it reach the outside.
 *
 * Everything else the old wants-keyed check refused is now accepted on purpose: an answer that
 * departs from what was wanted but breaks nothing established is valid, and a character reaching
 * outside a listed skill (but not through a CANNOT) is the autonomous behaviour working, not a
 * shape violation. Keeping the old branches would let a hallucinated wants silently reinstate the
 * exact shape-dictation this design removes, even though nothing prompts for it any more.
 *
 * `pov` defaults true, so a caller that does not know whose scene this is asks for nothing more.
 */
export function nonPovThoughtOnly(
  r: { speech: string; action: string }, pov = true,
): "reaction" | null {
  if (!pov && !r.speech && !r.action) return "reaction";
  return null;
}

// -- READING WHAT THE AUTHOR-SIDE AGENTS SEND BACK -------------------------
// Both return null for "that is not this kind of reply at all", which is the caller's cue to ask
// once more rather than to quietly take a default.

/** The judge's verdict, or null when the reply carries no verdict — it answered in another shape. */
export function parseVerdict(o: Record<string, unknown>): "accept" | "retry" | null {
  if (!("verdict" in o)) return null;
  const v = String(o.verdict ?? "").trim().toLowerCase();
  if (!v) return null;
  return v === "retry" ? "retry" : "accept";
}

/**
 * The narration lint's verdict, or null when the reply carries none — `{}`, `{"ok":"maybe"}`, an
 * unrelated shape. Only an explicit pass is a pass: reading a missing field as `ok` is how a check
 * comes to be performed without ever being made.
 */
export function parseLintVerdict(o: Record<string, unknown>): { ok: boolean; why: string } | null {
  if (!("ok" in o)) return null;
  if (o.ok === true) return { ok: true, why: "" };
  if (o.ok === false) return { ok: false, why: String(o.why ?? "").trim() };
  const v = String(o.ok ?? "").trim().toLowerCase();
  if (v === "true") return { ok: true, why: "" };
  if (v === "false") return { ok: false, why: String(o.why ?? "").trim() };
  return null;
}

/** The clarifier's answer — "" when it answered with nothing, null when it did not answer at all. */
export function parseClarifyAnswer(o: Record<string, unknown>): string | null {
  return "answer" in o ? String(o.answer ?? "").trim() : null;
}

/**
 * The batch judge's per-reactor verdicts, keyed by lowercased name → promotable. A reactor the judge
 * omits, or a malformed reply, yields no entry — the caller reads a missing entry as "not
 * promotable", so a volunteered deed lapses safely rather than reaching the page unchecked.
 */
export function parseBatchVerdict(o: Record<string, unknown>): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const arr = Array.isArray(o.verdicts) ? o.verdicts : [];
  for (const v of arr) {
    const name = nameKey(String((v as any)?.name ?? ""));
    if (!name) continue;
    const p = (v as any)?.promotable;
    out.set(name, p === true || String(p).trim().toLowerCase() === "true");
  }
  return out;
}

/** A character's answer: what they thought/said/did, and any clarification trail. */
export interface ConsultReply {
  character: string;
  thought: string; speech: string; action: string; note: string;
  clarifications: { question: string; answer: string }[];
  forced: boolean;                                       // ran out of clarifications and answered anyway
  raw: string;
}
/** Everything a consult can report to the run log, as one tagged event each. */
export type ConsultEvent =
  | { t: "consult"; character: string; situation: string; question: string; wants: string; attempt: number }
  | { t: "need"; character: string; question: string }
  | { t: "clarify"; character: string; question: string; answer: string }
  | { t: "clarify_failed"; character: string; question: string }
  | { t: "prose_reply"; character: string }
  | { t: "forced"; character: string }
  | { t: "repair"; character: string; why: string }
  | { t: "answer"; character: string; thought: string; speech: string; action: string;
      note: string };

/** How the caller answers a character's request for a missing fact. `null` means the call to answer
 *  it never came back — unreachable, not "answered with nothing" — and costs no clarification slot. */
export type Clarifier = (question: string, req: ConsultRequest) => Promise<string | null>;

/** Run one consult against a character agent: clarify, repair and answer within the given budget. */
export async function consult(
  agent: Agent, req: ConsultRequest,
  opts: { clarifications: number; clarify: Clarifier; attempt?: number; pov?: boolean;
          log?: (e: ConsultEvent) => void },
): Promise<ConsultReply> {
  const log = opts.log ?? (() => {});
  const pov = opts.pov ?? true;
  const extra: Msg[] = [{ role: "user", content: P.askBlock(req, opts.attempt ?? 1, pov) }];
  const clarifications: { question: string; answer: string }[] = [];
  let forced = false, repaired = false;

  log({ t: "consult", character: req.character, situation: req.situation, question: req.question,
        wants: req.wants, attempt: opts.attempt ?? 1 });

  for (;;) {
    const raw = await agent.generate(`${C.cyan}${agent.name}${C.reset}`, "character.consult", extra);
    const o = extractJson(raw, how => {
      if (how === "prose_fallback")
        log({ t: "prose_reply", character: req.character });
    });
    const need = String(o.need ?? "").trim();

    // -- the character wants a fact it was not given
    if (need) {
    // `!forced` gates this branch too: a clarifier that came back null has already moved the
    // consult onto the forced/repaired ladder, and is not tried again for the same character just
    // because budget remains — an unreachable clarifier stays unreachable.
      if (!forced && clarifications.length < opts.clarifications) {
        log({ t: "need", character: req.character, question: need });
        const answer = await opts.clarify(need, req);
        if (answer === null) {
          forced = true;
          log({ t: "clarify_failed", character: req.character, question: need });
          extra.push({ role: "assistant", content: JSON.stringify({ need }) },
                     { role: "user", content: P.AUTHOR_DONE_ANSWERING });
          continue;
        }
        const trimmed = answer.trim() || "(no answer)";
        clarifications.push({ question: need, answer: trimmed });
        log({ t: "clarify", character: req.character, question: need, answer: trimmed });
        extra.push({ role: "assistant", content: JSON.stringify({ need }) },
                   { role: "user", content: P.authorAnswers(trimmed) });
        continue;
      }
      // An author who has stopped answering is a fact about the situation, not a reason to stall.
      if (!forced) {
        forced = true;
        log({ t: "forced", character: req.character });
        extra.push({ role: "assistant", content: JSON.stringify({ need }) },
                   { role: "user", content: P.AUTHOR_DONE_ANSWERING });
        continue;
      }
      if (!repaired) {
        repaired = true;
        log({ t: "repair", character: req.character, why: "asked again after being told no more detail is coming" });
        extra.push({ role: "assistant", content: JSON.stringify({ need }) },
                   { role: "user", content: P.ANSWER_NOW });
        continue;
      }
      const stalled: ConsultReply = {
        character: req.character, thought: "", speech: "", action: "",
        note: `did not answer; kept asking: ${need}`,
        clarifications, forced: true, raw,
      };
      log({ t: "answer", character: req.character, thought: "", speech: "", action: "",
            note: stalled.note });
      return stalled;
    }

    const thought = String(o.thought ?? "").trim();
    const speech  = String(o.speech ?? "").trim();
    const action  = String(o.action ?? "").trim();
    const note    = String(o.note ?? "").trim();
    const shortOf = nonPovThoughtOnly({ speech, action }, pov);
    const why = !thought && !speech && !action ? "returned nothing usable"
              : shortOf ? "kept it behind their eyes, where the room could not catch it"
              : "";
    if (why && !repaired) {
      repaired = true;
      log({ t: "repair", character: req.character, why });
      extra.push({ role: "assistant", content: raw.trim() },
                 { role: "user", content: shortOf ? P.shapeCheck(shortOf) : P.EMPTY_REPLY });
      continue;
    }

    const reply: ConsultReply = {
      character: req.character, thought, speech, action, note,
      clarifications, forced, raw,
    };
    log({ t: "answer", character: req.character, thought, speech, action, note });
    return reply;
  }
}
