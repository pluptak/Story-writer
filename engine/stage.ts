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
  | { type: "kept"; entity: string; kept: string; offered: string }
  | { type: "refused"; entity: string; position: string; fixed: string }
  | { type: "noop" };

/** A working copy of the seed: the scene's staging as this scene's room, free for the
 *  writer to accrete onto without touching what the story file holds. */
export function seedStage(seed: readonly StagedEntity[]): StagedEntity[] {
  return seed.map(e => ({ ...e }));
}

/** The words of a placement, lowercased and split off punctuation, so a restatement is
 *  compared by what it names rather than how it is punctuated. */
const positionWords = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Fold one parsed placement into the room. Names, not indices: the entry whose key matches
 *  is the entry, whatever its case. A restatement that only loses — every word it names is
 *  already in the standing placement, and it names strictly fewer — is not a move: the fuller
 *  placement stands and the keep is logged, because overwriting it would erase detail the
 *  writer merely re-listed. A shorter position that names anything new is still a move. */
export function applyStageEntry(stage: StagedEntity[], entity: string, position: string): StageOutcome {
  const found = stage.find(e => nameKey(e.entity) === nameKey(entity));
  if (!found) {
    stage.push({ entity, position, fixed: false });
    return { type: "added", entity, position };
  }
  if (found.position === position) return { type: "noop" };
  // Before the fixed check: re-listing a load-bearing entry with less attempts nothing,
  // and refusing it would tell the writer something untrue.
  const standing = new Set(positionWords(found.position));
  const offered = positionWords(position);
  if (offered.every(w => standing.has(w)) && new Set(offered).size < standing.size)
    return { type: "kept", entity: found.entity, kept: found.position, offered: position };
  if (found.fixed) return { type: "refused", entity: found.entity, position, fixed: found.position };
  const from = found.position;
  found.position = position;
  return { type: "moved", entity: found.entity, from, to: position };
}

/** Resolve a character's target name against the live stage, by name and never by index. A
 *  match hands back the stage's own spelling and where it stands, so the writer reads one name
 *  for one thing however the character spelled it.
 *
 *  Read-only, and deliberately: naming a thing is not placing it. Only the writer's `stage` key
 *  places, because only it supplies a position — accreting a target here would push a
 *  positionless entity that observe() then filters out of every projection forever, and would
 *  let "the door" become a second entity beside the staged "steel door". An unmatched target is
 *  permitted and left alone, which is the normal case in a story that stages nothing. */
export function resolveTarget(stage: readonly StagedEntity[], target: string): { matched: boolean; entity: string; position: string } {
  const named = target.trim();
  if (!named) return { matched: false, entity: "", position: "" };
  const found = stage.find(e => sameName(e.entity, named));
  return found
    ? { matched: true, entity: found.entity, position: found.position }
    : { matched: false, entity: named, position: "" };
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
