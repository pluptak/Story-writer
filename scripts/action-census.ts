/**
 * ACTION CENSUS — how often does a character's answer actually touch the world?
 *
 * Offline, deterministic analysis over runs already on disk. No model call anywhere.
 *
 * Source: the run's `writing-log.jsonl` event stream (RunEvent). Accepted answers are the
 * `accept` events (single consults) plus `reaction` events (fan-out reactors); both carry
 * `speech`/`action`. The `consult` events carry the situation text used as the crude
 * external-entity corpus beside the scene's `place`. A malformed or truncated log line is
 * skipped, the same tolerance `runLlmLogs` gives a truncated transcript.
 *
 * Fallback source: a replay fixture dir holding `calls.jsonl` + `story.json`
 * (tests/fixtures/recorded-run) has no event stream — its `character.consult` responses are
 * counted instead, with prompts-stripped situations unavailable. The report says which source
 * each input used.
 *
 * Usage:
 *   npx tsx scripts/action-census.ts <story-dir|run-dir|fixture-dir>... [--json]
 *   npx tsx scripts/action-census.ts tests/fixtures/recorded-run
 *   npx tsx scripts/action-census.ts data/stories/doorway
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { runDirs } from "../engine/preflight.ts";

interface CensusAnswer { character: string; speech: string; action: string; run: string }
interface RunInput { label: string; storyDir: string; runId: string; logPath: string | null; fixturePath: string | null }

const BODY_ONLY_RES = [
  /\bshrug/, /\bnod/, /\bshake\s+(?:his|her|their|my)?\s*head/, /\blook\s+away/,
  /\bglanc(?:e|es|ed|ing)\s+away/, /\bflinch/, /\bblink/, /\bsigh/, /\bsmile/, /\bfrown/,
  /\bswallow/, /\bbreath[eines]+/, /\binhal(?:e|es|ed|ing)/, /\bexhal(?:e|es|ed|ing)/,
  /\bshift.*weight/, /\blean(?:s|ed|ing)?\s+(?:back|forward|against)/, /\bstraighten/,
  /\bfold.*arms/, /\bcross.*arms/, /\brub\s+(?:his|her|their|my)/, /\bremain\s+\w+ed\b/,
  /\bstay\s+(?:still|quiet|put)/, /\bclos(?:e|es|ed|ing)\s+(?:his|her|their|my)?\s*eyes/,
];

const STOP = new Set([
  "that", "this", "with", "from", "have", "has", "had", "will", "would", "could", "should",
  "they", "them", "their", "theirs", "them", "then", "than", "there", "here", "when", "where",
  "what", "which", "while", "after", "before", "into", "onto", "over", "under", "about",
  "through", "without", "within", "between", "across", "along", "toward", "towards",
  "shift", "slightly", "slowly", "quietly", "still", "just", "very", "more", "most",
  "look", "looks", "turn", "turns", "hand", "hands", "head", "eyes", "weight",
]);

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9']+/).filter(w => w.length >= 4 && !STOP.has(w));
}

function firstSentence(why: string): string {
  const s = why.split(". ")[0].trim();
  return s.length > 120 ? s.slice(0, 120) + "…" : s || "(no reason)";
}

function lintFamily(why: string): string {
  const s = firstSentence(why);
  if (/^restricted sense:/i.test(s)) return "restricted sense narrated anyway (mechanical)";
  if (/^unmatched quotation:/i.test(s)) return "ungranted quotation (mechanical)";
  if (/THE ONE RULE/i.test(s)) return "THE ONE RULE (invented deed/stillness)";
  if (/CANNOT/i.test(s)) return "CANNOT violation";
  if (/situation/i.test(s)) return "consult-situation quality";
  return s;
}

/** Grouping key for a refusal reason: first sentence, numbers folded so repeated
 *  shapes ("gone 2 pieces", "gone 3 pieces") count together. */
function causeKey(why: string): string {
  return firstSentence(why).replace(/\d+/g, "N");
}

