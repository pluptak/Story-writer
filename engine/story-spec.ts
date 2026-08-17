/** STORY SPEC — what the architect proposes: the shape, normalization, edits, and its renderings. */
import { C } from "../ansi.ts";
import { slugify } from "./config-util.ts";
import { SKILL_CATALOG, canonSkill, splitMeaning } from "./skills.ts";
import { StoryJson, type SceneDef, type CharacterDef, type SceneDef as SceneDefSchema } from "./story-schema.ts";

export type { SceneDef, CharacterDef } from "./story-schema.ts";

export interface StorySpec {
  title: string;
  premise: string;
  scene: SceneDef;
  scenes: SceneDef[];
  writerStyle: string;
  characters: Array<{
    name: string; persona: string; knows: string; goal: string; goals: string[];
    skills: string[]; restrictions: string[];
  }>;
}

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean)
  : typeof v === "string" ? v.split("|").map(s => s.trim()).filter(Boolean)
  : [];

export function normalizeSpec(raw: any): { spec: StorySpec; problems: string[] } {
  const problems: string[] = [];
  const o = raw ?? {};
  const rawScenes: any[] = Array.isArray(o.scenes) ? o.scenes
    : (o.scene && typeof o.scene === "object") ? [o.scene]
    : [];
  if (!rawScenes.length && o.scenes === undefined && o.scene) rawScenes.push(o.scene);
  if (!rawScenes.length) rawScenes.push({});
  const s = rawScenes[0] ?? {};

  const seen = new Set<string>();
  const characters: StorySpec["characters"] = [];
  for (const c of (Array.isArray(o.characters) ? o.characters : [])) {
    const name = String(c?.name ?? "").trim();
    if (!name) { problems.push("a character came back with no name — dropped"); continue; }
    if (seen.has(name.toLowerCase())) { problems.push(`two characters called "${name}" — kept the first`); continue; }
    seen.add(name.toLowerCase());
    const restrictions = asStrings(c?.restrictions ?? c?.lacks).filter(l => {
      const ok = Object.keys(SKILL_CATALOG).some(g => canonSkill(g) === canonSkill(splitMeaning(l).text));
      if (!ok) problems.push(`${name} "restrictions: ${l}" — not a general skill, so it would remove nothing`);
      return ok;
    });
    const goals = [
      String(c?.["goal 1"] ?? "").trim(),
      String(c?.["goal 2"] ?? "").trim(),
      String(c?.["goal 3"] ?? "").trim(),
    ];
    characters.push({
      name, persona: String(c?.persona ?? "").trim(), knows: String(c?.knows ?? "").trim(),
      goal: String(c?.goal ?? "").trim(), goals, skills: asStrings(c?.skills), restrictions,
    });
    if (!c?.persona) problems.push(`${name} has no persona`);
    else if (/\b(RESTRICTIONS|LACKS|KNOWS|SKILLS|GOAL)\s*:/.test(String(c.persona)))
      problems.push(`${name}'s persona restates knows/goal/skills/restrictions — the engine renders those, and the persona will contradict them`);
  }
  if (!characters.length) problems.push("no characters at all");
  if (characters.length > 4) { problems.push(`${characters.length} characters — keeping the first 4`); characters.length = 4; }

  const readSceneDef = (s: any, prefix: string): SceneDef => {
    const lengthRaw = Number(s.length);
    const pov = String(s.pov ?? "").trim();
    const povOk = !pov || characters.some(c => c.name.toLowerCase() === pov.toLowerCase());
    if (pov && !povOk) problems.push(`${prefix} pov "${pov}" is not one of the characters — cleared`);
    return {
      place: String(s.place ?? "").trim(),
      question: String(s.question ?? "").trim(),
      pov: povOk ? pov : "",
      length: Number.isFinite(lengthRaw) && lengthRaw >= 1 ? Math.round(lengthRaw) : 700,
      roaster: Array.isArray(s.roaster) ? s.roaster.map((r: unknown) => String(r).trim()).filter(Boolean) : [],
    };
  };

  const scenes: SceneDef[] = rawScenes.map((s, i) => readSceneDef(s, i === 0 ? "scene" : `scene ${i + 1}`));

  const spec: StorySpec = {
    title: String(o.title ?? "").trim(),
    premise: String(o.premise ?? "").trim(),
    scene: scenes[0],
    scenes,
    writerStyle: String(o.writer_style ?? o.writerStyle ?? "").trim(),
    characters,
  };
  if (!spec.title) problems.push("no title");
  if (!spec.premise) problems.push("no premise");
  for (const [i, sc] of scenes.entries()) {
    if (!sc.question)
      problems.push(`scene ${i + 1} has no question — nothing for that scene to answer`);
  }
  if (characters.length > 1 && !characters.some(c => c.restrictions.length))
    problems.push("nobody has any restrictions — no perceptual asymmetry for the consult to bite on");
  return { spec, problems };
}

