/** CLI FLAGS — the one place that reads process.argv. Everything downstream asks for what it needs;
 *  nothing else in the engine or server touches the raw argument list.
 *
 *  `OPTIONS` below is the command line's actual specification, not a convenience list: parsing runs
 *  through node:util's parseArgs in STRICT mode, so an option that is not declared there is a hard
 *  refusal rather than a silent no-op. That is the point of the table — a mistyped `--serv` used to
 *  start no viewer and say nothing about why. It also means `flag("x")` can only ever find an `x`
 *  that is declared here; adding a flag is one line in this table plus its reader. */
import { parseArgs } from "node:util";

const OPTIONS = {
  // Console entry points and process shape.
  preflight: { type: "boolean" },
  serve: { type: "boolean" },
  headless: { type: "boolean" },
  port: { type: "string" },
  // Run knobs.
  replace: { type: "boolean" },
  "no-cast-echo": { type: "boolean" },
  steps: { type: "string" },
  chapter: { type: "string" },
  model: { type: "string" },
  // The --consult console entry point and its presets.
  consult: { type: "string" },
  situation: { type: "string" },
  question: { type: "string" },
  wants: { type: "string" },
  // Architect tracing.
  "architect-debug": { type: "boolean" },
  "architect-debug-log": { type: "string" },
  // Retired, and declared only so that strict parsing does not reject them with its own generic
  // message before retiredFlagUsed() can point at --serve and the browser flow.
  new: { type: "boolean" },
  oneshot: { type: "boolean" },
  idea: { type: "boolean" },
  "next-chapter": { type: "boolean" },
} as const;

const RETIRED_FLAGS = ["new", "oneshot", "idea", "next-chapter"] as const;

type FlagValue = string | boolean | undefined;

let VALUES: Record<string, FlagValue> = {};
let POSITIONALS: string[] = [];
/** Why the command line would not parse — an unknown option, or a value-taking one left bare.
 *  Reported by main() rather than thrown, so a bad flag prints one line instead of a stack trace
 *  at import time. Empty when the arguments were fine. */
export let parseError = "";

try {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    options: OPTIONS,
    allowPositionals: true,
    strict: true,
  });
  VALUES = parsed.values as Record<string, FlagValue>;
  POSITIONALS = parsed.positionals;
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  // parseArgs' own unknown-option message ends by advising `--` for positionals starting with a
  // dash, which is never what happened here — a mistyped flag is. Say what IS accepted instead,
  // and fall back to the raw message if that wording ever changes upstream.
  if (err.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    const known = Object.keys(OPTIONS)
      .filter(k => !(RETIRED_FLAGS as readonly string[]).includes(k))
      .map(k => `--${k}`).join(" ");
    parseError = `${err.message.split(". To specify")[0]}.\nAccepted flags: ${known}`;
  } else {
    parseError = err.message;
  }
}

export const PREFLIGHT = VALUES.preflight === true;
export const SERVE = VALUES.serve === true;
/** Headless: serve only, no story argument, no console picker, no one-shot — the browser drives
 *  everything and SIGINT/SIGTERM shut the process down gracefully. Implies --serve. */
export const HEADLESS = VALUES.headless === true;
export const ARCHITECT_DEBUG = VALUES["architect-debug"] === true;
/** A --port= that is not a number falls back rather than failing the run: 0 is not a port here. */
export const PORT = Number(VALUES.port) || 8080;
export const ARCHITECT_DEBUG_LOG =
  typeof VALUES["architect-debug-log"] === "string" ? VALUES["architect-debug-log"] : "";
export const STORY_DIR = POSITIONALS[0] ?? "";

/** The value of `--name` or `--name=value`; undefined when absent, "" when bare. The "" is what
 *  presence tests read (`flag("no-cast-echo") === undefined`), so a declared boolean and a declared
 *  string stay distinguishable from an absent one. */
export const flag = (name: string): string | undefined => {
  const v = VALUES[name];
  if (v === undefined) return undefined;
  return v === true ? "" : String(v);
};

/** The first retired flag on the command line, if any — main() turns this into the rejection. */
export const retiredFlagUsed = (): string | undefined => {
  const hit = RETIRED_FLAGS.find(f => VALUES[f] === true);
  return hit && `--${hit}`;
};
