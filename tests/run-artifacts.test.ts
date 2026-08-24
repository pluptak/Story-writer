/** What a run leaves behind on disk, plus prompt and pacing checks. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadStory } from "../engine/story-format.ts";
import { num } from "../engine/config-util.ts";
import { llmFilenameFor, llmLogEntry, writeLlmRecord, Agent } from "../engine/agent.ts";
import { ENGINE } from "../engine/engine-state.ts";
import { WARN } from "../engine/warnings.ts";
import { runDirs, retainedRuns, runLlmLogs, readLlmLog } from "../engine/preflight.ts";
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

// -- LLM LOG READING --------------------------------------------------------
describe("runLlmLogs / readLlmLog", () => {
  async function addRun(storyDir: string, id: string, log?: object[]): Promise<void> {
    const runPath = join(storyDir, "out", id);
    await mkdir(runPath, { recursive: true });
    if (log) await writeFile(runPath + "/writing-log.jsonl", log.map(e => JSON.stringify(e)).join("\n"), "utf8");
  }
  async function addLlm(storyDir: string, id: string, file: string, records: object[]): Promise<void> {
    const dir = join(storyDir, "out", id, "llm");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, file), records.map(r => JSON.stringify(r)).join("\n"), "utf8");
  }

  it("returns nothing for a run with no llm folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      const storyDir = join(dir, "story");
      await mkdir(storyDir, { recursive: true });
      const id = "test-run";
      await mkdir(join(storyDir, "out", id), { recursive: true });
      assert.deepEqual(await runLlmLogs(storyDir, id), []);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("summarises each agent's transcript, counting calls and characters", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      const storyDir = join(dir, "story");
      await mkdir(storyDir, { recursive: true });
      const id = "test-run";
      await addLlm(storyDir, id, "writer.jsonl", [
        { ts: "t1", role: "writer", agent: "WRITER", model: "m1", prompt: [{ role: "system", content: "abc" }, { role: "user", content: "de" }], response: "xyz" },
        { ts: "t2", role: "writer", agent: "WRITER", model: "m1", prompt: [{ role: "user", content: "f" }], response: "12" },
      ]);
      const logs = await runLlmLogs(storyDir, id);
      assert.equal(logs.length, 1);
      assert.equal(logs[0].agent, "WRITER");
      assert.equal(logs[0].role, "writer");
      assert.equal(logs[0].calls, 2);
      assert.equal(logs[0].promptChars, 6);
      assert.equal(logs[0].responseChars, 5);
      assert.deepEqual(logs[0].models, ["m1"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("lists one entry per file, sorted by filename", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      const storyDir = join(dir, "story");
      await mkdir(storyDir, { recursive: true });
      const id = "test-run";
      await addLlm(storyDir, id, "writer.jsonl", [{ ts: "t1", role: "writer", agent: "W", model: "m", prompt: [], response: "r" }]);
      await addLlm(storyDir, id, "riven.jsonl", [{ ts: "t1", role: "character", agent: "R", model: "m", prompt: [], response: "r" }]);
      const logs = await runLlmLogs(storyDir, id);
      assert.deepEqual(logs.map(l => l.file), ["riven.jsonl", "writer.jsonl"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("collects every model a run used, in the order it saw them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      const storyDir = join(dir, "story");
      await mkdir(storyDir, { recursive: true });
      const id = "test-run";
      await addLlm(storyDir, id, "agent.jsonl", [
        { ts: "t1", role: "character", agent: "A", model: "m1", prompt: [], response: "r" },
        { ts: "t2", role: "character", agent: "A", model: "m2", prompt: [], response: "r" },
        { ts: "t3", role: "character", agent: "A", model: "m1", prompt: [], response: "r" },
      ]);
      const logs = await runLlmLogs(storyDir, id);
      assert.deepEqual(logs[0].models, ["m1", "m2"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("skips a line that will not parse rather than losing the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      const storyDir = join(dir, "story");
      await mkdir(storyDir, { recursive: true });
      const id = "test-run";
      const llmDir = join(storyDir, "out", id, "llm");
      await mkdir(llmDir, { recursive: true });
      const validRecord1 = JSON.stringify({ ts: "t1", role: "character", agent: "A", model: "m", prompt: [], response: "r1" });
      const invalidLine = "not json {";
      const validRecord2 = JSON.stringify({ ts: "t2", role: "character", agent: "A", model: "m", prompt: [], response: "r2" });
      await writeFile(join(llmDir, "agent.jsonl"), `${validRecord1}\n${invalidLine}\n${validRecord2}`, "utf8");
      const logs = await runLlmLogs(storyDir, id);
      assert.equal(logs.length, 1);
      assert.equal(logs[0].calls, 2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("readLlmLog returns the raw text of a listed transcript", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      const storyDir = join(dir, "story");
      await mkdir(storyDir, { recursive: true });
      const id = "test-run";
      const record = { ts: "t1", role: "character", agent: "A", model: "m", prompt: [], response: "test-response-xyz" };
      await addLlm(storyDir, id, "agent.jsonl", [record]);
      const text = await readLlmLog(storyDir, id, "agent.jsonl");
      assert.ok(text);
      assert.match(text!, /test-response-xyz/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("readLlmLog refuses a file the run does not have", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      const storyDir = join(dir, "story");
      await mkdir(storyDir, { recursive: true });
      const id = "test-run";
      await mkdir(join(storyDir, "out", id), { recursive: true });
      const result = await readLlmLog(storyDir, id, "nope.jsonl");
      assert.equal(result, null);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("readLlmLog refuses a traversal attempt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      const storyDir = join(dir, "story");
      await mkdir(storyDir, { recursive: true });
      const id = "test-run";
      await addRun(storyDir, id, [{ t: "scene_start" }]);
      // A populated listing, so the refusal is the allowlist doing its job rather than an empty
      // run refusing everything -- `llm/../writing-log.jsonl` is a real file, and still not served.
      await addLlm(storyDir, id, "agent.jsonl", [{ ts: "t1", role: "character", agent: "A", model: "m", prompt: [], response: "r" }]);
      assert.ok(await readLlmLog(storyDir, id, "agent.jsonl"));
      assert.equal(await readLlmLog(storyDir, id, "../writing-log.jsonl"), null);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

// -- LLM INTERACTION LOG ----------------------------------------------------
describe("LLM interaction log", () => {
  it("llmLogEntry: author-side names get their own role, any other name is a character", () => {
    const cases: [string, string][] = [
      ["WRITER", "writer"],
      ["JUDGE", "judge"],
      ["BATCH-JUDGE", "batch-judge"],
      ["NARRATION-JUDGE", "narration-judge"],
      ["CLARIFIER", "clarifier"],
      ["MERRITT", "character"],
      ["ANNE", "character"],
    ];
    for (const [name, role] of cases) {
      const e = llmLogEntry({ name, model: "m" }, "2026-01-01T00-00-00.000Z", [], "resp", 100, null);
      assert.equal(e.role, role);
    }
  });

  it("llmLogEntry: fields pass through unchanged, including durationMs and usage", () => {
    const prompt = [{ role: "system" as const, content: "sys" }];
    const usage = { promptTokens: 42, completionTokens: 7 };
    const e = llmLogEntry({ name: "Anne", model: "some-model" }, "2026-01-01T00-00-00.000Z", prompt, "raw reply", 3500, usage);
    assert.equal(e.ts, "2026-01-01T00-00-00.000Z");
    assert.equal(e.agent, "Anne");
    assert.equal(e.model, "some-model");
    assert.deepEqual(e.prompt, prompt);
    assert.equal(e.response, "raw reply");
    assert.equal(e.durationMs, 3500);
    assert.deepEqual(e.usage, usage);
  });

  it("llmLogEntry: usage is null when the server did not report it", () => {
    const e = llmLogEntry({ name: "Anne", model: "m" }, "t", [], "r", 100, null);
    assert.equal(e.usage, null);
    assert.equal(e.durationMs, 100);
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

  it("writeLlmRecord: a stream that fails warns once, then later records are dropped silently", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    // No llm/ subdir under outDir: opening the transcript stream fails asynchronously.
    const orig = { outDir: ENGINE.outDir, streams: ENGINE.llmStreams,
                   names: ENGINE.llmFilenames, dead: ENGINE.llmDead };
    ENGINE.outDir = dir; ENGINE.llmStreams = new Map();
    ENGINE.llmFilenames = new Set(); ENGINE.llmDead = new Set();
    const got: string[] = [];
    const origSink = WARN.sink;
    WARN.sink = (...a: unknown[]) => { got.push(a.map(String).join(" ")); };
    try {
      const agent = new Agent("TESTER", "m", "s");
      writeLlmRecord(agent, "t", [{ role: "user", content: "q" }], "{resp}", 5, null);
      await new Promise(r => setTimeout(r, 50));   // let the failed open fire its error
      writeLlmRecord(agent, "t2", [], "{resp2}", 5, null);
      await new Promise(r => setTimeout(r, 20));
    } finally {
      WARN.sink = origSink;
      Object.assign(ENGINE, orig);
      await rm(dir, { recursive: true, force: true });
    }
    assert.equal(got.length, 1, `expected exactly one warning, got ${JSON.stringify(got)}`);
    assert.match(got[0], /TESTER/);
    assert.match(got[0], /stopped being written/);
  });

  it("writeLlmRecord: no outDir means no logging and no warning", () => {
    const origOut = ENGINE.outDir;
    ENGINE.outDir = "";
    try {
      const got = warnings(() =>
        writeLlmRecord(new Agent("TESTER", "m", "s"), "t", [], "{r}", 1, null));
      assert.equal(got.length, 0);
    } finally { ENGINE.outDir = origOut; }
  });
});

// -- PROMPTS ---------------------------------------------------------------
describe("prompt construction", () => {
  it("a character is told its skills and its place, and NOT the premise", async () => {
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
    const merritt = sc.characters.find(c => c.name === "MERRITT")!;
    const p = wrapCharacter(merritt, sc.scenes[0].place);
    assert.match(p, /hearing/);
    assert.match(p, /Kessel/);                       // the place
    assert.ok(!p.includes("sight"), "a character must not be shown a skill it lacks");
    assert.ok(!p.includes(sc.premise.slice(0, 40)), "the premise is the author's, not the character's");
  });

  it("the writer is told what each character cannot do, and no personas", async () => {
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
    const p = wrapWriter(sc.premise, sc.scenes[0], writerCast(sc.characters, sc.scenes[0].roster), sc.writerStyle);
    assert.match(p, /MERRITT[\s\S]{0,200}CANNOT: sight/);
    assert.ok(!p.includes("night porter at Kessel's for nine years"),
              "the writer must not be handed the personas");
  });

  it("the writer is told that stillness is a choice and that pressure may not be resolved first", async () => {
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
    const p = wrapWriter(sc.premise, sc.scenes[0], writerCast(sc.characters, sc.scenes[0].roster), sc.writerStyle);
    assert.match(p, /HOLDING STILL IS A CHOICE/);
    assert.match(p, /YOU MAY NOT RESOLVE THE PRESSURE BEFORE YOU ASK ABOUT IT/);
  });

  it("the writer is given the closed `wants` vocabulary, not an invitation to phrase one", async () => {
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
    const p = wrapWriter(sc.premise, sc.scenes[0], writerCast(sc.characters, sc.scenes[0].roster), sc.writerStyle);
    for (const w of CONSULT_WANTS) assert.match(p, new RegExp(`\\b${w}\\b`));
    assert.match(p, /EXACTLY ONE of these four words/);
  });
});

// -- PACING ----------------------------------------------------------------
describe("max_prose_words", () => {
  it("defaults to a real ceiling — several pieces inside one scene's length", async () => {
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
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
