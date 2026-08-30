/** SCENE LOOP — the writer's draft/consult loop: character and writer agent wrapping, writeScene(), and runChapter(). */
import { createInterface } from "node:readline/promises";
import * as P from "../prompts.ts";
import { C } from "../ansi.ts";
import { Agent, trimHistory } from "./agent.ts";
import { extractJson, salvageProse } from "./json-extract.ts";
import { type CharacterDef, type SceneDef, type StoryConfig } from "./story-format.ts";
import type { ThinkLevel } from "./story-schema.ts";
import {
  consult, normalizeConsult, normalizeReactionConsult, parseVerdict, parseBatchVerdict,
  parseClarifyAnswer, parseLintVerdict, missingShape, reviseConsult,
  type ConsultEvent, type ConsultRequest, type ConsultReply, type Clarifier,
} from "./consult.ts";
import { type Msg } from "./llm-client.ts";
import { resolveReach, type Skill } from "./skills.ts";
import { lintQuotations } from "./quote-lint.ts";
import { lintRestrictedSenses } from "./sense-lint.ts";
import { LIVE, RUN, StoppedError, sseWrite, sseClients, runState } from "../live.ts";
import { ENGINE, progressDone } from "./engine-state.ts";

// -- CHARACTER AGENT -------------------------------------------------------
/** One character agent's system prompt: persona, place, skills, knowledge, goal, belief, impulse, voice.
 *  `reach` is this scene's grant only (I1/I4): it comes from per-scene resolution and is empty on
 *  every character-level view. */
export function wrapCharacter(def: CharacterDef, place: string, reach: Skill[] = []): string {
  return P.characterSystem({
    persona: def.persona, place, skills: def.skills, knows: def.knows, goal: def.goal,
    belief: def.belief, impulse: def.impulse, voice: def.voice, reach,
  });
}

/** One character's reach in ONE scene: the scene's grant, minus what restrictions remove (I2) and
 *  what an intrinsic skill already covers (I3). Never called for a character-level view.
 *  Grant keys match case-insensitively, like roster and pov: a mis-cased key must warn at load,
 *  not silently grant nothing. */
export function sceneReach(sd: SceneDef, def: CharacterDef): Skill[] {
  const grant = Object.entries(sd.reach ?? {})
    .find(([who]) => who.trim().toLowerCase() === def.name.toLowerCase())?.[1] ?? [];
  return resolveReach(def.name, def.skills, def.limits.join(" | "), grant.join(" | "));
}

/** One character agent: their wrapped system prompt, their model, and the run's character think level. */
export function newCharacterAgent(def: CharacterDef, place: string, think: ThinkLevel, reach: Skill[] = []): Agent {
  const a = new Agent(def.name, def.model, wrapCharacter(def, place, reach), 0.9);
  a.think = think;
  return a;
}

// -- WRITER AGENT ----------------------------------------------------------
/** The system prompt for the writer agent: premise, scene, the cast's skills, facts, and house style. */
export function wrapWriter(premise: string, scene: SceneDef, cast: { name: string; can: string[]; reach?: string[]; cannot: string[] }[], style: string, facts: string[] = []): string {
  return P.writerSystem({ premise, scene, cast, facts, style });
}

/** The cast actually in a scene; an empty roster means the whole cast. */
export const rosterOf = (characters: CharacterDef[], rostered: string[]): CharacterDef[] =>
  characters.filter(def => !rostered.length || rostered.some(r => r.toLowerCase() === def.name.toLowerCase()));

// `can`/`cannot` here, not the wire's `skills`/`restrictions`: these two feed the writer prompt,
// which prints "CANNOT:" and argues from that word. Renaming them rewords the prompt.
/** What the writer gets to know about each character: what they can do, and what they cannot —
 *  the authored negatives, not inferences from absence, so a restriction that removed a special
 *  skill is named under CANNOT like a removed sense. General skills are filtered out of `can`:
 *  everyone has them unless CANNOT says otherwise, so only the delta from that baseline is worth
 *  the writer's attention. `reach` is the scene's per-character grant (I4: the only place outside
 *  the character agents that ever sees it), shown as its own line. */
export function writerCast(characters: CharacterDef[], rostered: string[],
                           reach: Record<string, Skill[]> = {}): { name: string; can: string[]; reach: string[]; cannot: string[] }[] {
  return rosterOf(characters, rostered)
    .map(c => ({
      name: c.name,
      can: c.skills
        .filter(s => s.source !== "general" && s.source !== "reach")
        .map(s => !s.meaning ? s.name : `${s.name} -- ${s.meaning}`),
      reach: (reach[c.name] ?? []).map(s => !s.meaning ? s.name : `${s.name} -- ${s.meaning}`),
      cannot: c.limits,
    }));
}

// -- SCENE LOOP ------------------------------------------------------------
/** Everything the run can report to the viewer and the writing log, as one tagged event each. */
export type RunEvent =
  | ConsultEvent
  | { t: "scene_start"; story: string; characters: string[]; target: number; chapter: number }
  | { t: "draft"; step: number; prose: string; words: number; consulting: string; salvaged: boolean; chapter: number }
  | { t: "bad_consult"; character: string; why: string; chapter: number }
  | { t: "schema_mismatch"; call: "judge" | "clarify" | "lint"; character: string; chapter: number }
  | { t: "judge_failed"; character: string; why: string; chapter: number }
  | { t: "lint_failed"; why: string; chapter: number }
  | { t: "batch_judge_failed"; why: string; chapter: number }
  | { t: "fanout_skip"; character: string; why: string; chapter: number }
  | { t: "context_risk"; model: string; needs: number; has: number }
  | { t: "judge"; character: string; verdict: string; note: string; attempt: number; chapter: number }
  | { t: "accept"; character: string; attempt: number; speech: string; action: string; chapter: number }
  | { t: "retry"; character: string; attempt: number; situation: string; question: string; was: string; wantsRefused: string; chapter: number }
  | { t: "budget"; added: number; budget: number; chapter: number }
  | { t: "forced_end"; words: number; target: number; chapter: number }
  | { t: "narration_flag"; why: string; retried: boolean; chapter: number }
  | { t: "narration_quote_flag"; why: string; quote: string; character: string; chapter: number }
  | { t: "reader_ask"; step: number; framing: string; options: string[]; chapter: number }
  | { t: "reader_answer"; answer: string; chapter: number }
  | { t: "model_changed"; model: string }
  | { t: "retry_capped"; character: string; count: number; chapter: number }
  | { t: "reaction_fanout"; reactors: string[]; situation: string; chapter: number }
  | { t: "reaction"; character: string; thought: string; speech: string; action: string; chapter: number }
  | { t: "promote"; character: string; action: string; chapter: number }
  | { t: "exit"; character: string; pov: boolean; chapter: number }
  | { t: "exit_refused"; character: string; chapter: number }
  | { t: "done_deferred"; chapter: number }
  | { t: "answer_unwritten"; characters: string[]; stopped: boolean; chapter: number }
  | { t: "scene_end"; steps: number; words: number; done: boolean; stopped: boolean; chapter: number; retries: Record<string, number> };


