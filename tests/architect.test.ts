/**
 * Architect tests — story scaffolding, chapter handoff, and related HTTP routes.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  loadStory, type Defaults,
} from "../engine/story-format.ts";
import { normalizeSpec, applyEdits, renderStory } from "../engine/story-spec.ts";
import { architectNextChapter } from "../prompts.ts";
import { ScaffoldSession, NextChapterSession, openNextChapter } from "../engine/architect.ts";
import { LIVE } from "../live.ts";
import { handleNextChapterRoutes } from "../server/next-chapter-routes.ts";
import { HttpError, readJsonBody } from "../server/http-util.ts";
import type { ServerHost } from "../server/server.ts";
import { quiet, quietSync, ScriptedAgent } from "./helpers.ts";

// -- SCAFFOLD SUPPORT -------------------------------------------------------
const SCAFFOLD_DEFAULTS: Defaults = {
  models: { default: "none", architect: "none" },
  thinking: { architect: "low" },
  requestTimeout: 120, attempts: 3, maxTokens: 2000, stream: false, debug: false,
};

const STORY = {
  title: "The Fog Signal",
  premise: "Two keepers, one lamp, and a night that did not happen the way the log says it did.",
  scene: { place: "the lamp room", question: "Does Aster admit the signal never fired?", pov: "ASTER", length: 700 },
  writer_style: "Plain sentences. No weather as metaphor.",
  characters: [
    { name: "ASTER", persona: "Keeps the log in a small clear hand and has never once falsified it.",
      knows: "The signal did not fire.", skills: ["lamp-tending :: trimming and lighting the great lens"], restrictions: [] },
    { name: "BRAE", persona: "Came up from the boats and trusts the weather over anyone's paperwork.",
      knows: "", skills: [], restrictions: ["hearing"] },
  ],
};
const scaffold = (script: unknown[], storiesDir?: string) =>
  new ScaffoldSession(new ScriptedAgent(script.map(s => JSON.stringify(s))),
                      SCAFFOLD_DEFAULTS, "two lighthouse keepers", storiesDir);

// -- THE SCAFFOLD INTERVIEW -------------------------------------------------
describe("ScaffoldSession", () => {
  it("recovers from an ambiguous idea instead of patching a void", async () => {
    const s = scaffold([{ ask: "Is this a ghost story or a fraud story?" }, STORY]);

    const first = await s.propose();
    assert.equal(first.kind, "question");
    assert.equal(s.haveStory(), false);
    assert.equal(s.asks, 1);

    const req = s.request("a fraud story");
    assert.match(req, /\[MORE\]/);
    assert.match(req, /Propose the whole story now/);
    assert.doesNotMatch(req, /Reply with edits only/, "there is nothing yet to edit");

    const second = await s.say("a fraud story");
    assert.equal(second.kind, "proposal");
    assert.equal(s.haveStory(), true);
    assert.equal(s.asks, 0, "a story on the page resets the question budget");
    assert.equal(s.pendingAsk, "");
  });

  it("stops interrogating after three questions with nothing to show", async () => {
    const ask = { ask: "Which of the two is it?" };
    const s = scaffold([ask, ask, ask, STORY]);
    await s.propose();
    await s.say("a");
    await s.say("b");
    assert.equal(s.asks, 3);
    assert.match(s.request("c"), /Do not ask anything else/);
    assert.equal((await s.say("c")).kind, "proposal");
  });

  it("surfaces a question that arrives alongside a story, without blocking acceptance", async () => {
    const s = scaffold([{ ...STORY, ask: "Should the relief boat actually arrive?" }]);
    const r = await s.propose();
    assert.equal(r.kind, "proposal");
    assert.match((r as { note: string }).note, /it also asks: Should the relief boat actually arrive\?/);
    assert.equal(s.pendingAsk, "", "an outstanding question blocks accepting, and there is a story to accept");
    assert.equal(s.haveStory(), true);
  });

  it("keeps the note as well when a round both notes and asks", async () => {
    const s = scaffold([STORY, { edits: [{ field: "scene.length", value: 800 }], note: "shortened the premise", ask: "Colder or warmer?" }]);
    await s.propose();
    const r = await s.say("tighten it");
    assert.equal((r as { note: string }).note, "shortened the premise — it also asks: Colder or warmer?");
  });

  it("does not spend the question budget on a reply that asked nothing", async () => {
    const s = scaffold([{ note: "thinking out loud" }]);
    const r = await s.propose();
    assert.equal(r.kind, "nothing");
    assert.equal(s.asks, 0);
  });

  it("sends a patch once a story exists, against the spec the ENGINE holds", async () => {
    const s = scaffold([STORY, { edits: [{ field: "scene.length", value: 900 }] }]);
    await s.propose();

    const req = s.request("make it longer");
    assert.match(req, /\[CHANGE\] make it longer/);
    assert.match(req, /\[THE STORY AS IT STANDS\]/);
    assert.match(req, /Reply with edits only/);
    assert.match(req, /The Fog Signal/, "the engine's spec, not the architect's memory of it");

    const r = await s.say("make it longer");
    assert.equal(r.kind, "edits");
    assert.deepEqual((r as { applied: string[] }).applied, ["scene.length"]);
    assert.equal(s.spec.scenes[0].length, 900);
    assert.equal(s.spec.title, "The Fog Signal", "everything not named survived the round");
    assert.equal(s.spec.characters.length, 2);
  });

  it("changes nothing when the architect asks a question mid-refinement", async () => {
    const s = scaffold([STORY, { ask: "Longer how — more beats, or slower ones?" }]);
    await s.propose();
    const before = structuredClone(s.spec);
    const r = await s.say("make it longer");
    assert.equal(r.kind, "question");
    assert.deepEqual(s.spec, before);
    assert.equal(s.pendingAsk, "Longer how — more beats, or slower ones?");
  });

  it("clears the outstanding question once a round answers it", async () => {
    const s = scaffold([STORY, { ask: "Longer how?" }, { edits: [{ field: "scene.length", value: 1200 }] }]);
    await s.propose();
    await s.say("make it longer");
    assert.equal(s.pendingAsk, "Longer how?");
    await s.say("more beats");
    assert.equal(s.pendingAsk, "");
  });

  it("survives a round that fails, changing nothing", async () => {
    const s = scaffold([STORY]);
    await s.propose();
    const before = structuredClone(s.spec);
    const r = await s.say("change something");   // the script is spent, so the call throws
    assert.equal(r.kind, "failed");
    assert.deepEqual(s.spec, before);
  });
});

describe("ScaffoldSession.accept", () => {
  it("refuses to write before there is a story", async () => {
    assert.equal((await scaffold([]).accept()).kind, "no_story");
  });

  it("asks for a folder name when the title yields none, then writes one that loads", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "scaffold-"));
    try {
      const s = scaffold([{ ...STORY, title: "???" }], tmp);
      await s.propose();

      const asked = await s.accept();
      assert.equal(asked.kind, "needs_folder");
      assert.match((asked as { reason: string }).reason, /doesn't give a usable folder name/);

      const w = await quiet(() => s.accept("Fog Signal"));
      assert.ok(w.kind === "written", `expected written, got ${w.kind}`);
      assert.deepEqual(w.files, ["story.json"]);
      assert.match(w.dir.replace(/\\/g, "/"), /\/fog-signal$/);

      // The pre-flight ran the real loader on what was just written; prove it independently.
      const sc = await quiet(() => loadStory(w.dir));
      assert.deepEqual(sc.characters.map(c => c.name), ["ASTER", "BRAE"]);
      assert.ok(!sc.characters[1].skills.some(k => k.name === "hearing"), "BRAE's absence survived the write");
    } finally { await rm(tmp, { recursive: true, force: true }); }
  });

  it("never overwrites a story that is already there", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "scaffold-"));
    try {
      const s = scaffold([STORY], tmp);
      await s.propose();
      assert.equal((await quiet(() => s.accept())).kind, "written");
      const again = await s.accept();
      assert.equal(again.kind, "needs_folder");
      assert.match((again as { reason: string }).reason, /already exists/);
      assert.equal((await quiet(() => s.accept("the fog signal, again"))).kind, "written");
    } finally { await rm(tmp, { recursive: true, force: true }); }
  });
});

// -- THE HANDOFF -----------------------------------------------------------
describe("architectNextChapter", () => {
  const chapters = [{ n: 1, text: "The lamp went out." }, { n: 2, text: "Nobody relit it." }];
  const spec = JSON.stringify({ title: "Dark", scenes: [{}, {}] });

  it("asks for the chapter after the last one written, however the list is ordered", () => {
    const p = architectNextChapter("A premise.", spec, [chapters[1], chapters[0]]);
    assert.match(p, /Prepare chapter 3\./);
    assert.match(p, /Chapters 1-2 of this story are written/);
  });

  it("hands over the premise, every chapter's prose, and the story as it stands", () => {
    const p = architectNextChapter("A lighthouse, unlit.", spec, chapters);
    assert.match(p, /A lighthouse, unlit\./);
    assert.match(p, /CHAPTER 1, as written[\s\S]*The lamp went out\./);
    assert.match(p, /CHAPTER 2, as written[\s\S]*Nobody relit it\./);
    assert.ok(p.includes(spec), "the architect edits the story it was shown");
  });

  it("says the engine carries nothing forward — the reason the handoff exists at all", () => {
    const p = architectNextChapter("A premise.", spec, chapters);
    assert.match(p, /No character remembers a word of an earlier chapter/);
    assert.match(p, /roster/);
  });

  it("gives the edit vocabulary, including both ways to reach the next chapter's scene", () => {
    const p = architectNextChapter("A premise.", spec, chapters);
    for (const field of ["add_character", "remove_character", "add_scene", "remove_scene",
                         "characters.<NAME>.persona", "scene_<n>.place"])
      assert.ok(p.includes(field), `the handoff must name ${field}`);
    assert.match(p, /scene_3\.place/);       // re-author the scene the story already has
    assert.match(p, /add_scene/);            // or add it when it does not
  });

  it("counts one written chapter in the singular", () => {
    const p = architectNextChapter("A premise.", spec, [chapters[0]]);
    assert.match(p, /Chapter 1 of this story is written/);
    assert.match(p, /Prepare chapter 2\./);
  });
});

describe("NextChapterSession", () => {
  const spec = normalizeSpec(STORY).spec;
  const written = [{ n: 1, text: "The signal never fired, and Aster wrote that it did." }];
  const handoff = (script: unknown[], s = spec, dir = "stories/doorway") =>
    new NextChapterSession(new ScriptedAgent(script.map(x => JSON.stringify(x))),
                           SCAFFOLD_DEFAULTS, dir, s, written);

  it("prepares the chapter after the last one written, and hands over what was written", async () => {
    const s = handoff([{ edits: [{ field: "characters.ASTER.goal", value: "Get off the rock." }] }]);
    assert.equal(s.chapter, 2);
    const r = await s.propose();
    assert.equal(r.kind, "edits");
    const sent = s.architect.history[0].content;
    assert.match(sent, /Prepare chapter 2\./);
    assert.match(sent, /The signal never fired/);
    assert.match(sent, /The Fog Signal/, "the story as it stands, not the architect's memory of it");
  });

  it("folds the edits into the story and leaves everything they did not name alone", async () => {
    const s = handoff([{ edits: [
      { field: "characters.ASTER.knows", value: "Brae read the log." },
      { field: "add_scene", value: { place: "the boat shed", question: "Does Brae say so?", pov: "BRAE", length: 800, roster: ["BRAE", "ASTER"] } },
    ] }]);
    const r = await quiet(() => s.propose());
    assert.equal(r.kind, "edits");
    assert.equal(s.edited, true);
    assert.equal(s.spec.characters[0].knows, "Brae read the log.");
    assert.equal(s.spec.scenes.length, 2);
    assert.equal(s.spec.scenes[1].question, "Does Brae say so?");
    assert.equal(s.spec.scenes[0].question, spec.scenes[0].question, "chapter 1's scene is untouched");
    assert.equal(s.spec.title, "The Fog Signal");
  });

  it("refuses to remove a scene whose chapter is already written — it would renumber the rest", async () => {
    const two = quietSync(() => applyEdits(spec, { edits: [{ field: "add_scene", value: { question: "And then?" } }] })).spec;
    const s = handoff([{ edits: [{ field: "remove_scene", value: 1 }, { field: "remove_scene", value: 2 }] }], two);
    const r = await quiet(() => s.propose());
    assert.equal(r.kind, "edits");
    assert.deepEqual((r as { applied: string[] }).applied, ["removed scene 2"]);
    assert.match((r as { ignored: string[] }).ignored.join(" "), /remove_scene 1 . chapter 1 is already written/);
    assert.equal(s.spec.scenes.length, 1);
    assert.equal(s.spec.scenes[0].question, spec.scenes[0].question);
  });

  it("changes nothing when the architect asks instead of editing", async () => {
    const s = handoff([{ ask: "Did Aster ever admit it?" }]);
    const before = structuredClone(s.spec);
    const r = await s.propose();
    assert.equal(r.kind, "question");
    assert.equal(s.pendingAsk, "Did Aster ever admit it?");
    assert.equal(s.edited, false);
    assert.deepEqual(s.spec, before);
  });

  it("takes a follow-up as an ordinary change round", async () => {
    const s = handoff([{ ask: "How long is chapter 2?" }, { edits: [{ field: "scene.length", value: 900 }] }]);
    await s.propose();
    const r = await quiet(() => s.say("about the same"));
    assert.equal(r.kind, "edits");
    assert.match(s.architect.history[2].content, /\[CHANGE\] about the same/);
    assert.equal(s.spec.scenes[0].length, 900);
    assert.equal(s.pendingAsk, "");
  });

  it("reports a reply that is neither edits nor a question, and a round that fails", async () => {
    const s = handoff([{ note: "thinking about it" }]);
    assert.equal((await s.propose()).kind, "nothing");
    assert.equal(s.edited, false);
    assert.equal((await s.say("well?")).kind, "failed");   // the script is spent, so the call throws
  });
});

describe("NextChapterSession.accept", () => {
  const spec = normalizeSpec(STORY).spec;
  const prose = "The signal never fired, and Aster wrote that it did.\n";

  async function storyOnDisk(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "handoff-"));
    await writeFile(join(dir, "story.json"), renderStory(spec, { default: "none" })["story.json"], "utf8");
    await mkdir(join(dir, "chapters"), { recursive: true });
    await writeFile(join(dir, "chapters", "1.md"), prose, "utf8");
    return dir;
  }
  const session = (dir: string, script: unknown[]) =>
    new NextChapterSession(new ScriptedAgent(script.map(x => JSON.stringify(x))), SCAFFOLD_DEFAULTS,
                           dir, spec, [{ n: 1, text: prose }]);

  it("writes nothing until a round has changed something", async () => {
    const dir = await storyOnDisk();
    try {
      assert.equal((await session(dir, []).accept()).kind, "nothing");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("writes the re-authored story over the one on disk, and leaves the chapters alone", async () => {
    const dir = await storyOnDisk();
    try {
      const s = session(dir, [{ edits: [
        { field: "characters.BRAE.goal", value: "Get the log off the rock." },
        { field: "add_scene", value: { place: "the boat shed", question: "Does Brae take it?", pov: "BRAE" } },
      ] }]);
      await quiet(() => s.propose());
      const w = await quiet(() => s.accept());
      assert.ok(w.kind === "written", `expected written, got ${w.kind}`);
      assert.deepEqual(w.files, ["story.json"]);

      const sc = await quiet(() => loadStory(dir));
      assert.equal(sc.characters[1].goal, "Get the log off the rock.");
      assert.equal(sc.scenes.length, 2);
      assert.equal(await readFile(join(dir, "chapters", "1.md"), "utf8"), prose);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("puts back exactly what was there when the re-authored story does not load", async () => {
    const dir = await storyOnDisk();
    try {
      const before = await readFile(join(dir, "story.json"), "utf8");
      const s = session(dir, [{ edits: [{ field: "remove_character", value: "ASTER" },
                                        { field: "remove_character", value: "BRAE" }] }]);
      await quiet(() => s.propose());
      const r = await quiet(() => s.accept());
      assert.ok(r.kind === "unloadable", `expected unloadable, got ${r.kind}`);
      assert.match(r.error, /character/i);
      assert.equal(await readFile(join(dir, "story.json"), "utf8"), before,
                   "a story that already worked must survive a handoff that does not");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("openNextChapter", () => {
  const storyJson = () => renderStory(normalizeSpec(STORY).spec, { default: "none" })["story.json"];

  it("refuses a story with no chapters written — there is nothing to hand off from", async () => {
    const dir = await mkdtemp(join(tmpdir(), "handoff-"));
    try {
      await writeFile(join(dir, "story.json"), storyJson(), "utf8");
      await assert.rejects(() => openNextChapter(SCAFFOLD_DEFAULTS, dir), /nothing for the handoff to read/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("opens on the story as authored, at the chapter after the last written", async () => {
    const dir = await mkdtemp(join(tmpdir(), "handoff-"));
    try {
      await writeFile(join(dir, "story.json"), storyJson(), "utf8");
      await mkdir(join(dir, "chapters"), { recursive: true });
      for (const n of [1, 2]) await writeFile(join(dir, "chapters", `${n}.md`), `chapter ${n}\n`, "utf8");
      const s = await openNextChapter(SCAFFOLD_DEFAULTS, dir);
      assert.equal(s.chapter, 3);
      assert.equal(s.spec.title, "The Fog Signal");
      assert.deepEqual(s.spec.characters.map(c => c.name), ["ASTER", "BRAE"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
