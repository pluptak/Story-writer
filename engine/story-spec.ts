/** STORY SPEC — what the architect proposes: the shape, normalization, edits, and its renderings. */
import { C } from "../ansi.ts";
import { slugify } from "./config-util.ts";
import { SKILL_CATALOG, canonSkill, splitMeaning } from "./skills.ts";

export interface StorySpec {
  title: string;
  premise: string;
  scene: { place: string; question: string; pov: string; length: number };
  writerStyle: string;
  characters: Array<{ name: string; persona: string; knows: string; goal: string; skills: string[]; lacks: string[] }>;
}

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean)
  : typeof v === "string" ? v.split("|").map(s => s.trim()).filter(Boolean)
  : [];

export function normalizeSpec(raw: any): { spec: StorySpec; problems: string[] } {
  const problems: string[] = [];
  const o = raw ?? {};
  const s = (o.scene && typeof o.scene === "object") ? o.scene : {};

  const seen = new Set<string>();
  const characters: StorySpec["characters"] = [];
  for (const c of (Array.isArray(o.characters) ? o.characters : [])) {
    const name = String(c?.name ?? "").trim();
    if (!name) { problems.push("a character came back with no name — dropped"); continue; }
    if (seen.has(name.toLowerCase())) { problems.push(`two characters called "${name}" — kept the first`); continue; }
    seen.add(name.toLowerCase());
    const lacks = asStrings(c?.lacks).filter(l => {
      // A `lacks:` outside the catalog removes nothing — the silent opposite of what was asked for.
      const ok = Object.keys(SKILL_CATALOG).some(g => canonSkill(g) === canonSkill(splitMeaning(l).text));
      if (!ok) problems.push(`${name} "lacks: ${l}" — not a general skill, so it would remove nothing`);
      return ok;
    });
    characters.push({
      name, persona: String(c?.persona ?? "").trim(), knows: String(c?.knows ?? "").trim(),
      goal: String(c?.goal ?? "").trim(), skills: asStrings(c?.skills), lacks,
    });
    if (!c?.persona) problems.push(`${name} has no persona`);
    // The engine renders those fields itself, so a persona restating them contradicts the skill
    // list inside the character's own prompt.
    else if (/\b(LACKS|KNOWS|SKILLS|GOAL)\s*:/.test(String(c.persona)))
      problems.push(`${name}'s persona restates knows/goal/skills/lacks — the engine renders those, and the persona will contradict them`);
  }
  if (!characters.length) problems.push("no characters at all");
  if (characters.length > 4) { problems.push(`${characters.length} characters — keeping the first 4`); characters.length = 4; }

  const lengthRaw = Number(s.length);
  const pov = String(s.pov ?? "").trim();
  const povOk = !pov || characters.some(c => c.name.toLowerCase() === pov.toLowerCase());
  if (pov && !povOk) problems.push(`pov "${pov}" is not one of the characters — cleared`);

  const spec: StorySpec = {
    title: String(o.title ?? "").trim(),
    premise: String(o.premise ?? "").trim(),
    scene: {
      place: String(s.place ?? "").trim(),
      question: String(s.question ?? "").trim(),
      pov: povOk ? pov : "",
      length: Number.isFinite(lengthRaw) && lengthRaw >= 1 ? Math.round(lengthRaw) : 700,
    },
    writerStyle: String(o.writer_style ?? o.writerStyle ?? "").trim(),
    characters,
  };
  if (!spec.title) problems.push("no title");
  if (!spec.premise) problems.push("no premise");
  if (!spec.scene.question) problems.push("no scene question — nothing for the scene to answer");
  if (characters.length > 1 && !characters.some(c => c.lacks.length))
    problems.push("nobody lacks anything — no perceptual asymmetry for the consult to bite on");
  return { spec, problems };
}

