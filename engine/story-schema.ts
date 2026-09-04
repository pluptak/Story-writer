/** ZOD SCHEMA for story.json — the single validated JSON story format. */
import { z } from "zod";

/** All supported thinking levels. "off" suppresses reasoning; "default" means "send nothing". */
export const THINK_LEVELS = ["off", "low", "medium", "high", "default"] as const;
export type ThinkLevel = (typeof THINK_LEVELS)[number];

const thinkLevel = z.enum(THINK_LEVELS);

/** How many voice samples a character keeps — the editor's own cap notice reads this rather than
 *  restating it. */
export const VOICE_SAMPLE_CAP = 3;

/** One scene's definition: where it is, the question it answers, whose perception, length, roster,
 *  what each character can reach only here, and optional per-scene overrides. */
export const SceneDef = z.strictObject({
  place: z.string().default(""),
  question: z.string().default(""),
  pov: z.string().default(""),
  length: z.number().min(1).default(700),
  roster: z.array(z.string()).default([]),
  /** Per-character reach (I1): an interface the world offers this character HERE —
   *  `{"AURA": ["cameras :: perceiving through the lobby cameras"]}`. Exists only while this scene
   *  is being written; never carried between scenes, never merged into a character's skills. */
  reach: z.record(z.string(), z.array(z.string())).default({}),
  /** Writer-only overrides for this one scene; unset falls back to `models.writer` / `thinking.writer`. */
  writerModel: z.string().optional(),
  writerThink: thinkLevel.optional(),
});

export type SceneDef = z.infer<typeof SceneDef>;

/** One character as authored: name, model, persona, what they know, their goal, what they believe,
 *  how they act under pressure, voice samples, skills, restrictions, and optional per-character retry ceiling.
 *  The psychology fields (goal/belief/impulse/voice) are rendered text only — the skill system never resolves them. */
export const CharacterDef = z.strictObject({
  name: z.string().min(1),
  model: z.string().default(""),
  persona: z.string().default(""),
  knows: z.string().default(""),
  goal: z.string().default(""),
  /** One load-bearing conviction, possibly false — fills the slot the real fact would occupy. */
  belief: z.string().default(""),
  /** One conditional behaviour rule: "when X → Y". */
  impulse: z.string().default(""),
  /** Up to three lines of dialogue in the character's own words; models imitate samples better than
   *  adjectives. Extras past three are dropped on load — matching `normalizeSpec`'s truncate-and-keep
   *  — rather than rejecting the whole story, so both load paths converge on the same cap. */
  voice: z.array(z.string()).default([]).transform(v => v.slice(0, VOICE_SAMPLE_CAP)),
  skills: z.array(z.string()).default([]),
  restrictions: z.array(z.string()).default([]),
  /** This character's chapter-wide retry ceiling; unset falls back to `config.maxCharacterRetries`. */
  maxRetries: z.number().int().min(0).optional(),
});

export type CharacterDef = z.infer<typeof CharacterDef>;

/** One world event the architect authors: a fault alarm firing, an incoming call — the one category
 *  no character decides. Two forms per beat, not one: `hold` (what the writer may not start until
 *  told) and `fired` (what has happened). The spike proved the held form is not decoration —
 *  pre-firing is obedience, since the scene's question names the event. `at` is the trigger, a
 *  fraction of the chapter's word target. `memories` are per-character knowledge implanted when the
 *  beat fires — what they always knew and had no reason to think about — keyed by character name.
 *  `state` is authored bookkeeping the engine reads but never writes back: `void` is skipped,
 *  `pending`/`fired` both arm the beat for a fresh run (re-running a chapter re-fires its beat);
 *  only the handoff or the owner ever writes state. */
export const TimelineDef = z.strictObject({
  chapter: z.number().int().min(1),
  hold: z.string().min(1),
  fired: z.string().min(1),
  at: z.number().min(0).max(1).default(0.45),
  memories: z.record(z.string(), z.string()).default({}),
  state: z.enum(["pending", "fired", "void"]).default("pending"),
});

export type TimelineDef = z.infer<typeof TimelineDef>;

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
  /** Cumulative retries one character may cost per chapter before replies are force-accepted; unset means no ceiling. */
  maxCharacterRetries: z.number().int().min(0).optional(),
}).prefault(() => ({}));

export type RunConfig = z.infer<typeof RunConfig>;

/** The whole story.json: title, premise, one scene per chapter, cast, run config, and models. */
export const StoryJson = z.strictObject({
  title: z.string().default(""),
  premise: z.string().default(""),
  scenes: z.array(SceneDef).min(1).prefault(() => [{}]),
  writerStyle: z.string().default(""),
  /** The story-derived half of the house style -- perception clauses and the like, read off THIS
   *  cast and POV. Kept beside `writerStyle` rather than inside it because a reusable preset must
   *  never carry one (`styleProblems`, engine/catalog.ts), and only a separate list lets the preset
   *  be swapped without taking the story's own rules with it. The writer sees the two joined. */
  writerStyleConstraints: z.array(z.string()).default([]),
  /** World truths known to anyone who would know them — the writer sees these as THE FACTS. */
  facts: z.array(z.string()).default([]),
  /** World events the architect authors, fired into the writer one at a time (PLANS.md: the world
   *  timeline). Story-level, not per-scene: an entry carries a per-character memory map, which
   *  SceneDef has no shape for, and story-level is what lets the handoff re-aim a stranded beat. */
  timeline: z.array(TimelineDef).default([]),
  characters: z.array(CharacterDef).default([]),
  config: RunConfig,
  models: ModelsConfig.prefault(() => ({})),
});

export type StoryJson = z.infer<typeof StoryJson>;
