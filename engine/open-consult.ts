/**
 * OPEN-CONSULT — CLI-only prototype: a freetext pressure-test chat between an
 * author-side consult agent and a character fork.
 *
 * The consult agent knows a PRESSURE (a narrative problem + stakes, never a
 * desired outcome) and the character's skills/limits. It raises stakes and
 * resolves ambiguity; it must never suggest solutions or veto a valid
 * divergent decision (refusal, walk-out, hostility). Veto is legitimate only
 * for skill/fact breaks or no legible stance.
 *
 * The character is pure freetext throughout — it never tags, labels, or
 * closes anything itself. Only the consult side ever emits a trailing
 * `DONE:` block, and only as a transcription of the character's own last
 * reply into the thought/speech/action/note shape the writer needs (plain
 * `key: value` lines, not JSON — a brace-and-quote example primes even an
 * instructed-not-to model to imitate it from the first turn). A VETO judges
 * the character's last reply and is only legitimate when `lintCharacter`
 * evidences a break; a veto over a valid divergent stance is recorded as
 * vetoOverDivergence, a coercion failure. Budget exhaustion still guarantees
 * a structured answer: one final "transcribe now" turn is put to the
 * consult agent outside the round budget, so the writer always gets a
 * stance even when the chat itself never resolved.
 *
 * The full transcript is retained verbatim — no folding/trimming in this
 * experiment; the transcript IS the data. The gated path (consult(),
 * judge-gate, scene-loop) is untouched. This module never touches
 * Agent.generate (which forces a "{" JSON prefix); it chats freetext via
 * complete(), with an injectable driver so tests run without an LLM.
 */
import { complete, type Msg } from "./llm-client.ts";
import { extractJson } from "./json-extract.ts";
import {
  CONSULT_DONE_TAG,
  CONSULT_VETO_TAG,
  consultSuggestsSolution,
  stancePolarity,
} from "../prompts/open-consult.ts";
import type { ThinkLevel } from "./story-schema.ts";

/** One side of the chat: identity + system prompt + sampling knobs. The
 *  character side uses openCharacterSystem(); the consult side uses
 *  openConsultSystem(). */
export interface OpenParticipant {
  name: string;
  model: string;
  system: string;
  temperature?: number;
  think?: ThinkLevel;
}

/** (participant, history-without-system) -> freetext reply. Injected in tests. */
export type OpenChatDriver = (p: OpenParticipant, history: Msg[]) => Promise<string>;

/** Production driver: freetext completion, no "{" prefix. */
export const defaultOpenChatDriver: OpenChatDriver = async (p, history) => {
  const { text } = await complete(
    p.model,
    [{ role: "system", content: p.system }, ...history],
    p.temperature ?? 0.85,
    p.think ?? "low",
    { site: "open-consult.chat", agent: p.name },
  );
  return text;
};

/** Evidence of a skill/fact break in a character message; null = clean.
 *  Production CLI builds one from the character's CANNOT list (substring
 *  match); tests inject scripted checkers. Absent checker = no evidence. */
export type CharacterLint = (text: string) => string | null;

export interface OpenStance {
  thought: string;
  speech: string;
  action: string;
  note: string;
}

export interface OpenTurn {
  from: "consult" | "character";
  text: string;
  round: number;
}

export interface OpenCoercion {
  /** Consult turns that suggested a solution/option (brief forbids all). */
  suggestions: number;
  /** Character stance polarity flips between consecutive character turns. */
  stanceShifts: number;
  /** Consult vetoes over valid divergent stances (must be 0; overruled). */
  vetoOverDivergence: number;
  /** Breaks the lint evidenced that consult accepted without challenge. */
  missedViolations: number;
}

export interface OpenConsultResult {
  stance: OpenStance;
  transcript: OpenTurn[];
  roundsUsed: number;
  /** Always "consult": the character never closes. "budget" is the forced,
   *  post-budget transcription when the chat never resolved on its own. */
  endedBy: "consult" | "budget";
  forced: boolean;
  vetoes: number;
  skillFlags: string[];
  coercion: OpenCoercion;
}

