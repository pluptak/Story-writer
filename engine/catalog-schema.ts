/** ZOD SCHEMA for character catalog — reusable character templates. */
import { z } from "zod";

export const CATALOG_KINDS = ["characters"] as const;
export type CatalogKind = (typeof CATALOG_KINDS)[number];

/** One character as a portable library entry: name, portable persona half, psychology, voice samples,
 *  skills, and restrictions. Deliberately excludes goal, knows, model, and maxRetries — those are
 *  story-positional (only meaningful inside a single story) or run-configuration. `portablePersona`
 *  holds the half that travels between stories (temperament, manner, values, habits, stable identity);
 *  the story-specific half is authored per story and is not stored here. */
export const LibraryCharacter = z.strictObject({
  id: z.string().min(1),
  version: z.number().int().min(1).default(1),
  name: z.string().min(1),
  tags: z.array(z.string()).default([]),
  portablePersona: z.string().default(""),
  belief: z.string().default(""),
  impulse: z.string().default(""),
  /** Up to three lines of dialogue in the character's own words; models imitate samples better than
   *  adjectives. Extras past three are dropped on load — matching `CharacterDef`'s truncate-and-keep
   *  — rather than rejecting the whole entry, so both load paths converge on the same cap. */
  voice: z.array(z.string()).default([]).transform(v => v.slice(0, 3)),
  skills: z.array(z.string()).default([]),
  restrictions: z.array(z.string()).default([]),
});

export type LibraryCharacter = z.infer<typeof LibraryCharacter>;

export const CharacterCatalog = z.strictObject({
  entries: z.array(LibraryCharacter).default([]),
});

export type CharacterCatalog = z.infer<typeof CharacterCatalog>;
