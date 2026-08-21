/** ARCHITECT — builds the architect Agent, and the interactive story-building conversation with it. */
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join as joinPath, relative as relativePath } from "node:path";
import * as P from "../prompts.ts";
import { C } from "../ansi.ts";
import { ENGINE } from "./engine-state.ts";
import { Agent } from "./agent.ts";
import { extractJson } from "./json-extract.ts";
import { slugify } from "./config-util.ts";
import { SKILL_CATALOG, SPECIAL_SKILL_CATALOG, RESTRICTION_CATALOG } from "./skills.ts";
import { ROOT, resolveStoryDir, readChapters, readChapterSpec, type Defaults } from "./story-format.ts";
import { normalizeSpec, applyEdits, renderStory, sceneDrift, type StorySpec } from "./story-spec.ts";
import { runPreflight, modelInfo, contextShortfall } from "./preflight.ts";
import { estimateTokens } from "./llm-client.ts";

async function architectExample(): Promise<string> {
  try {
    const md = await readFile(joinPath(ROOT, "stories/doorway/story.json"), "utf8");
    const story = JSON.parse(md);
    const persona = story.characters.find((c: any) => c.name === "RIVEN")?.persona || "";
    return P.workedExample(md, persona);
  } catch { return ""; }
}

/**
 * Build the architect agent: its system prompt carries the skill catalog and, when scaffolding, a
 * worked example of the story format. A handoff does not want it — the prompt names every edit field
 * inline and sends the real story every round, so the example is the format said twice, and the one
 * shape it demonstrates is the whole-story reply a handoff must *not* send.
 */
export async function buildArchitect(d: Defaults, withExample = true): Promise<Agent> {
  const system = P.architectSystem(
    SKILL_CATALOG, SPECIAL_SKILL_CATALOG, RESTRICTION_CATALOG,
    withExample ? await architectExample() : "");
  const a = new Agent("ARCHITECT", d.models.architect, system, 0.9);
  a.think = d.thinking.architect;
  return a;
}

// -- SCAFFOLD SESSION ------------------------------------------------------

/** Which of the two automatic follow-up passes ran, for the CLI/SSE to label. */
export type AutoStage = "fillGaps" | "verify";

/** What one automatic fill-gaps/verify pass did, folded into the round that triggered it. */
export type AutoPass = {
  stage: AutoStage;
  applied: { field: string; before: unknown; after: unknown }[];
  ignored: string[];
  note: string;
  outcome: "edits" | "nothing" | "failed";
};

/** What one exchange with the architect produced, for the CLI/SSE to announce. */
export type ScaffoldRound =
  | { kind: "proposal"; note: string; auto?: AutoPass[] }
  | { kind: "edits"; applied: { field: string; before: unknown; after: unknown }[]; ignored: string[]; flags: string[]; note: string; auto?: AutoPass[] }
  | { kind: "question"; ask: string; auto?: AutoPass[] }
  | { kind: "nothing"; why: string }
  | { kind: "failed"; error: string };

/** The outcome of trying to write the accepted story to disk. */
export type ScaffoldAccept =
  | { kind: "written"; dir: string; files: string[]; warnings: string[] }
  | { kind: "unloadable"; dir: string; files: string[]; error: string; warnings: string[] }
  | { kind: "needs_folder"; reason: string }
  | { kind: "no_story" };

