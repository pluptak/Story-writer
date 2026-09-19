/** CLI FLAGS — the one place that reads process.argv. Everything downstream receives what it
 *  needs from `parseCli()`; nothing else in the engine or server touches the raw argument list.
 *
 *  `OPTIONS` below is the command line's actual specification, not a convenience list: parsing runs
 *  through node:util's parseArgs in STRICT mode, so an option that is not declared there is a hard
 *  refusal rather than a silent no-op. That is the point of the table — a mistyped `--serv` used to
 *  start no viewer and say nothing about why. */
import { parseArgs } from "node:util";

const OPTIONS = {
  // Console entry points and process shape.
  preflight: { type: "boolean" },
  // Plain --serve goes quiet (the viewer is the monitor); headless serves AND echoes (its console is).
  serve: { type: "boolean" },
  headless: { type: "boolean" },
  port: { type: "string" },
  // Run knobs.
  replace: { type: "boolean" },
  // --no-cast-echo trims just the characters' acts/reactions/answers from that echo; prose stays.
  "no-cast-echo": { type: "boolean" },
  steps: { type: "string" },
  chapter: { type: "string" },
  model: { type: "string" },
  // The --consult console entry point and its presets.
  consult: { type: "string" },
  situation: { type: "string" },
  question: { type: "string" },
  wants: { type: "string" },
  // Open-chat Consult spike (CLI-only prototype): freetext pressure-test chat.
  "open-consult": { type: "boolean" },
  pressure: { type: "string" },
  // Free Consult spike (CLI-only prototype): strip authorial behavioral steering. v2 adds the
  // uncertainty-vs-missing-fact distinction the v1 comparison run showed was missing; v3 keeps
  // v2's ladder and puts back just the attempt-3 nudge, isolating pressure from instruction.
  // Priority when more than one is passed: v3 > v2 > v1. Run-level CLI toggle only (like
  // --open-consult), never persisted to story.json.
  "free-consult": { type: "boolean" },
  "free-consult-v2": { type: "boolean" },
  "free-consult-v3": { type: "boolean" },
  // Split-judge spike (CLI-only prototype): the per-answer judge as a verdict call plus a
  // separate repair call, instead of one completion carrying both. Same run-level-toggle-only
  // rule; the gated path is byte-identical without it.
  "split-judge": { type: "boolean" },
  // Stale-character `since` spike (CLI-only prototype): a lone consult opened for a character two
  // or more prose pieces since their last consult must carry `since` or is refused. Same rule
  // again; stale consults without one are refused only with it on.
  "consult-since": { type: "boolean" },
  "heard-channel": { type: "boolean" },
  // CANNOT-rendering arms (CLI-only prototype), independently switchable so each can be attributed
  // to the finding it targets: the restriction's authored meaning, the explicit empty state, and
  // marking a judged answer as the character's own testimony. Same rule again, one flag per arm
  // so a measured delta can be attributed to one of them. Every prompt is byte-identical with
  // all off.
  "cannot-meaning": { type: "boolean" },
  "cannot-none": { type: "boolean" },
  "cannot-testimony": { type: "boolean" },
  // Architect tracing.
  "architect-debug": { type: "boolean" },
  "architect-debug-log": { type: "string" },
} as const;

export type FreeConsultMode = false | "v1" | "v2" | "v3";

export interface CliOptions {
  preflight: boolean;
  serve: boolean;
  /** Headless: serve only, no story argument, no console picker, no one-shot — the browser drives
   *  everything and SIGINT/SIGTERM shut the process down gracefully. Implies --serve. */
  headless: boolean;
  port: number;
  storyDir: string;
  run: {
    replace: boolean;
    noCastEcho: boolean;
    steps: string | undefined;
    chapter: string | undefined;
    model: string | undefined;
  };
  consult:
    | {
        character: string;
        situation: string | undefined;
        question: string | undefined;
        wants: string | undefined;
      }
    | undefined;
  experiments: {
    openConsult: boolean;
    pressure: string | undefined;
    freeConsult: FreeConsultMode;
    splitJudge: boolean;
    consultSince: boolean;
    heardChannel: boolean;
    cannotMeaning: boolean;
    cannotNone: boolean;
    cannotTestimony: boolean;
  };
  architectDebug: {
    enabled: boolean;
    log: string | undefined;
  };
}

export type CliParseResult = { ok: true; options: CliOptions } | { ok: false; error: string };

/** The port --port falls back to, and the session's initial port until the server binds. */
export const DEFAULT_PORT = 8080;

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function freeConsultMode(values: Record<string, unknown>): FreeConsultMode {
  if (values["free-consult-v3"] === true) return "v3";
  if (values["free-consult-v2"] === true) return "v2";
  if (values["free-consult"] === true) return "v1";
  return false;
}

/** Parse `--port`: the default applies only when the flag is absent. A provided value must be a
 *  valid TCP port, otherwise this returns an error string instead of silently falling back. */
function parsePort(value: unknown): { ok: true; port: number } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, port: DEFAULT_PORT };
  const raw = String(value);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535)
    return { ok: false, error: `--port=${raw} is not a valid port (1-65535)` };
  return { ok: true, port: n };
}

/** Parse one argument list into structured options. Never throws for a bad command line — it
 *  returns `{ ok: false, error }` so main() prints one line instead of a stack trace. */
export function parseCli(args = process.argv.slice(2)): CliParseResult {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    // parseArgs' own unknown-option message ends by advising `--` for positionals starting with a
    // dash, which is never what happened here — a mistyped flag is. Say what IS accepted instead,
    // and fall back to the raw message if that wording ever changes upstream.
    if (err.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      const known = Object.keys(OPTIONS).map(k => `--${k}`).join(" ");
      return { ok: false, error: `${err.message.split(". To specify")[0]}.\nAccepted flags: ${known}` };
    }
    return { ok: false, error: err.message };
  }

  const port = parsePort(parsed.values.port);
  if (!port.ok) return port;

  const values = parsed.values as Record<string, unknown>;
  return {
    ok: true,
    options: {
      preflight: values.preflight === true,
      serve: values.serve === true,
      headless: values.headless === true,
      port: port.port,
      storyDir: parsed.positionals[0] ?? "",
      run: {
        replace: values.replace === true,
        noCastEcho: values["no-cast-echo"] === true,
        steps: asString(values.steps),
        chapter: asString(values.chapter),
        model: asString(values.model),
      },
      consult:
        values.consult !== undefined
          ? {
              character: String(values.consult),
              situation: asString(values.situation),
              question: asString(values.question),
              wants: asString(values.wants),
            }
          : undefined,
      experiments: {
        openConsult: values["open-consult"] === true,
        pressure: asString(values.pressure),
        freeConsult: freeConsultMode(values),
        splitJudge: values["split-judge"] === true,
        consultSince: values["consult-since"] === true,
        heardChannel: values["heard-channel"] === true,
        cannotMeaning: values["cannot-meaning"] === true,
        cannotNone: values["cannot-none"] === true,
        cannotTestimony: values["cannot-testimony"] === true,
      },
      architectDebug: {
        enabled: values["architect-debug"] === true || values["architect-debug-log"] !== undefined,
        log: asString(values["architect-debug-log"]),
      },
    },
  };
}
