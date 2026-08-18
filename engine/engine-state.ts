/**
 * ENGINE-STATE — mutable run knobs shared across module boundaries (LM client, Agent, scene
 * loop, CLI entry). A bare exported `let` can't be reassigned from outside its defining
 * module, so — like LIVE in live.ts — these live as fields on one exported object.
 */
import { type WriteStream } from "node:fs";

/** Mutable run knobs shared across the engine: stream/debug/serve flags, token cap, and the run's LLM log handles. */
export const ENGINE = {
  stream: true,
  debug: false,
  serve: false,
  maxTokens: 2000,
  outDir: "",
  llmStreams: new Map<string, WriteStream>(),   // agent name -> this run's open stream
  llmFilenames: new Set<string>(),               // filenames already claimed this run
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