export function applyEdits(spec: StorySpec, raw: any): {
  spec: StorySpec; applied: string[]; ignored: string[]; problems: string[];
} {
  const applied: string[] = [], ignored: string[] = [];
  const draft: any = JSON.parse(JSON.stringify({ ...spec, writer_style: spec.writerStyle }));
  const edits = Array.isArray(raw?.edits) ? raw.edits : [];
  const findChar = (name: string) =>
    draft.characters.find((c: any) => String(c.name).toLowerCase() === name.trim().toLowerCase());

  for (const e of edits) {
    const field = String(e?.field ?? "").trim();
    const value = e?.value;
    const scalar = () => String(value ?? "").trim();

    if (field === "title" || field === "premise") { draft[field] = scalar(); applied.push(field); continue; }
    if (field === "writer_style" || field === "writerStyle") { draft.writer_style = scalar(); applied.push("writer_style"); continue; }

    const sceneKey = field.match(/^scene\.(place|question|pov|length)$/)?.[1];
    if (sceneKey) {
      draft.scene[sceneKey] = sceneKey === "length" ? Number(value) : scalar();
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

    const cm = field.match(/^characters\.(.+)\.(persona|knows|goal|skills|lacks)$/);
    if (cm) {
      const c = findChar(cm[1]);
      if (!c) { ignored.push(`${field} — no character called "${cm[1]}"`); continue; }
      c[cm[2]] = (cm[2] === "skills" || cm[2] === "lacks") ? asStrings(value) : scalar();
      applied.push(`${c.name}.${cm[2]}`);
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
  const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
  const files: Record<string, string> = {};

  const used = new Set<string>();
  const fileFor = (name: string) => {
    let base = slugify(name) || "character";
    let f = `${base}.md`, n = 2;
    while (used.has(f)) f = `${base}-${n++}.md`;    // two names can slug to one file; don't overwrite
    used.add(f);
    return f;
  };

  const blocks = spec.characters.map(c => {
    const file = fileFor(c.name);
    files[file] = `# ${c.name}\n\n${c.persona.trim()}\n`;
    return [
      `### ${c.name}`,
      `file: ${file}`,
      c.skills.length ? `skills: ${c.skills.map(oneLine).join(" | ")}` : "",
      c.lacks.length ? `lacks: ${c.lacks.map(oneLine).join(" | ")}` : "",
      c.knows ? `knows: ${oneLine(c.knows)}` : "",
      c.goal  ? `goal: ${oneLine(c.goal)}` : "",
    ].filter(Boolean).join("\n");
  });

  if (spec.writerStyle.trim()) files["writer.md"] = `# House style\n\n${spec.writerStyle.trim()}\n`;

  const sceneLines = [
    spec.scene.place ? `place: ${oneLine(spec.scene.place)}` : "",
    spec.scene.question ? `question: ${oneLine(spec.scene.question)}` : "",
    spec.scene.pov ? `pov: ${spec.scene.pov}` : "",
    `length: ${spec.scene.length}`,
  ].filter(Boolean).join("\n");

  files["story.md"] = [
    `# ${spec.title}`,
    `## Premise\n${spec.premise.trim()}`,
    `## Scene\n${sceneLines}`,
    ...(files["writer.md"] ? [`## Writer\nfile: writer.md`] : []),
    `## Characters\n\n${blocks.join("\n\n")}`,
    `## Config\nretries: 2\nclarifications: 2\nmax_steps: 24`,
    `## Models\ndefault: ${models.default}`,
  ].join("\n\n") + "\n";

  return files;
}

/** Never raw JSON — the round asks for a judgement about people, which JSON is the wrong shape for. */
export function renderSpec(spec: StorySpec, full = false): string {
  const head = `${C.bold}${spec.title || "(untitled)"}${C.reset}\n`
    + `${C.dim}${spec.scene.place || "(nowhere stated)"} · ~${spec.scene.length} words`
    + `${spec.scene.pov ? ` · pov ${spec.scene.pov}` : ""}${C.reset}\n\n`
    + `${spec.premise || "(no premise)"}\n\n`
    + `${C.bold}Question:${C.reset} ${spec.scene.question || "(none)"}\n`;
  const cast = spec.characters.map(c => {
    const lines = [`\n${C.cyan}${c.name}${C.reset}`];
    if (c.skills.length) lines.push(`  ${C.green}can also:${C.reset} ${c.skills.map(s => splitMeaning(s).text).join(", ")}`);
    if (c.lacks.length)  lines.push(`  ${C.red}cannot:${C.reset}   ${c.lacks.join(", ")}`);
    if (c.knows)         lines.push(`  ${C.dim}knows:${C.reset}    ${c.knows}`);
    if (c.goal)          lines.push(`  ${C.dim}wants:${C.reset}    ${c.goal}`);
    lines.push(full ? `\n${c.persona}\n` : `  ${C.dim}${c.persona.replace(/\s+/g, " ").slice(0, 140)}…${C.reset}`);
    return lines.join("\n");
  }).join("\n");
  return head + cast + (spec.writerStyle && full ? `\n\n${C.bold}House style${C.reset}\n${spec.writerStyle}\n` : "");
}

export function specView(spec: StorySpec) {
  return {
    title: spec.title, premise: spec.premise, scene: spec.scene, writerStyle: spec.writerStyle,
    characters: spec.characters.map(c => ({
      name: c.name, persona: c.persona, knows: c.knows, goal: c.goal,
      skills: c.skills.map(s => splitMeaning(s)),
      lacks: c.lacks,
    })),
  };
}
