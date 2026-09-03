/** SCENE LOOP — the writer's draft/consult loop: character and writer agent wrapping, writeScene(), and runChapter(). */
import * as P from "../prompts.ts";
import { C } from "../ansi.ts";
import { Agent, trimHistory } from "./agent.ts";
import { extractJson, salvageProse } from "./json-extract.ts";
import { type CharacterDef, type SceneDef, type StoryConfig } from "./story-format.ts";
import type { ThinkLevel, TimelineDef } from "./story-schema.ts";
import { bibleMeaningOf, resolveReach, type BibleLookup, type Skill } from "./skills.ts";
import {
  normalizeConsult,
  parseClarifyAnswer, parseLintVerdict, missingShape,
  type ConsultEvent, type Clarifier,
} from "./consult.ts";
import { judgeGate } from "./judge-gate.ts";
import { reactionFanout, type GrantedEntry } from "./fanout.ts";
import { lintPiece } from "./narration-lint.ts";
import { stripRepeatedPrefix } from "./repeat-lint.ts";
import { timelineTurn } from "./world-timeline.ts";
import { nameKey, sameName } from "./config-util.ts";
import { type Msg } from "./llm-client.ts";
import { LIVE, RUN, StoppedError, LIVE_IO, type SceneIo } from "../live.ts";
import { ENGINE } from "./engine-state.ts";

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
export function sceneReach(sd: SceneDef, def: CharacterDef, bible: BibleLookup = bibleMeaningOf): Skill[] {
  const grant = Object.entries(sd.reach ?? {})
    .find(([who]) => sameName(who, def.name))?.[1] ?? [];
  return resolveReach(def.name, def.skills, def.limits.join(" | "), grant.join(" | "), bible);
}

/** One character agent: their wrapped system prompt, their model, and the run's character think level. */
export function newCharacterAgent(def: CharacterDef, place: string, think: ThinkLevel, reach: Skill[] = []): Agent {
  const a = new Agent(def.name, def.model, wrapCharacter(def, place, reach), 0.9);
  a.think = think;
  return a;
}

// -- WRITER AGENT ----------------------------------------------------------
/** The system prompt for the writer agent: premise, scene, the cast's skills, facts, and house style. */
export function wrapWriter(premise: string, scene: SceneDef, cast: { name: string; can: string[]; reach?: string[]; cannot: string[] }[], style: string, facts: string[] = [], constraints: string[] = []): string {
  // The writer gets one HOUSE STYLE block. Joining here rather than in the prompt keeps the
  // preset/constraint split an authoring distinction -- which is where it earns its keep -- and
  // leaves the writer seeing exactly what a story with both typed into one field always saw.
  const houseStyle = [style.trim(), ...constraints.map(c => c.trim()).filter(Boolean)].join("\n").trim();
  return P.writerSystem({ premise, scene, cast, facts, style: houseStyle });
}

/** The cast actually in a scene; an empty roster means the whole cast. */
export const rosterOf = (characters: CharacterDef[], rostered: string[]): CharacterDef[] =>
  characters.filter(def => !rostered.length || rostered.some(r => sameName(r, def.name)));

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

// -- THE WRITER'S REPLY -----------------------------------------------------
/** One consult as the writer's reply carries it: who it is for ("" when the reply does not say),
 *  the situation/question/wants as given, and the fan-out reactors when it is one. `reactors` is
 *  null when the reply carried no reactors key at all — an empty array is a fan-out with no
 *  reactors, which the gate refuses, not a single consult. Each reactor keeps its own `situation`
 *  override where the writer gave one (a reactor who only heard, not saw, an event) — flattening
 *  this to bare names would hand every reactor the shared situation regardless of what the writer
 *  wrote for them, including past a restricted sense normalizeReactionConsult exists to guard. */
export interface DraftConsult {
  character: string;
  situation: string;
  question: string;
  wants: string;
  reactors: { name: string; situation?: string }[] | null;
}

/** The writer's reply, as the loop reads it. Every field is defensive: the writer is a model and
 *  the reply may be any shape at all. */
