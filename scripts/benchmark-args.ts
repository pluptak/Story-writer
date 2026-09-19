import { parseArgs } from "node:util";
import { THINK_LEVELS, type ThinkLevel } from "../engine/story-schema.ts";

export function parseBenchmarkArgs(
  args: string[],
  extra: { values?: readonly string[]; booleans?: readonly string[] } = {},
) {
  const options: Record<string, { type: "string" | "boolean" }> = {};
  for (const name of ["model", "samples", "story", "out", "think", ...extra.values ?? []]) {
    options[name] = { type: "string" };
  }
  for (const name of extra.booleans ?? []) options[name] = { type: "boolean" };
  const { values } = parseArgs({ args, options, strict: true, allowPositionals: false });
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === "string" && !value.trim()) {
      throw new Error(`--${name} requires a non-empty value`);
    }
  }
  const get = (name: string): string | undefined => {
    const value = values[name];
    return typeof value === "string" ? value : undefined;
  };
  const has = (name: string): boolean => values[name] === true;
  const samples = get("samples") === undefined ? undefined : Number(get("samples"));
  if (samples !== undefined && (!Number.isSafeInteger(samples) || samples <= 0)) {
    throw new Error("--samples must be a positive safe integer");
  }
  const think = get("think");
  if (think !== undefined && !(THINK_LEVELS as readonly string[]).includes(think)) {
    throw new Error(`--think must be one of: ${THINK_LEVELS.join(" ")}`);
  }
  return { get, has, samples, think: think as ThinkLevel | undefined };
}
