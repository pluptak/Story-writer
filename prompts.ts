/**
 * PROMPTS -- every word this engine says to a model.
 *
 * A thin barrel over prompts/: one role file per calling surface (common, architect, consult,
 * writer, judge, clarify). The two invariants hold for every file under prompts/, not just this
 * one: each imports NOTHING from the engine -- every function takes plain strings -- and every
 * model-facing string is composed here or under prompts/, nowhere else.
 *
 * prompts/internal.ts holds the helpers shared between role files; it is deliberately NOT
 * re-exported here, so the surface an engine caller sees stays exactly what it was before the split.
 */
export * from "./prompts/common.ts";
export * from "./prompts/architect.ts";
export * from "./prompts/consult.ts";
export * from "./prompts/writer.ts";
export * from "./prompts/judge.ts";
export * from "./prompts/clarify.ts";
