/** ZOD SCHEMA for story.json — the single validated JSON story format. */
import { z } from "zod";

const thinkLevel = z.enum(["low", "medium", "high"]);

export const SceneDef = z.object({
  place: z.string().default(""),
  question: z.string().default(""),
  pov: z.string().default(""),
  length: z.number().min(1).default(700),
  roaster: z.array(z.string()).default([]),
});

export type SceneDef = z.infer<typeof SceneDef>;

export const CharacterDef = z.object({
  name: z.string().min(1),
  model: z.string().default(""),
  persona: z.string().default(""),
  knows: z.string().default(""),
  goal: z.string().default(""),
  goals: z.array(z.string()).default(["", "", ""]),
  skills: z.array(z.string()).default([]),
  restrictions: z.array(z.string()).default([]),
});

export type CharacterDef = z.infer<typeof CharacterDef>;

export const ThinkingConfig = z.object({
  writer: thinkLevel.default("low"),
  character: thinkLevel.default("low"),
  summary: thinkLevel.default("low"),
});

export type ThinkingConfig = z.infer<typeof ThinkingConfig>;

export const ModelsConfig = z.object({
  default: z.string().default("qwen3.6-35b-a3b"),
  writer: z.string().optional(),
  summary: z.string().optional(),
});

export type ModelsConfig = z.infer<typeof ModelsConfig>;

export const StoryJson = z.object({
  title: z.string().default(""),
  premise: z.string().default(""),
  scenes: z.array(SceneDef).min(1).max(3).prefault(() => [{}]),
  writerStyle: z.string().default(""),
  characters: z.array(CharacterDef).default([]),
  config: z.object({
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
  }).prefault(() => ({})),
  models: ModelsConfig.prefault(() => ({})),
});

export type StoryJson = z.infer<typeof StoryJson>;
