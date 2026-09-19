/** STAGE — the live scene stage: what is in the room, and where, while one scene is
 *  being written. Seeded from the scene's own staging at scene start, mutated by the
 *  writer's reply as the prose places things, never written back to story.json.
 *
 *  Accretion only. The writer adds an entity the moment the prose needs one; from then on
 *  the entry is authoritative and every character sees it — there is no second write path,
 *  so nothing here merges, versions, or conflicts. Entries the seed marked load-bearing
 *  (`fixed`) may be added around but never flipped: a move against one is refused and the
 *  old placement stands. Non-fixed entries move freely, which is how the room stays
 *  truthful as the scene changes it.
 *
 *  Pure: no imports beyond the leaf text utilities, no warnings, no state of its own. The
 *  caller owns the list across the scene and logs what each application did.
 */
import { nameKey, sameName } from "./config-util.ts";
import { canonSkill, splitMeaning } from "./skills.ts";
import type { StagedEntity } from "./scene-loop.ts";
import type { Presence } from "./scene-loop.ts";
import type { Skill } from "./skills.ts";

/** One writer-submitted placement, parsed from the reply's `stage` key. Writer entries are
 *  never fixed no matter how they arrive: a `!` is stripped for matching, not honored —
 *  only the seed fixes placements, or any reply could freeze the room. Null places nothing
 *  and is dropped silently; the prose it rode in on still stands. */
export function parseStageEntry(raw: unknown): { entity: string; position: string } | null {
  const { text, meaning } = splitMeaning(String(raw ?? ""));
  const entity = (text.startsWith("!") ? text.slice(1) : text).trim();
  if (!entity || !meaning.trim()) return null;
  return { entity, position: meaning.trim() };
}

export type StageOutcome =
  | { type: "added"; entity: string; position: string }
  | { type: "moved"; entity: string; from: string; to: string }
  | { type: "refused"; entity: string; position: string; fixed: string }
  | { type: "noop" };

/** A working copy of the seed: the scene's staging as this scene's room, free for the
 *  writer to accrete onto without touching what the story file holds. */
export function seedStage(seed: readonly StagedEntity[]): StagedEntity[] {
  return seed.map(e => ({ ...e }));
}

/** Fold one parsed placement into the room. Names, not indices: the entry whose key matches
 *  is the entry, whatever its case. */
export function applyStageEntry(stage: StagedEntity[], entity: string, position: string): StageOutcome {
  const found = stage.find(e => nameKey(e.entity) === nameKey(entity));
  if (!found) {
    stage.push({ entity, position, fixed: false });
    return { type: "added", entity, position };
  }
  if (found.position === position) return { type: "noop" };
  if (found.fixed) return { type: "refused", entity: found.entity, position, fixed: found.position };
  const from = found.position;
  found.position = position;
  return { type: "moved", entity: found.entity, from, to: position };
}

/** What one character perceives of the room: the live stage filtered to their senses.
 *  `reach` is the character's already-resolved grant (sceneReach) — it rides along because a
 *  grant can only extend perception, never narrow it (I1), and I2 already stripped anything
 *  a restriction removes before observe() ever runs, so a sight grant can never smuggle
 *  visibility past a CANNOT. Entries that place nothing are dropped: the resolver warned
 *  about them already and a projection of nowhere is noise. */
export interface Observee {
  name: string;
  limits: readonly string[];
  presence: Presence | null;
  reach: readonly Skill[];
}

export function observe(o: Observee, stage: readonly StagedEntity[]): StagedEntity[] {
  const placed = stage.filter(e => e.position.trim());
  // A remote character is not in the room: the channel may carry words, never positions.
  if (o.presence?.mode === "remote") return [];
  // A character who cannot see does not receive the visible list — only where they
  // themselves are, which proprioception covers and no sense gate removes.
  if (o.limits.some(l => canonSkill(l) === "sight"))
    return placed.filter(e => sameName(e.entity, o.name));
  return [...placed];
}
