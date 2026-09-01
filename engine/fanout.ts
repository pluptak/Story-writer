/** FANOUT — the reaction fan-out: one shared beat, several present-but-not-acting characters react
 *  at once. Each runs an isolated consult (never seeing another's reply); the writer gets them
 *  together in one bundle, and one batch judge decides which volunteered deeds are promotable.
 *  Extracted from writeScene unchanged; the caller owns the ledgers the fan-out appends to. */
import * as P from "../prompts.ts";
import { C } from "../ansi.ts";
import { type Agent } from "./agent.ts";
import { extractJson } from "./json-extract.ts";
import {
  consult, normalizeReactionConsult, parseBatchVerdict,
  type ConsultEvent, type Clarifier,
} from "./consult.ts";
import { type Msg } from "./llm-client.ts";
import type { CharacterDef } from "./story-format.ts";
import { ENGINE } from "./engine-state.ts";
import { nameKey } from "./config-util.ts";

/** Everything the fan-out can report, as one tagged event each — the consult's own events plus the
 *  RunEvent members it emits, declared here so this module needs no scene-loop import. */
export type FanoutEvent =
  | ConsultEvent
  | { t: "bad_consult"; character: string; why: string; chapter: number }
  | { t: "reaction_fanout"; reactors: string[]; situation: string; chapter: number }
  | { t: "fanout_skip"; character: string; why: string; chapter: number }
  | { t: "reaction"; character: string; thought: string; speech: string; action: string; chapter: number }
  | { t: "batch_judge_failed"; why: string; chapter: number };

/** One line/deed the writer has actually been granted this scene, for the narration lint. */
export interface GrantedEntry { character: string; speech: string; action: string; thought?: string }

export interface FanoutOpts {
  /** The raw `reactors`/`situation`/`question` off the writer's reply. */
  reactors: unknown;
  situation: unknown;
  question: unknown;
  cast: ReadonlyArray<{ name: string; cannot: readonly string[] }>;
  defOf: (name: string) => CharacterDef | undefined;
  agents: Map<string, Agent>;
  isActive: (name: string) => boolean;
  isPov: (name: string) => boolean;
  /** The POV gate on thoughts: what the writer is handed of a reactor's inner life. */
  writerSees: (name: string, thought: string) => string;
  clarifications: number;
  clarify: Clarifier;
  beginAttempt: () => void;
  keepClarifications: () => void;
  dropClarifications: () => void;
  /** The three-strikes refusal wording, shared with single consults. */
  refusalFor: (why: string, name: string, situation: string) => string;
  writer: Agent;
  granted: GrantedEntry[];
  /** Deeds volunteered this beat, waiting on the writer's next reply to promote one. */
  pendingReactionActions: Map<string, string>;
  lastAsked: Map<string, number>;
  owed: string[];
  step: number;
  chapter: number;
  newBatchJudge: () => Agent;
  log: (e: FanoutEvent) => void;
  /** The run's stop flag, read live — the caller owns it, so this module imports no live.ts. */
  stopped: () => boolean;
}

/** Run one reaction fan-out. Returns whether anybody actually answered: a fan-out whose every
 *  reactor was skipped is an empty turn, and the caller's three-strikes counter has to see it. */
