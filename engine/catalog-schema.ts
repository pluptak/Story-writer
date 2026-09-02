/** ZOD SCHEMA for character catalog — reusable character templates and tag vocabularies. */
import { z } from "zod";

export const CATALOG_KINDS = ["characters", "tags"] as const;
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

// -- TAGS -------------------------------------------------------------------

export const TAG_FACETS = ["genre", "dramaticMode", "tone"] as const;
export type TagFacet = (typeof TAG_FACETS)[number];

/** One tag as a controlled vocabulary term. Facet groups related tags (genre, dramatic mode, tone).
 *  `version` is included so the shared upsert path treats every kind alike. */
export const TagEntry = z.strictObject({
  id: z.string().min(1),
  version: z.number().int().min(1).default(1),
  facet: z.enum(TAG_FACETS),
  label: z.string().min(1),
});

export type TagEntry = z.infer<typeof TagEntry>;

export const TagCatalog = z.strictObject({
  entries: z.array(TagEntry).default([]),
});

export type TagCatalog = z.infer<typeof TagCatalog>;

/** Starting vocabulary the author is expected to edit, not a fixed taxonomy.
 *  The point of the editor is that changing the tags is cheap. Ids are derived from facet and label,
 *  not written by hand, so a seed tag has a stable id across machines and re-runs. */
export const TAG_SEED: readonly { facet: TagFacet; label: string }[] = [
  // genre
  { facet: "genre", label: "science-fiction" },
  { facet: "genre", label: "fantasy" },
  { facet: "genre", label: "mystery" },
  { facet: "genre", label: "thriller" },
  { facet: "genre", label: "horror" },
  { facet: "genre", label: "literary" },
  { facet: "genre", label: "historical" },
  { facet: "genre", label: "western" },
  // dramaticMode
  { facet: "dramaticMode", label: "adventure" },
  { facet: "dramaticMode", label: "survival" },
  { facet: "dramaticMode", label: "romance" },
  { facet: "dramaticMode", label: "political" },
  { facet: "dramaticMode", label: "procedural" },
  { facet: "dramaticMode", label: "coming-of-age" },
  { facet: "dramaticMode", label: "revenge" },
  { facet: "dramaticMode", label: "redemption" },
  // tone
  { facet: "tone", label: "hopeful" },
  { facet: "tone", label: "bleak" },
  { facet: "tone", label: "comic" },
  { facet: "tone", label: "unsettling" },
  { facet: "tone", label: "tender" },
  { facet: "tone", label: "cold" },
  { facet: "tone", label: "wry" },
  { facet: "tone", label: "elegiac" },
];