export const OPEN_CONSULT_BUDGET = 10;

const EMPTY_STANCE: OpenStance = { thought: "", speech: "", action: "", note: "" };

/** A field left as the prompt's own "(none)"/"n/a"/"--" placeholder reads as absent, not as text. */
const NONE_PLACEHOLDER = /^\(?(?:none|n\/a)\)?$|^--?$/i;
const orEmpty = (v: unknown): string => {
  const s = String(v ?? "").trim();
  return NONE_PLACEHOLDER.test(s) ? "" : s;
};

/**
 * Parse a trailing `DONE:` close block. Returns the stance, or null when
 * there is no DONE line or its payload carries no stance (malformed DONE is
 * an ordinary message, never a termination — the parseVerdict discipline).
 * The payload is normally plain `key: value` lines (what the prompts ask
 * for — see prompts/open-consult.ts); a JSON object still parses too, since
 * extractJson() reads either shape.
 */
export function parseOpenDone(text: string): OpenStance | null {
  const lines = text.split("\n");
  const idx = lines.findIndex(l => l.trim().startsWith(CONSULT_DONE_TAG));
  if (idx < 0) return null;
  const tail = lines
    .slice(idx)
    .join("\n")
    .slice(CONSULT_DONE_TAG.length)
    .trim();
  if (!tail) return null;
  const o = extractJson(tail);
  const stance: OpenStance = {
    thought: orEmpty(o.thought),
    speech: orEmpty(o.speech),
    action: orEmpty(o.action),
    note: orEmpty(o.note),
  };
  if (!stance.thought && !stance.speech && !stance.action) return null;
  return stance;
}

/** True when a consult message opens with a `VETO:` control line. */
export function parseOpenVeto(text: string): string | null {
  const line = text.split("\n").find(l => l.trim().startsWith(CONSULT_VETO_TAG));
  if (!line) return null;
  return line.trim().slice(CONSULT_VETO_TAG.length).trim() || "(no reason given)";
}

/** Strip a trailing DONE block before forwarding consult->character: the
 *  close marker is harness protocol, not something the character reads. */
function stripDoneForForward(text: string): string {
  const idx = text.split("\n").findIndex(l => l.trim().startsWith(CONSULT_DONE_TAG));
  if (idx < 0) return text;
  return text.split("\n").slice(0, idx).join("\n").trim() || text;
}

export interface RunOpenConsultOpts {
  character: OpenParticipant;
  consult: OpenParticipant;
  /** The moment, in the character's terms (also given to consult as context). */
  situation: string;
  /** Narrative problem + stakes (consult side only; never forwarded). */
  pressure: string;
  budget?: number;
  chat?: OpenChatDriver;
  lintCharacter?: CharacterLint;
}

/** Run one pressure-test chat. Histories are local to the run; the caller's
 *  agents are never mutated (pass forks or fresh participants). */
