/**
 * ENGINE-STATE — mutable run knobs shared across module boundaries (LM client, Agent, scene
 * loop, CLI entry). A bare exported `let` can't be reassigned from outside its defining
 * module, so — like LIVE in live.ts — these live as fields on one exported object.
 */
import { type WriteStream } from "node:fs";

/** Mutable run knobs shared across the engine: stream/debug/serve/echo flags, token cap, and the run's LLM log handles. */
export const ENGINE = {
  stream: true,
  debug: false,
  serve: false,
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
  /** What the scene loop echoes to the console: the draft prose and the characters' acts and
   *  replies. `serve` only means the HTTP surface is up — a headless process serves AND echoes,
   *  because its console is the monitor there is; plain --serve goes quiet because the viewer is. */
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
