/**
 * ENGINE-STATE — mutable run knobs shared across module boundaries (LM client, Agent, scene
 * loop, CLI entry). A bare exported `let` can't be reassigned from outside its defining
 * module, so — like LIVE in live.ts — these live as fields on one exported object.
 */
import { type WriteStream } from "node:fs";

/** Mutable run knobs shared across the engine: stream/debug/echo flags, token cap, and the run's LLM log handles. */
export const ENGINE = {
  stream: true,
  debug: false,
  /** Free Consult spike (CLI-only, --free-consult / --free-consult-v2 / --free-consult-v3): strip
   *  authorial behavioral steering from the character prompt while keeping every information/
   *  physical boundary intact. "v1" is the strip-only condition; "v2" adds one paragraph to the
   *  ladder distinguishing "missing fact -> ask" from "uncertain interpretation -> act on it";
   *  "v3" keeps v2's ladder and puts back just the attempt-3 anti-stalling nudge, isolating
   *  whether pressure (not clearer instruction) was the missing ingredient (prompts/consult.ts). */
  freeConsult: false as false | "v1" | "v2" | "v3",
  /** Split-judge prototype (CLI-only, --split-judge): the per-answer gate as two calls instead of
   *  one -- a verdict call that only decides accept/retry and names the contradiction, and a repair
  *  call, made only on a retry, that authors the revision from that note alone. Measured motive
  *  and caveat in docs/PLANS.md ("Judge diagnostic matrix"). */
  splitJudge: false,
  /** Stale-character `since` enforcement (CLI-only, --consult-since): a lone consult opened for a
   *  character with two or more prose pieces since their last consult must carry `since` — what
   *  reached them in between — or it is refused like a thin situation. When present, the `since`
   *  text joins the situation before the consult gate, so no new channel and no new model call.
   *  Off, it is never required and never joined: the writer is never told the field exists, so in
   *  practice nothing sends it — but a `since` arriving anyway is still parsed, recorded, and
   *  logged, just never enforced. Prompts and call sequences are byte-identical
   *  (docs/PLANS.md). */
  consultSince: false,
  heardChannel: false,
  /** CANNOT-rendering arms (CLI-only, --cannot-meaning / --cannot-none / --cannot-testimony), one
   *  flag each because they target different measured findings and a bundle cannot be attributed.
   *  With all three off, every prompt is byte-identical to the pre-arm engine.
   *   - `cannotMeaning`: render each restriction's authored `:: meaning` beside its name, instead of
   *     the bare canon token. Aimed at Finding 2 -- `gemma-4-e4b` reads `CANNOT: sight` as removing
   *     perception generally, 0/10 on MERRITT's untouched hearing, deterministically.
   *   - `cannotNone`: render `CANNOT: (none)` for a character with no restrictions, instead of
   *     omitting the segment. Aimed at Finding 1 -- the judge invented a `CANNOT: sight` for a
   *     character whose `restrictions` is `[]`, a fact every model states correctly (20/20) when
   *     asked cleanly; absence currently reaches the model as no tokens at all.
   *   - `cannotTestimony`: mark the judged answer as the character's own words rather than
   *     established fact, and show the answerer's own limits beside it in the payload.
   *  docs/PLANS.md ("Judge diagnostic matrix") carries both findings. */
  cannotMeaning: false,
  cannotNone: false,
  cannotTestimony: false,
  /** What the scene loop echoes to the console: the draft prose and the characters' acts and
   *  replies. A headless process echoes because its console is the monitor there is; plain --serve
   *  goes quiet because the viewer is. */
  echoConsole: true,
  /** The characters' own replies on top of that: `acts:`, `reacts:` and consult answers. Off with
   *  --no-cast-echo; the prose echo and the JSONL/SSE record are untouched by it. */
  echoCast: true,
  maxTokens: 2000,
  outDir: "",
  llmStreams: new Map<string, WriteStream>(),   // agent name -> this run's open stream
  llmFilenames: new Set<string>(),              // filenames already claimed this run
  llmDead: new Set<string>(),                   // agents whose transcript stream failed — warned once, then skipped
  fitWarned: new Set<string>(),                 // models the context-fit warning already fired for — once per run
};

// TTY only: carriage returns in a redirected log file are worse than silence.
let progressOpen = false;
/** Paint a one-line status at the cursor (TTY only), so the terminal shows what a long call is doing. */
export function progress(text: string) {
  if (!process.stdout.isTTY) return;
  process.stdout.write(`\r\x1b[2K  ${text}`);
  progressOpen = true;
}
/** Clear the status line before anything else prints, so real output never lands on top of it. */
export function progressDone() {
  if (!progressOpen) return;
  process.stdout.write(`\r\x1b[2K`);
  progressOpen = false;
}

/** The ENGINE fields the command line owns: everything story-writer.ts used to assign field by
 *  field. A plain-data snapshot — no argv, no precedence, no side effects — so the CLI-to-engine
 *  mapping (cli-to-engine.ts) stays pure and unit-testable, and this module stays the only place
 *  that mutates the singleton. Deliberately excludes stream/debug/maxTokens/outDir and the per-run
 *  log handles: those come from the story config and the run setup, never the command line. */
export interface EngineOptions {
  echoConsole: boolean;
  echoCast: boolean;
  freeConsult: typeof ENGINE.freeConsult;
  splitJudge: boolean;
  consultSince: boolean;
  heardChannel: boolean;
  cannotMeaning: boolean;
  cannotNone: boolean;
  cannotTestimony: boolean;
}

/** Apply a mapped EngineOptions to the singleton. The one impure step, kept beside ENGINE so the
 *  composition root configures the engine without touching its fields directly. */
export function applyEngineOptions(opts: EngineOptions): void {
  ENGINE.echoConsole = opts.echoConsole;
  ENGINE.echoCast = opts.echoCast;
  ENGINE.freeConsult = opts.freeConsult;
  ENGINE.splitJudge = opts.splitJudge;
  ENGINE.consultSince = opts.consultSince;
  ENGINE.heardChannel = opts.heardChannel;
  ENGINE.cannotMeaning = opts.cannotMeaning;
  ENGINE.cannotNone = opts.cannotNone;
  ENGINE.cannotTestimony = opts.cannotTestimony;
}