export async function runOpenConsult(o: RunOpenConsultOpts): Promise<OpenConsultResult> {
  const budget = o.budget ?? OPEN_CONSULT_BUDGET;
  const chat = o.chat ?? defaultOpenChatDriver;
  const lint = o.lintCharacter ?? null;

  const transcript: OpenTurn[] = [];
  const consultHist: Msg[] = [];
  const charHist: Msg[] = [];
  const skillFlags: string[] = [];
  const coercion: OpenCoercion = { suggestions: 0, stanceShifts: 0, vetoOverDivergence: 0, missedViolations: 0 };
  let vetoes = 0;
  let lastPolarity: -1 | 0 | 1 | null = null;

  const lastCharText = () => charHist.length ? charHist[charHist.length - 1].content : "";

  const noteCharacterTurn = (text: string) => {
    if (lint) {
      const hit = lint(text);
      if (hit && !skillFlags.includes(hit)) skillFlags.push(hit);
    }
    const pol = stancePolarity(text);
    if (lastPolarity !== null && pol !== 0 && lastPolarity !== 0 && pol !== lastPolarity)
      coercion.stanceShifts++;
    if (pol !== 0) lastPolarity = pol;
  };

  const noteConsultTurn = (text: string) => {
    if (consultSuggestsSolution(text)) coercion.suggestions++;
  };

  // Opening: consult speaks first from the pressure brief; the character only
  // ever sees pressing/veto turns forwarded to it, in plain prose — it never
  // tags, labels, or closes anything itself (module docstring).
  for (let round = 1; round <= budget; round++) {
    const consultIn = round === 1
      ? `[PRESSURE BRIEF — yours alone, never quote it]\n${o.pressure}\n\n[THEIR MOMENT]\n${o.situation}\n\nPress once. No narration, no commentary — one sentence of pressure, then ask what is unclear.`
      : `They said:\n${lastCharText()}\n\nPress further, or — if their stance is stable and legible — `
        + `transcribe it now as your own DONE block for the writer. If it breaks a skill/fact or is `
        + `illegible, open with VETO: <reason> and one consistency question instead. No narration, `
        + `no solutions, no options.`;
    consultHist.push({ role: "user", content: consultIn });
    const consultText = (await chat(o.consult, consultHist)).trim();
    consultHist.push({ role: "assistant", content: consultText });
    transcript.push({ from: "consult", text: consultText, round });
    noteConsultTurn(consultText);

    // Consult closes: its DONE is a transcription of the character's own
    // last reply — the only place a stance ever becomes structured. A DONE
    // with no parseable stance is an ordinary message (malformed never ends).
    const consultDone = parseOpenDone(consultText);
    if (consultDone) {
      const missed = lint?.(lastCharText()) ?? null;
      if (missed) coercion.missedViolations++;
      return {
        stance: consultDone, transcript, roundsUsed: round,
        endedBy: "consult", forced: false, vetoes, skillFlags, coercion,
      };
    }

    // A VETO judges the character's last reply — nothing to veto on round 1,
    // before the character has spoken at all.
    if (round > 1) {
      const vetoReason = parseOpenVeto(consultText);
      if (vetoReason) {
        const violation = lint?.(lastCharText()) ?? null;
        if (violation) {
          vetoes++;
          if (!skillFlags.includes(violation)) skillFlags.push(violation);
        } else {
          // Veto over a valid divergent stance: coercion failure, but the
          // chat is not forced to end here — the character still reads the
          // challenge and answers again, same as any other press.
          coercion.vetoOverDivergence++;
        }
      }
    }

    // Forward to the character verbatim — pressing or a veto challenge are
    // both things it legitimately reads; a stray DONE fragment from a
    // malformed close is not.
    const fwd = stripDoneForForward(consultText);
    charHist.push({ role: "user", content: fwd });
    const charText = (await chat(o.character, charHist)).trim();
    charHist.push({ role: "assistant", content: charText });
    transcript.push({ from: "character", text: charText, round });
    noteCharacterTurn(charText);
  }

  // Budget exhausted without a close: one guaranteed final transcription, so
  // the writer always gets a structured stance even when the chat itself
  // never resolved. This step formats — it must not press or challenge.
  consultHist.push({
    role: "user",
    content: `Budget spent. Do not challenge or press further. Transcribe their last reply into your `
      + `DONE block for the writer exactly as they gave it — do not invent or improve on it:\n\n${lastCharText()}`,
  });
  const forceText = (await chat(o.consult, consultHist)).trim();
  consultHist.push({ role: "assistant", content: forceText });
  transcript.push({ from: "consult", text: forceText, round: budget });
  const forced = parseOpenDone(forceText);
  if (forced) {
    const missed = lint?.(lastCharText()) ?? null;
    if (missed) coercion.missedViolations++;
  }
  return {
    stance: forced ?? EMPTY_STANCE, transcript, roundsUsed: budget,
    endedBy: "budget", forced: true, vetoes, skillFlags, coercion,
  };
}