export interface DraftReply {
  prose: string;
  /** The prose was salvaged from a truncated reply, not parsed whole. */
  salvaged: boolean;
  proseWords: number;
  /** `scene_done` as declared — `true`, the string `"true"`, or nothing. */
  sceneDone: boolean;
  consult: DraftConsult | null;
  exit: string;
  promote: string;
}

/** Parse one writer reply: prose (possibly salvaged from a truncated one), the done declaration,
 *  an optional consult, and any exit or promote it declares. */
export function parseDraftReply(raw: string, onProseFallback?: () => void): DraftReply {
  const d = extractJson(raw, how => {
    if (how === "prose_fallback") onProseFallback?.();
  });
  let prose = String(d.prose ?? "").trim();
  let salvaged = false;
  if (!prose) {
    const recovered = salvageProse(raw);
    if (recovered) { prose = recovered; salvaged = true; }
  }
  const c = (d.consult && typeof d.consult === "object") ? d.consult as Record<string, unknown> : null;
  return {
    prose,
    salvaged,
    proseWords: prose ? prose.split(/\s+/).filter(Boolean).length : 0,
    sceneDone: d.scene_done === true || String(d.scene_done ?? "").toLowerCase() === "true",
    consult: !c ? null : {
      character: String(c.character ?? "").trim(),
      situation: String(c.situation ?? "").trim(),
      question: String(c.question ?? "").trim(),
      wants: String(c.wants ?? "").trim(),
      reactors: Array.isArray(c.reactors)
        ? c.reactors
            .map((r: unknown) => {
              const name = String((r as any)?.name ?? (typeof r === "string" ? r : "")).trim();
              const situation = String((r as any)?.situation ?? "").trim();
              return name ? (situation ? { name, situation } : { name }) : null;
            })
            .filter((r): r is { name: string; situation?: string } => r !== null)
        : null,
    },
    exit: String(d.exit ?? "").trim(),
    promote: String(d.promote ?? "").trim(),
  };
}

// -- SCENE LOOP ------------------------------------------------------------
/** Everything the run can report to the viewer and the writing log, as one tagged event each. */
export type RunEvent =
  | ConsultEvent
  | { t: "scene_start"; story: string; characters: string[]; target: number; chapter: number }
  | { t: "draft"; step: number; prose: string; words: number; consulting: string; salvaged: boolean; chapter: number }
  | { t: "bad_consult"; character: string; why: string; chapter: number }
  | { t: "schema_mismatch"; call: "judge" | "clarify" | "lint" | "done"; character: string; chapter: number }
  | { t: "judge_failed"; character: string; why: string; chapter: number }
  | { t: "lint_failed"; why: string; chapter: number }
  | { t: "done_judge_failed"; why: string; chapter: number }
  | { t: "done_flagged"; why: string; chapter: number }
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
  | { t: "world_beat"; beat: string; hold: string; step: number; chapter: number }
  | { t: "beat_stranded"; beat: string; at: number; chapter: number }
  | { t: "memory_surfaced"; character: string; chapter: number }
  | { t: "repeat_strip"; chars: number; words: number; whole: boolean; chapter: number }
  | { t: "done_deferred"; chapter: number }
  | { t: "answer_unwritten"; characters: string[]; stopped: boolean; chapter: number }
  | { t: "scene_end"; steps: number; words: number; done: boolean; stopped: boolean; chapter: number; retries: Record<string, number> };


const OVERRUN_SLACK = 1.5;

// The tail the repeat guard compares a new piece against: the last two pieces, capped. A callback
// to an older beat is legitimate prose; re-emitting where the page ends is the defect.
const REPEAT_TAIL_CHARS = 2000;

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
    const last = lastAsked.get(nameKey(name));
    return last === undefined || step - last >= threshold;
  });
}

/** Everything one writeScene call needs, as one object. The fields mirror what runChapter reads off
 *  a StoryConfig; `scene` is the SceneDef being written and everything else is run-level. */
