/**
 * Deterministic suite for story format loading and validation.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadStory, discoverStories, chooseStory, selectableStory, NEW_STORY, loadDefaults, readChapters, writtenChapters, readChapterSpec, ROOT,
  type Defaults,
} from "../engine/story-format.ts";
import { StoryJson } from "../engine/story-schema.ts";
import { num, bool, enumOf, slugify } from "../engine/config-util.ts";
import { normalizeSpec, applyEdits, directEdit, renderStory } from "../engine/story-spec.ts";
import { quiet, quietSync, warnings } from "./helpers.ts";

// `new URL(...).pathname` is wrong on Windows and this repo's path may contain a space.
const FIXTURE = fileURLToPath(new URL("./fixtures/badstory", import.meta.url));

// -- STORY SCHEMA (story.json validation) -----------------------------------
describe("StoryJson schema", () => {
  it("fills in every default when only a character name is given", () => {
    const r = StoryJson.parse({ characters: [{ name: "X" }] });
    assert.equal(r.title, "");
    assert.equal(r.premise, "");
    assert.equal(r.scenes.length, 1);
    assert.deepEqual(r.scenes[0], { place: "", question: "", pov: "", length: 700, roster: [] });
    assert.equal(r.config.maxSteps, 24);
    assert.equal(r.config.thinking.writer, "low");
    assert.equal(r.models.default, "qwen3.6-35b-a3b");
  });

  it("wants at least one scene, and puts no ceiling on how many chapters a story runs to", () => {
    const scene = { question: "Q?" };
    assert.equal(StoryJson.safeParse({ characters: [{ name: "X" }], scenes: [] }).success, false);
    assert.equal(
      StoryJson.safeParse({ characters: [{ name: "X" }], scenes: Array(12).fill(scene) }).success, true);
  });

  it("requires a character's name to be non-empty, but allows an empty cast at the schema level", () => {
    assert.equal(StoryJson.safeParse({ characters: [{ name: "" }] }).success, false);
    assert.equal(StoryJson.safeParse({ characters: [] }).success, true,
                 "loadStory, not the schema, is what refuses a story with nobody in it");
  });

  it("rejects a value of the wrong type or out of range, rather than coercing it", () => {
    const r = StoryJson.safeParse({
      characters: [{ name: "X" }],
      scenes: [{ length: "not-a-number" }],
      config: { retries: 7.5, clarifications: -1, stream: "flase", thinking: { writer: "highh" } },
    });
    assert.equal(r.success, false);
    if (!r.success) {
      const paths = r.error.issues.map(i => i.path.join("."));
      for (const p of ["scenes.0.length", "config.retries", "config.clarifications",
                        "config.stream", "config.thinking.writer"])
        assert.ok(paths.includes(p), `expected an issue at ${p}, got ${paths.join(", ")}`);
    }
  });

  it("rejects an unknown key at the top level instead of silently dropping it", () => {
    const r = StoryJson.safeParse({
      characters: [{ name: "X" }],
      unknown_field: "should fail",
    });
    assert.equal(r.success, false);
    if (!r.success) {
      const msgs = r.error.issues.map(i => i.message).join(" ");
      assert.ok(msgs.includes("unknown_field"), `expected unknown_field in error, got "${msgs}"`);
    }
  });

  it("rejects the pre-rename spelling 'lacks' in a character instead of treating it as unknown", () => {
    const r = StoryJson.safeParse({
      characters: [{ name: "X", lacks: ["telepathy"] }],
    });
    assert.equal(r.success, false);
    if (!r.success) {
      const msgs = r.error.issues.map(i => i.message).join(" ");
      assert.ok(msgs.includes("lacks"), `expected lacks in error, got "${msgs}"`);
    }
  });

  it("rejects the misspelled 'skils' in a character instead of treating it as unknown", () => {
    const r = StoryJson.safeParse({
      characters: [{ name: "X", skils: ["lockpicking"] }],
    });
    assert.equal(r.success, false);
    if (!r.success) {
      const msgs = r.error.issues.map(i => i.message).join(" ");
      assert.ok(msgs.includes("skils"), `expected skils in error, got "${msgs}"`);
    }
  });

  it("rejects the pre-rename spelling 'roaster' in a scene instead of treating it as unknown", () => {
    const r = StoryJson.safeParse({
      characters: [{ name: "X" }],
      scenes: [{ roaster: ["X"] }],
    });
    assert.equal(r.success, false);
    if (!r.success) {
      const msgs = r.error.issues.map(i => i.message).join(" ");
      assert.ok(msgs.includes("roaster"), `expected roaster in error, got "${msgs}"`);
    }
  });

  it("rejects the pre-JSON snake_case spelling 'max_steps' in config instead of treating it as unknown", () => {
    const r = StoryJson.safeParse({
      characters: [{ name: "X" }],
      config: { max_steps: 99 },
    });
    assert.equal(r.success, false);
    if (!r.success) {
      const msgs = r.error.issues.map(i => i.message).join(" ");
      assert.ok(msgs.includes("max_steps"), `expected max_steps in error, got "${msgs}"`);
    }
  });

  it("accepts per-scene writerModel and writerThink overrides, falling back without them", () => {
    const withOverrides = StoryJson.parse({
      characters: [{ name: "X" }],
      scenes: [{ writerModel: "claude-4", writerThink: "high" }],
    });
    assert.equal(withOverrides.scenes[0].writerModel, "claude-4");
    assert.equal(withOverrides.scenes[0].writerThink, "high");

    const without = StoryJson.parse({ characters: [{ name: "X" }] });
    assert.equal(without.scenes[0].writerModel, undefined);
    assert.equal(without.scenes[0].writerThink, undefined);
  });

  it("rejects an invalid writerThink value", () => {
    const r = StoryJson.safeParse({
      characters: [{ name: "X" }],
      scenes: [{ writerThink: "superhigh" }],
    });
    assert.equal(r.success, false);
    if (!r.success) {
      const paths = r.error.issues.map(i => i.path.join("."));
      assert.ok(paths.includes("scenes.0.writerThink"), `expected scenes.0.writerThink in error paths, got ${JSON.stringify(paths)}`);
    }
  });
});

// -- CONFIG VALIDATION -----------------------------------------------------
describe("config validation", () => {
  it("num rejects a value that is not wholly an integer", () => {
    const kv = { "config.a": "16garbage", "config.b": "10.9", "config.c": "0", "config.d": "12" };
    assert.equal(quietSync(() => num(kv, "config.a", 24)), 24);
    assert.equal(quietSync(() => num(kv, "config.b", 24)), 24);
    assert.equal(quietSync(() => num(kv, "config.c", 24)), 24);   // must be >= 1
    assert.equal(num(kv, "config.d", 24), 12);
    assert.equal(num(kv, "config.missing", 24), 24);              // absent is silent
    assert.equal(warnings(() => num(kv, "config.missing", 24)).length, 0);
  });

  it("bool takes only true/false", () => {
    const kv = { "config.s": "flase", "config.t": "TRUE" };
    assert.equal(quietSync(() => bool(kv, "config.s", true)), true);
    assert.equal(bool(kv, "config.t", false), true);
  });

  it("enumOf rejects an unknown value instead of silently defaulting", () => {
    const kv = { "config.think": "mediumm", "config.ok": "High" };
    assert.equal(quietSync(() => enumOf(kv, "config.think", ["low", "medium"] as const, "low")), "low");
    assert.equal(warnings(() => enumOf(kv, "config.think", ["low", "medium"] as const, "low")).length, 1);
    assert.equal(enumOf(kv, "config.ok", ["low", "high"] as const, "low"), "high");
  });

  it("rejects a story.json with malformed config values instead of silently accepting them", async () => {
    await assert.rejects(() => loadStory(FIXTURE), (e: any) => {
      assert.match(e.message, /story\.json/);
      assert.match(e.message, /scenes\.0\.length/);
      assert.match(e.message, /config\.retries/);
      assert.match(e.message, /config\.clarifications/);
      assert.match(e.message, /config\.stream/);
      assert.match(e.message, /config\.thinking\.writer/);
      assert.ok(!/"code"/.test(e.message), "error message must not contain JSON dump");
      return true;
    });
  });

  it("formats schema errors as human-readable path: message, not JSON dumps", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      await writeFile(join(dir, "story.json"), JSON.stringify({
        title: "T", premise: "A premise.",
        scenes: [{ place: "Nowhere" }],
        characters: [{ name: "X", lacks: ["sight"] }],
      }), "utf8");

      await assert.rejects(() => loadStory(dir), (e: any) => {
        assert.match(e.message, /story\.json/);
        assert.match(e.message, /characters\.0.*lacks/);
        assert.ok(!/"code"/.test(e.message), "error message must not contain JSON dump");
        return true;
      });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

// -- LOADING A STRUCTURALLY VALID BUT IMPERFECT STORY -----------------------
describe("loadStory warnings", () => {
  it("loads a story with non-fatal problems, warning about each one instead of failing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      await writeFile(join(dir, "story.json"), JSON.stringify({
        title: "T", premise: "A premise.",
        scenes: [{ place: "Nowhere" }],                                     // no question
        characters: [{ name: "GHOST", persona: "x", restrictions: ["telepathy"] }],  // not a general skill
      }), "utf8");

      const warns: string[] = [];
      const orig = console.warn;
      console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
      let sc;
      try { sc = await loadStory(dir); } finally { console.warn = orig; }

      assert.equal(sc.characters.length, 1, "a non-fatal problem must not stop the story from loading");
      assert.ok(!sc.characters[0].skills.some(s => s.name === "telepathy"),
                "an unrecognized restriction removes nothing, and must not become a real skill");
      assert.match(warns.join(" "), /telepathy/);
      assert.match(warns.join(" "), /no "question"/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("warns when a scene roster names a character that is not in the cast", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      await writeFile(join(dir, "story.json"), JSON.stringify({
        title: "T", premise: "A premise.",
        scenes: [{ place: "Nowhere", roster: ["MERRIT", "GHOST"] }],
        characters: [{ name: "GHOST", persona: "x" }],
      }), "utf8");

      const warns: string[] = [];
      const orig = console.warn;
      console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
      try { await loadStory(dir); } finally { console.warn = orig; }

      assert.match(warns.join(" "), /roster "MERRIT"/);
      assert.ok(!/roster "GHOST"/.test(warns.join(" ")),
                "a roster name that is in the cast must not be warned about");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("rejects a story with an empty premise", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      await writeFile(join(dir, "story.json"), JSON.stringify({
        title: "T", premise: "",
        scenes: [{ place: "Nowhere" }],
        characters: [{ name: "GHOST", persona: "x" }],
      }), "utf8");

      await assert.rejects(() => loadStory(dir), (e: any) => {
        assert.match(e.message, /story\.json/);
        assert.match(e.message, /[Pp]remise.*empty/);
        return true;
      });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("rejects a story with a whitespace-only premise", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      await writeFile(join(dir, "story.json"), JSON.stringify({
        title: "T", premise: "   \n\t  ",
        scenes: [{ place: "Nowhere" }],
        characters: [{ name: "GHOST", persona: "x" }],
      }), "utf8");

      await assert.rejects(() => loadStory(dir), (e: any) => {
        assert.match(e.message, /story\.json/);
        assert.match(e.message, /[Pp]remise.*empty/);
        return true;
      });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("exposes the title from story.json", async () => {
    const sc = await quiet(() => loadStory("stories/doorway"));
    assert.equal(sc.title, "Doorway");
  });

  it("loads with an empty title when none is given in story.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      await writeFile(join(dir, "story.json"), JSON.stringify({
        premise: "A premise.",
        scenes: [{ place: "Nowhere" }],
        characters: [{ name: "GHOST", persona: "x" }],
      }), "utf8");

      const sc = await quiet(() => loadStory(dir));
      assert.equal(sc.title, "");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

// -- MODEL OVERRIDE  ------
describe("loadStory model override", () => {
  async function withStory(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    await writeFile(join(dir, "story.json"), JSON.stringify({
      title: "T", premise: "A premise.",
      scenes: [{ question: "Q?" }],
      characters: [
        { name: "A", persona: "A's persona." },
        { name: "B", persona: "B's persona.", model: "b-own-model" },
      ],
      models: { default: "story-default" },
    }), "utf8");
    return dir;
  }

  it("beats the story's own default when given", async () => {
    const dir = await withStory();
    try {
      const sc = await quiet(() => loadStory(dir, "gui-override"));
      assert.equal(sc.models.default, "gui-override");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("reaches a character with no model: of its own, never one that names its own", async () => {
    const dir = await withStory();
    try {
      const sc = await quiet(() => loadStory(dir, "gui-override"));
      const a = sc.characters.find(c => c.name === "A")!, b = sc.characters.find(c => c.name === "B")!;
      assert.equal(a.model, "gui-override", "A has no model: of its own — it inherits the override");
      assert.equal(b.model, "b-own-model", "B named its own model — the override must not touch it");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("leaves the story's own default in force when none is given", async () => {
    const dir = await withStory();
    try {
      const sc = await quiet(() => loadStory(dir));
      assert.equal(sc.models.default, "story-default");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("readChapters", () => {
  it("returns an empty list when chapters/ does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      const chapters = await readChapters(dir);
      assert.deepEqual(chapters, []);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("reads the chapters that exist and returns their text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      await mkdir(join(dir, "chapters"), { recursive: true });
      await writeFile(join(dir, "chapters", "1.md"), "Chapter 1 prose.", "utf8");
      await writeFile(join(dir, "chapters", "2.md"), "Chapter 2 prose.", "utf8");

      const chapters = await readChapters(dir);
      assert.equal(chapters.length, 2);
      assert.equal(chapters[0].n, 1);
      assert.equal(chapters[0].text, "Chapter 1 prose.");
      assert.equal(chapters[1].n, 2);
      assert.equal(chapters[1].text, "Chapter 2 prose.");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("orders chapters numerically, not lexically", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      await mkdir(join(dir, "chapters"), { recursive: true });
      await writeFile(join(dir, "chapters", "1.md"), "One", "utf8");
      await writeFile(join(dir, "chapters", "10.md"), "Ten", "utf8");
      await writeFile(join(dir, "chapters", "2.md"), "Two", "utf8");

      const chapters = await readChapters(dir);
      assert.deepEqual(chapters.map(c => c.n), [1, 2, 10]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("ignores files that are not <digits>.md", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      await mkdir(join(dir, "chapters"), { recursive: true });
      await writeFile(join(dir, "chapters", "1.md"), "One", "utf8");
      await writeFile(join(dir, "chapters", "notes.md"), "Notes", "utf8");
      await writeFile(join(dir, "chapters", "3.txt"), "Three as txt", "utf8");
      await writeFile(join(dir, "chapters", "draft-2.md"), "Draft", "utf8");

      const chapters = await readChapters(dir);
      assert.deepEqual(chapters.map(c => c.n), [1]);
      assert.equal(chapters[0].text, "One");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("writtenChapters", () => {
  it("returns an empty list when chapters/ does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      const chapters = await writtenChapters(dir);
      assert.deepEqual(chapters, []);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("returns chapter numbers in numeric order, ignoring non-matching files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      await mkdir(join(dir, "chapters"), { recursive: true });
      await writeFile(join(dir, "chapters", "2.md"), "Chapter 2", "utf8");
      await writeFile(join(dir, "chapters", "10.md"), "Chapter 10", "utf8");
      await writeFile(join(dir, "chapters", "notes.md"), "Notes", "utf8");
      await writeFile(join(dir, "chapters", "3.txt"), "Chapter 3 as txt", "utf8");
      await mkdir(join(dir, "chapters", "subdir"), { recursive: true });

      const chapters = await writtenChapters(dir);
      assert.deepEqual(chapters, [2, 10]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("returns the same chapter numbers that readChapters will read with contents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      await mkdir(join(dir, "chapters"), { recursive: true });
      await writeFile(join(dir, "chapters", "2.md"), "Chapter 2 text", "utf8");
      await writeFile(join(dir, "chapters", "10.md"), "Chapter 10 text", "utf8");

      const nums = await writtenChapters(dir);
      const full = await readChapters(dir);

      assert.deepEqual(nums, [2, 10]);
      assert.equal(full.length, 2);
      assert.equal(full[0].n, 2);
      assert.equal(full[0].text, "Chapter 2 text");
      assert.equal(full[1].n, 10);
      assert.equal(full[1].text, "Chapter 10 text");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("readChapterSpec", () => {
  it("returns null when no chapters/ directory at all", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      const spec = await readChapterSpec(dir, 1);
      assert.equal(spec, null);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("returns null when a chapter with prose but no .json snapshot exists (older chapter case)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      await mkdir(join(dir, "chapters"), { recursive: true });
      await writeFile(join(dir, "chapters", "1.md"), "Chapter 1 prose.", "utf8");

      const spec = await readChapterSpec(dir, 1);
      assert.equal(spec, null);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("returns the parsed object when a valid snapshot exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      await mkdir(join(dir, "chapters"), { recursive: true });
      const specData = { title: "Test Story", scenes: [{ place: "Somewhere" }], characters: [{ name: "Hero" }] };
      await writeFile(join(dir, "chapters", "1.json"), JSON.stringify(specData), "utf8");

      const spec = await readChapterSpec(dir, 1);
      assert.deepEqual(spec, specData);
      assert.equal((spec as any)?.title, "Test Story");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("returns null when a snapshot exists but is not valid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      await mkdir(join(dir, "chapters"), { recursive: true });
      await writeFile(join(dir, "chapters", "1.json"), "not valid json {", "utf8");

      const spec = await readChapterSpec(dir, 1);
      assert.equal(spec, null);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("loadDefaults", () => {
  it("reads defaults.json, and --model overrides everything in it", async () => {
    const d = await quiet(() => loadDefaults());
    assert.ok(d.models.default);
    assert.ok(d.models.architect);
    const o = await quiet(() => loadDefaults("forced-model"));
    assert.equal(o.models.default, "forced-model");
    assert.equal(o.models.architect, "forced-model");
  });
});

// -- SHIPPED STORY ---------------------------------------------------------
describe("stories/doorway", () => {
  it("loads, and is built so both the clarification path and the skill check are reachable", async () => {
    const sc = await quiet(() => loadStory("stories/doorway"));
    assert.deepEqual(sc.characters.map(c => c.name), ["RIVEN", "MERRITT"]);
    const riven = sc.characters[0], merritt = sc.characters[1];
    assert.ok(riven.skills.some(s => s.name === "lockpicking" && s.source === "story"));
    assert.ok(!merritt.skills.some(s => s.name === "sight"));
    assert.ok(sc.scenes[0].question);
    assert.ok(sc.premise.length > 100);
  });

  it("is discoverable, and the fixture is not", async () => {
    const found = await discoverStories();
    assert.ok(found.includes("stories/doorway"));
    assert.ok(!found.some(d => d.includes("badstory")));
  });

  it("never offers to build a story when there is no terminal", async () => {
    const orig = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      const picked = await chooseStory("");
      assert.notEqual(picked, NEW_STORY);
      assert.equal(picked, (await discoverStories())[0]);
      assert.equal(await chooseStory("stories/doorway"), "stories/doorway");
    } finally {
      if (orig) Object.defineProperty(process.stdin, "isTTY", orig);
    }
  });
});

// -- CHOOSING FROM OUTSIDE THE PROCESS -------------------------------------
describe("selectableStory", () => {
  it("resolves a discovered story, by full path or bare folder name", async () => {
    assert.equal(await selectableStory("stories/doorway"), "stories/doorway");
    assert.equal(await selectableStory("doorway"), "stories/doorway");
    assert.equal(await selectableStory("stories/doorway/"), "stories/doorway");
    assert.equal(await selectableStory("stories\\doorway"), "stories/doorway",
                 "a Windows separator names the same story, not a different one");
  });

  it("refuses anything the engine did not discover", async () => {
    for (const bad of ["", "   ", "../../etc/passwd", "stories/../story-writer.ts", "stories",
                       "stories/nope", "/etc/passwd", "C:/Windows/System32", "tests/fixtures/badstory"]) {
      assert.equal(await selectableStory(bad), null, `must refuse ${JSON.stringify(bad)}`);
    }
  });
});
