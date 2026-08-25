/** CONSULT — the writer<->character protocol: what a consult must contain, and running one. */
import * as P from "../prompts.ts";
import { C } from "../ansi.ts";
import { type Agent } from "./agent.ts";
import { canonSkill, type Skill } from "./skills.ts";
import { extractJson } from "./json-extract.ts";
import { type Msg } from "./llm-client.ts";

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
];

const MIN_SITUATION_WORDS = 5;

/** The outcome of checking a proposed consult: sendable, or refused with a reason the writer can act on. */
export type ConsultCheck = { ok: true; req: ConsultRequest } | { ok: false; why: string };

/** Validate and canonicalize a consult before it is sent, so a bad one is refused instead of wasting a step. */
export function normalizeConsult(raw: {
  character: string; situation?: unknown; question?: unknown; wants?: unknown;
}): ConsultCheck {
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

  const wants = canonWants(raw.wants);
  if (!wants)
    return { ok: false, why: P.badConsult.badWants(CONSULT_WANTS, String(raw.wants ?? "")) };

  return { ok: true, req: { character, situation, question, wants } };
}

/** The outcome of checking a reaction fan-out: one sendable request per reactor, or a single refusal. */
export type ReactionCheck = { ok: true; reqs: ConsultRequest[] } | { ok: false; why: string };

/**
 * Validate a reaction fan-out: a shared situation/question asked of several reactors at once. Each
 * reactor resolves to an ordinary `ConsultRequest` — reusing `normalizeConsult`'s gate per reactor,
 * with `wants` pinned to "reaction" — so a reactor with too thin a situation is refused just as a
 * lone consult would be. A per-reactor `situation` overrides the shared one (someone who only heard it).
 */
export function normalizeReactionConsult(raw: {
  reactors?: unknown; situation?: unknown; question?: unknown;
}): ReactionCheck {
  const shared = String(raw.situation ?? "").trim();
  const question = String(raw.question ?? "").trim();
  const list = Array.isArray(raw.reactors) ? raw.reactors : [];
  if (!list.length) return { ok: false, why: P.badReaction.noReactors() };

  const reqs: ConsultRequest[] = [];
  for (const r of list) {
    const name = String((r as any)?.name ?? (typeof r === "string" ? r : "")).trim();
    if (!name) return { ok: false, why: P.badReaction.namelessReactor() };
    const situation = String((r as any)?.situation ?? "").trim() || shared;
    const check = normalizeConsult({ character: name, situation, question, wants: "reaction" });
    if (!check.ok) return { ok: false, why: check.why };
    reqs.push(check.req);
  }
  return { ok: true, reqs };
}

/**
 * The judge's `revised` folded over the request it replaces, and checked by exactly the same gate a
 * first consult goes through — a field the judge left out keeps its previous value.
 *
 * A revision used to skip the check entirely, which is how a re-ask of "What do you do?" reached a
 * character that the front door had already refused.
 */
export function reviseConsult(prev: ConsultRequest, rev: Record<string, unknown>): ConsultCheck {
  return normalizeConsult({
    character: prev.character,
    situation: String(rev.situation ?? "").trim() || prev.situation,
    question: String(rev.question ?? "").trim() || prev.question,
    wants: canonWants(rev.wants) ?? prev.wants,
  });
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

/** A character's answer: what they thought/said/did, what they claimed to use, and any clarification trail. */
export interface ConsultReply {
  character: string;
  thought: string; speech: string; action: string; note: string;
  skillsUsed: string[];
  unverified: string[];                                  // claimed skills this character does not have
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
  | { t: "skill_flag"; character: string; claimed: string[]; unknown: string[] }
  | { t: "answer"; character: string; thought: string; speech: string; action: string;
      note: string; skills_used: string[]; unverified: string[] };

/** How the caller answers a character's request for a missing fact. `null` means the call to answer
 *  it never came back — unreachable, not "answered with nothing" — and costs no clarification slot. */
export type Clarifier = (question: string, req: ConsultRequest) => Promise<string | null>;

const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean)
  : typeof v === "string" ? v.split(/[,;|]/).map(s => s.trim()).filter(Boolean)
  : [];

/** Run one consult against a character agent: clarify, repair and answer within the given budget. */
export async function consult(
  agent: Agent, req: ConsultRequest, skills: Skill[],
  opts: { clarifications: number; clarify: Clarifier; attempt?: number; log?: (e: ConsultEvent) => void },
): Promise<ConsultReply> {
  const log = opts.log ?? (() => {});
  const have = new Map(skills.map(s => [canonSkill(s.name), s.name]));
  const extra: Msg[] = [{ role: "user", content: P.askBlock(req) }];
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
        skillsUsed: [], unverified: [], clarifications, forced: true, raw,
      };
      log({ t: "answer", character: req.character, thought: "", speech: "", action: "",
            note: stalled.note, skills_used: [], unverified: [] });
      return stalled;
    }

    const thought = String(o.thought ?? "").trim();
    const speech  = String(o.speech ?? "").trim();
    const action  = String(o.action ?? "").trim();
    const note    = String(o.note ?? "").trim();
    const claimed = asList(o.skills_used);
    const unknown = claimed.filter(s => !have.has(canonSkill(s)));
    const shortOf = missingShape(req.wants, { speech, action });
    const why = !thought && !speech && !action ? "returned nothing usable"
              : unknown.length ? `used ${unknown.map(s => `"${s}"`).join(", ")}`
              : shortOf ? `was asked for ${shortOf} and gave none`
              : "";
    if (why && !repaired) {
      repaired = true;
      log({ t: "repair", character: req.character, why });
      extra.push({ role: "assistant", content: raw.trim() },
                 { role: "user", content: unknown.length
                   ? P.skillCheck(unknown, [...have.values()])
                   : shortOf ? P.shapeCheck(shortOf)
                   : P.EMPTY_REPLY });
      continue;
    }

    if (unknown.length) log({ t: "skill_flag", character: req.character, claimed, unknown });

    const reply: ConsultReply = {
      character: req.character, thought, speech, action, note,
      skillsUsed: claimed, unverified: unknown, clarifications, forced, raw,
    };
    log({ t: "answer", character: req.character, thought, speech, action, note,
          skills_used: claimed, unverified: unknown });
    return reply;
  }
}
