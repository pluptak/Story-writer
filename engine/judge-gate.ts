/** JUDGE GATE — the attempt cycle around one ask: consult the character, judge the answer, and on a
 *  retry verdict re-ask a fresh fork of the agent, until an accept, the attempt budget, or a retry
 *  ceiling stops it. Extracted from writeScene unchanged; the caller folds in only the outcome. */
import * as P from "../prompts.ts";
import { C } from "../ansi.ts";
import { type Agent } from "./agent.ts";
import { extractJson } from "./json-extract.ts";
import {
  consult, parseVerdict, reviseConsult,
  type CannotCast, type ConsultEvent, type ConsultReply, type ConsultRequest, type Clarifier,
} from "./consult.ts";
import { type Msg } from "./llm-client.ts";
import type { CharacterDef } from "./story-format.ts";
import { nameKey } from "./config-util.ts";

/** Everything the gate can report, as one tagged event each — the consult's own events plus the
 *  RunEvent members the gate itself emits, declared here so this module needs no scene-loop import. */
export type GateEvent =
  | ConsultEvent
  | { t: "schema_mismatch"; call: "judge"; character: string; chapter: number }
  | { t: "judge_failed"; character: string; why: string; chapter: number }
  | { t: "judge"; character: string; verdict: string; note: string; attempt: number; chapter: number }
  | { t: "bad_consult"; character: string; why: string; chapter: number }
  | { t: "retry_capped"; character: string; count: number; chapter: number }
  | { t: "retry"; character: string; attempt: number; situation: string; question: string;
      was: string; wantsRefused: string; chapter: number };

export interface JudgeGateOpts {
  def: CharacterDef;
  /** The character's persistent agent; attempt 1 uses it directly, later attempts a fork. */
  agent: Agent;
  req: ConsultRequest;
  cast: CannotCast;
  retries: number;
  maxCharacterRetries?: number;
  clarifications: number;
  clarify: Clarifier;
  pov: boolean;
  chapter: number;
  /** Chapter-wide retry tally, keyed by lowercased name — mutated as retries are spent. */
  retryCounts: Map<string, number>;
  newJudge: () => Agent;
  /** Marks the clarifier (and the attempt's clarifications) before each attempt, and unwinds them
   *  when an attempt is abandoned for a retry — the caller owns that ledger. */
  beginAttempt: () => void;
  dropClarifications: () => void;
  log: (e: GateEvent) => void;
}

/** How the cycle ended: the answer in hand (the last reply, even on a spent budget or unusable
 *  revision), the transport failure message if the consult call itself died, which attempt ran
 *  last, and the request as it finally stood. */
export interface JudgeGateResult {
  reply: ConsultReply | null;
  failed: string;
  usedAttempt: number;
  req: ConsultRequest;
}

/** Run one ask through the gate. */
export async function judgeGate(o: JudgeGateOpts): Promise<JudgeGateResult> {
  const { def, log, chapter } = o;
  let req = o.req;
  let reply: ConsultReply | null = null;
  let usedAttempt = 1;
  let failed = "";

  for (let attempt = 1; ; attempt++) {
    usedAttempt = attempt;
    const agent = attempt === 1 ? o.agent : o.agent.fork();
    o.beginAttempt();
    try {
      reply = await consult(agent, req, {
        clarifications: o.clarifications, attempt, log, clarify: o.clarify, pov: o.pov });
    } catch (e) {
      failed = (e as Error).message;
      break;
    }

    const flags = P.answerFlags(reply);
    let judgeReply: Record<string, any> = {};
    let judged: "accept" | "retry" | null = null;
    const judge = o.newJudge();
    const judgeExtra: Msg[] = [{
      role: "user",
      content: P.judgeRequest({
        name: def.name, situation: req.situation, question: req.question, wants: req.wants,
        thought: reply.thought, speech: reply.speech, action: reply.action, note: reply.note,
        flags, pov: o.pov,
      }),
    }];
    try {
      for (let tries = 0; ; tries++) {
        const judgeRaw = await judge.generate(`${C.magenta}JUDGE${C.reset}`, "judge.answer", judgeExtra);
        judgeReply = extractJson(judgeRaw);
        judged = parseVerdict(judgeReply);
        if (judged || tries) break;
        log({ t: "schema_mismatch", call: "judge", character: def.name, chapter });
        judgeExtra.push({ role: "assistant", content: judgeRaw.trim() },
                        { role: "user", content: P.VERDICT_ONLY });
      }
    } catch (e) {
      log({ t: "judge_failed", character: def.name, why: (e as Error).message, chapter });
      console.log(`${C.red}(judge call failed: ${(e as Error).message} — accepting)${C.reset}`);
    }
    // A reply that never carried a verdict is not a judgement; taking "accept" is the fallback,
    // not the reading, and `schema_mismatch` is what says so in the log.
    const verdict = judged ?? "accept";
    const note = String(judgeReply.note ?? "").trim();
    log({ t: "judge", character: def.name, verdict, note, attempt, chapter });

    const effectiveCeiling = def.maxRetries ?? o.maxCharacterRetries;
    const cumulative = o.retryCounts.get(nameKey(def.name)) ?? 0;

    if (verdict === "accept" || attempt > o.retries || (effectiveCeiling !== undefined && cumulative >= effectiveCeiling)) {
      if (verdict === "retry" && effectiveCeiling !== undefined && cumulative >= effectiveCeiling) {
        console.log(`${C.dim}(chapter-wide retry ceiling hit for ${def.name} — force-accepting)${C.reset}`);
        if (cumulative === effectiveCeiling) {
          log({ t: "retry_capped", character: def.name, count: cumulative, chapter });
        }
      } else if (verdict === "retry") {
        console.log(`${C.dim}(retries spent — taking ${def.name}'s last answer)${C.reset}`);
      }
      break;
    }
    // A revision goes through the same gate as the first ask. It used to skip the check,
    // which is how a re-ask of "What do you do?" — refused at the front door — reached a
    // character anyway and drew the do-nothing answer the guard exists to prevent.
    const rev = (judgeReply.revised && typeof judgeReply.revised === "object")
      ? judgeReply.revised as Record<string, unknown> : {};
    const revised = reviseConsult(req, rev, o.cast);
    if (!revised.ok) {
      // Asking again with a question that cannot be sent would spend the attempt on nothing,
      // so the answer already in hand is the one the scene gets.
      log({ t: "bad_consult", character: def.name, why: revised.why, chapter });
      console.log(`${C.yellow}(${def.name}'s re-ask was not usable — ${revised.why.split(". ")[0]}. `
        + `Keeping the answer.)${C.reset}`);
      break;
    }
    // The attempt is abandoned here, and everything it settled goes with it.
    o.dropClarifications();
    o.retryCounts.set(nameKey(def.name), cumulative + 1);
    const wasAsked = req.question;
    req = revised.req;
    console.log(`${C.yellow}retry ${attempt}/${o.retries} — ${def.name}${C.reset}${note ? ` ${C.dim}(${note})${C.reset}` : ""}`);
    if (revised.wantsRefused) {
      console.log(`${C.yellow}(the judge asked to make that a ${revised.wantsRefused} question — `
        + `kept as ${req.wants})${C.reset}`);
    }
    // `was` is the whole drift record: a judge that answers an inconvenient reply by asking a
    // different question is visible here and nowhere else.
    log({ t: "retry", character: def.name, attempt, situation: req.situation,
          question: req.question, was: wasAsked, wantsRefused: revised.wantsRefused, chapter });
  }

  return { reply, failed, usedAttempt, req };
}
