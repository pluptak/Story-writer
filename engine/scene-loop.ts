/** SCENE LOOP — the writer's draft/consult loop: character and writer agent wrapping, and writeScene(). */
import { createInterface } from "node:readline/promises";
import * as P from "../prompts.ts";
import { C } from "../ansi.ts";
import { Agent, trimHistory } from "./agent.ts";
import { extractJson, salvageProse } from "./json-extract.ts";
import { canonSkill, SKILL_CATALOG } from "./skills.ts";
import { type CharacterDef, type StoryConfig } from "./story-format.ts";
import {
  consult, normalizeConsult, canonWants,
  type ConsultEvent, type ConsultRequest, type ConsultReply,
} from "./consult.ts";
import { LIVE, RUN, StoppedError, sseWrite, sseClients, runState } from "../live.ts";
import { ENGINE, progressDone } from "./engine-state.ts";

// -- CHARACTER AGENT -------------------------------------------------------
export function wrapCharacter(def: CharacterDef, place: string): string {
  return P.characterSystem({
    persona: def.persona, place, skills: def.skills, knows: def.knows, goal: def.goal,
  });
}

export function buildCharacterAgents(sc: StoryConfig): Map<string, Agent> {
  const agents = new Map<string, Agent>();
  for (const def of sc.characters) {
    const a = new Agent(def.name, def.model, wrapCharacter(def, sc.scene.place), 0.9);
    a.think = sc.thinking.character;
    agents.set(def.name.toLowerCase(), a);
  }
  return agents;
}

// -- WRITER AGENT ----------------------------------------------------------
export function wrapWriter(sc: StoryConfig): string {
  const general = Object.keys(SKILL_CATALOG);
  return P.writerSystem({
    premise: sc.premise,
    scene: sc.scene,
    cast: sc.characters.map(c => ({
      name: c.name,
      can: c.skills.map(s => s.name),
      cannot: general.filter(g => !c.skills.some(s => canonSkill(s.name) === canonSkill(g))),
    })),
    style: sc.writerStyle,
  });
}

// -- SCENE LOOP ------------------------------------------------------------
export type RunEvent =
  | ConsultEvent
  | { t: "scene_start"; story: string; characters: string[]; target: number }
  | { t: "draft"; step: number; prose: string; words: number; consulting: string; salvaged: boolean }
  | { t: "bad_consult"; character: string; why: string }
  | { t: "judge"; character: string; verdict: string; note: string; attempt: number }
  | { t: "accept"; character: string; attempt: number; speech: string; action: string }
  | { t: "retry"; character: string; attempt: number; situation: string; question: string }
  | { t: "budget"; added: number; budget: number }
  | { t: "reader_ask"; step: number; framing: string; options: string[] }
  | { t: "reader_answer"; answer: string }
  | { t: "model_changed"; model: string }
  | { t: "scene_end"; steps: number; words: number; done: boolean; stopped: boolean };


