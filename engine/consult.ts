/** CONSULT — the writer<->character protocol: what a consult must contain, and running one. */
import * as P from "../prompts.ts";
import { C } from "../ansi.ts";
import { type Agent } from "./agent.ts";
import { extractJson } from "./json-extract.ts";
import { type Msg } from "./llm-client.ts";
import { lintRestrictedSituation } from "./sense-lint.ts";

/** The cast shape the consult gate needs: each character's resolved CANNOT list, so a situation can
 *  be checked against its addressee. Scene-loop already resolves exactly this for the narration lint. */
export type CannotCast = ReadonlyArray<{ name: string; cannot: readonly string[] }>;

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
  // The vagueness dodge: with the menu refused, the first live run under the gate sent "What do
  // you choose regarding the lock?" and "What do you decide to do with the current snag?" --
  // "What do you do?" wearing a subject. A choose/decide question with no cost named is the same
  // shrug; a rare cost-bearing one ("...knowing he is armed?") is refused once and rewritten,
  // which is the cheap failure beside the step the dodge was already burning.
  /^what do you (choose|decide)\b/i,
];

/** A question that carries both branches of its fork pre-written — "Do you concede, or do you double
 *  down?" — is answered by picking, and picking is all it leaves the character to do: nothing to ask
 *  for, no third way to reach for. This is the rule the evidence got, not a guess: every retained
 *  run's writing-log holds 133 consult questions, 113 of them carrying " or ", and reading them,
 *  every one is a menu. One word-bounded "or" is the whole detector; anything finer ("or" followed
 *  by a verb, say) misses "or with Hale and Marsh (pull the lever now)". The character names the
 *  options; the writer names what hangs on the choice. */
const QUESTION_CARRIES_ANSWERS = /\bor\b/i;

const MIN_SITUATION_WORDS = 5;

/** The outcome of checking a proposed consult: sendable, or refused with a reason the writer can act on. */
export type ConsultCheck = { ok: true; req: ConsultRequest } | { ok: false; why: string };

/** Validate and canonicalize a consult before it is sent, so a bad one is refused instead of wasting a step.
 *
 *  When the cast is given, the situation is also linted against the addressee's own CANNOT list: the
 *  situation is the only author-side string that enters a character as ground truth, and one phrased
 *  around a sense they have lost would be received as fact. This runs here — not in the scene loop —
 *  so every situation-entry path passes the same door: the writer's first ask, the judge's `revised`
 *  on a retry (reviseConsult), and each reactor of a fan-out (normalizeReactionConsult). */
export function normalizeConsult(raw: {
  character: string; situation?: unknown; question?: unknown; wants?: unknown;
}, cast?: ReadonlyArray<{ name: string; cannot: readonly string[] }>): ConsultCheck {
  const character = String(raw.character ?? "").trim();
  const situation = String(raw.situation ?? "").trim();
  const question  = String(raw.question ?? "").trim();
  const words = situation.split(/\s+/).filter(Boolean).length;

  if (!situation)
    return { ok: false, why: P.badConsult.emptySituation(character) };
  if (words < MIN_SITUATION_WORDS)
    return { ok: false, why: P.badConsult.shortSituation(character, words) };
  if (!question)
    return { ok: false, why: P.badConsult.noQuestion(character) };
  if (DEGENERATE_QUESTIONS.some(re => re.test(question)))
    return { ok: false, why: P.badConsult.degenerate(question) };
  if (QUESTION_CARRIES_ANSWERS.test(question))
    return { ok: false, why: P.badConsult.carriesAnswers(question) };

  const wants = canonWants(raw.wants);
  if (!wants)
    return { ok: false, why: P.badConsult.badWants(CONSULT_WANTS, String(raw.wants ?? "")) };

  const member = cast?.find(c => c.name.trim().toLowerCase() === character.toLowerCase());
  if (member?.cannot?.length) {
    const hit = lintRestrictedSituation(situation, character, member.cannot);
    if (hit)
      return { ok: false, why: P.badConsult.restrictedSense(character, hit.sense, hit.match) };
  }

  return { ok: true, req: { character, situation, question, wants } };
}

/** The outcome of checking a reaction fan-out: one sendable request per reactor, or a single refusal. */
export type ReactionCheck = { ok: true; reqs: ConsultRequest[] } | { ok: false; why: string };

/**
 * Validate a reaction fan-out: a shared situation/question asked of several reactors at once. Each
 * reactor resolves to an ordinary `ConsultRequest` — reusing `normalizeConsult`'s gate per reactor,
 * with `wants` pinned to "reaction" — so a reactor with too thin a situation is refused just as a
 * lone consult would be. A per-reactor `situation` overrides the shared one (someone who only heard it).
 *
 * A name listed twice is a slip, not a second character — the fan-out asks one shared moment, and
 * asking it twice would let the second answer see the first — so entries collapse
 * case-insensitively and the first wins, keeping its own per-reactor situation. Refusing the whole
 * fan-out over one duplicated name would punish every reactor for it.
 *
 * With the cast given, the gate is strict per reactor: the shared situation is ground truth for
 * everyone present, so it is checked against EACH reactor's CANNOT list through the per-reactor
 * `normalizeConsult` call, and a per-reactor override is checked against its owner only. One
 * restricted reactor phrased around turns the whole fan-out back.
 */
