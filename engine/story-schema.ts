/** ZOD SCHEMA for story.json — the single validated JSON story format. */
import { z } from "zod";

/** All supported thinking levels. "off" suppresses reasoning; "default" means "send nothing". */
export const THINK_LEVELS = ["off", "low", "medium", "high", "default"] as const;
export type ThinkLevel = (typeof THINK_LEVELS)[number];

const thinkLevel = z.enum(THINK_LEVELS);

/** One scene's definition: where it is, the question it answers, whose perception, length, roster, and optional per-scene overrides. */
export const SceneDef = z.strictObject({
  place: z.string().default(""),
  question: z.string().default(""),
  pov: z.string().default(""),
  length: z.number().min(1).default(700),
  roster: z.array(z.string()).default([]),
  writerModel: z.string().optional(),
  writerThink: thinkLevel.optional(),
});

export type SceneDef = z.infer<typeof SceneDef>;

/** One character as authored: name, model, persona, what they know, their goal, skills, restrictions, and optional per-character retry ceiling. */
export const CharacterDef = z.strictObject({
  name: z.string().min(1),
  model: z.string().default(""),
  persona: z.string().default(""),
  knows: z.string().default(""),
  goal: z.string().default(""),
  skills: z.array(z.string()).default([]),
  restrictions: z.array(z.string()).default([]),
  maxRetries: z.number().int().min(0).optional(),
});

export type CharacterDef = z.infer<typeof CharacterDef>;

/** How much reasoning each agent uses: writer, character, and the summarizer. */
export const ThinkingConfig = z.strictObject({
  writer: thinkLevel.default("low"),
  character: thinkLevel.default("low"),
  summary: thinkLevel.default("low"),
});

export type ThinkingConfig = z.infer<typeof ThinkingConfig>;

/** Model selection: a default for everyone, with writer and summary overrides. */
export const ModelsConfig = z.strictObject({
  default: z.string().default("qwen3.6-35b-a3b"),
  writer: z.string().optional(),
  summary: z.string().optional(),
});

export type ModelsConfig = z.infer<typeof ModelsConfig>;

/** Run configuration: retries, clarifications, pacing, timeouts, per-character retry ceiling, and thinking levels. */
export const RunConfig = z.strictObject({
  retries: z.number().int().min(0).default(2),
  clarifications: z.number().int().min(0).default(2),
  maxSteps: z.number().int().min(1).default(24),
  maxProseWords: z.number().int().min(1).default(140),
  stream: z.boolean().default(true),
  debug: z.boolean().default(false),
  thinking: ThinkingConfig.prefault(() => ({})),
  requestTimeout: z.number().int().min(1).default(120),
  attempts: z.number().int().min(1).default(3),
  maxTokens: z.number().int().min(1).default(2000),
  maxCharacterRetries: z.number().int().min(0).optional(),
}).prefault(() => ({}));

export type RunConfig = z.infer<typeof RunConfig>;

/** The whole story.json: title, premise, one scene per chapter, cast, run config, and models. */
export const StoryJson = z.strictObject({
  title: z.string().default(""),
  premise: z.string().default(""),
  scenes: z.array(SceneDef).min(1).prefault(() => [{}]),
  writerStyle: z.string().default(""),
  /** World truths known to anyone who would know them — the writer sees these as THE FACTS. */
  facts: z.array(z.string()).default([]),
  characters: z.array(CharacterDef).default([]),
  config: RunConfig,
  models: ModelsConfig.prefault(() => ({})),
});

export type StoryJson = z.infer<typeof StoryJson>;