export interface SceneRun {
  scene: SceneDef;
  chapter: number;
  characters: CharacterDef[];
  agents: Map<string, Agent>;
  premise: string;
  writerStyle: string;
  writerStyleConstraints: string[];
  writerModel: string;
  summaryModel: string;
  thinking: { writer: ThinkLevel; summary: ThinkLevel };
  maxSteps: number;
  maxProseWords: number;
  retries: number;
  clarifications: number;
  dir: string;
  log: (e: RunEvent) => void;
  maxCharacterRetries?: number;
  facts?: string[];
  /** The world-event ledger. Beats aimed at this chapter hold, fire once at their trigger, and
   *  implant their memories into the cast present when they do (world-timeline.ts). */
  timeline?: TimelineDef[];
  /** The human-interaction port (step budget, pause, reader seat). Defaults to LIVE_IO — the
   *  session's LIVE state and SSE bus — so a run can be driven without either. */
  io?: SceneIo;
  /** The special-skill bible the scene's reach resolves against. Defaults to the in-code catalog,
   *  so a hand-built SceneRun needs none; runChapter passes the one the story was loaded with. */
  bible?: BibleLookup;
}

/** Write one scene: the draft/consult loop that stops at choices, consults, judges, and trims history. */
export async function writeScene(run: SceneRun) {
  const { scene: sd, chapter, characters, agents, premise, writerStyle, writerStyleConstraints,
          writerModel, summaryModel, thinking, maxSteps, maxProseWords,
          retries, clarifications, dir, log } = run;
  const maxCharacterRetries = run.maxCharacterRetries;
  const facts = run.facts ?? [];
  const timeline = run.timeline ?? [];
  const io = run.io ?? LIVE_IO;
  const bible = run.bible ?? bibleMeaningOf;
  const roster = rosterOf(characters, sd.roster);
  const rosterNames = roster.map(c => c.name);
  const active = new Set(rosterNames);          // the cast still in the scene; shrinks as one exits
  const isActive = (name: string) => [...active].some(n => sameName(n, name));
  const cast = writerCast(roster, [], Object.fromEntries(roster.map(c => [c.name, sceneReach(sd, c, bible)])));
  const writer = new Agent("WRITER", sd.writerModel ?? writerModel, wrapWriter(premise, sd, cast, writerStyle, facts, writerStyleConstraints), 0.8);
  writer.think = sd.writerThink ?? thinking.writer;
  const defOf = (name: string) => roster.find(c => sameName(c.name, name));
  // A thought reaches the writer only from inside the POV. The narration lint already holds that
  // nobody else's inner life is narratable fact, so a non-POV thought on the writer's desk would
  // only authorize narrating one anyway. It still goes into the character's own history — the
  // thought is their memory and continuity depends on it — and they are never told it may be
  // withheld, because a character writing for an audience is not answering as itself.
  const isPov = (name: string) => !!sd.pov && sameName(sd.pov, name);
  const writerSees = (name: string, thought: string) => isPov(name) ? thought : "";
  LIVE.writer = writer; LIVE.log = log;

  // Each author-side helper has its own name, so it gets its own transcript file, stats row and role
  // tag — and all take `writer.model` at call time, so a mid-run /model swap still reaches them.
  // The four judges are one factory differing only in name and system prompt; the comments below
  // say what each is FOR.
  const newJudgeFor = (name: string, system: string) => {
    const a = new Agent(name, writer.model, system, JUDGE_TEMPERATURE);
    a.think = writer.think;
    return a;
  };
  const newJudge = () => newJudgeFor("JUDGE", P.judgeSystem(cast));
  // Stateless like the judge, but it weighs many volunteered deeds in one call and returns a
  // promotable flag each — so a reaction beat costs at most one judge call, and none when nobody acted.
  const newBatchJudge = () => newJudgeFor("BATCH-JUDGE", P.batchJudgeSystem(cast));
  // Also stateless: checks the piece just drafted against THE ONE RULE, CANNOT, and (when the reply
  // opens a consult) whether the situation names a concrete fact — before any of it reaches the page.
  const newNarrationJudge = () => newJudgeFor("NARRATION-JUDGE", P.narrationLintSystem(cast));
  // The only one of the family that reads the page whole, and the only one with no cast block: it
  // weighs a question against what the prose settled, and no CANNOT bears on whether it was settled.
  const newDoneJudge = () => newJudgeFor("DONE-JUDGE", P.DONE_JUDGE_FORMAT);
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
    const key = `${nameKey(name)}|${situation.trim().toLowerCase()}`;
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
  const granted: GrantedEntry[] = [];
  let steps = 0, budget = maxSteps, done = false, empties = 0;
  let overran = 0;
  // Which world beats have fired this scene, held by entry identity (world-timeline.ts). A beat
  // fires once; its held form stands down the moment it does.
  const beatFired = new Set<TimelineDef>();
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
        const raw = await cl.generate(`${C.magenta}CLARIFIER${C.reset}`, "clarifier.answer", extra);
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

    if (await io.pauseGate()) {
      if (RUN.stopped) break;
      continue;
    }

    if (steps >= budget) {
      const extra = await io.moreSteps(steps, budget, chapter);
      if (!extra) break;
      budget += extra;
      log({ t: "budget", added: extra, budget, chapter });
    }

    if (io.readerTake()) {
      writer.hear(P.askReader(wordCount()));
      let askRaw = "";
      try {
        askRaw = await writer.generate(`${C.magenta}WRITER${C.reset}`, "writer.ask");
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

        const answer = await io.readerAnswer();
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
    // The world timeline: a held event the writer may not start, and — at the trigger — a fired
    // event injected as already true. Zero inference; the decision is world-timeline.ts's, and the
    // implant lands before the instruction so the consult the writer opens in response already
    // reasons from the memory.
    const turn = timelineTurn(timeline, chapter, words, sd.length, beatFired);
    if (turn.fired) {
      beatFired.add(turn.fired);
      console.log(`\n${C.cyan}(world beat fired at step ${steps + 1}, ${words}/${sd.length} words)${C.reset}`);
      log({ t: "world_beat", beat: turn.fired.fired, hold: turn.fired.hold, step: steps + 1, chapter });
      for (const [name, mem] of turn.memories) {
        const def = defOf(name);
        if (!def || !isActive(def.name)) continue;
        const a = agents.get(nameKey(def.name));
        if (!a) continue;
        a.system += P.memorySurfaced(mem);
        a.hear(P.memoryMarker(mem));
        log({ t: "memory_surfaced", character: def.name, chapter });
        if (ENGINE.echoConsole && ENGINE.echoCast) console.log(`${C.dim}(${def.name} remembers)${C.reset}`);
      }
    }
    writer.hear(P.writeInstruction({
      words, target: sd.length, maxProseWords, overran, neglected, hardCap,
      ...(turn.fired ? { fired: turn.fired.fired } : {}),
      ...(turn.hold ? { hold: turn.hold } : {}),
    }));
    let draftRaw: string;
    try {
      draftRaw = await writer.generate(`${C.magenta}WRITER${C.reset}`, "writer.draft");
    } catch (e) {
      if (e instanceof StoppedError || RUN.stopped) break;
      console.log(`\n${C.red}Writer call failed (${(e as Error).message}) — stopping with what we have.${C.reset}`);
      break;
    }
    steps++;

    let reply: DraftReply;
    let stoppedMidLint = false;

    for (let lintAttempt = 0; ; lintAttempt++) {
      reply = parseDraftReply(draftRaw, () => log({ t: "prose_reply", character: writer.name }));
      if (reply.salvaged)
        console.log(`${C.yellow}(recovered a truncated draft — ${reply.prose.split(/\s+/).length} words)${C.reset}`);

      // -- NARRATION LINT: check before anything is committed to the page. Nothing drafted and
      // nothing asked ⇒ nothing to lint, same as the empty/asked-nobody path below.
      if (!reply.prose && !reply.consult) break;

      const ask = reply.consult;
      const outgoingConsult = ask ? {
        character: ask.character || undefined,
        reactors: ask.reactors?.length ? ask.reactors.map(r => r.name) : undefined,
        situation: ask.situation,
        question: ask.question,
      } : null;

      // A deed this same reply promotes was volunteered last beat and is the writer's to render — the
      // promote itself is processed a few lines below, once the piece survives the lint. Without it
      // in evidence the lint flags the writer for using exactly what it was entitled to.
      const promoteDef = reply.promote ? defOf(reply.promote) : undefined;
      const promoted = promoteDef ? pendingReactionActions.get(nameKey(promoteDef.name)) : undefined;
      const lintGranted = promoted && promoteDef
        ? [...granted, { character: promoteDef.name, speech: "", action: promoted }]
        : granted;

      const flagged = await lintPiece({
        prose: reply.prose, granted: lintGranted, cast, pov: sd.pov,
        consult: outgoingConsult, newNarrationJudge, log, chapter,
      });

      if (!flagged) break;

      const retried = lintAttempt >= NARRATION_LINT_RETRIES;
      log({ t: "narration_flag", why: flagged, retried, chapter });
      console.log(`${C.yellow}(narration flagged — ${flagged.split(". ")[0]}.)${C.reset}`);
      if (retried) break;   // one redraft only — accept whatever comes back next

      writer.hear(P.narrationFlagged(flagged));
      try {
        draftRaw = await writer.generate(`${C.magenta}WRITER${C.reset}`, "writer.redraft");
      } catch (e) {
        if (e instanceof StoppedError || RUN.stopped) { stoppedMidLint = true; break; }
        console.log(`\n${C.red}Writer redraft call failed (${(e as Error).message}) — keeping the flagged piece.${C.reset}`);
        break;
      }
      steps++;
    }
    if (stoppedMidLint) break;

    // -- REPEAT GUARD: a piece that opens by re-emitting the page's tail is stripped back to its
    // new text before anything records it — the doorway run appended a verbatim repeat of its
    // opening paragraph plus one new sentence, so the scene opened with the paragraph twice. It
    // runs after the lint (a redraft is checked like any other draft) and before the push, the
    // writer's history and the draft event, so the page and everything the writer reads back carry
    // the kept text. No model call; repeat-lint declines rather than cutting mid-sentence, so it
    // only ever removes a prefix it is confident about.
    if (reply.prose && pieces.length) {
      const tail = pieces.slice(-2).join("\n\n").slice(-REPEAT_TAIL_CHARS);
      const strip = stripRepeatedPrefix(reply.prose, tail);
      if (strip) {
        reply.prose = strip.kept;
        reply.proseWords = strip.kept ? strip.kept.split(/\s+/).filter(Boolean).length : 0;
        log({ t: "repeat_strip", chars: strip.chars, words: strip.words, whole: strip.whole, chapter });
        console.log(`${C.yellow}(repeat stripped — the piece opened with ${strip.words} words `
          + `already on the page${strip.whole ? "; nothing new was written" : ""})${C.reset}`);
      }
    }

    overran = reply.proseWords > maxProseWords * OVERRUN_SLACK ? reply.proseWords : 0;
    // A beat written after the answers landed is the writing turn they were owed; the consults this
    // same reply opens are answered further down and start the count over.
    if (reply.prose) { pieces.push(reply.prose); owed = []; }
    // The writer's own turn, as it will read it back next time. It keeps what was asked — who, the
    // situation, question and shape — not just who: the answer arrives as bare thought/speech/action,
    // and "No" or "the left one" means nothing against a draft that no longer says what was asked.
    // One `consult` key holds all of it — two spreads used to collide, dropping the name whenever a
    // reply carried both a consult and a fan-out.
    const ask = reply.consult;
    const askedRecord = ask ? {
      ...(ask.character ? { character: ask.character } : {}),
      ...(ask.reactors?.length ? { reactors: ask.reactors.map(r => r.name) } : {}),
      ...(ask.situation ? { situation: ask.situation } : {}),
      ...(ask.question ? { question: ask.question } : {}),
      ...(ask.wants ? { wants: ask.wants } : {}),
    } : null;
    writer.said(JSON.stringify({ prose: reply.prose,
      ...(askedRecord ? { consult: askedRecord } : {}),
      scene_done: reply.sceneDone }));
    log({ t: "draft", step: steps, prose: reply.prose, words: wordCount(),
          consulting: ask?.character ?? "", salvaged: reply.salvaged, chapter });
    if (reply.prose && ENGINE.echoConsole) console.log(`\n${reply.prose}\n`);

    // -- PROMOTE: the writer turns one deed a reactor volunteered last beat into canon. Done before
    // the consult below, so this beat's own fan-out (if any) can re-arm the offer afterward. The
    // offer is one-shot — read here, then cleared whether or not it was taken.
    if (reply.promote && pendingReactionActions.size) {
      const def = defOf(reply.promote);
      const action = def ? pendingReactionActions.get(nameKey(def.name)) : undefined;
      const persistent = def ? agents.get(nameKey(def.name)) : undefined;
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
    let asked = false;
    if (ask?.reactors) {
      // -- REACTION FAN-OUT: one shared beat, several present-but-not-acting characters react at once.
      // Each runs an isolated consult (never seeing another's reply); the writer gets them together.
      asked = await reactionFanout({
        reactors: ask.reactors, situation: ask.situation, question: ask.question, cast,
        defOf, agents, isActive, isPov, writerSees,
        clarifications, clarify, beginAttempt, keepClarifications, dropClarifications,
        refusalFor, writer, granted, pendingReactionActions, lastAsked, owed,
        step: steps, chapter, newBatchJudge, log, stopped: () => RUN.stopped,
      });
    } else if (ask?.character) {
      const who = ask.character;
      const def = defOf(who);
      const persistent = agents.get(nameKey(who));
      const check = def ? normalizeConsult({ ...ask, character: def.name }, cast) : null;
      if (!def || !persistent) {
        writer.hear(P.noSuchCharacter(who, [...active]));
      } else if (!isActive(def.name)) {
        console.log(`${C.yellow}(not sent to ${def.name} — they have left the scene.)${C.reset}`);
        writer.hear(P.consultExited(def.name));
      } else if (!check!.ok) {
        log({ t: "bad_consult", character: def.name, why: check!.why, chapter });
        console.log(`${C.yellow}(not sent to ${def.name} — ${check!.why.split(". ")[0]}.)${C.reset}`);
        writer.hear(refusalFor(check!.why, def.name, ask.situation));
      } else {
        asked = true;
        const { reply, failed, usedAttempt, req } = await judgeGate({
          def, agent: persistent, req: check!.req, cast, retries, maxCharacterRetries,
          clarifications, clarify, pov: isPov(def.name), chapter,
          retryCounts, newJudge, beginAttempt, dropClarifications, log,
        });

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
          lastAsked.set(nameKey(def.name), steps);
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
    if (reply.exit && !reply.prose) {
      const name = defOf(reply.exit)?.name ?? reply.exit;
      log({ t: "exit_refused", character: name, chapter });
      console.log(`${C.yellow}(${name} was declared gone in a reply that wrote nothing — nobody has left.)${C.reset}`);
      writer.hear(P.exitNotWritten(name));
    } else if (reply.exit) {
      const name = defOf(reply.exit)?.name ?? reply.exit;
      if (isActive(name)) {
        for (const n of [...active]) if (sameName(n, name)) active.delete(n);
        const pov = !!sd.pov && sameName(sd.pov, name);
        log({ t: "exit", character: name, pov, chapter });
        console.log(`${C.dim}(${name} has left the scene${pov ? " — the point of view, so the chapter ends here" : ""})${C.reset}`);
        if (pov) done = true;
      }
    }

    if (!reply.prose && !asked) {
      if (++empties >= 3) { console.log(`${C.red}Writer wrote nothing and asked nobody, three times — stopping.${C.reset}`); break; }
    } else empties = 0;

    // A reply that ends the scene while its consult is still open would leave an answer unwritten —
    // whether it declares done or hits the hard cap. Hold the scene open one more turn so the
    // answer is written in; the scene closes after that turn whatever it produces.
    // `sceneEnded` starts as the reply declared it; the deferral clears it because the turn being
    // held open is not itself the ending.
    let sceneEnded = reply.sceneDone;
    const deferredNow = (sceneEnded || hardCap) && owed.length > 0 && !closing;
    if (deferredNow) {
      const why = sceneEnded ? "done" : "cap";
      sceneEnded = false;
      closing = true;
      writer.hear(P.answerStillOwed(why));
      log({ t: "done_deferred", chapter });
      console.log(`${C.yellow}(scene ending with a consult open — holding the scene open `
        + `to write the answer in)${C.reset}`);
    }

    // The writer is the only witness to whether the scene's question was answered, and a standoff is
    // the cheapest way out of a hard scene: live runs close `done: true` with the very thing the
    // scene existed to settle still open on the last line. One call reads the page back against the
    // question when the writer declares it over, and records the verdict.
    //
    // It records; it does not hold the scene open. It did once, and the refusal was a nudge nobody
    // could satisfy: told the question was unanswered, the writer wrote four more steps of the same
    // deadlock and never declared done again, turning a bad ending into no ending at all. A deadlock
    // is broken by somebody choosing differently, which is not the writer's to write — so a refusal
    // names a lever the writer does not hold. Re-arm this as a gate when a refusal can arrive with
    // one.
    //
    // Only an ending the writer chose is checked: the hard cap and a spent budget are budget rather
    // than judgement. A scene with no question of its own has nothing to check against.
    if (!deferredNow && (sceneEnded || closing) && pieces.length && sd.question.trim()) {
      let unanswered = "";
      try {
        const doneJudge = newDoneJudge();
        const extra: Msg[] = [{ role: "user", content: P.doneJudgeRequest({
          question: sd.question, prose: pieces.join("\n\n") }) }];
        for (let tries = 0; ; tries++) {
          const raw = await doneJudge.generate(`${C.magenta}DONE-JUDGE${C.reset}`, "judge.done", extra);
          const verdict = parseLintVerdict(extractJson(raw));
          if (verdict) {
            if (!verdict.ok) unanswered = verdict.why || "the scene's question is not answered";
            break;
          }
          // Asked twice with no verdict: nothing is recorded, as on an outage. A check nobody made
          // must not read as a check that passed, so the log says which of the two happened.
          if (tries) break;
          log({ t: "schema_mismatch", call: "done", character: "(scene)", chapter });
          extra.push({ role: "assistant", content: raw.trim() },
                     { role: "user", content: P.DONE_ONLY });
        }
      } catch (e) {
        if (!(e instanceof StoppedError) && !RUN.stopped) {
          log({ t: "done_judge_failed", why: (e as Error).message, chapter });
          console.log(`${C.yellow}(scene-done judge failed: ${(e as Error).message})${C.reset}`);
        }
      }
      if (unanswered) {
        log({ t: "done_flagged", why: unanswered, chapter });
        console.log(`${C.yellow}(the scene ends without answering its question: ${unanswered})${C.reset}`);
      }
    }

    // The turn that armed `closing` is the one being held open, so nothing closes the scene on it —
    // not the hard cap either, or the answer would be owed to a page that never comes.
    if (deferredNow) {
      // held open
    } else if (sceneEnded && !reply.prose && pieces.length === 0 && !blankDone && !closing) {
      blankDone = true;
      writer.hear(P.blankSceneRefused);
      console.log(`${C.yellow}(scene done declared with nothing on the page yet — holding it open)${C.reset}`);
    } else if (sceneEnded || closing) {
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
      const a = agents.get(nameKey(def.name));
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

  // A beat aimed at this chapter that never fired: the scene ended before its trigger, or ended
  // early. Nothing else in the record says so, and the handoff has no other way to know there is
  // something left to re-aim.
  for (const b of timeline)
    if (b.chapter === chapter && b.state !== "void" && !beatFired.has(b)) {
      log({ t: "beat_stranded", beat: b.fired, at: b.at, chapter });
      console.log(`${C.yellow}(the scene ended without the world event ever firing: ${b.fired})${C.reset}`);
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
    agents.set(nameKey(def.name), newCharacterAgent(def, sd.place, sc.thinking.character, sceneReach(sd, def, sc.bible)));
  }

  LIVE.agents = agents;

  try {
    return await writeScene({
      scene: sd, chapter, characters: sc.characters, agents,
      premise: sc.premise, writerStyle: sc.writerStyle, writerStyleConstraints: sc.writerStyleConstraints,
      writerModel: sc.models.writer, summaryModel: sc.models.summary,
      thinking: sc.thinking, maxSteps: sc.maxSteps, maxProseWords: sc.maxProseWords,
      retries: sc.retries, clarifications: sc.clarifications,
      dir: sc.dir, log, maxCharacterRetries: sc.maxCharacterRetries,
      facts: sc.facts,
      timeline: sc.timeline,
      bible: sc.bible,
    });
  } finally {
    LIVE.writer = null; LIVE.agents = null; LIVE.log = null;
  }
}
