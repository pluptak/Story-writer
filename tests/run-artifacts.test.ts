/** What a run leaves behind on disk, plus prompt and pacing checks. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadStory } from "../engine/story-format.ts";
import { chapterStartRefusal } from "../app.ts";
import { llmFilenameFor, llmLogEntry, writeLlmRecord, Agent } from "../engine/agent.ts";
import { ENGINE } from "../engine/engine-state.ts";
import { WARN } from "../engine/warnings.ts";
import { runDirs, retainedRuns, runLlmLogs, readLlmLog } from "../engine/preflight.ts";
import { CONSULT_WANTS } from "../engine/consult.ts";
import { wrapCharacter, wrapWriter, writerCast, sceneReach } from "../engine/scene-loop.ts";
import { fingerprint, LOADED, writeRunManifest } from "../run-manifest.ts";
import { quiet, warnings } from "./helpers.ts";

// -- THE RUN MANIFEST -------------------------------------------------------
// Its purpose is catching a process running code the working tree no longer holds, so the test that
// matters is whether the digest moves when the source under it does.
describe("run manifest", () => {
  /** A miniature source tree of the shape `fingerprint` walks. */
  async function fakeTree(engineBody: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "story-writer-print-"));
    await mkdir(join(root, "engine"), { recursive: true });
    await mkdir(join(root, "prompts"), { recursive: true });
    await writeFile(join(root, "engine", "scene-loop.ts"), engineBody, "utf8");
    await writeFile(join(root, "prompts", "writer.ts"), "export const X = 1;\n", "utf8");
    await writeFile(join(root, "prompts.ts"), "export * from './prompts/writer.ts';\n", "utf8");
    return root;
  }

  it("changes when a source file's contents change", async () => {
    const a = await fakeTree("export const N = 1;\n");
    const b = await fakeTree("export const N = 2;\n");
    try {
      assert.notEqual(fingerprint(a), fingerprint(b), "an edited engine must not fingerprint the same");
      assert.equal(fingerprint(a), fingerprint(a), "and the digest is stable for unchanged source");
    } finally {
      await rm(a, { recursive: true, force: true });
      await rm(b, { recursive: true, force: true });
    }
  });

  it("changes when a source file is added or removed, not only edited", async () => {
    const root = await fakeTree("export const N = 1;\n");
    try {
      const before = fingerprint(root);
      await writeFile(join(root, "engine", "extra.ts"), "export const Y = 1;\n", "utf8");
      assert.notEqual(fingerprint(root), before, "a new module changes what the engine is");
      await rm(join(root, "engine", "extra.ts"));
      assert.equal(fingerprint(root), before, "and removing it puts the digest back");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("survives a tree it cannot read at all", () => {
    // Coarse beats throwing: a fingerprint that fails takes the run with it.
    assert.match(fingerprint(join(tmpdir(), "story-writer-nonexistent-tree")), /^[0-9a-f]{12}$/);
  });

  it("writes a manifest naming the engine that is running", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      const m = await writeRunManifest(dir, {
        run: "2026-08-28T00-00-00-000Z", story: "stories/x", chapter: 2,
        scene: { pov: "ELIAS", target: 700 }, models: { writer: "w", summary: "s" },
      });
      const onDisk = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
      assert.deepEqual(onDisk, m, "what it returned is what it wrote");
      assert.equal(m.engine, LOADED, "the run is stamped with the loaded engine, not the one on disk");
      assert.equal(m.engineStale, false, "and this test process is running its own tree");
      assert.equal(m.chapter, 2);
      assert.equal(m.scene.pov, "ELIAS");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

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
      // A populated listing, so the refusal is the allowlist doing its job, not an empty
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

  it("llmLogEntry: reasoning, finish_reason and reasoningOnly land in the record when given", () => {
    const e = llmLogEntry({ name: "Anne", model: "m" }, "t", [], "answer", 100, null,
      { reasoning: "the chain of thought", finishReason: "stop" });
    assert.equal(e.finish_reason, "stop");
    assert.equal(e.reasoning, "the chain of thought");
    assert.equal(e.reasoningOnly, undefined);
  });

  it("llmLogEntry: reasoningOnly flags a reply that arrived entirely via the reasoning channel", () => {
    const e = llmLogEntry({ name: "Anne", model: "m" }, "t", [], "r", 100, null, { reasoningOnly: true });
    assert.equal(e.reasoningOnly, true);
    assert.equal(e.reasoning, undefined);
  });

  it("llmLogEntry: broken_off appears only when the reply was salvaged from a broken stream", () => {
    const salvaged = llmLogEntry({ name: "Anne", model: "m" }, "t", [], "r", 100, null, { brokenOff: true });
    assert.equal(salvaged.broken_off, true);
    const clean = llmLogEntry({ name: "Anne", model: "m" }, "t", [], "r", 100, null, { brokenOff: false });
    assert.equal("broken_off" in clean, false);
    const bare = llmLogEntry({ name: "Anne", model: "m" }, "t", [], "r", 100, null);
    assert.equal("broken_off" in bare, false);
  });

  it("llmLogEntry: without meta, finish_reason is null and no reasoning keys appear", () => {
    const e = llmLogEntry({ name: "Anne", model: "m" }, "t", [], "r", 100, null);
    assert.equal(e.finish_reason, null);
    assert.equal("reasoning" in e, false);
    assert.equal("reasoningOnly" in e, false);
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

  it("a removed special skill is named under CANNOT, not merely absent from can", async () => {
    // The live gap this pins: a removed lockpicking would be invisible if only absence-from-can spoke.
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
    const bound = { ...sc.characters[0], limits: ["touch", "lockpicking"] };
    const cast = writerCast([bound], []);
    assert.deepEqual(cast[0].cannot, ["touch", "lockpicking"]);
    const p = wrapWriter(sc.premise, sc.scenes[0], cast, sc.writerStyle);
    assert.match(p, /CANNOT: touch, lockpicking/);
  });

  it("the cast block shows the delta from the general baseline, not the seven obvious generals", async () => {
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
    const withGeneral = { ...sc.characters[0], skills: [
      { name: "speech", meaning: "saying things aloud", source: "general" as const },
      { name: "keys", meaning: "carrying and using every key on Kessel's ring", source: "custom" as const },
    ] };
    const cast = writerCast([withGeneral], []);
    assert.deepEqual(cast[0].can, ["keys -- carrying and using every key on Kessel's ring"],
      "a general skill never reaches a can line");
    const p = wrapWriter(sc.premise, sc.scenes[0], cast, sc.writerStyle);
    assert.match(p, /RIVEN[\s\S]{0,200}can: keys/);
    assert.ok(!/can:[^\n]*\bspeech\b/.test(p), "a general skill must not appear on any can line");
  });

  it("the cast block states the baseline, so a short can list does not read as a short leash", async () => {
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
    const bare = { ...sc.characters[0], skills: [] };
    const p = wrapWriter(sc.premise, sc.scenes[0], writerCast([bare], []), sc.writerStyle);
    assert.match(p, /ordinary human abilities/);
    assert.ok(!/RIVEN -- can:/.test(p), "a character with nothing beyond the baseline has no can line");
    assert.ok(/RIVEN$|RIVEN -- CANNOT/m.test(p));
  });

  it("the writer is told that stillness is a choice and that pressure may not be resolved first", async () => {
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
    const p = wrapWriter(sc.premise, sc.scenes[0], writerCast(sc.characters, sc.scenes[0].roster), sc.writerStyle);
    assert.match(p, /HOLDING STILL IS A CHOICE/);
    assert.match(p, /YOU MAY NOT RESOLVE THE PRESSURE BEFORE YOU ASK ABOUT IT/);
  });

  it("the writer's consult is two fields, and it is told the situation is the whole ask", async () => {
    // Stage 3: `question` and `wants` are gone from what the writer sends, so the closed vocabulary
    // it once got would now invite filling a field nothing reads.
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
    const p = wrapWriter(sc.premise, sc.scenes[0], writerCast(sc.characters, sc.scenes[0].roster), sc.writerStyle);
    assert.match(p, /"character": "NAME", "situation"/);
    assert.match(p, /THE WHOLE OF WHAT YOU ARE SENDING/);
    assert.ok(!/EXACTLY ONE of these four words/.test(p), "no shape menu is offered any more");
    assert.ok(!/"wants"/.test(p), "and no wants field to fill in");
  });
});

// -- REACH BOUNDARIES (I1–I4) ------------------------------------------------
describe("reach boundaries", () => {
  const AURA: import("../engine/story-format.ts").CharacterDef = {
    name: "AURA", model: "", persona: "The building's AI.", knows: "", goal: "", belief: "",
    impulse: "", voice: [],
    skills: [{ name: "speech", meaning: "saying things aloud over the intercom", source: "general" }],
    limits: [],
  };
  const CAMERAS = [{ name: "cameras", meaning: "perceiving through the lobby cameras", source: "reach" as const }];
  // As authored on the scene: raw "name :: meaning" strings.
  const GRANTED = { AURA: ["cameras :: perceiving through the lobby cameras"] };
  const sceneOf = (reach: Record<string, string[]>) =>
    ({ place: "the lobby", question: "Does AURA let them in?", pov: "AURA", length: 700, roster: ["AURA"], reach }) as never;

  it("I4 — reach disappears at the scene boundary, from both the menu and the cast block", async () => {
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
    // Scene A grants camera reach; scene B grants nothing.
    const inLobby = wrapCharacter(AURA, "the lobby", sceneReach(sceneOf(GRANTED), AURA));
    const elsewhere = wrapCharacter(AURA, "the basement");
    assert.match(inLobby, /REACH -- yours only through where you are standing right now/);
    assert.match(inLobby, /cameras -- perceiving through the lobby cameras/);
    assert.ok(!elsewhere.includes("cameras"), "the grant must not survive into a later scene's agent");

    const granted = wrapWriter(sc.premise, sc.scenes[0], writerCast([AURA], [], { AURA: CAMERAS }), "");
    const after = wrapWriter(sc.premise, sc.scenes[0], writerCast([AURA], []), "");
    assert.match(granted, /REACH: cameras/);
    assert.ok(!after.includes("cameras"), "and must not survive into the next scene's cast block");
  });

  it("I4 — loadStory never carries a reach entry on a character, however much the scenes grant", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reach-"));
    try {
      const raw = JSON.parse(await readFile("tests/fixtures/doorway/story.json", "utf8"));
      raw.scenes = [{
        place: "the lobby", question: "Does AURA let them in?", pov: "RIVEN", length: 700,
        roster: [raw.characters[0].name],
        reach: { [raw.characters[0].name]: ["cameras :: perceiving through the lobby cameras"] },
      }];
      await writeFile(join(dir, "story.json"), JSON.stringify(raw), "utf8");
      const sc = await quiet(() => loadStory(dir));
      for (const c of sc.characters)
        assert.ok(c.skills.every(s => s.source !== "reach"),
          `${c.name} is a character-level view; reach must never merge into their skills`);
      assert.ok(sc.scenes[0].reach && Object.keys(sc.scenes[0].reach).length > 0,
        "the grant itself survives on the scene where it belongs");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("a situational capability is never emitted on a can: line — `can: cameras` is unreachable output", () => {
    const cast = writerCast([{ ...AURA, skills: [...AURA.skills, ...CAMERAS] } as never, ], [], {});
    assert.ok(!cast[0].can.some(c => c.startsWith("cameras")),
      "even a hand-assembled reach-tagged skill cannot ride onto can:");
  });

  it("loadStory warns when reach names nobody who could receive it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reach-"));
    try {
      const raw = JSON.parse(await readFile("tests/fixtures/doorway/story.json", "utf8"));
      raw.scenes = [{ place: "the lobby", question: "Q?", pov: "", length: 700,
        roster: [raw.characters[0].name], reach: { NOBODY: ["cameras :: seeing everywhere"] } }];
      await writeFile(join(dir, "story.json"), JSON.stringify(raw), "utf8");
      const got: string[] = [];
      const origSink = WARN.sink;
      WARN.sink = (...a: unknown[]) => { got.push(a.map(String).join(" ")); };
      try { await loadStory(dir); } finally { WARN.sink = origSink; }
      assert.ok(got.some(x => /grants reach to "NOBODY"/.test(x)));
    } finally { await rm(dir, { recursive: true, force: true }); }
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
});

// -- CHAPTER DURABILITY (runOne's guard) ------------------------------------
describe("chapterStartRefusal", () => {
  /** A throwaway story directory with `sceneCount` scenes, so a gap is reachable. */
  async function storyCopy(sceneCount: number): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "durability-"));
    const raw = JSON.parse(await readFile("tests/fixtures/doorway/story.json", "utf8"));
    while (raw.scenes.length < sceneCount)
      raw.scenes.push({ ...raw.scenes[0], question: raw.scenes[0].question + " And then?" });
    await writeFile(join(dir, "story.json"), JSON.stringify(raw), "utf8");
    return dir;
  }

  it("refuses to overwrite an existing chapter", async () => {
    const dir = await storyCopy(1);
    try {
      await mkdir(join(dir, "chapters"), { recursive: true });
      await writeFile(join(dir, "chapters", "1.md"), "already written\n", "utf8");
      assert.match((await chapterStartRefusal(dir, 1, false))!, /already written.*--replace/s);
      assert.equal(await chapterStartRefusal(dir, 1, true), null, "the explicit authorization lets it through");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("refuses to skip past an unwritten chapter", async () => {
    const dir = await storyCopy(2);
    try {
      assert.match((await chapterStartRefusal(dir, 2, false))!, /chapter 1 was never written/);
      assert.equal(await chapterStartRefusal(dir, 2, true), null);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("lets an ordinary next-chapter run through", async () => {
    const dir = await storyCopy(2);
    try {
      assert.equal(await chapterStartRefusal(dir, 1, false), null);
      await mkdir(join(dir, "chapters"), { recursive: true });
      await writeFile(join(dir, "chapters", "1.md"), "chapter one\n", "utf8");
      assert.equal(await chapterStartRefusal(dir, 2, false), null, "contiguous and unwritten is the normal case");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
