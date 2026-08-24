/** STORY SPEC — what the architect proposes: the shape, normalization, edits, and its renderings. */
import { C } from "../ansi.ts";
import { slugify } from "./config-util.ts";
import { SKILL_CATALOG, RESTRICTION_CATALOG, bibleMeaningOf, canonSkill, splitMeaning } from "./skills.ts";
import { StoryJson, RunConfig, THINK_LEVELS, type ThinkLevel, type SceneDef, type CharacterDef } from "./story-schema.ts";

export type { SceneDef, CharacterDef, RunConfig } from "./story-schema.ts";

/** What the architect proposes: a story in the working shape used for editing and rendering. */
export interface StorySpec {
  title: string;
  premise: string;
  scenes: SceneDef[];
  writerStyle: string;
  facts: string[];
  config: RunConfig;
  models: { default: string; writer: string; summary: string };
  characters: Array<{
    name: string; model: string; persona: string; knows: string; goal: string;
    belief: string; impulse: string; voice: string[];
    skills: string[]; restrictions: string[]; maxRetries?: number;
  }>;
}

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean)
  : typeof v === "string" ? v.split("|").map(s => s.trim()).filter(Boolean)
  : [];

/** The belief/impulse/voice fields are required by convention, not by schema (so old stories still load).
 *  Both `normalizeSpec` (architect proposals) and the saved-story check surface their absence from here,
 *  so the wording lives in one place. */
export function characterPsychologyWarnings(
  name: string, belief: string, impulse: string, voice: string[],
): string[] {
  const out: string[] = [];
  if (!belief.trim()) out.push(`${name} has no belief — one load-bearing conviction, possibly false`);
  if (!impulse.trim()) out.push(`${name} has no impulse — one conditional rule: "when X → Y"`);
  if (!voice.length) out.push(`${name} has no voice samples — 1 to 3 lines of dialogue in their own words`);
  return out;
}