/** One exchange with the architect: say it, take the reply, and pull JSON out of it. */
async function architectRound(agent: Agent, message: string):
  Promise<{ out: Record<string, any> } | { error: string }> {
  agent.hear(message);
  try {
    const reply = await agent.generate(`${C.magenta}ARCHITECT${C.reset}`);
    agent.said(reply.trim());
    return { out: extractJson(reply) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

function withAsk(out: Record<string, any>): string {
  const note = String(out.note ?? "").trim();
  const ask = String(out.ask ?? "").trim();
  if (!ask) return note;
  return note ? `${note} — it also asks: ${ask}` : `it also asks: ${ask}`;
}

/**
 * Run the fill-gaps and verify passes after a successful proposal, before a human sees it: neither
 * ARCHITECT_FORMAT nor architectNextChapter's own message ever asks for scene.roster or story-level
 * facts, so nothing gets authored unless these dedicated passes ask for it. A question from either
 * pass aborts the sequence and is surfaced exactly like any other blocking ask; whatever the earlier
 * pass already applied stays on the spec. A failed or empty pass never discards a good proposal — it
 * is recorded as an AutoPass with outcome "failed"/"nothing" instead.
 */
async function runAutoPasses(
  architect: Agent, spec: StorySpec, sceneField: string,
  onStage?: (stage: AutoStage) => void,
  refuse?: (edits: any[]) => { edits: any[]; refused: string[] },
): Promise<{ spec: StorySpec; problems: string[]; auto: AutoPass[]; question?: string }> {
  let cur = spec;
  let problems: string[] = [];
  const auto: AutoPass[] = [];
  const specJson = (s: StorySpec) => JSON.stringify({ ...s, writer_style: s.writerStyle }, null, 1);

  const runStage = async (stage: AutoStage, prompt: string): Promise<string | undefined> => {
    onStage?.(stage);
    const r = await architectRound(architect, prompt);
    if ("error" in r) {
      auto.push({ stage, applied: [], ignored: [], note: `the ${stage} pass failed: ${r.error}`, outcome: "failed" });
      return undefined;
    }
    const ask = String(r.out.ask ?? "").trim();
    if (ask && !r.out.edits) return ask;                    // abort signal -- surfaced as this round's question
    if (!Array.isArray(r.out.edits)) {
      auto.push({ stage, applied: [], ignored: [], note: withAsk(r.out), outcome: "nothing" });
      return undefined;
    }
    const guarded = refuse ? refuse(r.out.edits) : { edits: r.out.edits, refused: [] as string[] };
    const e = applyEdits(cur, { edits: guarded.edits });
    cur = e.spec; problems = e.problems;
    auto.push({ stage, applied: e.applied, ignored: [...guarded.refused, ...e.ignored], note: withAsk(r.out), outcome: "edits" });
    return undefined;
  };

  let ask = await runStage("fillGaps", P.architectFillGaps(specJson(cur), sceneField));
  if (ask !== undefined) return { spec: cur, problems, auto, question: ask };
  ask = await runStage("verify", P.architectVerify(specJson(cur), sceneField));
  if (ask !== undefined) return { spec: cur, problems, auto, question: ask };
  return { spec: cur, problems, auto };
}

/** One interactive story-building conversation: propose, refine via edits, and accept to disk. */
export class ScaffoldSession {
  spec: StorySpec = normalizeSpec({}).spec;    // nothing proposed yet
  problems: string[] = [];
  pendingAsk = "";
  asks = 0;                                    // consecutive questions with no story to show for them
  static readonly MAX_ASKS = 3;

  constructor(public architect: Agent, public defaults: Defaults, public idea: string,
              public storiesDir: string = joinPath(ROOT, "stories")) {}

  haveStory(): boolean { return this.spec.characters.length > 0; }

  /** Replace the in-memory draft after a full GUI edit; nothing is written until accept(). */
  setSpec(raw: unknown): { applied: { field: string; before: unknown; after: unknown }[]; problems: string[] } {
    const n = normalizeSpec(raw);
    this.spec = n.spec;
    this.problems = n.problems;
    this.pendingAsk = "";
    this.asks = 0;
    return { applied: [{ field: "story", before: null, after: "updated from editor" }], problems: n.problems };
  }

  request(userText: string): string {
    if (!userText) return P.architectIdea(this.idea);
    if (this.haveStory())
      return P.architectChange(userText,
        JSON.stringify({ ...this.spec, writer_style: this.spec.writerStyle }, null, 1));
    return P.architectMore(userText, this.idea, this.asks >= ScaffoldSession.MAX_ASKS);
  }

  private round(userText: string) { return architectRound(this.architect, this.request(userText)); }

  private takeProposal(out: Record<string, any>): ScaffoldRound {
    const n = normalizeSpec(out);
    if (!n.spec.characters.length) {
      const back = String(out.ask ?? "").trim();
      if (back) { this.pendingAsk = back; this.asks++; return { kind: "question", ask: back }; }
      return { kind: "nothing", why: "the reply was neither a story nor a question" };
    }
    this.asks = 0; this.pendingAsk = "";
    this.spec = n.spec; this.problems = n.problems;
    return { kind: "proposal", note: withAsk(out) };
  }

  /** Runs the automatic fill-gaps/verify passes right after a proposal lands, whether reached via
   *  propose() or via say() following a clarifying question. Any other round kind passes through untouched. */
  private async afterProposal(base: ScaffoldRound, onStage?: (stage: AutoStage) => void): Promise<ScaffoldRound> {
    if (base.kind !== "proposal") return base;
    const r = await runAutoPasses(this.architect, this.spec, "scene", onStage);
    this.spec = r.spec; this.problems = r.problems;
    if (r.question !== undefined) { this.pendingAsk = r.question; return { kind: "question", ask: r.question, auto: r.auto }; }
    this.pendingAsk = "";
    return { ...base, auto: r.auto };
  }

  async propose(onStage?: (stage: AutoStage) => void): Promise<ScaffoldRound> {
    const r = await this.round("");
    return "error" in r ? { kind: "failed", error: r.error } : this.afterProposal(this.takeProposal(r.out), onStage);
  }

  async say(text: string, onStage?: (stage: AutoStage) => void): Promise<ScaffoldRound> {
    const wasPatch = this.haveStory();
    const r = await this.round(text);
    if ("error" in r) return { kind: "failed", error: r.error };
    if (!wasPatch) return this.afterProposal(this.takeProposal(r.out), onStage);

    const back = String(r.out.ask ?? "").trim();
    if (back && !r.out.edits) { this.pendingAsk = back; return { kind: "question", ask: back }; }

    const e = applyEdits(this.spec, r.out);
    this.spec = e.spec; this.problems = e.problems;
    this.pendingAsk = "";
    return { kind: "edits", applied: e.applied, ignored: e.ignored, flags: [], note: withAsk(r.out) };
  }

  private label(abs: string): string {
    const rel = relativePath(ROOT, abs).replace(/\\/g, "/");
    return rel && !rel.startsWith("..") ? rel : abs;
  }

  async accept(folderName = ""): Promise<ScaffoldAccept> {
    if (!this.haveStory()) return { kind: "no_story" };
    const from = folderName || this.spec.title;
    const slug = slugify(from);
    if (!slug) return { kind: "needs_folder", reason: `"${from}" doesn't give a usable folder name.` };

    const abs = joinPath(this.storiesDir, slug);
    const taken = await readFile(joinPath(abs, "story.json"), "utf8").then(() => true).catch(() => false);
    if (taken) return { kind: "needs_folder", reason: `${this.label(abs)} already exists.` };

    const dir = this.label(abs);
    const rendered = renderStory(this.spec, this.defaults.models);
    await mkdir(abs, { recursive: true });
    for (const [name, body] of Object.entries(rendered)) await writeFile(joinPath(abs, name), body, "utf8");
    const files = Object.keys(rendered).sort();

    const pf = await runPreflight(dir);
    const warnings = pf.warnings.map(w => w.trim());
    if (!pf.ok) {
      // Transactional, like the handoff: this folder did not exist before accept() made it, so
      // putting back exactly what was there means leaving nothing behind.
      await rm(abs, { recursive: true, force: true });
      return { kind: "unloadable", dir, files, error: pf.error ?? "unknown", warnings };
    }
    return { kind: "written", dir, files, warnings };
  }
}

// -- NEXT-CHAPTER SESSION --------------------------------------------------

/** The outcome of trying to write the re-authored story back over the one on disk. */
export type HandoffAccept =
  | { kind: "written"; dir: string; files: string[]; warnings: string[] }
  | { kind: "unloadable"; dir: string; error: string }
  | { kind: "nothing" };

/**
 * The handoff between two chapters: show the architect what was actually written, take back edits to
 * the cast and the next scene, and write them over `story.json` only when the author accepts.
 */
export class NextChapterSession {
  problems: string[] = [];
  pendingAsk = "";
  edited = false;                              // has any round changed the spec

  constructor(public architect: Agent, public defaults: Defaults, public dir: string,
              public spec: StorySpec, public chapters: { n: number; text: string }[]) {}

  /** The chapter this handoff is preparing: the one after the last written. */
  get chapter(): number { return this.chapters.reduce((m, c) => Math.max(m, c.n), 0) + 1; }

  private specJson(): string {
    return JSON.stringify({ ...this.spec, writer_style: this.spec.writerStyle }, null, 1);
  }

  /** Edits that would rewrite history: removing a scene already written renumbers chapters after it,
   *  and editing fields of a scene in an already-written chapter would desync the story from its prose. */
  private refuse(edits: any[]): { edits: any[]; refused: string[] } {
    const written = this.chapter - 1;
    const refused: string[] = [];
    const kept = edits.filter(e => {
      const field = String(e?.field ?? "").trim();
      const n = Number(e?.value);
      if (field === "remove_scene" && Number.isInteger(n) && n >= 1 && n <= written) {
        refused.push(`remove_scene ${n} — chapter ${n} is already written`);
        return false;
      }
      // The same field shapes applyEdits accepts, read the same way: an unnumbered `scene.x` is scene 1.
      const m = field.match(/^scene(?:_(\d+))?\.(place|question|pov|length|roster)$/);
      const k = m ? (m[1] ? Number(m[1]) : 1) : 0;
      if (k >= 1 && k <= written) {
        refused.push(`${field} — chapter ${k} is already written`);
        return false;
      }
      return true;
    });
    return { edits: kept, refused };
  }

  private take(r: { out: Record<string, any> } | { error: string }): ScaffoldRound {
    if ("error" in r) return { kind: "failed", error: r.error };
    const back = String(r.out.ask ?? "").trim();
    if (back && !r.out.edits) { this.pendingAsk = back; return { kind: "question", ask: back }; }
    if (!Array.isArray(r.out.edits))
      return { kind: "nothing", why: "the reply was neither edits nor a question" };

    const guarded = this.refuse(r.out.edits);
    const e = applyEdits(this.spec, { edits: guarded.edits });
    this.spec = e.spec; this.problems = e.problems; this.pendingAsk = "";
    this.edited = true;
    const flags = Array.isArray(r.out.flags)
      ? r.out.flags.filter((flag): flag is string => typeof flag === "string")
        .map(flag => flag.trim()).filter(Boolean)
      : [];
    return { kind: "edits", applied: e.applied, ignored: [...guarded.refused, ...e.ignored], flags, note: withAsk(r.out) };
  }

  /** The handoff request itself: the premise, the chapters as written, and the story as it stands.
   *  A successful edits round is then run through the same fill-gaps/verify passes as the scaffold,
   *  targeting the scene this handoff is preparing -- never an earlier, already-written one. */
  async propose(onStage?: (stage: AutoStage) => void): Promise<ScaffoldRound> {
    const prompt = P.architectNextChapter(this.spec.premise, this.specJson(), this.chapters);
    const info = await modelInfo();
    const short = info && contextShortfall(info.get(this.architect.model),
                                           estimateTokens(this.architect.system + prompt), ENGINE.maxTokens);
    if (short) return { kind: "failed", error:
      `this round needs about ${short.needs} tokens and ${this.architect.model} is loaded with ${short.has} — `
      + `raise its context length in LM Studio and try again` };
    const base = this.take(await architectRound(this.architect, prompt));
    if (base.kind !== "edits") return base;

    const r = await runAutoPasses(this.architect, this.spec, `scene_${this.chapter}`, onStage, edits => this.refuse(edits));
    this.spec = r.spec; this.problems = r.problems;
    if (r.question !== undefined) { this.pendingAsk = r.question; return { kind: "question", ask: r.question, auto: r.auto }; }
    this.pendingAsk = "";
    return { ...base, auto: r.auto };
  }

  /** A follow-up from the author, in the same edits-only format. */
  async say(text: string): Promise<ScaffoldRound> {
    return this.take(await architectRound(this.architect, P.architectChange(text, this.specJson())));
  }

  /**
   * Write the re-authored story over the one on disk, and put back exactly what was there if the
   * result does not load — a story that already works must not be lost to a bad handoff.
   */
  async accept(): Promise<HandoffAccept> {
    if (!this.edited) return { kind: "nothing" };
    const abs = resolveStoryDir(this.dir);
    const rendered = renderStory(this.spec, this.defaults.models);

    const before = new Map<string, string | null>();
    for (const name of Object.keys(rendered))
      before.set(name, await readFile(joinPath(abs, name), "utf8").catch(() => null));
    for (const [name, body] of Object.entries(rendered)) await writeFile(joinPath(abs, name), body, "utf8");

    const pf = await runPreflight(this.dir);
    if (!pf.ok) {
      for (const [name, body] of before)
        body === null ? await rm(joinPath(abs, name), { force: true })
                      : await writeFile(joinPath(abs, name), body, "utf8");
      return { kind: "unloadable", dir: this.dir, error: pf.error ?? "unknown" };
    }
    return { kind: "written", dir: this.dir, files: Object.keys(rendered).sort(), warnings: pf.warnings.map(w => w.trim()) };
  }
}

/** Open a handoff on a story that has at least one chapter written; throws if it has none, or does not parse. */
export async function openNextChapter(d: Defaults, dir: string): Promise<NextChapterSession> {
  const chapters = await readChapters(dir);
  if (!chapters.length)
    throw new Error(`No chapters written yet in ${dir} — there is nothing for the handoff to read.`);
  const raw = JSON.parse(await readFile(joinPath(resolveStoryDir(dir), "story.json"), "utf8"));
  const n = normalizeSpec(raw);
  const s = new NextChapterSession(await buildArchitect(d, false), d, dir, n.spec, chapters);
  s.problems = n.problems;

  // `refuse()` keeps the architect off a written chapter's scene, but a hand edit reaches it, and
  // that is legitimate -- so this says so rather than undoing it. Chapters written before snapshots
  // existed have nothing to compare and must pass quietly.
  for (const c of chapters) {
    try {
      const snapshot = await readChapterSpec(dir, c.n);
      if (!snapshot) continue;
      const drifted = sceneDrift(normalizeSpec(snapshot).spec.scenes[c.n - 1], s.spec.scenes[c.n - 1]);
      if (drifted.length)
        s.problems.push(`chapter ${c.n}'s prose was written from a different scene definition `
          + `(${drifted.join(", ")})`);
    } catch { /* a broken snapshot must not stop the handoff opening */ }
  }
  return s;
}

// -- STATELESS SUGGEST ------------------------------------------------------

/** A stateless architect call: given the current story spec and the author's instruction, return
 *  proposed edits. Creates a fresh agent per call, so no history carries between invocations. */
export async function suggestEdits(d: Defaults, spec: StorySpec, text: string):
  Promise<{ kind: "edits"; applied: { field: string; before: unknown; after: unknown }[]; ignored: string[];
            problems: string[]; note: string }
         | { kind: "question"; ask: string }
         | { kind: "failed"; error: string }> {
  const agent = await buildArchitect(d, false);
  const specJson = JSON.stringify({ ...spec, writer_style: spec.writerStyle }, null, 1);
  const prompt = P.architectChange(text, specJson);
  const r = await architectRound(agent, prompt);
  if ("error" in r) return { kind: "failed", error: r.error };

  const back = String(r.out.ask ?? "").trim();
  if (back && !r.out.edits) return { kind: "question", ask: back };
  if (!Array.isArray(r.out.edits))
    return { kind: "failed", error: "the reply contained neither edits nor a question" };

  const e = applyEdits(spec, r.out);
  return {
    kind: "edits", applied: e.applied, ignored: e.ignored, problems: e.problems,
    note: String(r.out.note ?? "").trim(),
  };
}
