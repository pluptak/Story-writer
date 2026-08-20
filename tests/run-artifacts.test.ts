/** What a run leaves behind on disk, plus prompt and pacing checks. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadStory } from "../engine/story-format.ts";
import { num } from "../engine/config-util.ts";
import { llmFilenameFor, llmLogEntry } from "../engine/agent.ts";
import { runDirs, retainedRuns } from "../engine/preflight.ts";
import { CONSULT_WANTS } from "../engine/consult.ts";
import { wrapCharacter, wrapWriter, writerCast } from "../engine/scene-loop.ts";
import { quiet, quietSync, warnings } from "./helpers.ts";

// -- RETAINED RUNS (§F3) ----------------------------------------------------
describe("runDirs / retainedRuns", () => {
  async function withOut(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    await mkdir(join(dir, "out"), { recursive: true });
    return dir;
  }
  async function addRun(storyDir: string, id: string, log?: object[]): Promise<void> {
    const runPath = join(storyDir, "out", id);
    await mkdir(runPath, { recursive: true });
    if (log) await writeFile(runPath + "/writing-log.jsonl", log.map(e => JSON.stringify(e)).join("\n"), "utf8");
  }

  it("returns nothing for a story with no out/ yet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      assert.deepEqual(await runDirs(dir), []);
      assert.deepEqual(await retainedRuns(dir), []);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("ignores flat legacy out/scene.md and out/writing-log.jsonl -- only directories count", async () => {
    const dir = await withOut();
    try {
      await writeFile(join(dir, "out", "scene.md"), "old prose", "utf8");
      await writeFile(join(dir, "out", "writing-log.jsonl"), "{}", "utf8");
      assert.deepEqual(await runDirs(dir), []);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("lists runs newest first, reading outcome off each run's own scene_end line", async () => {
    const dir = await withOut();
    try {
      await addRun(dir, "2026-01-01T00-00-00-000Z", [
        { t: "scene_start", chapter: 1 }, { t: "scene_end", chapter: 1, steps: 4, words: 900, done: true, stopped: false },
      ]);
      await addRun(dir, "2026-01-02T00-00-00-000Z", [
        { t: "scene_start", chapter: 2 }, { t: "scene_end", chapter: 2, steps: 2, words: 300, done: false, stopped: true },
      ]);
      const runs = await retainedRuns(dir);
      assert.deepEqual(runs.map(r => r.id), ["2026-01-02T00-00-00-000Z", "2026-01-01T00-00-00-000Z"]);
      assert.equal(runs[0].chapter, 2);
      assert.equal(runs[0].stopped, true);
      assert.equal(runs[1].chapter, 1);
      assert.equal(runs[1].done, true);
      assert.equal(runs[1].words, 900);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("still lists a run killed mid-scene, with its outcome fields simply absent, but still attributed to its chapter", async () => {
    const dir = await withOut();
    try {
      await addRun(dir, "2026-01-01T00-00-00-000Z", [{ t: "scene_start", chapter: 3 }, { t: "draft", step: 1, chapter: 3 }]);
      const runs = await retainedRuns(dir);
      assert.equal(runs.length, 1);
      assert.equal(runs[0].chapter, 3);
      assert.equal(runs[0].done, undefined);
      assert.equal(runs[0].stopped, undefined);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("leaves chapter unset for a run retained from before chapter numbers were logged", async () => {
    const dir = await withOut();
    try {
      await addRun(dir, "2026-01-01T00-00-00-000Z", [
        { t: "scene_start" }, { t: "scene_end", steps: 4, words: 900, done: true, stopped: false },
      ]);
      const runs = await retainedRuns(dir);
      assert.equal(runs[0].chapter, undefined);
      assert.equal(runs[0].done, true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

// -- LLM INTERACTION LOG ----------------------------------------------------
describe("LLM interaction log", () => {
  it("llmLogEntry: WRITER gets role writer, anyone else gets role character", () => {
    const w = llmLogEntry({ name: "WRITER", model: "m" }, "2026-01-01T00-00-00.000Z", [], "resp");
    assert.equal(w.role, "writer");
    const c = llmLogEntry({ name: "Anne", model: "m" }, "2026-01-01T00-00-00.000Z", [], "resp");
    assert.equal(c.role, "character");
  });

  it("llmLogEntry: fields pass through unchanged", () => {
    const prompt = [{ role: "system" as const, content: "sys" }];
    const e = llmLogEntry({ name: "Anne", model: "some-model" }, "2026-01-01T00-00-00.000Z", prompt, "raw reply");
    assert.equal(e.ts, "2026-01-01T00-00-00.000Z");
    assert.equal(e.agent, "Anne");
    assert.equal(e.model, "some-model");
    assert.deepEqual(e.prompt, prompt);
    assert.equal(e.response, "raw reply");
  });

  it("llmFilenameFor: slugifies the name", () => {
    assert.equal(llmFilenameFor("Anne", new Set()), "anne.jsonl");
  });

  it("llmFilenameFor: two names slugifying the same get -2, -3, ...", () => {
    const used = new Set<string>();
    assert.equal(llmFilenameFor("Anne", used), "anne.jsonl");
    assert.equal(llmFilenameFor("anne!", used), "anne-2.jsonl");
    assert.equal(llmFilenameFor("ANNE", used), "anne-3.jsonl");
    assert.deepEqual(used, new Set(["anne.jsonl", "anne-2.jsonl", "anne-3.jsonl"]));
  });

  it("llmFilenameFor: a name that slugifies empty falls back to 'agent'", () => {
    assert.equal(llmFilenameFor("!!!", new Set()), "agent.jsonl");
  });
});

// -- PROMPTS ---------------------------------------------------------------
describe("prompt construction", () => {
  it("a character is told its skills and its place, and NOT the premise", async () => {
    const sc = await quiet(() => loadStory("stories/doorway"));
    const merritt = sc.characters.find(c => c.name === "MERRITT")!;
    const p = wrapCharacter(merritt, sc.scenes[0].place);
    assert.match(p, /hearing/);
    assert.match(p, /Kessel/);                       // the place
    assert.ok(!p.includes("sight"), "a character must not be shown a skill it lacks");
    assert.ok(!p.includes(sc.premise.slice(0, 40)), "the premise is the author's, not the character's");
  });

  it("the writer is told what each character cannot do, and no personas", async () => {
    const sc = await quiet(() => loadStory("stories/doorway"));
    const p = wrapWriter(sc.premise, sc.scenes[0], writerCast(sc.characters, sc.scenes[0].roster), sc.writerStyle);
    assert.match(p, /MERRITT[\s\S]{0,200}CANNOT: sight/);
    assert.ok(!p.includes("night porter at Kessel's for nine years"),
              "the writer must not be handed the personas");
  });

  it("the writer is told that stillness is a choice and that pressure may not be resolved first", async () => {
    const sc = await quiet(() => loadStory("stories/doorway"));
    const p = wrapWriter(sc.premise, sc.scenes[0], writerCast(sc.characters, sc.scenes[0].roster), sc.writerStyle);
    assert.match(p, /HOLDING STILL IS A CHOICE/);
    assert.match(p, /YOU MAY NOT RESOLVE THE PRESSURE BEFORE YOU ASK ABOUT IT/);
  });

  it("the writer is given the closed `wants` vocabulary, not an invitation to phrase one", async () => {
    const sc = await quiet(() => loadStory("stories/doorway"));
    const p = wrapWriter(sc.premise, sc.scenes[0], writerCast(sc.characters, sc.scenes[0].roster), sc.writerStyle);
    for (const w of CONSULT_WANTS) assert.match(p, new RegExp(`\\b${w}\\b`));
    assert.match(p, /EXACTLY ONE of these four words/);
  });
});

// -- PACING ----------------------------------------------------------------
describe("max_prose_words", () => {
  it("defaults to a real ceiling — several pieces inside one scene's length", async () => {
    const sc = await quiet(() => loadStory("stories/doorway"));
    assert.equal(sc.maxProseWords, 140);
    assert.ok(sc.maxProseWords * 3 <= sc.scenes[0].length,
              "a cap that a scene fits into in one or two pieces is not a cap");
  });

  it("is read from the story, and holds the same line every other config value does", () => {
    assert.equal(num({ "config.max_prose_words": "90" }, "config.max_prose_words", 140), 90);
    assert.equal(warnings(() => num({ "config.max_prose_words": "0" }, "config.max_prose_words", 140)).length, 1);
    assert.equal(num({ "config.max_prose_words": "lots" }, "config.max_prose_words", 140), 140);
  });
});