/** Normalize a raw architect proposal into a StorySpec, collecting non-fatal problems instead of failing. */
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
    const skills = asStrings(c?.skills);
    for (const entry of skills) {
      const { text, meaning } = splitMeaning(entry);
      if (bibleMeaningOf(text) === undefined && !meaning)
        problems.push(`${name} has skill "${text}" — not a bible skill, and it carries no ":: meaning", so nobody can tell what it lets them do`);
    }
    const restrictions = asStrings(c?.restrictions ?? c?.lacks).filter(l => {
      const r = splitMeaning(l).text;
      const rk = canonSkill(r);
      const ok = Object.keys(SKILL_CATALOG).some(g => canonSkill(g) === rk)
        || Object.keys(RESTRICTION_CATALOG).some(p => canonSkill(p) === rk)
        || bibleMeaningOf(r) !== undefined
        || skills.some(s => canonSkill(splitMeaning(s).text) === rk);
      if (!ok) problems.push(`${name} "restrictions: ${l}" — not a known skill or penalty, so it would remove nothing`);
      return ok;
    });
    const voice = asStrings(c?.voice);
    if (voice.length > 3) { voice.length = 3; problems.push(`${name} came back with more than 3 voice samples — keeping the first 3`); }
    const belief = String(c?.belief ?? "").trim(), impulse = String(c?.impulse ?? "").trim();
    // A proposal may carry what a chapter taught someone as its own field. It is knowledge, so it
    // lands in knows verbatim and the field itself never survives normalization into a spec.
    const knows = String(c?.knows ?? "").trim();
    const learned = String(c?.learned ?? "").trim();
    if (learned) problems.push(`${name} arrived with "learned" — folded into their knows`);
    characters.push({
      name, model: String(c?.model ?? "").trim(), persona: String(c?.persona ?? "").trim(),
      knows: [knows, learned].filter(Boolean).join(" "),
      goal: String(c?.goal ?? "").trim(),
      belief, impulse, voice,
      skills, restrictions,
      ...(Number.isInteger(c?.maxRetries) && c.maxRetries >= 0 ? { maxRetries: c.maxRetries } : {}),
    });
    if (!c?.persona) problems.push(`${name} has no persona`);
    else if (/\b(RESTRICTIONS|LACKS|KNOWS|SKILLS|GOAL|BELIEF|IMPULSE|VOICE)\s*:/.test(String(c.persona)))
      problems.push(`${name}'s persona restates knows/goal/belief/impulse/voice/skills/restrictions — the engine renders those, and the persona will contradict them`);
    problems.push(...characterPsychologyWarnings(name, belief, impulse, voice));
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
      roster: Array.isArray(s.roster) ? s.roster.map((r: unknown) => String(r).trim()).filter(Boolean) : [],
      ...(s.writerModel ? { writerModel: String(s.writerModel).trim() } : {}),
      ...(s.writerThink && (THINK_LEVELS as readonly string[]).includes(String(s.writerThink))
        ? { writerThink: String(s.writerThink) as ThinkLevel } : {}),
    };
  };

  const scenes: SceneDef[] = rawScenes.map((s, i) => readSceneDef(s, i === 0 ? "scene" : `scene ${i + 1}`));

  const config = RunConfig.parse(o.config ?? {});

  const models = {
    default: String(o.models?.default ?? "").trim(),
    writer: String(o.models?.writer ?? "").trim(),
    summary: String(o.models?.summary ?? "").trim(),
  };

  const spec: StorySpec = {
    title: String(o.title ?? "").trim(),
    premise: String(o.premise ?? "").trim(),
    scenes,
    writerStyle: String(o.writer_style ?? o.writerStyle ?? "").trim(),
    facts: Array.isArray(o.facts) ? o.facts.map((f: unknown) => String(f).trim()).filter(Boolean) : [],
    config,
    models,
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

/** Apply a list of field edits to a spec without mutating the input; report what was applied and what was ignored. */
export function applyEdits(spec: StorySpec, raw: any): {
  spec: StorySpec; applied: { field: string; before: unknown; after: unknown }[]; ignored: string[]; problems: string[];
} {
  type Applied = { field: string; before: unknown; after: unknown };
  type Work = Applied & { key: string; snapshot: unknown; resolve?: (next: StorySpec) => unknown };
  const work: Work[] = [], ignored: string[] = [];
  const draft: any = JSON.parse(JSON.stringify({ ...spec, writer_style: spec.writerStyle, scenes: spec.scenes }));
  const rawEdits = Array.isArray(raw?.edits) ? raw.edits : [];
  // The canonical edit shape is {"field": "...", "value": ...}. Some models instead emit a single
  // object whose KEYS are the field names ({"title": "...", "premise": "..."}). Expand those into the
  // canonical field/value pairs so the edit is applied instead of being silently dropped as "an edit
  // with no field".
  const edits = rawEdits.flatMap((e: any) => {
    if (e && typeof e === "object" && !Array.isArray(e) && typeof e.field !== "string") {
      return Object.entries(e).map(([k, v]) => ({ field: k, value: v }));
    }
    return [e];
  });
  // One round may rename a character and then address them by the old name ("rewrite the prose
  // under the old name in the same round") -- later edits follow renames made earlier in the list.
  const renames = new Map<string, string>();
  const findChar = (name: string) => {
    let key = name.trim().toLowerCase();
    for (let hops = 0; hops <= renames.size; hops++) {
      const c = draft.characters.find((c: any) => String(c.name).toLowerCase() === key);
      if (c) return c;
      const next = renames.get(key);
      if (!next) return undefined;
      key = next;
    }
    return undefined;
  };
  const normalizedDraft = () => normalizeSpec(draft).spec;
  const add = (entry: Omit<Work, "after"> & { after?: unknown }) => work.push(entry as Work);
  const scalarResolver = (key: string, resolve: (next: StorySpec) => unknown, before: unknown, field = key) => {
    const normalized = normalizedDraft();
    add({ field, before, after: undefined, key, snapshot: resolve(normalized), resolve });
  };

  for (const e of edits) {
    const field = String(e?.field ?? "").trim();
    const value = e?.value;
    const scalar = () => String(value ?? "").trim();

    if (field === "title" || field === "premise") {
      const before = normalizedDraft()[field as "title" | "premise"];
      draft[field] = scalar();
      scalarResolver(field, next => next[field as "title" | "premise"], before);
      continue;
    }
    if (field === "writer_style" || field === "writerStyle") {
      const before = normalizedDraft().writerStyle;
      draft.writer_style = scalar();
      scalarResolver("writer_style", next => next.writerStyle, before, "writer_style");
      continue;
    }
    if (field === "facts") {
      const before = normalizedDraft().facts;
      draft.facts = asStrings(value);
      scalarResolver("facts", next => next.facts, before, "facts");
      continue;
    }

    const sceneMatch = field.match(/^(scene(?:_(\d+))?)\.(place|question|pov|length|roster)$/);
    if (sceneMatch) {
      const idx = sceneMatch[2] ? Number(sceneMatch[2]) - 1 : 0;
      if (idx >= draft.scenes.length) { ignored.push(`${field} — scene ${idx + 1} does not exist`); continue; }
      const sceneField = sceneMatch[3];
      const before = (normalizedDraft().scenes[idx] as any)[sceneField];
      if (sceneField === "roster") draft.scenes[idx].roster = asStrings(value);
      else if (sceneField === "length") draft.scenes[idx].length = Number(value);
      else draft.scenes[idx][sceneField] = scalar();
      const key = `scene:${idx}.${sceneField}`;
      scalarResolver(key, next => (next.scenes[idx] as any)?.[sceneField], before, field);
      continue;
    }

    if (field === "add_scene") {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        ignored.push("add_scene — the value must be a scene object"); continue;
      }
      const before = undefined;
      draft.scenes.push(value);
      const sceneNumber = draft.scenes.length;
      const normalized = normalizedDraft();
      add({ field: `added scene ${sceneNumber}`, before, after: undefined, key: `added-scene:${sceneNumber}`, snapshot: normalized.scenes[sceneNumber - 1] });
      continue;
    }
    if (field === "remove_scene") {
      const n = Number(typeof value === "object" ? NaN : value);
      if (!Number.isInteger(n) || n < 1 || n > draft.scenes.length) {
        ignored.push(`remove_scene ${scalar() || "(nothing)"} — there is no scene ${scalar() || "(nothing)"}`); continue;
      }
      // A story with no scenes has nothing to write; normalizeSpec would silently invent a blank one.
      if (draft.scenes.length === 1) { ignored.push("remove_scene 1 — a story needs at least one scene"); continue; }
      const before = normalizedDraft().scenes[n - 1];
      draft.scenes.splice(n - 1, 1);
      add({ field: `removed scene ${n}`, before, after: undefined, key: `removed-scene:${n}`, snapshot: undefined });
      continue;
    }

    if (field === "add_character") {
      const name = String(value?.name ?? "").trim();
      if (!name) { ignored.push(`add_character with no name`); continue; }
      if (findChar(name)) { ignored.push(`add_character "${name}" — already in the cast`); continue; }
      const before = undefined;
      draft.characters.push(value);
      const normalized = normalizedDraft();
      const added = normalized.characters.find(c => c.name.toLowerCase() === name.toLowerCase());
      add({ field: `added ${name}`, before, after: undefined, key: `added-character:${name.toLowerCase()}`, snapshot: added });
      continue;
    }
    if (field === "remove_character") {
      const name = scalar();
      const idx = draft.characters.findIndex((c: any) => String(c.name).toLowerCase() === name.toLowerCase());
      if (idx < 0) { ignored.push(`remove_character "${name}" — not in the cast`); continue; }
      const before = normalizedDraft().characters[idx];
      draft.characters.splice(idx, 1);
      add({ field: `removed ${name}`, before, after: undefined, key: `removed-character:${name.toLowerCase()}`, snapshot: undefined });
      continue;
    }

    // What a chapter taught someone arrives as its own field and is absorbed into their knows on
    // arrival -- reported as a knows change so the author sees where it landed.
    const lm = field.match(/^characters\.(.+)\.learned$/);
    if (lm) {
      const who = lm[1].replace(/^<+/, "").replace(/>+$/, "").trim() || lm[1];
      const c = findChar(who);
      if (!c) { ignored.push(`${field} — no character called "${who}"`); continue; }
      const text = scalar();
      if (!text) { ignored.push(`${field} — nothing to learn was given`); continue; }
      const before = normalizedDraft().characters.find(x => x.name.toLowerCase() === c.name.toLowerCase())?.knows;
      c.knows = [String(c.knows ?? "").trim(), text].filter(Boolean).join(" ");
      scalarResolver(`character:${c.name.toLowerCase()}.knows`,
        next => next.characters.find(x => x.name.toLowerCase() === c.name.toLowerCase())?.knows,
        before, `${c.name}.learned`);
      continue;
    }

    const cm = field.match(/^characters\.(.+)\.(persona|knows|goal|belief|impulse|voice|skills|restrictions|lacks|name)$/);
    if (cm) {
      // Models copy the <NAME> placeholder literally sometimes; unwrap it rather than refuse.
      const who = cm[1].replace(/^<+/, "").replace(/>+$/, "").trim() || cm[1];
      const c = findChar(who);
      if (!c) { ignored.push(`${field} — no character called "${who}"`); continue; }

      // A rename carries the structural references with it: who a roster names, whose perception
      // a scene sits inside. Prose that speaks of the person under the old name is the architect's
      // to rewrite, not the engine's.
      if (cm[2] === "name") {
        const fresh = scalar();
        if (!fresh) { ignored.push(`${field} — a character cannot be renamed to nothing`); continue; }
        if (fresh.toLowerCase() !== c.name.toLowerCase() && findChar(fresh)) {
          ignored.push(`${field} — "${fresh}" is already in the cast`); continue;
        }
        const before = normalizedDraft().characters.find(x => x.name.toLowerCase() === c.name.toLowerCase())?.name;
        const old = c.name;
        c.name = fresh;
        renames.set(old.toLowerCase(), fresh.toLowerCase());
        for (const sc of draft.scenes) {
          if (String(sc.pov ?? "").trim().toLowerCase() === old.toLowerCase()) sc.pov = fresh;
          sc.roster = ((sc.roster ?? []) as string[])
            .map(r => String(r).trim().toLowerCase() === old.toLowerCase() ? fresh : r);
        }
        scalarResolver(`character:${old.toLowerCase()}.name`,
          next => next.characters.find(x => x.name.toLowerCase() === fresh.toLowerCase())?.name,
          before, `${old}.name`);
        continue;
      }

      const targetField = cm[2] === "lacks" ? "restrictions" : cm[2];
      const before = (normalizedDraft().characters.find(x => x.name.toLowerCase() === c.name.toLowerCase()) as any)?.[targetField];
      const LIST_FIELDS = new Set(["skills", "restrictions", "voice"]);
      c[targetField] = LIST_FIELDS.has(targetField) ? asStrings(value) : scalar();
      const key = `character:${c.name.toLowerCase()}.${targetField}`;
      scalarResolver(key, next => (next.characters.find(x => x.name.toLowerCase() === c.name.toLowerCase()) as any)?.[targetField], before, `${c.name}.${targetField}`);
      continue;
    }

    // -- FACT EDITS ---------------------------------------------------------
    if (field === "add_fact") {
      const before = undefined;
      draft.facts.push(scalar());
      const factNumber = draft.facts.length;
      scalarResolver(`fact:${factNumber}`, next => next.facts[factNumber - 1], before, "added fact");
      continue;
    }
    if (field === "remove_fact") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > draft.facts.length) {
        ignored.push(`remove_fact ${scalar() || "(nothing)"} — no such fact`);
        continue;
      }
      const before = normalizedDraft().facts[n - 1];
      draft.facts.splice(n - 1, 1);
      add({ field: `removed fact ${n}`, before, after: undefined, key: `removed-fact:${n}`, snapshot: undefined });
      continue;
    }
    const factMatch = field.match(/^fact_(\d+)$/);
    if (factMatch) {
      const idx = Number(factMatch[1]) - 1;
      if (idx < 0 || idx >= draft.facts.length) {
        ignored.push(`${field} — fact ${factMatch[1]} does not exist`);
        continue;
      }
      const before = normalizedDraft().facts[idx];
      draft.facts[idx] = scalar();
      scalarResolver(`fact:${idx}`, next => next.facts[idx], before, `updated fact ${factMatch[1]}`);
      continue;
    }

    // -- TECHNICAL EDITS ----------------------------------------------------
    // The "technical" checklist stage authors these; they must also be editable by an in-gate
    // [CHANGE] so a refinement round can tweak what the stage proposed. Option (a): models.* is
    // NOT authored here (it stays resolved from defaults.json / the user), so only `default` may
    // be set, and `writer`/`summary` are left to the author.
    if (field.startsWith("config.") && field.split(".").length === 2) {
      const key = field.slice(6);
      const NUM = new Set(["retries", "clarifications", "maxSteps", "maxProseWords",
        "requestTimeout", "attempts", "maxTokens", "maxCharacterRetries"]);
      const BOOL = new Set(["stream", "debug"]);
      if (!NUM.has(key) && !BOOL.has(key)) { ignored.push(`${field} — not an editable config key`); continue; }
      const before = (normalizedDraft().config as any)?.[key];
      draft.config = draft.config || {};
      if (NUM.has(key)) {
        const n = Number(value);
        draft.config[key] = (value === "" || !Number.isFinite(n)) ? undefined : Math.round(n);
      } else {
        draft.config[key] = Boolean(value);
      }
      scalarResolver(`config:${key}`, next => (next.config as any)?.[key], before, field);
      continue;
    }
    if (field.startsWith("config.thinking.")) {
      const key = field.slice("config.thinking.".length);
      if (!["writer", "character", "summary"].includes(key)) { ignored.push(`${field} — not an editable thinking key`); continue; }
      const before = (normalizedDraft().config?.thinking as any)?.[key];
      draft.config = draft.config || {};
      draft.config.thinking = draft.config.thinking || {};
      draft.config.thinking[key] = scalar();
      scalarResolver(`config.thinking:${key}`, next => (next.config?.thinking as any)?.[key], before, field);
      continue;
    }
    if (field.startsWith("models.")) {
      const key = field.slice(7);
      if (!["default", "writer", "summary"].includes(key)) { ignored.push(`${field} — not an editable models key`); continue; }
      const before = (normalizedDraft().models as any)?.[key];
      draft.models = draft.models || {};
      draft.models[key] = scalar() || undefined;
      scalarResolver(`models:${key}`, next => (next.models as any)?.[key], before, field);
      continue;
    }
    const techScene = field.match(/^scene(?:_(\d+))?\.writer(Think|Model)$/);
    if (techScene) {
      const idx = techScene[1] ? Number(techScene[1]) - 1 : 0;
      if (idx >= draft.scenes.length) { ignored.push(`${field} — scene ${idx + 1} does not exist`); continue; }
      const sub = techScene[2] === "Think" ? "writerThink" : "writerModel";
      const before = (normalizedDraft().scenes[idx] as any)?.[sub];
      draft.scenes[idx][sub] = scalar() || undefined;
      scalarResolver(`scene:${idx}.${sub}`, next => (next.scenes[idx] as any)?.[sub], before, field);
      continue;
    }
    const charMax = field.match(/^characters\.(.+)\.maxRetries$/);
    if (charMax) {
      const who = charMax[1].replace(/^<+/, "").replace(/>+$/, "").trim() || charMax[1];
      const c = findChar(who);
      if (!c) { ignored.push(`${field} — no character called "${who}"`); continue; }
      const before = (normalizedDraft().characters.find(x => x.name.toLowerCase() === c.name.toLowerCase()) as any)?.maxRetries;
      const target = draft.characters.find((x: any) => String(x.name).toLowerCase() === c.name.toLowerCase());
      if (target) target.maxRetries = (value === "" || value == null) ? undefined : Number(value);
      scalarResolver(`character:${c.name.toLowerCase()}.maxRetries`,
        next => (next.characters.find(x => x.name.toLowerCase() === c.name.toLowerCase()) as any)?.maxRetries,
        before, `${c.name}.maxRetries`);
      continue;
    }

    ignored.push(field ? `unknown field "${field}"` : "an edit with no field");
  }

  const { spec: next, problems } = normalizeSpec(draft);
  const counts = new Map<string, number>();
  for (const e of work) counts.set(e.key, (counts.get(e.key) ?? 0) + 1);
  const applied = work.map(({ field, before, snapshot, resolve, key }) => ({
    field,
    before,
    after: counts.get(key) === 1 && resolve ? (resolve(next) ?? snapshot) : snapshot,
  }));
  return { spec: next, applied, ignored, problems };
}