async function askMoreSteps(steps: number, budget: number): Promise<number> {
  if (RUN.stopped) return 0;
  if (!LIVE.interactive) {
    console.log(`\n${C.yellow}Step budget (${budget}) spent and the scene is not finished. `
      + `Stopping — interactive is off.${C.reset}`);
    return 0;
  }
  if (sseClients.size) {
    LIVE.awaitingContinue = { steps, budget };
    progressDone();
    console.log(`\n${C.yellow}Budget spent — waiting on the viewer.${C.reset}`);
    sseWrite({ t: "continue_prompt", steps, budget, suggested: 8 });
    return new Promise<number>(resolve => { LIVE.continueResolve = resolve; });
  }
  if (!process.stdin.isTTY) {
    console.log(`\n${C.yellow}Step budget (${budget}) spent and the scene is not finished. `
      + `Stopping — nobody to ask.${C.reset}`);
    return 0;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question(`\n${C.yellow}${steps} steps used and the scene is not done. `
    + `How many more? [8, 0 to stop]: ${C.reset}`)).trim();
  rl.close();
  const n = ans === "" ? 8 : Number(ans);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

const OVERRUN_SLACK = 1.5;

const NEGLECT_GAP = 3;

export function neglectedCast(cast: string[], lastAsked: Map<string, number>, step: number, gap: number): string[] {
  if (step < gap) return [];
  return cast.filter(name => {
    const last = lastAsked.get(name.toLowerCase());
    return last === undefined || step - last >= gap;
  });
}

export async function writeScene(sc: StoryConfig, log: (e: RunEvent) => void) {
  const writer = new Agent("WRITER", sc.models.writer, wrapWriter(sc), 0.8);
  writer.think = sc.thinking.writer;
  const agents = buildCharacterAgents(sc);
  const defOf = (name: string) => sc.characters.find(c => c.name.toLowerCase() === name.trim().toLowerCase());
  LIVE.writer = writer; LIVE.agents = agents; LIVE.log = log;

  const pieces: string[] = [];
  const wordCount = () => pieces.join(" ").split(/\s+/).filter(Boolean).length;
  const lastAsked = new Map<string, number>();
  let steps = 0, budget = sc.maxSteps, done = false, empties = 0;
  let overran = 0;

  log({ t: "scene_start", story: sc.dir, characters: sc.characters.map(c => c.name), target: sc.scene.length });

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
      const extra = await askMoreSteps(steps, budget);
      if (!extra) break;
      budget += extra;
      log({ t: "budget", added: extra, budget });
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
        log({ t: "reader_ask", step: steps, framing, options });
        console.log(`\n${C.cyan}(waiting on the reader — ${options.length} direction(s) offered)${C.reset}`);

        const answer = await new Promise<string>(resolve => { LIVE.readerResolve = resolve; });
        if (RUN.stopped) break;
        if (answer) {
          log({ t: "reader_answer", answer });
          writer.hear(P.readerChose(answer));
        }
      }
      continue;
    }

    const words = wordCount();
    const neglected = neglectedCast(sc.characters.map(c => c.name), lastAsked, steps, NEGLECT_GAP);
    writer.hear(P.writeInstruction({
      words, target: sc.scene.length, maxProseWords: sc.maxProseWords, overran, neglected,
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
    const d = extractJson(draftRaw);
    let prose = String(d.prose ?? "").trim();
    let salvaged = false;
    if (!prose) {
      const recovered = salvageProse(draftRaw);
      if (recovered) {
        prose = recovered; salvaged = true;
        console.log(`${C.yellow}(recovered a truncated draft — ${recovered.split(/\s+/).length} words)${C.reset}`);
      }
    }
    const sceneDone = d.scene_done === true || String(d.scene_done ?? "").toLowerCase() === "true";
    const c = (d.consult && typeof d.consult === "object") ? d.consult as Record<string, unknown> : null;
    const who = c ? String(c.character ?? "").trim() : "";

    const proseWords = prose ? prose.split(/\s+/).filter(Boolean).length : 0;
    overran = proseWords > sc.maxProseWords * OVERRUN_SLACK ? proseWords : 0;
    if (prose) pieces.push(prose);
    writer.said(JSON.stringify({ prose, ...(who ? { consult: { character: who } } : {}), scene_done: sceneDone }));
    log({ t: "draft", step: steps, prose, words: wordCount(), consulting: who, salvaged });
    if (prose && !ENGINE.serve) console.log(`\n${prose}\n`);

    // -- CONSULT (with accept / retry)
    let asked = false;                   // did anyone actually get consulted this step?
    if (who) {
      const def = defOf(who);
      const persistent = agents.get(who.toLowerCase());
      const check = def ? normalizeConsult({ ...c!, character: def.name }) : null;
      if (!def || !persistent) {
        writer.hear(P.noSuchCharacter(who, sc.characters.map(x => x.name)));
      } else if (!check!.ok) {
        log({ t: "bad_consult", character: def.name, why: check!.why });
        console.log(`${C.yellow}(not sent to ${def.name} — ${check!.why.split(". ")[0]}.)${C.reset}`);
        writer.hear(P.consultNotSent(check!.why, def.name));
      } else {
        asked = true;
        let req: ConsultRequest = check!.req;
        let reply: ConsultReply | null = null;
        let usedAttempt = 1;
        let failed = "";

        for (let attempt = 1; ; attempt++) {
          usedAttempt = attempt;
          const agent = attempt === 1 ? persistent : persistent.fork();
          try {
            reply = await consult(agent, req, def.skills, {
              clarifications: sc.clarifications, attempt, log,
              clarify: async (q, r) => {
                let a = "";
                try {
                  const raw = await writer.generate(`${C.magenta}WRITER${C.reset}`, [{
                    role: "user", content: P.clarifyRequest(r.character, q, r.situation),
                  }]);
                  a = String(extractJson(raw).answer ?? "").trim();
                } catch (e) {
                  console.log(`${C.red}(clarification call failed: ${(e as Error).message})${C.reset}`);
                  return "";     // consult turns this into "(no answer)" and the character answers anyway
                }
                writer.hear(P.characterAsks(r.character, q));
                writer.said(JSON.stringify({ answer: a }));
                return a;
              },
            });
          } catch (e) {
            failed = (e as Error).message;
            break;
          }

          const flags = P.answerFlags(reply);
          let j: Record<string, any> = {};
          try {
            const judgeRaw = await writer.generate(`${C.magenta}WRITER${C.reset}`, [{
              role: "user",
              content: P.judgeRequest({
                name: def.name, question: req.question, thought: reply.thought,
                speech: reply.speech, action: reply.action, note: reply.note, flags,
              }),
            }]);
            j = extractJson(judgeRaw);
          } catch (e) {
            console.log(`${C.red}(judge call failed: ${(e as Error).message} — accepting)${C.reset}`);
          }
          const verdict = String(j.verdict ?? "accept").trim().toLowerCase() === "retry" ? "retry" : "accept";
          const note = String(j.note ?? "").trim();
          log({ t: "judge", character: def.name, verdict, note, attempt });

          if (verdict === "accept" || attempt > sc.retries) {
            if (verdict === "retry") console.log(`${C.dim}(retries spent — taking ${def.name}'s last answer)${C.reset}`);
            break;
          }
          const rev = (j.revised && typeof j.revised === "object") ? j.revised as Record<string, unknown> : {};
          req = {
            character: def.name,
            situation: String(rev.situation ?? "").trim() || req.situation,
            question: String(rev.question ?? "").trim() || req.question,
            wants: canonWants(rev.wants) ?? req.wants,
          };
          console.log(`${C.yellow}retry ${attempt}/${sc.retries} — ${def.name}${C.reset}${note ? ` ${C.dim}(${note})${C.reset}` : ""}`);
          log({ t: "retry", character: def.name, attempt, situation: req.situation, question: req.question });
        }

        if (RUN.stopped) break;

        const stalled = !!reply && !reply.thought && !reply.speech && !reply.action;
        if (failed || !reply || stalled) {
          const why = failed || (stalled ? reply!.note || "did not answer" : "no reply");
          console.log(`${C.red}${def.name}: ${why}.${C.reset}`);
          writer.hear(P.noAnswer(def.name, why));
        } else {
          persistent.hear(P.askBlock(req) + P.clarificationTrail(reply.clarifications));
          persistent.said(JSON.stringify({ thought: reply.thought, speech: reply.speech, action: reply.action }));
          writer.hear(P.characterAnswered(def.name, P.answerBody(reply)));
          lastAsked.set(def.name.toLowerCase(), steps);
          log({ t: "accept", character: def.name, attempt: usedAttempt, speech: reply.speech, action: reply.action });
          if (!ENGINE.serve) console.log(`${C.cyan}${def.name}${C.reset} ${C.dim}→${C.reset} `
            + (reply.speech ? `"${reply.speech}" ` : "") + (reply.action ? `${C.dim}${reply.action}${C.reset}` : ""));
        }
      }
    }

    if (!prose && !asked) {
      if (++empties >= 3) { console.log(`${C.red}Writer wrote nothing and asked nobody, three times — stopping.${C.reset}`); break; }
    } else empties = 0;

    if (sceneDone) done = true;
    if (RUN.stopped) break;              // don't spend summary calls on a run that is over
    await trimHistory(writer, sc.models.summary, sc.thinking.summary);
    for (const a of agents.values()) await trimHistory(a, sc.models.summary, sc.thinking.summary);
  }

  log({ t: "scene_end", steps, words: wordCount(), done, stopped: RUN.stopped });
  LIVE.writer = null; LIVE.agents = null; LIVE.log = null;
  return { prose: pieces, steps, words: wordCount(), done, stopped: RUN.stopped };
}