export async function reactionFanout(o: FanoutOpts): Promise<boolean> {
  const { log, chapter } = o;
  const rc = normalizeReactionConsult({ reactors: o.reactors, situation: o.situation, question: o.question }, o.cast);
  if (!rc.ok) {
    log({ t: "bad_consult", character: "(reaction)", why: rc.why, chapter });
    console.log(`${C.yellow}(reaction not sent — ${rc.why.split(". ")[0]}.)${C.reset}`);
    o.writer.hear(o.refusalFor(rc.why, "the group", String(o.situation ?? "")));
    return false;
  }
  log({ t: "reaction_fanout", reactors: rc.reqs.map(r => r.character),
        situation: rc.reqs[0].situation, chapter });
  const collected: { name: string; thought: string; speech: string; action: string; situation: string }[] = [];
  for (const req of rc.reqs) {
    if (o.stopped()) break;
    const def = o.defOf(req.character);
    const persistent = o.agents.get(nameKey(req.character));
    if (!def || !persistent || !o.isActive(def.name)) {
      log({ t: "fanout_skip", character: req.character,
            why: !def ? "no such character" : "left the scene", chapter });
      continue;   // unknown or gone — skip quietly
    }
    let reply;
    o.beginAttempt();
    try {
      // A reaction is not retried here; consult()'s empty/shape repair is guard enough for the thought.
      // Drop consult()'s decision-shaped events — a `reaction` event stands in for them.
      reply = await consult(persistent, req, {
        clarifications: o.clarifications, clarify: o.clarify, pov: o.isPov(def.name),
        log: e => { if (e.t !== "consult" && e.t !== "answer") log(e); },
      });
    } catch (e) {
      log({ t: "fanout_skip", character: def.name, why: (e as Error).message, chapter });
      console.log(`${C.red}${def.name}: reaction failed (${(e as Error).message}).${C.reset}`);
      o.dropClarifications();
      continue;
    }
    // Nothing to write: the reaction never happened, so neither did anything it asked for.
    if (!reply.thought && !reply.speech && !reply.action) { o.dropClarifications(); continue; }
    o.keepClarifications();
    // Fold the thought and anything they actually said; a volunteered action stays out of
    // history until it is promoted, so an un-taken impulse never contradicts the page.
    persistent.hear(P.foldedAsk(req) + P.clarificationTrail(reply.clarifications));
    persistent.said(JSON.stringify({ thought: reply.thought,
      ...(reply.speech ? { speech: reply.speech } : {}) }));
    o.lastAsked.set(nameKey(def.name), o.step);
    // The run record carries the reaction as it was actually given — this is the reader's view
    // of the run, not the writer's desk, and the withholding below is about the writer only.
    log({ t: "reaction", character: def.name, thought: reply.thought, speech: reply.speech,
          action: reply.action, chapter });
    const shownThought = o.writerSees(def.name, reply.thought);
    collected.push({ name: def.name, thought: shownThought, speech: reply.speech,
                     action: reply.action, situation: req.situation });
    // A line the character actually gave is granted — the writer may render exactly it, and
    // the lint needs it on the ledger to tell that from an invented quotation. The felt
    // entry rides along because the bundle hands the writer the interiority to render.
    // A withheld thought grants nothing: the writer was never handed it to render.
    if (reply.speech || shownThought)
      o.granted.push({ character: def.name, speech: reply.speech, action: "", thought: shownThought });
    if (ENGINE.echoConsole && ENGINE.echoCast) console.log(`${C.cyan}${def.name}${C.reset} ${C.dim}reacts:${C.reset} ${reply.thought}`);
  }

  // One batch judge over every volunteered deed decides which are promotable; the rest lapse.
  // No deed volunteered ⇒ no judge call at all.
  const volunteered = collected.filter(x => x.action);
  let promotable = new Map<string, boolean>();
  if (volunteered.length && !o.stopped()) {
    try {
      const raw = await o.newBatchJudge().generate(`${C.magenta}BATCH-JUDGE${C.reset}`, "judge.batch",
        [{ role: "user", content: P.batchJudgeRequest(volunteered) }] as Msg[]);
      promotable = parseBatchVerdict(extractJson(raw));
    } catch (e) {
      log({ t: "batch_judge_failed", why: (e as Error).message, chapter });
      console.log(`${C.red}(reaction judge failed: ${(e as Error).message} — no deeds promoted)${C.reset}`);
    }
  }
  for (const x of collected)
    if (x.action && promotable.get(nameKey(x.name))) o.pendingReactionActions.set(nameKey(x.name), x.action);

  // A reactor whose thought was withheld, who said nothing and whose deed was not promoted
  // has nothing the writer may write, so it is not in the bundle at all — a bare name there
  // would invite the writer to invent what it was standing next to.
  const bundle = collected
    .filter(x => x.thought || x.speech || o.pendingReactionActions.has(nameKey(x.name)))
    .map(x => ({
      name: x.name,
      ...(x.thought ? { thought: x.thought } : {}),
      ...(x.speech ? { speech: x.speech } : {}),
      ...(o.pendingReactionActions.has(nameKey(x.name)) ? { action: x.action } : {}),
    }));
  // The beat counts as asked only if somebody actually answered it — a fan-out whose every
  // reactor was skipped is an empty turn, and the three-strikes counter has to see it.
  const asked = collected.length > 0;
  if (bundle.length) {
    o.writer.hear(P.reactionsAnswered(bundle));
    o.owed.push(...bundle.map(b => b.name));
  } else if (collected.length) {
    // They answered; none of it is the writer's to write. Say so, or the fan-out looks
    // unanswered and gets asked again.
    o.writer.hear(P.reactionsWithheld(collected.map(x => x.name)));
  }
  return asked;
}