/** The fields a GUI may set directly; everything else goes through the architect. */
export const DIRECT_FIELDS = ["scene.length"] as const;
/** The acceptable length range for one scene, enforced by directEdit. */
export const MIN_SCENE_WORDS = 100, MAX_SCENE_WORDS = 10000;
/** The one direct edit the engine trusts: `scene.length`, rounded and bounds-checked. */
export function directEdit(spec: StorySpec, field: string, value: unknown):
  { ok: false; reason: string } | { ok: true; spec: StorySpec; applied: { field: string; before: unknown; after: unknown }[]; problems: string[] } {
  if (!(DIRECT_FIELDS as readonly string[]).includes(field))
    return { ok: false, reason: `"${field}" is the architect's to change — say what you want instead` };
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < MIN_SCENE_WORDS || n > MAX_SCENE_WORDS)
    return { ok: false, reason: `a scene is ${MIN_SCENE_WORDS}–${MAX_SCENE_WORDS} words` };
  const e = applyEdits(spec, { edits: [{ field, value: n }] });
  return { ok: true, spec: e.spec, applied: e.applied, problems: e.problems };
}

/** Which of a scene's fields differ between two versions of the story, for detecting that a chapter's
 *  prose was written from a definition that has since changed. Roster order is not a difference. */
export function sceneDrift(before: SceneDef | undefined, after: SceneDef | undefined): string[] {
  if (!before || !after) return [];
  const diff: string[] = [];
  if (before.place.trim() !== after.place.trim()) diff.push("place");
  if (before.question.trim() !== after.question.trim()) diff.push("question");
  if (before.pov.trim() !== after.pov.trim()) diff.push("pov");
  if (before.length !== after.length) diff.push("length");
  const was = new Set(before.roster), now = new Set(after.roster);
  if (was.size !== now.size || ![...was].every(x => now.has(x))) diff.push("roster");
  return diff;
}

