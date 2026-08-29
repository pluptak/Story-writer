/** CLI FLAGS — the one place that reads process.argv. Everything downstream asks for what it needs;
 *  nothing else in the engine or server touches the raw argument list. */

const CLI = process.argv.slice(2);

export const PREFLIGHT = CLI.includes("--preflight");
export const SERVE = CLI.includes("--serve");
/** Headless: serve only, no story argument, no console picker, no one-shot — the browser drives
 *  everything and SIGINT/SIGTERM shut the process down gracefully. Implies --serve. */
export const HEADLESS = CLI.includes("--headless");
export const ARCHITECT_DEBUG = CLI.includes("--architect-debug");
export const PORT = Number(CLI.find(a => a.startsWith("--port="))?.slice(7)) || 8080;
export const ARCHITECT_DEBUG_LOG = CLI.find(a => a.startsWith("--architect-debug-log="))
  ?.slice("--architect-debug-log=".length) ?? "";
export const STORY_DIR = CLI.find(a => !a.startsWith("--")) ?? "";

/** The value of `--name` or `--name=value`; undefined when absent, "" when bare. */
export const flag = (name: string): string | undefined => {
  const hit = CLI.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (hit === undefined) return undefined;
  const eq = hit.indexOf("=");
  return eq < 0 ? "" : hit.slice(eq + 1);
};

const RETIRED_FLAGS = ["--new", "--oneshot", "--idea", "--next-chapter"];

/** The first retired flag on the command line, if any — main() turns this into the rejection. */
export const retiredFlagUsed = (): string | undefined =>
  RETIRED_FLAGS.find(f => CLI.includes(f));
