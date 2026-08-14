/** ARCHITECT — builds the architect Agent, and the interactive story-building conversation with it. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join as joinPath, relative as relativePath } from "node:path";
import * as P from "../prompts.ts";
import { C } from "../ansi.ts";
import { Agent } from "./agent.ts";
import { extractJson } from "./json-extract.ts";
import { slugify } from "./config-util.ts";
import { SKILL_CATALOG } from "./skills.ts";
import { ROOT, type Defaults } from "./story-format.ts";
import { normalizeSpec, applyEdits, renderStory, type StorySpec } from "./story-spec.ts";
import { runPreflight } from "./preflight.ts";

async function architectExample(): Promise<string> {
  try {
    const md = await readFile(joinPath(ROOT, "stories/doorway/story.md"), "utf8");
    const persona = await readFile(joinPath(ROOT, "stories/doorway/riven.md"), "utf8");
    return P.workedExample(md, persona);
  } catch { return ""; }
}

export async function buildArchitect(d: Defaults): Promise<Agent> {
  const system = P.architectSystem(SKILL_CATALOG, await architectExample());
  const a = new Agent("ARCHITECT", d.models.architect, system, 0.9);
  a.think = d.thinking.architect;
  return a;
}

// -- SCAFFOLD SESSION ------------------------------------------------------

export type ScaffoldRound =
  | { kind: "proposal"; note: string }
  | { kind: "edits"; applied: string[]; ignored: string[]; note: string }
  | { kind: "question"; ask: string }
  | { kind: "nothing"; why: string }
  | { kind: "failed"; error: string };

export type ScaffoldAccept =
  | { kind: "written"; dir: string; files: string[]; warnings: string[] }
  | { kind: "unloadable"; dir: string; files: string[]; error: string; warnings: string[] }
  | { kind: "needs_folder"; reason: string }
  | { kind: "no_story" };

function withAsk(out: Record<string, any>): string {
  const note = String(out.note ?? "").trim();
  const ask = String(out.ask ?? "").trim();
  if (!ask) return note;
  return note ? `${note} — it also asks: ${ask}` : `it also asks: ${ask}`;
}

export class ScaffoldSession {
  spec: StorySpec = normalizeSpec({}).spec;    // nothing proposed yet
  problems: string[] = [];
  pendingAsk = "";
  asks = 0;                                    // consecutive questions with no story to show for them
  static readonly MAX_ASKS = 3;

  constructor(public architect: Agent, public defaults: Defaults, public idea: string,
              public storiesDir: string = joinPath(ROOT, "stories")) {}

  haveStory(): boolean { return this.spec.characters.length > 0; }

  request(userText: string): string {
    if (!userText) return P.architectIdea(this.idea);
    if (this.haveStory())
      return P.architectChange(userText,
        JSON.stringify({ ...this.spec, writer_style: this.spec.writerStyle }, null, 1));
    return P.architectMore(userText, this.idea, this.asks >= ScaffoldSession.MAX_ASKS);
  }

  private async round(userText: string): Promise<{ out: Record<string, any> } | { error: string }> {
    this.architect.hear(this.request(userText));
    try {
      const reply = await this.architect.generate(`${C.magenta}ARCHITECT${C.reset}`);
      this.architect.said(reply.trim());
      return { out: extractJson(reply) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

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

  async propose(): Promise<ScaffoldRound> {
    const r = await this.round("");
    return "error" in r ? { kind: "failed", error: r.error } : this.takeProposal(r.out);
  }

  async say(text: string): Promise<ScaffoldRound> {
    const wasPatch = this.haveStory();
    const r = await this.round(text);
    if ("error" in r) return { kind: "failed", error: r.error };
    if (!wasPatch) return this.takeProposal(r.out);

    const back = String(r.out.ask ?? "").trim();
    if (back && !r.out.edits) { this.pendingAsk = back; return { kind: "question", ask: back }; }

    const e = applyEdits(this.spec, r.out);
    this.spec = e.spec; this.problems = e.problems;
    this.pendingAsk = "";
    return { kind: "edits", applied: e.applied, ignored: e.ignored, note: withAsk(r.out) };
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
    const taken = await readFile(joinPath(abs, "story.md"), "utf8").then(() => true).catch(() => false);
    if (taken) return { kind: "needs_folder", reason: `${this.label(abs)} already exists.` };

    const dir = this.label(abs);
    const rendered = renderStory(this.spec, this.defaults.models);
    await mkdir(abs, { recursive: true });
    for (const [name, body] of Object.entries(rendered)) await writeFile(joinPath(abs, name), body, "utf8");
    const files = Object.keys(rendered).sort();

    const pf = await runPreflight(dir);
    const warnings = pf.warnings.map(w => w.trim());
    return pf.ok
      ? { kind: "written", dir, files, warnings }
      : { kind: "unloadable", dir, files, error: pf.error ?? "unknown", warnings };
  }
}
