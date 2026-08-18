/** ZOD SCHEMA for story.json — the single validated JSON story format. */
import { z } from "zod";

const thinkLevel = z.enum(["low", "medium", "high"]);

/** One scene's definition: where it is, the question it answers, whose perception, length, and roster. */
export const SceneDef = z.object({
  place: z.string().default(""),
  question: z.string().default(""),
  pov: z.string().default(""),
  length: z.number().min(1).default(700),
  roster: z.array(z.string()).default([]),
});

export type SceneDef = z.infer<typeof SceneDef>;

/** One character as authored: name, model, persona, what they know, their goal, skills and restrictions. */
export const CharacterDef = z.object({
  name: z.string().min(1),
  model: z.string().default(""),
  persona: z.string().default(""),
  knows: z.string().default(""),
  goal: z.string().default(""),
  skills: z.array(z.string()).default([]),
  restrictions: z.array(z.string()).default([]),
});

export type CharacterDef = z.infer<typeof CharacterDef>;

/** How much reasoning each agent uses: writer, character, and the summarizer. */
export const ThinkingConfig = z.object({
  writer: thinkLevel.default("low"),
  character: thinkLevel.default("low"),
  summary: thinkLevel.default("low"),
});

export type ThinkingConfig = z.infer<typeof ThinkingConfig>;

/** Model selection: a default for everyone, with writer and summary overrides. */
export const ModelsConfig = z.object({
  default: z.string().default("qwen3.6-35b-a3b"),
  writer: z.string().optional(),
  summary: z.string().optional(),
});

export type ModelsConfig = z.infer<typeof ModelsConfig>;

/** Run configuration: retries, clarifications, pacing, timeouts, and thinking levels. */
export const RunConfig = z.object({
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
}).prefault(() => ({}));

export type RunConfig = z.infer<typeof RunConfig>;

/** The whole story.json: title, premise, 1-3 scenes, cast, run config, and models. */
export const StoryJson = z.object({
  title: z.string().default(""),
  premise: z.string().default(""),
  scenes: z.array(SceneDef).min(1).max(3).prefault(() => [{}]),
  writerStyle: z.string().default(""),
  characters: z.array(CharacterDef).default([]),
  config: RunConfig,
  models: ModelsConfig.prefault(() => ({})),
});

export type StoryJson = z.infer<typeof StoryJson>;