/** Render a spec to the story files on disk (currently just story.json), ready to write into a story folder. */
export function renderStory(spec: StorySpec, models: { default: string }): Record<string, string> {
  const files: Record<string, string> = {};

  const charDefs = spec.characters.map(c => ({
    name: c.name,
    model: c.model,
    persona: c.persona,
    knows: c.knows,
    goal: c.goal,
    belief: c.belief,
    impulse: c.impulse,
    voice: c.voice,
    skills: c.skills,
    restrictions: c.restrictions,
    ...(c.maxRetries !== undefined ? { maxRetries: c.maxRetries } : {}),
  }));

  const renderedModels = {
    default: spec.models.default || models.default,
    ...(spec.models.writer ? { writer: spec.models.writer } : {}),
    ...(spec.models.summary ? { summary: spec.models.summary } : {}),
  };

  const story = {
    title: spec.title,
    premise: spec.premise,
    scenes: spec.scenes,
    writerStyle: spec.writerStyle,
    facts: spec.facts,
    characters: charDefs,
    config: spec.config,
    models: renderedModels,
  };

  files["story.json"] = JSON.stringify(story, null, 2) + "\n";

  return files;
}

/** Never raw JSON — the round asks for a judgement about people, which JSON is the wrong shape for. */
export function renderSpec(spec: StorySpec, full = false): string {
  const head = `${C.bold}${spec.title || "(untitled)"}${C.reset}\n`
    + `${C.dim}${spec.scenes[0].place || "(nowhere stated)"} · ~${spec.scenes[0].length} words`
    + `${spec.scenes[0].pov ? ` · pov ${spec.scenes[0].pov}` : ""}${C.reset}`
    + `${spec.scenes.length > 1 ? ` · ${spec.scenes.length} scenes` : ""}\n\n`
    + `${spec.premise || "(no premise)"}\n\n`
    + `${C.bold}Question:${C.reset} ${spec.scenes[0].question || "(none)"}\n`;
  const cast = spec.characters.map(c => {
    const lines = [`\n${C.cyan}${c.name}${C.reset}`];
    if (c.skills.length) lines.push(`  ${C.green}can also:${C.reset} ${c.skills.map(s => splitMeaning(s).text).join(", ")}`);
    if (c.restrictions.length)  lines.push(`  ${C.red}cannot:${C.reset}   ${c.restrictions.join(", ")}`);
    if (c.knows)         lines.push(`  ${C.dim}knows:${C.reset}    ${c.knows}`);
    if (c.goal)          lines.push(`  ${C.dim}wants:${C.reset}    ${c.goal}`);
    if (c.belief)        lines.push(`  ${C.dim}believes:${C.reset} ${c.belief}`);
    if (c.impulse)       lines.push(`  ${C.dim}impulse:${C.reset}  ${c.impulse}`);
    lines.push(full ? `\n${c.persona}\n` : `  ${C.dim}${c.persona.replace(/\s+/g, " ").slice(0, 140)}…${C.reset}`);
    for (const v of full ? c.voice : []) lines.push(`  ${C.dim}says:${C.reset}     "${v}"`);
    return lines.join("\n");
  }).join("\n");
  return head + cast + (spec.writerStyle && full ? `\n\n${C.bold}House style${C.reset}\n${spec.writerStyle}\n` : "");
}

/** The spec as the GUI expects it: character skills split into their `name :: meaning` parts. */
export function specView(spec: StorySpec) {
  return {
    title: spec.title, premise: spec.premise, scene: spec.scenes[0], scenes: spec.scenes, writerStyle: spec.writerStyle,
    facts: spec.facts, config: spec.config, models: spec.models,
    characters: spec.characters.map(c => ({
      name: c.name, model: c.model, persona: c.persona, knows: c.knows, goal: c.goal,
      belief: c.belief, impulse: c.impulse, voice: c.voice,
      skills: c.skills.map(s => splitMeaning(s)),
      restrictions: c.restrictions,
      ...(c.maxRetries !== undefined ? { maxRetries: c.maxRetries } : {}),
    })),
  };
}