export function applyEdits(spec: StorySpec, raw: any): {
  spec: StorySpec; applied: string[]; ignored: string[]; problems: string[];
} {
  const applied: string[] = [], ignored: string[] = [];
  const draft: any = JSON.parse(JSON.stringify({ ...spec, writer_style: spec.writerStyle, scenes: spec.scenes }));
  const edits = Array.isArray(raw?.edits) ? raw.edits : [];
  const findChar = (name: string) =>
    draft.characters.find((c: any) => String(c.name).toLowerCase() === name.trim().toLowerCase());

  for (const e of edits) {
    const field = String(e?.field ?? "").trim();
    const value = e?.value;
    const scalar = () => String(value ?? "").trim();

    if (field === "title" || field === "premise") { draft[field] = scalar(); applied.push(field); continue; }
    if (field === "writer_style" || field === "writerStyle") { draft.writer_style = scalar(); applied.push("writer_style"); continue; }

    const sceneMatch = field.match(/^(scene(?:_(\d))?)\.(place|question|pov|length|roaster)$/);
    if (sceneMatch) {
      const idx = sceneMatch[2] ? Number(sceneMatch[2]) - 1 : 0;
      if (idx >= draft.scenes.length) { ignored.push(`${field} — scene ${idx + 1} does not exist`); continue; }
      if (sceneMatch[3] === "roaster") draft.scenes[idx].roaster = asStrings(value);
      else if (sceneMatch[3] === "length") draft.scenes[idx].length = Number(value);
      else draft.scenes[idx][sceneMatch[3]] = scalar();
      applied.push(field);
      continue;
    }

    if (field === "add_character") {
      const name = String(value?.name ?? "").trim();
      if (!name) { ignored.push(`add_character with no name`); continue; }
      if (findChar(name)) { ignored.push(`add_character "${name}" — already in the cast`); continue; }
      draft.characters.push(value);
      applied.push(`added ${name}`);
      continue;
    }
    if (field === "remove_character") {
      const name = scalar();
      const idx = draft.characters.findIndex((c: any) => String(c.name).toLowerCase() === name.toLowerCase());
      if (idx < 0) { ignored.push(`remove_character "${name}" — not in the cast`); continue; }
      draft.characters.splice(idx, 1);
      applied.push(`removed ${name}`);
      continue;
    }

    const cm = field.match(/^characters\.(.+)\.(persona|knows|goal|skills|restrictions|lacks)$/);
    if (cm) {
      const c = findChar(cm[1]);
      if (!c) { ignored.push(`${field} — no character called "${cm[1]}"`); continue; }
      const targetField = cm[2] === "lacks" ? "restrictions" : cm[2];
      c[targetField] = (targetField === "skills" || targetField === "restrictions") ? asStrings(value) : scalar();
      applied.push(`${c.name}.${targetField}`);
      continue;
    }

    const goalMatch = field.match(/^characters\.(.+)\.goal_(\d)$/);
    if (goalMatch) {
      const c = findChar(goalMatch[1]);
      if (!c) { ignored.push(`${field} — no character called "${goalMatch[1]}"`); continue; }
      const idx = Number(goalMatch[2]) - 1;
      if (!c.goals) c.goals = ["", "", ""];
      c.goals[idx] = scalar();
      applied.push(`${c.name}.goal_${goalMatch[2]}`);
      continue;
    }

    ignored.push(field ? `unknown field "${field}"` : "an edit with no field");
  }

  const { spec: next, problems } = normalizeSpec(draft);
  return { spec: next, applied, ignored, problems };
}