async function askMoreSteps(steps: number, budget: number, chapter: number): Promise<number> {
  if (RUN.stopped) return 0;
  if (!LIVE.interactive) {
    console.log(`\n${C.yellow}Step budget (${budget}) spent on chapter ${chapter} and the scene is not finished. `
      + `Stopping — interactive is off.${C.reset}`);
    return 0;
  }
  if (sseClients.size) {
    LIVE.awaitingContinue = { steps, budget };
    progressDone();
    console.log(`\n${C.yellow}Budget spent on chapter ${chapter} — waiting on the viewer.${C.reset}`);
    sseWrite({ t: "continue_prompt", steps, budget, suggested: 8 });
    return new Promise<number>(resolve => { LIVE.continueResolve = resolve; });
  }
  if (!process.stdin.isTTY) {
    console.log(`\n${C.yellow}Step budget (${budget}) spent on chapter ${chapter} and the scene is not finished. `
      + `Stopping — nobody to ask.${C.reset}`);
    return 0;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question(`\n${C.yellow}${steps} steps used on chapter ${chapter} and the scene is not done. `
    + `How many more? [8, 0 to stop]: ${C.reset}`)).trim();
  rl.close();
  const n = ans === "" ? 8 : Number(ans);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

const OVERRUN_SLACK = 1.5;

const NEGLECT_GAP = 3;

// A scene told repeatedly that it is at length and still not ending (PLANS.md: a 750-word chapter
// ran to 2,237) needs a hard stop under the soft nudges. Twice the target is the last piece the
// writer gets — `hardCap` forces the instruction and the loop closes the scene after it, whatever
// the reply says.
const HARD_CAP_MULT = 2;

// One redraft only — a flagged piece gets one chance to come back clean, then is accepted anyway.
// The lint warns; it never blocks the scene, matching the consult-retry fallback elsewhere.
const NARRATION_LINT_RETRIES = 1;

// Judging an answer is classification, not composition: the writer's own 0.8 buys nothing here.
const JUDGE_TEMPERATURE = 0.3;

// SPIKE — the world timeline, ahead of block 1 (PLANS.md). One beat, injected once, with no schema,
// no entity and no repair: it only measures whether an injected world event lands.
// The beat text belongs to a run, not the engine, so it arrives by environment; an unset SPIKE_BEAT
// leaves every instruction byte-identical to before. Delete this and its call site.
//
// The trigger is a fraction of the word target, not a step number: step counts vary with cast size
// (17 for a duo, 24-31 for a four-hander), so the same absolute step lands at a different point in
// each — which is the comparison the duo control exists to make.
//
// SPIKE_HOLD names what the writer may not start on its own until then. Without it the writer opens
// with the event already underway — correct behaviour, since it is steering toward a scene question
// that names the event, so firing it in line one is obedience, not error.
const SPIKE_BEAT = process.env.SPIKE_BEAT?.trim() ?? "";
const SPIKE_HOLD = process.env.SPIKE_HOLD?.trim() ?? "";
const SPIKE_BEAT_AT = Number(process.env.SPIKE_BEAT_AT ?? 0.45);

/** Cast members who have gone unconsulted for long enough that the writer may have lost one.
 *
 *  `gap` is a floor, not the threshold. One consult per step means a cast of N cannot beat a gap of
 *  N-1 even while attending to everyone in turn, so a fixed 3 names somebody on every step of any
 *  four-hander — a nudge that cannot be satisfied and so never stops. The threshold clears a full
 *  rotation of whoever is still in the scene. */
export function neglectedCast(cast: string[], lastAsked: Map<string, number>, step: number, gap: number): string[] {
  const threshold = Math.max(gap, cast.length + 1);
  if (step < threshold) return [];
  return cast.filter(name => {
    const last = lastAsked.get(name.toLowerCase());
    return last === undefined || step - last >= threshold;
  });
}

/** Write one scene: the draft/consult loop that stops at choices, consults, judges, and trims history. */
export async function writeScene(
  sd: SceneDef, chapter: number, characters: CharacterDef[], agents: Map<string, Agent>,
  premise: string, writerStyle: string, writerModel: string, summaryModel: string,
  thinking: { writer: ThinkLevel; summary: ThinkLevel },
  maxSteps: number, maxProseWords: number, retries: number, clarifications: number,
  dir: string, log: (e: RunEvent) => void,
  maxCharacterRetries?: number,
  facts: string[] = [],
) {
  const roster = rosterOf(characters, sd.roster);
  const rosterNames = roster.map(c => c.name);
  const active = new Set(rosterNames);          // the cast still in the scene; shrinks as one exits
  const isActive = (name: string) => [...active].some(n => n.toLowerCase() === name.trim().toLowerCase());
  const cast = writerCast(roster, [], Object.fromEntries(roster.map(c => [c.name, sceneReach(sd, c)])));
  const writer = new Agent("WRITER", sd.writerModel ?? writerModel, wrapWriter(premise, sd, cast, writerStyle, facts), 0.8);
  writer.think = sd.writerThink ?? thinking.writer;
  const defOf = (name: string) => roster.find(c => c.name.toLowerCase() === name.trim().toLowerCase());
  // A thought reaches the writer only from inside the POV. The narration lint already holds that
  // nobody else's inner life is narratable fact, so a non-POV thought on the writer's desk would
  // only authorize narrating one anyway. It still goes into the character's own history — the
  // thought is their memory and continuity depends on it — and they are never told it may be
  // withheld, because a character writing for an audience is not answering as itself.
  const isPov = (name: string) => !!sd.pov && sd.pov.trim().toLowerCase() === name.trim().toLowerCase();
  const writerSees = (name: string, thought: string) => isPov(name) ? thought : "";
  LIVE.writer = writer; LIVE.log = log;

  // Each author-side helper has its own name, so it gets its own transcript file, stats row and role
  // tag — and all take `writer.model` at call time, so a mid-run /model swap still reaches them.
  const newJudge = () => {
    const a = new Agent("JUDGE", writer.model, P.judgeSystem(cast), JUDGE_TEMPERATURE);
    a.think = writer.think;
    return a;
  };
  // Stateless like the judge, but it weighs many volunteered deeds in one call and returns a
  // promotable flag each — so a reaction beat costs at most one judge call, and none when nobody acted.
  const newBatchJudge = () => {
    const a = new Agent("BATCH-JUDGE", writer.model, P.batchJudgeSystem(cast), JUDGE_TEMPERATURE);
    a.think = writer.think;
    return a;
  };
  // Also stateless: checks the piece just drafted against THE ONE RULE, CANNOT, and (when the reply
  // opens a consult) whether the situation names a concrete fact — before any of it reaches the page.
  const newNarrationJudge = () => {
    const a = new Agent("NARRATION-JUDGE", writer.model, P.narrationLintSystem(cast), JUDGE_TEMPERATURE);
    a.think = writer.think;
    return a;
  };
  // The judge is stateless — it is given everything it needs and gains nothing from remembering an
  // earlier verdict. The clarifier is not: what it settles becomes true for the rest of the scene,
  // so it keeps its own history and is trimmed along with everyone else.
  let clarifier: Agent | null = null;
  const theClarifier = () => {
    if (!clarifier) {
      clarifier = new Agent("CLARIFIER", writer.model,
        P.clarifySystem({ premise, scene: sd, facts, cast }), writer.temperature);
      clarifier.think = writer.think;
    }
    clarifier.model = writer.model;
    return clarifier;
  };

  // How many times the gate has already turned an ask back. A refusal says what is wrong, and the
  // writer can still re-send the identical thing — five times running, in one observed scene — so
  // the repetition is named rather than answered with the same words again. Keyed on the SITUATION
  // and its addressee, because that is the ask now: the question is absent altogether from an open
  // beat, and keying on it would quietly never match.
  const refusedAsks = new Map<string, number>();
  const refusalFor = (why: string, name: string, situation: string) => {
    const key = `${name.trim().toLowerCase()}|${situation.trim().toLowerCase()}`;
    const times = situation.trim() ? (refusedAsks.get(key) ?? 0) + 1 : 1;
    if (situation.trim()) refusedAsks.set(key, times);
    return times > 1 ? P.consultRepeated(why, name, times) : P.consultNotSent(why, name);
  };

  const pieces: string[] = [];
  const wordCount = () => pieces.join(" ").split(/\s+/).filter(Boolean).length;
  const lastAsked = new Map<string, number>();
  const retryCounts = new Map<string, number>();
  // Deeds volunteered by the last reaction fan-out (lowercased name → action), waiting for the
  // writer's next reply to promote at most one. A one-shot offer: cleared as the next reply is read.
  const pendingReactionActions = new Map<string, string>();
  // Every line/deed the writer has actually been granted this scene, for the narration lint to check
  // "not yours" against. A reaction's thought goes in here too — as a felt entry: the writer was
  // handed that interiority to render, and without it the lint flags exactly what it asked for.
  // Only a promoted reaction action joins later, like the writer's own history folding only a
  // promoted deed; a reaction's un-promoted action never becomes canon.
  const granted: { character: string; speech: string; action: string; thought?: string }[] = [];
  let steps = 0, budget = maxSteps, done = false, empties = 0;
  let overran = 0;
  let beatFired = false; // SPIKE (world timeline): the beat fires once, then the hold lifts.
  // Set when a reply declared the scene done with a consult still open and an answer landed: the
  // scene is held open one more turn so the answer reaches the page, then closes regardless.
  let closing = false;

  // A `scene_done` on an empty page ends a scene that never happened. The first one is refused with
  // a message and a flag, so the writer cannot be trapped by its own declaration; a second is
  // honored — an empty chapter can still not be saved (run-and-save), which is the backstop if the
  // model keeps insisting. A turn already held open to pay an owed answer is never held twice: that
  // one closes whatever it produces.
  let blankDone = false;
  // Characters whose accepted answer has not had a writing turn since. An accept only puts the answer
  // in the writer's history; only the next piece of prose can put it on the page, so the names sit
  // here until one is committed. What the engine can check is that a beat was written after the
  // answer landed, not that it honors the answer — a scene that ends with names still here ended
  // with a character's choice missing from the chapter, and says so.
  let owed: string[] = [];

  // A clarification is part of the attempt that asked for it and survives on the same terms the
  // answer does. The clarifier folds it in as it goes — a character may ask twice in one attempt,
  // and the second answer has to know the first — but an attempt whose answer is thrown away is
  // rewound to here, and the writer is told nothing at all until the answer is the one the scene
  // takes. Otherwise a rejected branch's invented fact would become canon for the writer while the
  // fresh instance that replaced the rejected character has never heard it.
  let attemptClarifications: { character: string; question: string; answer: string }[] = [];
  let clarifierMark = 0;
  const beginAttempt = () => {
    attemptClarifications = [];
    clarifierMark = clarifier?.history.length ?? 0;
  };
  const keepClarifications = () => {
    for (const cl of attemptClarifications) {
      writer.hear(P.characterAsks(cl.character, cl.question));
      writer.said(JSON.stringify({ answer: cl.answer }));
    }
    attemptClarifications = [];
  };
  const dropClarifications = () => {
    clarifier?.rewind(clarifierMark);
    attemptClarifications = [];
  };

  // How a character's request for a missing fact is answered, shared by single consults and reaction
  // fan-outs. The clarifier remembers so it stays consistent; the writer remembers so its own
  // narration does not contradict what the character was told.
  const clarify: Clarifier = async (q, r) => {
    const cl = theClarifier();
    // The asking character's own `knows` rides in the transient payload, never folded into the
    // clarifier's history: the instructions tell it to reveal only what this character could
    // perceive or already know, and that boundary is uncheckable without the field itself.
    const extra: Msg[] = [{
      role: "user",
      content: P.clarifyRequest(r.character, q, r.situation,
                                pieces[pieces.length - 1] ?? "", defOf(r.character)?.knows ?? ""),
    }];
    let a = "";
    try {
      for (let tries = 0; ; tries++) {
        const raw = await cl.generate(`${C.magenta}CLARIFIER${C.reset}`, extra);
        const answered = parseClarifyAnswer(extractJson(raw));
        if (answered !== null) { a = answered; break; }
        if (tries) break;
        log({ t: "schema_mismatch", call: "clarify", character: r.character, chapter });
        extra.push({ role: "assistant", content: raw.trim() },
                   { role: "user", content: P.ANSWER_ONLY });
      }
    } catch (e) {
      console.log(`${C.red}(clarification call failed: ${(e as Error).message})${C.reset}`);
      return null;
    }
    cl.hear(P.characterAsks(r.character, q));
    cl.said(JSON.stringify({ answer: a }));
    attemptClarifications.push({ character: r.character, question: q, answer: a });
    return a;
  };

  log({ t: "scene_start", story: dir, characters: characters.map(c => c.name), target: sd.length, chapter });

  while (!done) {
    if (RUN.stopped) break;

    if (LIVE.pausing) {
      LIVE.paused = true;
      sseWrite(runState());
      await new Promise<void>(res => { LIVE.pauseResolve = res; });
      if (RUN.stopped) break;
      continue;
    }

    if (steps >= budget) {
      const extra = await askMoreSteps(steps, budget, chapter);
      if (!extra) break;
      budget += extra;
      log({ t: "budget", added: extra, budget, chapter });
    }

    if (LIVE.readerArmed && LIVE.interactive && sseClients.size) {
      LIVE.readerArmed = false;
      sseWrite(runState());
      writer.hear(P.askReader(wordCount()));
      let askRaw = "";
      try {
        askRaw = await writer.generate(`${C.magenta}WRITER${C.reset}`);
      } catch (e) {
        if (e instanceof StoppedError || RUN.stopped) break;
        console.log(`\n${C.red}Reader-consult call failed (${(e as Error).message}) — `
          + `writing normally instead.${C.reset}`);
      }
      if (askRaw) {
        steps++;
        const ask = extractJson(askRaw);
        const framing = String(ask.framing ?? "").trim();
        const options = Array.isArray(ask.options)
          ? ask.options.map((o: unknown) => String(o).trim()).filter(Boolean).slice(0, 3) : [];
        writer.said(JSON.stringify({ framing, options }));
        log({ t: "reader_ask", step: steps, framing, options, chapter });
        console.log(`\n${C.cyan}(waiting on the reader — ${options.length} direction(s) offered)${C.reset}`);

        const answer = await new Promise<string>(resolve => { LIVE.readerResolve = resolve; });
        if (RUN.stopped) break;
        if (answer) {
          log({ t: "reader_answer", answer, chapter });
          writer.hear(P.readerChose(answer));
        }
      }
      continue;
    }

    const words = wordCount();
    const neglected = neglectedCast([...active], lastAsked, steps, NEGLECT_GAP);
    const hardCap = words >= sd.length * HARD_CAP_MULT;
    const fired = SPIKE_BEAT && !beatFired && words >= sd.length * SPIKE_BEAT_AT ? SPIKE_BEAT : "";
    if (fired) {
      beatFired = true;
      console.log(`\n${C.cyan}(world beat fired at step ${steps}, ${words}/${sd.length} words)${C.reset}`);
    }
    writer.hear(P.writeInstruction({
      words, target: sd.length, maxProseWords, overran, neglected, hardCap,
      fired, hold: beatFired ? "" : SPIKE_HOLD,
    }));
    let draftRaw: string;
    try {
      draftRaw = await writer.generate(`${C.magenta}WRITER${C.reset}`);
    } catch (e) {
      if (e instanceof StoppedError || RUN.stopped) break;
      console.log(`\n${C.red}Writer call failed (${(e as Error).message}) — stopping with what we have.${C.reset}`);
      break;
    }
    steps++;

    let d: Record<string, any> = {};
    let prose = "", salvaged = false, sceneDone = false;
    let c: Record<string, unknown> | null = null, who = "", exiting = "", promoting = "";
    let fanoutNames: string[] = [], proseWords = 0;
    let stoppedMidLint = false;

    for (let lintAttempt = 0; ; lintAttempt++) {
      d = extractJson(draftRaw, how => {
        if (how === "prose_fallback")
          log({ t: "prose_reply", character: writer.name });
      });
      prose = String(d.prose ?? "").trim();
      salvaged = false;
      if (!prose) {
        const recovered = salvageProse(draftRaw);
        if (recovered) {
          prose = recovered; salvaged = true;
          console.log(`${C.yellow}(recovered a truncated draft — ${recovered.split(/\s+/).length} words)${C.reset}`);
        }
      }
      sceneDone = d.scene_done === true || String(d.scene_done ?? "").toLowerCase() === "true";
      c = (d.consult && typeof d.consult === "object") ? d.consult as Record<string, unknown> : null;
      who = c ? String(c.character ?? "").trim() : "";
      exiting = String(d.exit ?? "").trim();
      promoting = String(d.promote ?? "").trim();
      fanoutNames = c && Array.isArray(c.reactors)
        ? c.reactors.map((r: unknown) => String((r as any)?.name ?? (typeof r === "string" ? r : "")).trim())
            .filter(Boolean)
        : [];
      proseWords = prose ? prose.split(/\s+/).filter(Boolean).length : 0;

      // -- NARRATION LINT: check before anything is committed to the page. Nothing drafted and
      // nothing asked ⇒ nothing to lint, same as the empty/asked-nobody path below.
      if (!prose && !c) break;

      const outgoingConsult = c ? {
        character: who || undefined,
        reactors: fanoutNames.length ? fanoutNames : undefined,
        situation: String((c as Record<string, unknown>).situation ?? "").trim(),
        question: String((c as Record<string, unknown>).question ?? "").trim(),
      } : null;

      // A deed this same reply promotes was volunteered last beat and is the writer's to render — the
      // promote itself is processed a few lines below, once the piece survives the lint. Without it
      // in evidence the lint flags the writer for using exactly what it was entitled to.
      const promoteDef = promoting ? defOf(promoting) : undefined;
      const promoted = promoteDef ? pendingReactionActions.get(promoteDef.name.toLowerCase()) : undefined;
      const lintGranted = promoted && promoteDef
        ? [...granted, { character: promoteDef.name, speech: "", action: promoted }]
        : granted;

      let flagged: string | null = null;
      // Both mechanical checks run ALONGSIDE the LLM lint, never before it. There is one redraft
      // only, so reporting serially spends it on the first finding and leaves the second unfixed —
      // a piece with an invented line AND an invented deed must get both in one message. The
      // quotation check used to short-circuit here: every hit, false positives included, silently
      // skipped the deed and stillness checks. Two live runs skipped six pieces that way and put
      // three unasked-for stillnesses on the page. The extra model call is only spent on pieces
      // already in trouble.
      const quoteLint = lintQuotations(prose, lintGranted, cast.map(c => c.name));
      if (quoteLint && !quoteLint.ok) {
        log({ t: "narration_quote_flag", why: quoteLint.why, quote: quoteLint.quote,
              character: quoteLint.character, chapter });
      }
      {
      const senseLint = lintRestrictedSenses(prose, cast);
      let lintWhy: string | null = null;
      try {
        const lintJudge = newNarrationJudge();
        const lintExtra: Msg[] = [{ role: "user", content: P.narrationLintRequest({
          pov: sd.pov, prose, granted: lintGranted, consult: outgoingConsult }) }];
        for (let tries = 0; ; tries++) {
          const lintRaw = await lintJudge.generate(`${C.magenta}NARRATION-JUDGE${C.reset}`, lintExtra);
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
      flagged = [quoteLint?.why, senseLint?.why, lintWhy].filter((w): w is string => !!w).join(". ") || null;
      }

      if (!flagged) break;

      const retried = lintAttempt >= NARRATION_LINT_RETRIES;
      log({ t: "narration_flag", why: flagged, retried, chapter });
      console.log(`${C.yellow}(narration flagged — ${flagged.split(". ")[0]}.)${C.reset}`);
      if (retried) break;   // one redraft only — accept whatever comes back next

      writer.hear(P.narrationFlagged(flagged));
      try {
        draftRaw = await writer.generate(`${C.magenta}WRITER${C.reset}`);
      } catch (e) {
        if (e instanceof StoppedError || RUN.stopped) { stoppedMidLint = true; break; }
        console.log(`\n${C.red}Writer redraft call failed (${(e as Error).message}) — keeping the flagged piece.${C.reset}`);
        break;
      }
      steps++;
    }
    if (stoppedMidLint) break;

    overran = proseWords > maxProseWords * OVERRUN_SLACK ? proseWords : 0;
    // A beat written after the answers landed is the writing turn they were owed; the consults this
    // same reply opens are answered further down and start the count over.
    if (prose) { pieces.push(prose); owed = []; }
    // The writer's own turn, as it will read it back next time. It keeps what was asked — who, the
    // situation, question and shape — not just who: the answer arrives as bare thought/speech/action,
    // and "No" or "the left one" means nothing against a draft that no longer says what was asked.
    // One `consult` key holds all of it — two spreads used to collide, dropping the name whenever a
    // reply carried both a consult and a fan-out.
    const askedRecord = c ? {
      ...(who ? { character: who } : {}),
      ...(fanoutNames.length ? { reactors: fanoutNames } : {}),
      ...(String(c.situation ?? "").trim() ? { situation: String(c.situation).trim() } : {}),
      ...(String(c.question ?? "").trim() ? { question: String(c.question).trim() } : {}),
      ...(String(c.wants ?? "").trim() ? { wants: String(c.wants).trim() } : {}),
    } : null;
    writer.said(JSON.stringify({ prose,
      ...(askedRecord ? { consult: askedRecord } : {}),
      scene_done: sceneDone }));
    log({ t: "draft", step: steps, prose, words: wordCount(), consulting: who, salvaged, chapter });
    if (prose && ENGINE.echoConsole) console.log(`\n${prose}\n`);

    // -- PROMOTE: the writer turns one deed a reactor volunteered last beat into canon. Done before
    // the consult below, so this beat's own fan-out (if any) can re-arm the offer afterward. The
    // offer is one-shot — read here, then cleared whether or not it was taken.
    if (promoting && pendingReactionActions.size) {
      const def = defOf(promoting);
      const action = def ? pendingReactionActions.get(def.name.toLowerCase()) : undefined;
      const persistent = def ? agents.get(def.name.toLowerCase()) : undefined;
      if (def && action && persistent) {
        persistent.hear(P.AUTHOR_TOOK_YOUR_ACTION);
        persistent.said(JSON.stringify({ action }));
        granted.push({ character: def.name, speech: "", action });
        log({ t: "promote", character: def.name, action, chapter });
        if (ENGINE.echoConsole && ENGINE.echoCast) console.log(`${C.cyan}${def.name}${C.reset} ${C.dim}acts:${C.reset} ${action}`);
      }
    }
    pendingReactionActions.clear();

    // -- CONSULT (with accept / retry)
    const reactors = c && Array.isArray((c as Record<string, unknown>).reactors)
      ? (c as Record<string, unknown>).reactors : null;
    let asked = false;
    if (reactors) {
      // -- REACTION FAN-OUT: one shared beat, several present-but-not-acting characters react at once.
      // Each runs an isolated consult (never seeing another's reply); the writer gets them together.
      const rc = normalizeReactionConsult({ reactors, situation: c!.situation, question: c!.question }, cast);
      if (!rc.ok) {
        log({ t: "bad_consult", character: "(reaction)", why: rc.why, chapter });
        console.log(`${C.yellow}(reaction not sent — ${rc.why.split(". ")[0]}.)${C.reset}`);
        writer.hear(refusalFor(rc.why, "the group", String(c!.situation ?? "")));
      } else {
        log({ t: "reaction_fanout", reactors: rc.reqs.map(r => r.character),
              situation: rc.reqs[0].situation, chapter });
        const collected: { name: string; thought: string; speech: string; action: string; situation: string }[] = [];
        for (const req of rc.reqs) {
          if (RUN.stopped) break;
          const def = defOf(req.character);
          const persistent = agents.get(req.character.toLowerCase());
          if (!def || !persistent || !isActive(def.name)) {
            log({ t: "fanout_skip", character: req.character,
                  why: !def ? "no such character" : "left the scene", chapter });
            continue;   // unknown or gone — skip quietly
          }
          let reply: ConsultReply;
          beginAttempt();
          try {
            // A reaction is not retried here; consult()'s empty/shape repair is guard enough for the thought.
            // Drop consult()'s decision-shaped events — a `reaction` event stands in for them.
            reply = await consult(persistent, req, {
              clarifications, clarify, pov: isPov(def.name),
              log: e => { if (e.t !== "consult" && e.t !== "answer") log(e); },
            });
          } catch (e) {
            log({ t: "fanout_skip", character: def.name, why: (e as Error).message, chapter });
            console.log(`${C.red}${def.name}: reaction failed (${(e as Error).message}).${C.reset}`);
            dropClarifications();
            continue;
          }
          // Nothing to write: the reaction never happened, so neither did anything it asked for.
          if (!reply.thought && !reply.speech && !reply.action) { dropClarifications(); continue; }
          keepClarifications();
          // Fold the thought and anything they actually said; a volunteered action stays out of
          // history until it is promoted, so an un-taken impulse never contradicts the page.
          persistent.hear(P.foldedAsk(req) + P.clarificationTrail(reply.clarifications));
          persistent.said(JSON.stringify({ thought: reply.thought,
            ...(reply.speech ? { speech: reply.speech } : {}) }));
          lastAsked.set(def.name.toLowerCase(), steps);
          // The run record carries the reaction as it was actually given — this is the reader's view
          // of the run, not the writer's desk, and the withholding below is about the writer only.
          log({ t: "reaction", character: def.name, thought: reply.thought, speech: reply.speech,
                action: reply.action, chapter });
          const shownThought = writerSees(def.name, reply.thought);
          collected.push({ name: def.name, thought: shownThought, speech: reply.speech,
                           action: reply.action, situation: req.situation });
          // A line the character actually gave is granted — the writer may render exactly it, and
          // the lint needs it on the ledger to tell that from an invented quotation. The felt
          // entry rides along because the bundle hands the writer the interiority to render.
          // A withheld thought grants nothing: the writer was never handed it to render.
          if (reply.speech || shownThought)
            granted.push({ character: def.name, speech: reply.speech, action: "", thought: shownThought });
          if (ENGINE.echoConsole && ENGINE.echoCast) console.log(`${C.cyan}${def.name}${C.reset} ${C.dim}reacts:${C.reset} ${reply.thought}`);
        }

        // One batch judge over every volunteered deed decides which are promotable; the rest lapse.
        // No deed volunteered ⇒ no judge call at all.
        const volunteered = collected.filter(x => x.action);
        let promotable = new Map<string, boolean>();
        if (volunteered.length && !RUN.stopped) {
          try {
            const raw = await newBatchJudge().generate(`${C.magenta}BATCH-JUDGE${C.reset}`,
              [{ role: "user", content: P.batchJudgeRequest(volunteered) }]);
            promotable = parseBatchVerdict(extractJson(raw));
          } catch (e) {
            log({ t: "batch_judge_failed", why: (e as Error).message, chapter });
            console.log(`${C.red}(reaction judge failed: ${(e as Error).message} — no deeds promoted)${C.reset}`);
          }
        }
        for (const x of collected)
          if (x.action && promotable.get(x.name.toLowerCase())) pendingReactionActions.set(x.name.toLowerCase(), x.action);

        // A reactor whose thought was withheld, who said nothing and whose deed was not promoted
        // has nothing the writer may write, so it is not in the bundle at all — a bare name there
        // would invite the writer to invent what it was standing next to.
        const bundle = collected
          .filter(x => x.thought || x.speech || pendingReactionActions.has(x.name.toLowerCase()))
          .map(x => ({
            name: x.name,
            ...(x.thought ? { thought: x.thought } : {}),
            ...(x.speech ? { speech: x.speech } : {}),
            ...(pendingReactionActions.has(x.name.toLowerCase()) ? { action: x.action } : {}),
          }));
        // The beat counts as asked only if somebody actually answered it — a fan-out whose every
        // reactor was skipped is an empty turn, and the three-strikes counter has to see it.
        asked = collected.length > 0;
        if (bundle.length) {
          writer.hear(P.reactionsAnswered(bundle));
          owed.push(...bundle.map(b => b.name));
        } else if (collected.length) {
          // They answered; none of it is the writer's to write. Say so, or the fan-out looks
          // unanswered and gets asked again.
          writer.hear(P.reactionsWithheld(collected.map(x => x.name)));
        }
      }
    } else if (who) {
      const def = defOf(who);
      const persistent = agents.get(who.toLowerCase());
      const check = def ? normalizeConsult({ ...c!, character: def.name }, cast) : null;
      if (!def || !persistent) {
        writer.hear(P.noSuchCharacter(who, [...active]));
      } else if (!isActive(def.name)) {
        console.log(`${C.yellow}(not sent to ${def.name} — they have left the scene.)${C.reset}`);
        writer.hear(P.consultExited(def.name));
      } else if (!check!.ok) {
        log({ t: "bad_consult", character: def.name, why: check!.why, chapter });
        console.log(`${C.yellow}(not sent to ${def.name} — ${check!.why.split(". ")[0]}.)${C.reset}`);
        writer.hear(refusalFor(check!.why, def.name, String(c!.situation ?? "")));
      } else {
        asked = true;
        let req: ConsultRequest = check!.req;
        let reply: ConsultReply | null = null;
        let usedAttempt = 1;
        let failed = "";

        for (let attempt = 1; ; attempt++) {
          usedAttempt = attempt;
          const agent = attempt === 1 ? persistent : persistent.fork();
          beginAttempt();
          try {
            reply = await consult(agent, req, {
              clarifications, attempt, log, clarify, pov: isPov(def.name) });
          } catch (e) {
            failed = (e as Error).message;
            break;
          }

          const flags = P.answerFlags(reply);
          let j: Record<string, any> = {};
          let judged: "accept" | "retry" | null = null;
          const judge = newJudge();
          const judgeExtra: Msg[] = [{
            role: "user",
            content: P.judgeRequest({
              name: def.name, situation: req.situation, question: req.question, wants: req.wants,
              thought: reply.thought, speech: reply.speech, action: reply.action, note: reply.note,
              flags, pov: isPov(def.name),
            }),
          }];
          try {
            for (let tries = 0; ; tries++) {
              const judgeRaw = await judge.generate(`${C.magenta}JUDGE${C.reset}`, judgeExtra);
              j = extractJson(judgeRaw);
              judged = parseVerdict(j);
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
          const note = String(j.note ?? "").trim();
          log({ t: "judge", character: def.name, verdict, note, attempt, chapter });

          const effectiveCeiling = def.maxRetries ?? maxCharacterRetries;
          const cumulative = retryCounts.get(def.name.toLowerCase()) ?? 0;

          if (verdict === "accept" || attempt > retries || (effectiveCeiling !== undefined && cumulative >= effectiveCeiling)) {
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
          const rev = (j.revised && typeof j.revised === "object") ? j.revised as Record<string, unknown> : {};
          const revised = reviseConsult(req, rev, cast);
          if (!revised.ok) {
            // Asking again with a question that cannot be sent would spend the attempt on nothing,
            // so the answer already in hand is the one the scene gets.
            log({ t: "bad_consult", character: def.name, why: revised.why, chapter });
            console.log(`${C.yellow}(${def.name}'s re-ask was not usable — ${revised.why.split(". ")[0]}. `
              + `Keeping the answer.)${C.reset}`);
            break;
          }
          // The attempt is abandoned here, and everything it settled goes with it.
          dropClarifications();
          retryCounts.set(def.name.toLowerCase(), cumulative + 1);
          const wasAsked = req.question;
          req = revised.req;
          console.log(`${C.yellow}retry ${attempt}/${retries} — ${def.name}${C.reset}${note ? ` ${C.dim}(${note})${C.reset}` : ""}`);
          if (revised.wantsRefused) {
            console.log(`${C.yellow}(the judge asked to make that a ${revised.wantsRefused} question — `
              + `kept as ${req.wants})${C.reset}`);
          }
          // `was` is the whole drift record: a judge that answers an inconvenient reply by asking a
          // different question is visible here and nowhere else.
          log({ t: "retry", character: def.name, attempt, situation: req.situation,
                question: req.question, was: wasAsked, wantsRefused: revised.wantsRefused, chapter });
        }

        if (RUN.stopped) break;

        const stalled = !!reply && !reply.thought && !reply.speech && !reply.action;
        // A thought with nothing said and nothing done answers a "reaction" and nothing else. Taken
        // as an accept it is worse than a refusal: it costs the attempts, marks the character as
        // freshly consulted, and hands the writer an answer with nothing in it to write.
        // POV decides what a "reaction" has to carry: from anyone else a thought alone reaches the
        // writer as nothing, which is the same empty answer the other three shapes are refused for.
        const shortOf = reply && !stalled ? missingShape(req.wants, reply, isPov(def.name)) : null;
        if (failed || !reply || stalled || shortOf) {
          const why = failed
            || (stalled ? reply!.note || "did not answer"
            : shortOf === "reaction"
              ? "reacted from behind their eyes, and the scene is not written from theirs"
            : shortOf ? `was asked for ${shortOf} and gave none`
            : "no reply");
          console.log(`${C.red}${def.name}: ${why}.${C.reset}`);
          writer.hear(P.noAnswer(def.name, why));
          dropClarifications();
        } else {
          // The permanent record of what was asked is the situation and the shape — none of the
          // standing instructions that went out with it. The nudge is transient pressure for this
          // one answer; writing it permanently into history would bend every later reply.
          // The rest of askBlock is the same thing one step quieter (P.foldedAsk), and consult()
          // threads the attempt into the outgoing message only.
          persistent.hear(P.foldedAsk(req) + P.clarificationTrail(reply.clarifications));
          persistent.said(JSON.stringify({
            thought: reply.thought,
            ...(reply.speech ? { speech: reply.speech } : {}),
            ...(reply.action ? { action: reply.action } : {}),
          }));
          keepClarifications();   // before the answer: the writer settled these facts to get it
          const shown = { thought: writerSees(def.name, reply.thought),
                          speech: reply.speech, action: reply.action };
          writer.hear(P.characterAnswered(def.name, P.answerBody(shown), req.question));
          lastAsked.set(def.name.toLowerCase(), steps);
          // An answer joins the lint's ledger as whatever the writer actually got. A thought-only
          // answer from the POV character lands as a felt entry, like a fan-out's bundle — without
          // it, the writer rendering that interiority is flagged for using exactly what it was
          // handed. A withheld thought grants nothing: it never reached the desk.
          if (reply.speech || reply.action || shown.thought) {
            granted.push({
              character: def.name,
              speech: reply.speech,
              action: reply.action,
              ...(!reply.speech && !reply.action && shown.thought ? { thought: shown.thought } : {}),
            });
          }
          owed.push(def.name);
          log({ t: "accept", character: def.name, attempt: usedAttempt, speech: reply.speech, action: reply.action, chapter });
          if (ENGINE.echoConsole && ENGINE.echoCast) console.log(`${C.cyan}${def.name}${C.reset} ${C.dim}→${C.reset} `
            + (reply.speech ? `"${reply.speech}" ` : "") + (reply.action ? `${C.dim}${reply.action}${C.reset}` : ""));
        }
      }
    }

    // A character the writer wrote out: drop them from the active cast so they are not consulted or
    // missed again. Exiting the POV character ends the chapter — the handoff re-authors the cast
    // from here, reading the exit out of the prose. The exit must be ON the page to take effect:
    // a reply that wrote nothing cannot remove anybody, so the declaration is refused.
    if (exiting && !prose) {
      const name = defOf(exiting)?.name ?? exiting;
      log({ t: "exit_refused", character: name, chapter });
      console.log(`${C.yellow}(${name} was declared gone in a reply that wrote nothing — nobody has left.)${C.reset}`);
      writer.hear(P.exitNotWritten(name));
    } else if (exiting) {
      const name = defOf(exiting)?.name ?? exiting;
      if (isActive(name)) {
        for (const n of [...active]) if (n.toLowerCase() === name.toLowerCase()) active.delete(n);
        const pov = !!sd.pov && sd.pov.toLowerCase() === name.toLowerCase();
        log({ t: "exit", character: name, pov, chapter });
        console.log(`${C.dim}(${name} has left the scene${pov ? " — the point of view, so the chapter ends here" : ""})${C.reset}`);
        if (pov) done = true;
      }
    }

    if (!prose && !asked) {
      if (++empties >= 3) { console.log(`${C.red}Writer wrote nothing and asked nobody, three times — stopping.${C.reset}`); break; }
    } else empties = 0;

    // A reply that ends the scene while its consult is still open would leave an answer unwritten —
    // whether it declares done or hits the hard cap. Hold the scene open one more turn so the
    // answer is written in; the scene closes after that turn whatever it produces.
    const deferredNow = (sceneDone || hardCap) && owed.length > 0 && !closing;
    if (deferredNow) {
      const why = sceneDone ? "done" : "cap";
      sceneDone = false;
      closing = true;
      writer.hear(P.answerStillOwed(why));
      log({ t: "done_deferred", chapter });
      console.log(`${C.yellow}(scene ending with a consult open — holding the scene open `
        + `to write the answer in)${C.reset}`);
    }

    // The turn that armed `closing` is the one being held open, so nothing closes the scene on it —
    // not the hard cap either, or the answer would be owed to a page that never comes.
    if (deferredNow) {
      // held open
    } else if (sceneDone && !prose && pieces.length === 0 && !blankDone && !closing) {
      blankDone = true;
      writer.hear(P.blankSceneRefused);
      console.log(`${C.yellow}(scene done declared with nothing on the page yet — holding it open)${C.reset}`);
    } else if (sceneDone || closing) {
      done = true;
    } else if (hardCap) {
      done = true;
      log({ t: "forced_end", words: wordCount(), target: sd.length, chapter });
      console.log(`${C.yellow}(scene forced to a close — ${wordCount()} words against a `
        + `${sd.length}-word target)${C.reset}`);
    }
    if (RUN.stopped) break;
    await trimHistory(writer, summaryModel, thinking.summary);
    if (clarifier) await trimHistory(clarifier, summaryModel, thinking.summary);
    for (const def of roster) {
      const a = agents.get(def.name.toLowerCase());
      if (a) await trimHistory(a, summaryModel, thinking.summary);
    }
  }

  // The scene ended with no beat written after these answers landed. The consults show as accepted,
  // but the chapter does not carry the choices they made — say so plainly rather than let the run
  // record read as a clean finish.
  if (owed.length) {
    const names = [...new Set(owed)];
    log({ t: "answer_unwritten", characters: names, stopped: RUN.stopped, chapter });
    console.log(`${C.red}(the scene ended before ${names.join(", ")}'s answer reached the page — `
      + `accepted, but not in the chapter)${C.reset}`);
  }

  log({ t: "scene_end", steps, words: wordCount(), done, stopped: RUN.stopped, chapter, retries: Object.fromEntries(retryCounts) });
  return { prose: pieces, steps, words: wordCount(), done, stopped: RUN.stopped };
}

/** Write one chapter: build the agents for the chapter's roster, call writeScene, and clean up. */
export async function runChapter(sc: StoryConfig, chapter: number, log: (e: RunEvent) => void): Promise<
  { prose: string[]; steps: number; words: number; done: boolean; stopped: boolean }
> {
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > sc.scenes.length) {
    throw new Error(`Chapter must be an integer in 1..${sc.scenes.length}, not ${chapter}`);
  }

  const sd = sc.scenes[chapter - 1];
  const agents = new Map<string, Agent>();

  for (const def of rosterOf(sc.characters, sd.roster)) {
    agents.set(def.name.toLowerCase(), newCharacterAgent(def, sd.place, sc.thinking.character, sceneReach(sd, def)));
  }

  LIVE.agents = agents;

  try {
    const r = await writeScene(
      sd, chapter, sc.characters, agents,
      sc.premise, sc.writerStyle, sc.models.writer, sc.models.summary,
      sc.thinking, sc.maxSteps, sc.maxProseWords, sc.retries, sc.clarifications,
      sc.dir, log, sc.maxCharacterRetries,
      sc.facts,
    );
    return r;
  } finally {
    LIVE.writer = null; LIVE.agents = null; LIVE.log = null;
  }
}