function parseFragment(response: unknown): Record<string, unknown> | null {
  if (response && typeof response === "object") return response as Record<string, unknown>;
  if (typeof response !== "string") return null;
  // Transcripts hold bare fragments (`"thought": ..., "action": ...`) as often as whole
  // objects — the same shape `extractJson` accepts — so try both before the regex fallback.
  for (const candidate of [response, `{${response}}`]) {
    try {
      const o = JSON.parse(candidate);
      if (o && typeof o === "object") return o as Record<string, unknown>;
    } catch { /* try next */ }
  }
  return null;
}

function parseActionFromConsultResponse(response: unknown): { speech: string; action: string } {
  const o = parseFragment(response);
  if (o) return { speech: String(o.speech ?? ""), action: String(o.action ?? "") };
  if (typeof response === "string") {
    const speech = /"speech"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(response)?.[1] ?? "";
    const action = /"action"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(response)?.[1] ?? "";
    return { speech, action };
  }
  return { speech: "", action: "" };
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function resolveInputs(args: string[]): Promise<RunInput[]> {
  const out: RunInput[] = [];
  for (const arg of args) {
    if (await exists(joinPath(arg, "writing-log.jsonl"))) {
      out.push({ label: arg, storyDir: arg, runId: arg, logPath: joinPath(arg, "writing-log.jsonl"), fixturePath: null });
      continue;
    }
    if (await exists(joinPath(arg, "calls.jsonl"))) {
      out.push({ label: arg, storyDir: arg, runId: arg, logPath: null, fixturePath: joinPath(arg, "calls.jsonl") });
      continue;
    }
    const ids = await runDirs(arg);
    if (ids.length) {
      for (const id of ids) {
        const logPath = joinPath(arg, "out", id, "writing-log.jsonl");
        if (await exists(logPath)) out.push({ label: `${arg}/out/${id}`, storyDir: arg, runId: id, logPath, fixturePath: null });
      }
      continue;
    }
    console.warn(`(skip ${arg}: no writing-log.jsonl, calls.jsonl, or out/ runs found)`);
  }
  return out;
}

async function readStoryPlaces(storyDir: string): Promise<string> {
  for (const candidate of [joinPath(storyDir, "story.json"), joinPath(storyDir, "out", "..", "story.json")]) {
    try {
      const raw = JSON.parse(await readFile(candidate, "utf8"));
      const scenes = Array.isArray(raw.scenes) ? raw.scenes : [];
      return scenes.map((s: { place?: unknown }) => String(s.place ?? "")).join("\n");
    } catch { /* try next */ }
  }
  try {
    const raw = JSON.parse(await readFile(joinPath(storyDir, "story.json"), "utf8"));
    const scenes = Array.isArray(raw.scenes) ? raw.scenes : [];
    return scenes.map((s: { place?: unknown }) => String(s.place ?? "")).join("\n");
  } catch { return ""; }
}

interface StoryTallies {
  story: string;
  source: string;
  runs: number;
  accepted: number;
  withAction: number;
  external: number;
  bodyOnly: number;
  answers: CensusAnswer[];
  corpus: Set<string>;
  place: Set<string>;
  judge: Map<string, number>;
  lint: Map<string, number>;
}

function newTallies(story: string, source: string): StoryTallies {
  return { story, source, runs: 0, accepted: 0, withAction: 0, external: 0, bodyOnly: 0,
           answers: [], corpus: new Set(), place: new Set(), judge: new Map(), lint: new Map() };
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

async function censusEventLog(input: RunInput, t: StoryTallies): Promise<void> {
  t.runs++;
  const situByAttempt = new Map<string, string>();
  const pending: { character: string; speech: string; action: string; attempt: number }[] = [];
  const text = await readFile(input.logPath!, "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line); } catch { continue; }
    const type = String(e.t ?? "");
    if (type === "consult") {
      const key = `${String(e.character ?? "").toLowerCase()}|${Number(e.attempt ?? 1)}`;
      situByAttempt.set(key, String(e.situation ?? ""));
      for (const w of words(String(e.situation ?? ""))) t.corpus.add(w);
    } else if (type === "accept") {
      pending.push({ character: String(e.character ?? ""), speech: String(e.speech ?? ""),
                     action: String(e.action ?? ""), attempt: Number(e.attempt ?? 1) });
    } else if (type === "reaction") {
      t.accepted++;
      const speech = String(e.speech ?? ""), action = String(e.action ?? "");
      t.answers.push({ character: String(e.character ?? ""), speech, action, run: input.label });
      if (action.trim()) {
        t.withAction++;
        classifyAction(action, t);
      }
      for (const w of words(`${speech} ${action}`)) t.corpus.add(w);
    } else if (type === "judge") {
      bump(t.judge, `verdict=${String(e.verdict ?? "?")}`);
    } else if (type === "retry") {
      bump(t.judge, "retry issued");
    } else if (type === "constraint_refused") {
      bump(t.judge, `constraint_refused [${String(e.constraint ?? "?")}] bars "${String(e.match ?? "")}"`);
    } else if (type === "judge_failed" || type === "repair_failed" || type === "retry_capped") {
      bump(t.judge, type);
    } else if (type === "bad_consult") {
      bump(t.judge, `bad_consult: ${causeKey(String(e.why ?? ""))}`);
    } else if (type === "narration_flag") {
      bump(t.lint, `narration_flag: ${lintFamily(String(e.why ?? ""))}${(e as { retried?: unknown }).retried ? " (retried)" : ""}`);
    } else if (type === "narration_quote_flag") {
      bump(t.lint, `narration_quote_flag [${String(e.character ?? "?")}]`);
    } else if (type === "lint_failed") {
      bump(t.lint, type);
    } else if (type === "schema_mismatch") {
      bump(t.judge, `schema_mismatch:${String((e as { call?: unknown }).call ?? "?")}`);
    }
  }
  for (const p of pending) {
    t.accepted++;
    t.answers.push({ character: p.character, speech: p.speech, action: p.action, run: input.label });
    if (p.action.trim()) {
      t.withAction++;
      const situ = situByAttempt.get(`${p.character.toLowerCase()}|${p.attempt}`) ?? "";
      classifyAction(p.action, t, situ);
    }
  }
}

async function censusFixture(input: RunInput, t: StoryTallies): Promise<void> {
  t.runs++;
  const text = await readFile(input.fixturePath!, "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line); } catch { continue; }
    const site = String(e.site ?? "");
    if (site === "judge.answer") {
      // Fragments often trail salvage (`"verdict": "accept"\n}`), so read the key directly.
      const verdict = /"verdict"\s*:\s*"([^"]*)"/.exec(String(e.response ?? ""))?.[1] ?? "unparseable";
      bump(t.judge, `verdict=${verdict}`);
      continue;
    }
    if (site === "judge.narration") {
      const ok = /"ok"\s*:\s*(true|false|"true"|"false")/.exec(String(e.response ?? ""))?.[1]
        ?.replace(/"/g, "") ?? "unparseable";
      bump(t.lint, `narration ok=${ok}`);
      continue;
    }
    if (site !== "character.consult") continue;
    const { speech, action } = parseActionFromConsultResponse(e.response);
    t.accepted++;
    t.answers.push({ character: String(e.agent ?? ""), speech, action, run: input.label });
    if (action.trim()) {
      t.withAction++;
      classifyAction(action, t);
    }
  }
}

function classifyAction(action: string, t: StoryTallies, situation?: string): void {
  const tokens = words(action);
  // The linked situation (or the scene's place) is the corpus. The pooled run-wide corpus
  // is the fallback only when no linked situation exists (fan-out reactions, fixtures) —
  // pooling everything would match every word against every situation and read 100%.
  const hay = situation
    ? new Set([...t.place, ...words(situation)])
    : new Set([...t.place, ...t.corpus]);
  if (tokens.some(w => hay.has(w))) t.external++;
  // Independent of the external hit: an idle-body move naming the furniture ("shifts their
  // weight on the crate") still needs no avatar layer, so it counts here too.
  if (BODY_ONLY_RES.some(re => re.test(action.toLowerCase()))) t.bodyOnly++;
}

function reportText(stories: StoryTallies[]): string {
  const lines: string[] = ["ACTION CENSUS — how often does an answer touch the world?", ""];
  const total = { accepted: 0, withAction: 0, external: 0, bodyOnly: 0, runs: 0 };
  for (const t of stories) {
    total.accepted += t.accepted; total.withAction += t.withAction;
    total.external += t.external; total.bodyOnly += t.bodyOnly; total.runs += t.runs;
    const pct = (n: number, d: number) => d ? `${((100 * n) / d).toFixed(1)}%` : "n/a";
    lines.push(`## ${t.story}  (source: ${t.source}, runs: ${t.runs})`);
    lines.push(`accepted answers: ${t.accepted}; with non-empty action: ${t.withAction} (${pct(t.withAction, t.accepted)})`);
    lines.push(`of those, naming an entity from place/linked-situation: ${t.external} (${pct(t.external, t.withAction)})`);
    lines.push(`matching idle-body patterns (needs no avatar layer; overlaps external): ${t.bodyOnly} (${pct(t.bodyOnly, t.withAction)})`);
    lines.push("judge rejections:");
    if (!t.judge.size) lines.push("  (none)");
    for (const [k, v] of [...t.judge.entries()].sort((a, b) => b[1] - a[1])) lines.push(`  ${v}x ${k}`);
    lines.push("narration-lint rejections:");
    if (!t.lint.size) lines.push("  (none)");
    for (const [k, v] of [...t.lint.entries()].sort((a, b) => b[1] - a[1])) lines.push(`  ${v}x ${k}`);
    lines.push("");
  }
  const pct = (n: number, d: number) => d ? `${((100 * n) / d).toFixed(1)}%` : "n/a";
  lines.push(`TOTAL across ${stories.length} input(s), ${total.runs} run(s): accepted=${total.accepted} ` +
    `withAction=${total.withAction} (${pct(total.withAction, total.accepted)}) ` +
    `external=${total.external} (${pct(total.external, total.withAction)}) ` +
    `bodyOnly=${total.bodyOnly} (${pct(total.bodyOnly, total.withAction)})`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const asJson = rawArgs.includes("--json");
  const args = rawArgs.filter(a => a !== "--json");
  if (!args.length) {
    console.log("Usage: npx tsx scripts/action-census.ts <story-dir|run-dir|fixture-dir>... [--json]");
    process.exit(1);
  }
  const inputs = await resolveInputs(args);
  if (!inputs.length) {
    console.log("No countable runs found.");
    return;
  }
  const byStory = new Map<string, StoryTallies>();
  for (const input of inputs) {
    const key = input.storyDir;
    let t = byStory.get(key);
    if (!t) {
      const source = input.logPath ? "writing-log.jsonl answer/accept events" : "calls.jsonl character.consult responses (situations unavailable)";
      t = newTallies(key, source);
      const place = await readStoryPlaces(input.storyDir);
      for (const w of words(place)) { t.corpus.add(w); t.place.add(w); }
      byStory.set(key, t);
    }
    if (input.logPath) await censusEventLog(input, t);
    else if (input.fixturePath) await censusFixture(input, t);
  }
  const stories = [...byStory.values()];
  if (asJson) {
    console.log(JSON.stringify(stories.map(t => ({
      story: t.story, source: t.source, runs: t.runs, accepted: t.accepted,
      withAction: t.withAction, external: t.external, bodyOnly: t.bodyOnly,
      judge: Object.fromEntries(t.judge), lint: Object.fromEntries(t.lint),
      actions: t.answers.map(a => ({ run: a.run, character: a.character, action: a.action })),
    })), null, 2));
  } else {
    console.log(reportText(stories));
  }
}

await main();