export const DIRECT_FIELDS = ["scene.length"] as const;
export const MIN_SCENE_WORDS = 100, MAX_SCENE_WORDS = 10000;
export function directEdit(spec: StorySpec, field: string, value: unknown):
  { ok: false; reason: string } | { ok: true; spec: StorySpec; applied: string[]; problems: string[] } {
  if (!(DIRECT_FIELDS as readonly string[]).includes(field))
    return { ok: false, reason: `"${field}" is the architect's to change — say what you want instead` };
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < MIN_SCENE_WORDS || n > MAX_SCENE_WORDS)
    return { ok: false, reason: `a scene is ${MIN_SCENE_WORDS}–${MAX_SCENE_WORDS} words` };
  const e = applyEdits(spec, { edits: [{ field, value: n }] });
  return { ok: true, spec: e.spec, applied: e.applied, problems: e.problems };
}

export function renderStory(spec: StorySpec, models: { default: string }): Record<string, string> {
  const files: Record<string, string> = {};

  const charDefs = spec.characters.map(c => {
    const goals = [...c.goals];
    while (goals.length < 3) goals.push("");
    return {
      name: c.name,
      model: "",
      persona: c.persona,
      knows: c.knows,
      goal: c.goal,
      goals,
      skills: c.skills,
      restrictions: c.restrictions,
    };
  });

  const story = {
    title: spec.title,
    premise: spec.premise,
    scenes: spec.scenes,
    writerStyle: spec.writerStyle,
    characters: charDefs,
    config: {
      retries: 2,
      clarifications: 2,
      maxSteps: 24,
    },
    models: {
      default: models.default,
    },
  };

  files["story.json"] = JSON.stringify(story, null, 2) + "\n";

  return files;
}

/** Never raw JSON — the round asks for a judgement about people, which JSON is the wrong shape for. */
export function renderSpec(spec: StorySpec, full = false): string {
  const head = `${C.bold}${spec.title || "(untitled)"}${C.reset}\n`
    + `${C.dim}${spec.scene.place || "(nowhere stated)"} · ~${spec.scene.length} words`
    + `${spec.scene.pov ? ` · pov ${spec.scene.pov}` : ""}${C.reset}`
    + `${spec.scenes.length > 1 ? ` · ${spec.scenes.length} scenes` : ""}\n\n`
    + `${spec.premise || "(no premise)"}\n\n`
    + `${C.bold}Question:${C.reset} ${spec.scene.question || "(none)"}\n`;
  const cast = spec.characters.map(c => {
    const lines = [`\n${C.cyan}${c.name}${C.reset}`];
    if (c.skills.length) lines.push(`  ${C.green}can also:${C.reset} ${c.skills.map(s => splitMeaning(s).text).join(", ")}`);
    if (c.restrictions.length)  lines.push(`  ${C.red}cannot:${C.reset}   ${c.restrictions.join(", ")}`);
    if (c.knows)         lines.push(`  ${C.dim}knows:${C.reset}    ${c.knows}`);
    if (c.goal)          lines.push(`  ${C.dim}wants:${C.reset}    ${c.goal}`);
    lines.push(full ? `\n${c.persona}\n` : `  ${C.dim}${c.persona.replace(/\s+/g, " ").slice(0, 140)}…${C.reset}`);
    return lines.join("\n");
  }).join("\n");
  return head + cast + (spec.writerStyle && full ? `\n\n${C.bold}House style${C.reset}\n${spec.writerStyle}\n` : "");
}

export function specView(spec: StorySpec) {
  return {
    title: spec.title, premise: spec.premise, scene: spec.scene, scenes: spec.scenes, writerStyle: spec.writerStyle,
    characters: spec.characters.map(c => ({
      name: c.name, persona: c.persona, knows: c.knows, goal: c.goal,
      skills: c.skills.map(s => splitMeaning(s)),
      restrictions: c.restrictions,
    })),
  };
}