export function normalizeReactionConsult(raw: {
  reactors?: unknown; situation?: unknown; question?: unknown;
}, cast?: CannotCast): ReactionCheck {
  const shared = String(raw.situation ?? "").trim();
  const question = String(raw.question ?? "").trim();
  const list = Array.isArray(raw.reactors) ? raw.reactors : [];
  if (!list.length) return { ok: false, why: P.badReaction.noReactors() };

  const reqs: ConsultRequest[] = [];
  const seen = new Set<string>();
  for (const r of list) {
    const name = String((r as any)?.name ?? (typeof r === "string" ? r : "")).trim();
    if (!name) return { ok: false, why: P.badReaction.namelessReactor() };
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const situation = String((r as any)?.situation ?? "").trim() || shared;
    const check = normalizeConsult({ character: name, situation, question, wants: "reaction" }, cast);
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
 * A revision used to skip the check entirely, which is how a re-ask of "What do you do?" reached a
 * character that the front door had already refused.
 *
 * `wants` is pinned to the original. The judge may reframe a fork it asked badly; it may not turn one
 * fork into another, and the shape asked for is what makes a fork the fork it is — "which way do you
 * go" and "what do you say about it" are different moments in the scene. The judge's own instructions
 * already say as much (a missing fact is fixed in the SITUATION, and an answer is never retried for
 * being inconvenient), so a changed `wants` is drift to record rather than an instruction to honor.
 * Nothing here can tell whether a rewritten *question* is still the same fork — that judgement needs
 * a model, and the model that would make it is the one being checked — so the run record carries what
 * each retry replaced, and reading it is the check.
 *
 * The cast, when given, travels with it: the judge's `revised.situation` is a situation-entry path
 * like any other — it reaches a fresh instance that has no way to know better — so it passes the
 * same CANNOT gate the first ask did.
 */
export function reviseConsult(prev: ConsultRequest, rev: Record<string, unknown>,
  cast?: CannotCast): Revision {
  const asked = canonWants(rev.wants);
  const checked = normalizeConsult({
    character: prev.character,
    situation: String(rev.situation ?? "").trim() || prev.situation,
    question: String(rev.question ?? "").trim() || prev.question,
    wants: prev.wants,
  }, cast);
  if (!checked.ok) return checked;
  return { ok: true, req: checked.req, wantsRefused: asked && asked !== prev.wants ? asked : "" };
}
/**
 * What the asked-for shape requires the reply to actually carry, or null when the reply satisfies it.
 *
 * `reaction` is the one shape a thought alone answers — it asks what something lands on them as, and
 * that happens behind the eyes. Every other shape asks for something that reaches the page, and a
 * thought on its own leaves the scene exactly where it was: an answer in form, nothing in substance.
 */
export function missingShape(
  wants: ConsultWants | "", r: { speech: string; action: string },
): ConsultWants | null {
  if (wants === "speech" && !r.speech) return "speech";
  if (wants === "action" && !r.action) return "action";
  if (wants === "decision" && !r.speech && !r.action) return "decision";
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
 * unrelated shape. Only an explicit pass is a pass: a reply the lint never made cannot clear a piece,
 * and reading a missing field as `ok` is how a check comes to be performed without ever being made.
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
 * omits, or a malformed reply, yields no entry — the caller reads a missing entry as "not promotable",
 * so a volunteered deed lapses safely rather than reaching the page unchecked.
 */
export function parseBatchVerdict(o: Record<string, unknown>): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const arr = Array.isArray(o.verdicts) ? o.verdicts : [];
  for (const v of arr) {
    const name = String((v as any)?.name ?? "").trim().toLowerCase();
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
  opts: { clarifications: number; clarify: Clarifier; attempt?: number; log?: (e: ConsultEvent) => void },
): Promise<ConsultReply> {
  const log = opts.log ?? (() => {});
  const extra: Msg[] = [{ role: "user", content: P.askBlock(req, opts.attempt ?? 1) }];
  const clarifications: { question: string; answer: string }[] = [];
  let forced = false, repaired = false;

  log({ t: "consult", character: req.character, situation: req.situation, question: req.question,
        wants: req.wants, attempt: opts.attempt ?? 1 });

  for (;;) {
    const raw = await agent.generate(`${C.cyan}${agent.name}${C.reset}`, extra);
    const o = extractJson(raw, how => {
      if (how === "prose_fallback")
        log({ t: "prose_reply", character: req.character });
    });
    const need = String(o.need ?? "").trim();

    // -- the character wants a fact it was not given
    if (need) {
      // `!forced` gates this branch too: a clarifier that came back null has already moved the
      // consult onto the forced/repaired ladder, and must not be tried again for the same character
      // just because the budget was never spent — an unreachable clarifier stays unreachable.
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
    const shortOf = missingShape(req.wants, { speech, action });
    const why = !thought && !speech && !action ? "returned nothing usable"
              : shortOf ? `was asked for ${shortOf} and gave none`
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
