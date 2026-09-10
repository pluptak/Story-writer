/**
 * NextChapterSession tests — the handoff application, editing, and style presets.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadStory, type Defaults,
} from "../engine/story-format.ts";
import { normalizeSpec, applyEdits, renderStory } from "../engine/story-spec.ts";
import * as P from "../prompts.ts";
import { ScaffoldSession, NextChapterSession, openNextChapter, suggestEdits, buildArchitect } from "../engine/architect.ts";
import { architectNextChapter } from "../prompts.ts";
import { Agent } from "../engine/agent.ts";
import { quiet, quietSync, ScriptedAgent } from "./helpers.ts";

// -- SCAFFOLD SUPPORT -------------------------------------------------------
const SCAFFOLD_DEFAULTS: Defaults = {
  models: { default: "none", architect: "none", assistant: "none" },
  thinking: { architect: "low", assistant: "low" },
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

describe("NextChapterSession", () => {
  const spec = normalizeSpec(STORY).spec;
  const written = [{ n: 1, text: "The signal never fired, and Aster wrote that it did." }];
  const handoff = (script: unknown[], s = spec, dir = "data/stories/doorway") =>
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
    assert.deepEqual((r as { applied: { field: string }[] }).applied.map(a => a.field), ["removed scene 2"]);
    assert.match((r as { ignored: string[] }).ignored.join(" "), /remove_scene 1 . chapter 1 is already written/);
    assert.equal(s.spec.scenes.length, 1);
    assert.equal(s.spec.scenes[0].question, spec.scenes[0].question);
  });

  it("refuses to edit scene_1.question when chapter 1 is already written", async () => {
    const s = handoff([{ edits: [{ field: "scene_1.question", value: "Did Aster confess?" }] }]);
    const before = structuredClone(s.spec);
    const r = await quiet(() => s.propose());
    assert.equal(r.kind, "edits");
    assert.equal((r as { applied: unknown[] }).applied.length, 0);
    assert.match((r as { ignored: string[] }).ignored.join(" "), /scene_1\.question . chapter 1 is already written/);
    assert.equal(s.spec.scenes[0].question, before.scenes[0].question);
  });

  it("passes trimmed continuity flags separately from applied edits and problems", async () => {
    const s = handoff([{ flags: ["  prose contradicts the fact bible.  ", "the cast knows too much", 42, "   "], edits: [
      { field: "characters.ASTER.goal", value: "Get off the rock." },
    ] }]);
    const r = await quiet(() => s.propose());
    assert.equal(r.kind, "edits");
    assert.deepEqual((r as { flags: string[] }).flags, ["prose contradicts the fact bible.", "the cast knows too much"]);
    assert.deepEqual((r as { applied: { field: string }[] }).applied.map(a => a.field), ["ASTER.goal"]);
    assert.deepEqual(s.problems, []);
  });

  it("refuses to edit bare scene.place when chapter 1 is already written", async () => {
    const s = handoff([{ edits: [{ field: "scene.place", value: "the rock" }] }]);
    const before = structuredClone(s.spec);
    const r = await quiet(() => s.propose());
    assert.equal(r.kind, "edits");
    assert.equal((r as { applied: unknown[] }).applied.length, 0);
    assert.match((r as { ignored: string[] }).ignored.join(" "), /scene\.place . chapter 1 is already written/);
    assert.equal(s.spec.scenes[0].place, before.scenes[0].place);
  });

  it("refuses to edit bracketed scene[0].place when chapter 1 is already written", async () => {
    const s = handoff([{ edits: [{ field: "scene[0].place", value: "the rock" }] }]);
    const before = structuredClone(s.spec);
    const r = await quiet(() => s.propose());
    assert.equal(r.kind, "edits");
    assert.equal((r as { applied: unknown[] }).applied.length, 0);
    assert.match((r as { ignored: string[] }).ignored.join(" "), /scene_1\.place . chapter 1 is already written/);
    assert.equal(s.spec.scenes[0].place, before.scenes[0].place);
  });

  it("accepts scene_2 field edits when preparing chapter 2 with an existing scene 2", async () => {
    const two = quietSync(() => applyEdits(spec, { edits: [{ field: "add_scene", value: { question: "And then?" } }] })).spec;
    const s = handoff([{ edits: [{ field: "scene_2.question", value: "What happens next?" }] }], two);
    const r = await quiet(() => s.propose());
    assert.equal(r.kind, "edits");
    assert.deepEqual((r as { applied: { field: string }[] }).applied.map(a => a.field), ["scene_2.question"]);
    assert.deepEqual((r as { ignored: string[] }).ignored, []);
    assert.equal(s.spec.scenes[1].question, "What happens next?");
  });

  it("keeps legitimate edits and drops only the refused scene field edits", async () => {
    const s = handoff([{ edits: [
      { field: "characters.ASTER.goal", value: "Escape the lighthouse." },
      { field: "scene_1.place", value: "the rock" },
    ] }]);
    const r = await quiet(() => s.propose());
    assert.equal(r.kind, "edits");
    assert.deepEqual((r as { applied: { field: string }[] }).applied.map(a => a.field), ["ASTER.goal"]);
    assert.match((r as { ignored: string[] }).ignored.join(" "), /scene_1\.place . chapter 1 is already written/);
    assert.equal(s.spec.characters[0].goal, "Escape the lighthouse.");
    assert.equal(s.spec.scenes[0].place, spec.scenes[0].place, "scene 1 place is unchanged");
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
    const s = handoff([{ ask: "How long is chapter 2?" }, { edits: [{ field: "characters.ASTER.goal", value: "Reveal the truth." }] }]);
    await s.propose();
    const r = await quiet(() => s.say("about the same"));
    assert.equal(r.kind, "edits");
    assert.match(s.architect.history[2].content, /\[CHANGE\] about the same/);
    assert.equal(s.spec.characters[0].goal, "Reveal the truth.");
    assert.equal(s.pendingAsk, "");
  });

  it("feeds the last round's refused edits into the next change round, and clears them once clean", async () => {
    // The handoff's propose() runs fill-gaps and verify after its edits round; each consumes a reply.
    const s = handoff([{ edits: [{ field: "scene_1.place", value: "the rock" }] },
                       { edits: [] }, { edits: [] },
                       { edits: [{ field: "characters.ASTER.goal", value: "Confess." }] },
                       { edits: [] }]);
    const first = await quiet(() => s.propose());
    assert.match((first as { ignored: string[] }).ignored.join(" "), /already written/);

    await s.say("try again");
    const users = () => s.architect.history.filter(m => m.role === "user").map(m => m.content);
    assert.match(users().at(-1)!, /\[REFUSED LAST TIME\]/);
    assert.match(users().at(-1)!, /scene_1\.place — chapter 1 is already written/);

    const second = await quiet(() => s.say("and now something clean"));
    assert.equal(second.kind, "edits");
    assert.doesNotMatch(users().at(-1)!, /\[REFUSED LAST TIME\]/);
  });

  it("reports a reply that is neither edits nor a question, and a round that fails", async () => {
    const s = handoff([{ note: "thinking about it" }]);
    assert.equal((await s.propose()).kind, "nothing");
    assert.equal(s.edited, false);
    assert.equal((await s.say("well?")).kind, "failed");   // the script is spent, so the call throws
  });

  it("takes a reply written entirely in words as the architect asking", async () => {
    // Not JSON.stringify'd: the point is a model that never produced an object at all.
    const s = new NextChapterSession(new ScriptedAgent(["Which scene should I fill the details for?"]),
                                     SCAFFOLD_DEFAULTS, "data/stories/doorway", spec, written);
    const r = await s.propose();
    assert.equal(r.kind, "question");
    assert.equal(s.pendingAsk, "Which scene should I fill the details for?");
  });

  it("targets the chapter being prepared when filling gaps and verifying, not an earlier scene", async () => {
    const s = handoff([{ edits: [{ field: "characters.ASTER.goal", value: "Get off the rock." }] },
                       { edits: [] }, { edits: [] }]);
    assert.equal(s.chapter, 2);
    await s.propose();
    const fillGapsPrompt = s.architect.history[2].content;
    assert.match(fillGapsPrompt, /scene_2\.roster/);
    assert.doesNotMatch(fillGapsPrompt, /scene_1\.roster/);
    const verifyPrompt = s.architect.history[4].content;
    // The verify prompt no longer names scene_2.roster: the roster/sense reach checks are mechanical
    // now (in normalizeSpec). It still targets the chapter being prepared via the I5 bullet.
    assert.match(verifyPrompt, /scene_2\.place/);
  });

  it("refuses a fill-gaps edit that would rewrite the already-written chapter's scene", async () => {
    const two = quietSync(() => applyEdits(spec, { edits: [{ field: "add_scene", value: { question: "And then?" } }] })).spec;
    const s = handoff([
      { edits: [{ field: "characters.ASTER.goal", value: "Get off the rock." }] },
      { edits: [{ field: "scene_1.roster", value: ["ASTER"] },
                { field: "scene_2.roster", value: ["ASTER", "BRAE"] }] },
      { edits: [] },
    ], two);
    const r = await s.propose();
    assert.equal(r.kind, "edits");
    const auto = (r as { auto?: { stage: string; applied: { field: string }[]; ignored: string[] }[] }).auto;
    const fillGaps = auto?.[0];
    assert.deepEqual(fillGaps?.applied.map(a => a.field), ["scene_2.roster"]);
    assert.match(fillGaps?.ignored.join(" ") ?? "", /scene_1\.roster . chapter 1 is already written/);
    assert.deepEqual((r as { applied: { field: string }[] }).applied.map(a => a.field), ["ASTER.goal"],
                     "pass 1's legitimate edit still lands");
  });

  it("keeps edited true when an automatic pass has to ask, since pass 1's edits already landed", async () => {
    const s = handoff([
      { edits: [{ field: "characters.ASTER.goal", value: "Get off the rock." }] },
      { ask: "Is Brae also in this scene?" },
    ]);
    const r = await s.propose();
    assert.equal(r.kind, "question");
    assert.equal(s.pendingAsk, "Is Brae also in this scene?");
    assert.equal(s.edited, true);
    assert.equal(s.spec.characters[0].goal, "Get off the rock.", "pass 1's edit is not rolled back");
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
  // A story with one world beat aimed at chapter 2, so sidecar entries resolve to a ledger row.
  const storyJsonWithBeat = () => renderStory(normalizeSpec({
    ...STORY,
    timeline: [{ chapter: 2, hold: "the panel going into alarm", fired: "The sounder takes over.", at: 0.45 }],
  }).spec, { default: "none" })["story.json"];

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

  // The sidecar the run writes beside a chapter it could not spend all its beats in. It is the only
  // record of a beat that never fired: nothing is in the prose, and the chapter's own snapshot says
  // what was aimed there, not what happened.
  it("picks up each chapter's unfired world events and carries them into the round", async () => {
    const dir = await mkdtemp(join(tmpdir(), "handoff-"));
    try {
      await writeFile(join(dir, "story.json"), storyJsonWithBeat(), "utf8");
      await mkdir(join(dir, "chapters"), { recursive: true });
      for (const n of [1, 2]) await writeFile(join(dir, "chapters", `${n}.md`), `chapter ${n}\n`, "utf8");
      await writeFile(join(dir, "chapters", "2.unfired.json"),
        JSON.stringify([{ beat: "The sounder takes over.", at: 0.45 }]), "utf8");

      const s = await openNextChapter(SCAFFOLD_DEFAULTS, dir);
      // No .beats.json: a chapter from before outcomes shipped. The unfired sidecar still speaks,
      // exactly like the old prompt did, but now carrying the resolved beat index.
      assert.deepEqual(s.stranded, [{ beatIndex: 1, chapter: 2, text: "The sounder takes over.", at: 0.45 }]);
      assert.deepEqual(s.firedBeats, []);
      assert.deepEqual(s.autoVoids, []);
      assert.match(architectNextChapter(s.spec.premise, "{}", s.chapters, s.stranded, s.firedBeats),
                   /beat 1 \(chapter 2, set for 0\.45 of the way in\): "The sounder takes over\."/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("carries nothing when a chapter left no sidecar, and survives one that will not parse", async () => {
    const dir = await mkdtemp(join(tmpdir(), "handoff-"));
    try {
      await writeFile(join(dir, "story.json"), storyJson(), "utf8");
      await mkdir(join(dir, "chapters"), { recursive: true });
      await writeFile(join(dir, "chapters", "1.md"), "chapter 1\n", "utf8");
      await writeFile(join(dir, "chapters", "1.unfired.json"), "{ not json", "utf8");
      const s = await openNextChapter(SCAFFOLD_DEFAULTS, dir);
      assert.deepEqual(s.stranded, [], "a broken sidecar must not cost the handoff its opening");
      assert.deepEqual(s.firedBeats, []);
      assert.deepEqual(s.autoVoids, []);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("leaves the worked example out of the handoff agent, which the scaffold agent still carries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "handoff-"));
    try {
      await writeFile(join(dir, "story.json"), storyJson(), "utf8");
      await mkdir(join(dir, "chapters"), { recursive: true });
      await writeFile(join(dir, "chapters", "1.md"), "chapter 1\n", "utf8");
      const s = await openNextChapter(SCAFFOLD_DEFAULTS, dir);
      const scaffolding = await buildArchitect(SCAFFOLD_DEFAULTS);

      assert.ok(scaffolding.system.includes("A WORKED EXAMPLE"),
                "the scaffold has no story yet, so it needs the format demonstrated");
      assert.ok(!s.architect.system.includes("A WORKED EXAMPLE"),
                "the handoff sends the real story every round; the example is the format said twice");
      assert.ok(s.architect.system.length < scaffolding.system.length);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

// -- STATELESS SUGGEST -------------------------------------------------------
describe("suggestEdits", () => {
  const spec = normalizeSpec(STORY).spec;

  it("applies the edits the architect proposed", async () => {
    const orig = Agent.prototype.generate;
    Agent.prototype.generate = async () => JSON.stringify(
      { edits: [{ field: "scene.question", value: "Does Aster sign the false log?" }], ask: "", note: "" });
    try {
      const r = await suggestEdits(SCAFFOLD_DEFAULTS, spec, "sharpen the question");
      assert.equal(r.kind, "edits");
      assert.deepEqual((r as { applied: { field: string }[] }).applied.map(a => a.field), ["scene.question"]);
    } finally { Agent.prototype.generate = orig; }
  });

  it("takes a reply written entirely in words as the architect asking", async () => {
    const orig = Agent.prototype.generate;
    Agent.prototype.generate = async () => "Which scene should I fill the details for?";
    try {
      const r = await suggestEdits(SCAFFOLD_DEFAULTS, spec, "fill the details for scene");
      assert.equal(r.kind, "question");
      assert.equal((r as { ask: string }).ask, "Which scene should I fill the details for?");
    } finally { Agent.prototype.generate = orig; }
  });

  it("still fails a reply that produced JSON of the wrong shape", async () => {
    const orig = Agent.prototype.generate;
    Agent.prototype.generate = async () => JSON.stringify({ note: "an edits object, not a list" });
    try {
      const r = await suggestEdits(SCAFFOLD_DEFAULTS, spec, "do the thing");
      assert.equal(r.kind, "failed");
      assert.match((r as { error: string }).error, /neither edits nor a question/);
    } finally { Agent.prototype.generate = orig; }
  });
});

// -- WHAT THE ARCHITECT IS TOLD ABOUT THE SCENE QUESTION --------------------
// The question reaches the writer's system prompt verbatim, so a question naming a world event
// hands the writer the timeline through the back door — it opens the scene with the event already
// underway, which is obedience rather than error. Both authoring surfaces have to say so.
describe("the scene question names stakes, not mechanisms", () => {
  for (const [surface, text] of [
    ["the one-shot format", P.ARCHITECT_FORMAT],
    ["the staged scene stage", P.architectSceneStage("(the story so far)")],
  ] as const) {
    it(`${surface} forbids a question that names an event the scene has not reached`, () => {
      assert.match(text, /NAME THE STAKES, NOT THE MECHANISM/);
      assert.match(text, /never what the world is about to do/);
      assert.match(text, /already\s+underway/);
    });
  }
});

// -- THE HANDOFF AND THE WORLD-EVENT LEDGER --------------------------------
// A beat that never fired leaves no trace in the prose, so the architect cannot read it off the
// chapter the way it reads everything else. It arrives carrying its resolved beat_<n> index.
describe("stranded world events in the handoff", () => {
  const CH = [{ n: 1, text: "Chapter one prose." }];
  const stranded = [{ beatIndex: 2, chapter: 1, text: "The wing evacuation sounder takes over.", at: 0.45 }];

  it("names each stranded beat with its beat number, chapter and trigger", () => {
    const t = P.architectNextChapter("A depot.", "{}", CH, stranded);
    assert.match(t, /\[STRANDED WORLD EVENTS]/);
    assert.match(t, /beat 2 \(chapter 1, set for 0\.45 of the way in\): "The wing evacuation sounder takes over\."/);
  });

  it("tells the architect not to look for it in the prose", () => {
    const t = P.architectNextChapter("A depot.", "{}", CH, stranded);
    assert.match(t, /none of them is anywhere in the prose/);
    assert.match(t, /a beat aimed at a written chapter can never fire/);
  });

  it("offers re-aim and void, and prefers void to removal", () => {
    const t = P.architectNextChapter("A depot.", "{}", CH, stranded);
    assert.match(t, /Re-aim it: beat_<n>\.chapter/);
    assert.match(t, /beat_<n>\.state "void"/);
    assert.match(t, /Prefer void\./);
  });

  it("says nothing at all when no beat was stranded", () => {
    const t = P.architectNextChapter("A depot.", "{}", CH);
    assert.doesNotMatch(t, /STRANDED WORLD EVENTS/);
    assert.doesNotMatch(t, /never fire/);
  });

  it("lists the ledger's edit fields either way — a beat may be edited without being stranded", () => {
    for (const t of [P.architectNextChapter("A depot.", "{}", CH),
                     P.architectNextChapter("A depot.", "{}", CH, stranded)]) {
      assert.match(t, /beat_<n>\.chapter/);
      assert.match(t, /beat_<n>\.memories/);
      assert.match(t, /remove_beat/);
    }
  });
});

// -- FIRED WORLD EVENTS IN THE HANDOFF --------------------------------------
// The architect already reads every chapter's full prose, so its one-shot reply also judges
// fired beats — since a contradicted beat can then be caught (revise), not just a stranded one.
describe("fired world events in the handoff", () => {
  const CH = [{ n: 1, text: "Chapter one prose." }];
  const fired = [{ beatIndex: 5, chapter: 2, text: "The alarm sounds.", at: 0.45 }];

  it("names each fired beat with its beat number, chapter and trigger, and asks for both judgments", () => {
    const t = P.architectNextChapter("A depot.", "{}", CH, [], fired);
    assert.match(t, /\[FIRED WORLD EVENTS TO CHECK]/);
    assert.match(t, /beat 5 \(chapter 2, fired at 0\.45 of the way in\): "The alarm sounds\."/);
    assert.match(t, /whether it's still possible/);
    assert.match(t, /whether the question it served is still live/);
    assert.match(t, /Judge only the\nbeats listed/);
  });

  it("tells the architect to author the replacement in the same reply when contradicted and live", () => {
    const t = P.architectNextChapter("A depot.", "{}", CH, [], fired);
    assert.match(t, /beat_<n>\.hold \/ beat_<n>\.fired \/ beat_<n>\.memories/);
  });

  it("carries beat_checks in the reply schema", () => {
    const t = P.architectNextChapter("A depot.", "{}", CH, [], fired);
    assert.match(t, /"beat_checks": \[\{"beat": 5, "possible": true, "questionLive": true/);
  });

  it("says nothing at all when no beat fired", () => {
    const t = P.architectNextChapter("A depot.", "{}", CH);
    assert.doesNotMatch(t, /FIRED WORLD EVENTS TO CHECK/);
    // The reply schema still names the field — a stable format, like edits/flags/ask/note —
    // with omit-when-unlisted as its instruction.
    assert.match(t, /Omit it \(or send \[\]\) when no fired beats are listed/);
  });
});

// -- MECHANICAL BEAT REPAIR --------------------------------------------------
// Stranded beats no longer ride into the prompt as prose for the model to guess re-aim vs.
// void over: openNextChapter adjudicates them, voids apply silently in round 1, and only
// re-aim candidates reach the architect.
describe("mechanical beat repair", () => {
  const storyJsonWithChapterOneBeat = () => renderStory(normalizeSpec({
    ...STORY,
    timeline: [{ chapter: 1, hold: "the panel going into alarm", fired: "The sounder takes over.", at: 0.45 }],
  }).spec, { default: "none" })["story.json"];

  async function chapterOneWith(outcome: unknown): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "handoff-"));
    await writeFile(join(dir, "story.json"), storyJsonWithChapterOneBeat(), "utf8");
    await mkdir(join(dir, "chapters"), { recursive: true });
    await writeFile(join(dir, "chapters", "1.md"), "chapter 1\n", "utf8");
    await writeFile(join(dir, "chapters", "1.unfired.json"),
      JSON.stringify([{ beat: "The sounder takes over.", at: 0.45 }]), "utf8");
    await writeFile(join(dir, "chapters", "1.beats.json"), JSON.stringify(outcome), "utf8");
    return dir;
  }

  it("auto-applies void in round 1 for a stranded beat whose question settled", async () => {
    const dir = await chapterOneWith(
      { judged: true, doneFlagged: false, doneFlaggedWhy: "", fired: [] });
    try {
      const s = await openNextChapter(SCAFFOLD_DEFAULTS, dir);
      assert.deepEqual(s.autoVoids, [{ field: "beat_1.state", value: "void" }]);
      assert.deepEqual(s.stranded, [], "a voided beat never reaches the prompt at all");

      // The model's own reply is empty: the void must come from the adjudication, not from it.
      const agent = new ScriptedAgent([{ edits: [] }, { edits: [] }, { edits: [] }].map(x => JSON.stringify(x)));
      const t = new NextChapterSession(agent, SCAFFOLD_DEFAULTS, dir, s.spec, s.chapters,
                                       s.stranded, s.firedBeats, s.autoVoids);
      const r = await quiet(() => t.propose());
      assert.equal(r.kind, "edits");
      assert.ok((r as { applied: { field: string }[] }).applied.some(a => a.field === "beat_1.state"));
      assert.equal(t.spec.timeline[0].state, "void");
      assert.doesNotMatch(agent.history[0].content, /STRANDED WORLD EVENTS/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("re-aims, never voids, when the judge left the question live", async () => {
    // The direction that matters: doneFlagged means the judge thinks the question is NOT
    // answered (still live). The naive negation would silently void most ordinary stranded
    // beats — every chapter that closed cleanly — so this gets its own explicit case.
    const dir = await chapterOneWith(
      { judged: true, doneFlagged: true, doneFlaggedWhy: "neither of them has moved off the door", fired: [] });
    try {
      const s = await openNextChapter(SCAFFOLD_DEFAULTS, dir);
      assert.deepEqual(s.autoVoids, []);
      assert.deepEqual(s.stranded,
        [{ beatIndex: 1, chapter: 1, text: "The sounder takes over.", at: 0.45 }]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("defaults an unjudged chapter to live — never silently drops a beat", async () => {
    const dir = await chapterOneWith(
      { judged: false, doneFlagged: false, doneFlaggedWhy: "", fired: [] });
    try {
      const s = await openNextChapter(SCAFFOLD_DEFAULTS, dir);
      assert.deepEqual(s.autoVoids, []);
      assert.equal(s.stranded.length, 1, "unjudged re-aims rather than voids");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

// -- FIRED-BEAT JUDGMENT ------------------------------------------------------
// The one-shot reply also judges fired beats: a contradicted beat with a live question is
// caught (revise), not silently ignored.
describe("fired-beat judgment", () => {
  const specWithBeat = () => normalizeSpec({
    ...STORY,
    timeline: [{ chapter: 1, hold: "the panel going into alarm", fired: "The alarm sounds.", at: 0.45 }],
  }).spec;
  const fired = [{ beatIndex: 1, chapter: 1, text: "The alarm sounds.", at: 0.45 }];
  const session = (script: unknown[]) =>
    new NextChapterSession(new ScriptedAgent(script.map(x => JSON.stringify(x))),
                           SCAFFOLD_DEFAULTS, "data/stories/doorway",
                           specWithBeat(), [{ n: 1, text: "Chapter one prose." }], [], fired);

  it("flags a contradicted live beat the reply did not re-author", async () => {
    const s = session([
      { edits: [], beat_checks: [{ beat: 1, possible: false, questionLive: true, why: "the door was sealed shut" }] },
      { edits: [] }, { edits: [] },
    ]);
    const r = await quiet(() => s.propose());
    assert.equal(r.kind, "edits");
    assert.match((r as { flags: string[] }).flags.join("\n"), /beat 1 \(chapter 1\) fired as "The alarm sounds\."/);
    assert.match((r as { flags: string[] }).flags.join("\n"), /contradicts/);
    assert.match((r as { flags: string[] }).flags.join("\n"), /the door was sealed shut/);
  });

  it("stays quiet when the same round already authored the replacement", async () => {
    const s = session([
      { edits: [{ field: "beat_1.fired", value: "The alarm shrieks through a broken grille." }],
        beat_checks: [{ beat: 1, possible: false, questionLive: true, why: "the door was sealed shut" }] },
      { edits: [] }, { edits: [] },
    ]);
    const r = await quiet(() => s.propose());
    assert.equal(r.kind, "edits");
    assert.deepEqual((r as { flags: string[] }).flags, [], "the model did its job — nothing to escalate");
  });

  it("takes no action when the beat is uncontradicted or its question settled", async () => {
    for (const check of [{ beat: 1, possible: true, questionLive: true },
                         { beat: 1, possible: false, questionLive: false }]) {
      const s = session([{ edits: [], beat_checks: [check] }, { edits: [] }, { edits: [] }]);
      const r = await quiet(() => s.propose());
      assert.equal(r.kind, "edits");
      assert.deepEqual((r as { flags: string[] }).flags, []);
      assert.deepEqual((r as { ignored: string[] }).ignored, []);
    }
  });

  it("ignores a judgment for a beat that was never listed, or one without both verdicts", async () => {
    const s = session([
      { edits: [], beat_checks: [{ beat: 9, possible: false, questionLive: true },
                                 { beat: 1, possible: false }] },
      { edits: [] }, { edits: [] },
    ]);
    const r = await quiet(() => s.propose());
    assert.equal(r.kind, "edits");
    assert.deepEqual((r as { flags: string[] }).flags, []);
    assert.match((r as { ignored: string[] }).ignored.join("\n"), /beat_checks beat 9 — no such fired beat/);
    assert.match((r as { ignored: string[] }).ignored.join("\n"), /beat_checks beat 1 — "possible" and "questionLive"/);
  });
});

// -- STYLE PRESET HANDLING ---------------------------------------------------
describe("style preset feature", () => {
  const STORY_STAGE = {
    title: "Test Story",
    premise: "A test premise",
    tension: "Character A wants X; Character B wants Y",
    facts: [],
  };
  const CAST_STAGE = { characters: STORY.characters };
  const TECHNICAL_STAGE = {
    config: { maxSteps: 24 },
  };
  const SCENE_STAGE = { scene: STORY.scene };

  describe("architectSettingsStage prompts", () => {
    it("without a preset, asks for both writer_style and writer_style_constraints", () => {
      const text = P.architectSettingsStage("{}");
      assert.match(text, /"writer_style": "\.\.\."/);
      assert.match(text, /writer_style_constraints/);
      assert.doesNotMatch(text, /\[THE VOICE THE AUTHOR CHOSE\]/);
    });

    it("with a preset, contains the preset name and voice, asks for constraints only, not style", () => {
      const preset = { name: "Close third", voice: "Third person, past tense." };
      const text = P.architectSettingsStage("{}", preset);
      assert.match(text, /\[THE VOICE THE AUTHOR CHOSE\]/);
      assert.match(text, /Close third/);
      assert.match(text, /Third person, past tense\./);
      assert.match(text, /writer_style_constraints/);
      assert.doesNotMatch(text, /"writer_style": "\.\.\."/);
      assert.match(text, /The voice above is SETTLED/);
      assert.match(text, /it is not yours to rewrite/);
    });
  });

  describe("staged session with style preset", () => {
    const stage = (script: unknown[], newJudge: () => ScriptedAgent = () => new ScriptedAgent([JSON.stringify({ ok: true })])) =>
      new ScaffoldSession(new ScriptedAgent(script.map(s => JSON.stringify(s))),
                            SCAFFOLD_DEFAULTS, "test idea", undefined, "staged", newJudge);

    it("reverts a different writer_style sent by the architect, and notes it", async () => {
      const SETTINGS_WITH_SENT_STYLE = {
        writer_style: "First person, present tense.",
        writer_style_constraints: [],
      };
      const s = stage([STORY_STAGE, CAST_STAGE, SETTINGS_WITH_SENT_STYLE, TECHNICAL_STAGE, SCENE_STAGE,
                       { edits: [], note: "verified" }, // verify pass
                       { timeline: [] }]); // world stage
      s.style = { id: "preset1", name: "Close third", voice: "Third person, past tense." };

      await s.propose();
      // approve() advances to the next gate AND runs it, so the settings round is the second one.
      // A third would run "technical", whose own visibleProblems would wipe this note.
      await s.approve(); // -> cast
      const settingsRound = await s.approve(); // -> settings
      assert.equal(settingsRound.kind, "proposal");
      assert.equal(s.spec.writerStyle, "Third person, past tense.", "the preset voice is kept, not the sent one");
      assert.match(s.problems.join(" "), /the architect rewrote the voice/);
      assert.match(s.problems.join(" "), /Close third/);
    });

    it("does not add a revert note when no writer_style is sent", async () => {
      const SETTINGS_NO_STYLE = {
        writer_style_constraints: ["prose shows only what the POV character sees"],
      };
      const s = stage([STORY_STAGE, CAST_STAGE, SETTINGS_NO_STYLE, TECHNICAL_STAGE, SCENE_STAGE,
                       { edits: [], note: "verified" },
                       { timeline: [] }]);
      s.style = { id: "preset1", name: "Close third", voice: "Third person, past tense." };

      await s.propose();
      // approve() advances to the next gate AND runs it, so the settings round is the second one.
      // A third would run "technical", whose own visibleProblems would wipe this note.
      await s.approve(); // -> cast
      const settingsRound = await s.approve(); // -> settings
      assert.equal(settingsRound.kind, "proposal");
      assert.equal(s.spec.writerStyle, "Third person, past tense.", "the preset voice is still set");
      // No revert note when architect never sent a different voice
      assert.doesNotMatch(s.problems.join(" "), /architect rewrote the voice/);
    });

    it("accepts a settings reply with only writer_style_constraints as a real proposal, not empty", async () => {
      const SETTINGS_CONSTRAINTS_ONLY = {
        writer_style_constraints: [],
      };
      const s = stage([STORY_STAGE, CAST_STAGE, SETTINGS_CONSTRAINTS_ONLY, TECHNICAL_STAGE, SCENE_STAGE,
                       { edits: [], note: "verified" },
                       { timeline: [] }]);
      s.style = { id: "preset1", name: "Close third", voice: "Third person, past tense." };

      await s.propose();
      // approve() advances to the next gate AND runs it, so the settings round is the second one.
      // A third would run "technical", whose own visibleProblems would wipe this note.
      await s.approve(); // -> cast
      const settingsRound = await s.approve(); // -> settings
      assert.equal(settingsRound.kind, "proposal", "constraints-only reply is a valid proposal");
      assert.equal(s.stage, "settings", "the settings gate is the one that ran");
      assert.equal(s.spec.writerStyle, "Third person, past tense.");
      assert.deepEqual(s.spec.writerStyleConstraints, []);
    });
  });

  describe("staged session without style preset", () => {
    const stage = (script: unknown[]) =>
      new ScaffoldSession(new ScriptedAgent(script.map(s => JSON.stringify(s))),
                            SCAFFOLD_DEFAULTS, "test idea", undefined, "staged",
                            () => new ScriptedAgent([JSON.stringify({ ok: true })]));

    it("lands writer_style_constraints from the settings reply on the spec", async () => {
      const SETTINGS_WITH_BOTH = {
        writer_style: "Third person, past tense.",
        writer_style_constraints: ["prose knows only what POV can see", "no weather as metaphor"],
      };
      const s = stage([STORY_STAGE, CAST_STAGE, SETTINGS_WITH_BOTH, TECHNICAL_STAGE, SCENE_STAGE,
                       { edits: [], note: "verified" },
                       { timeline: [] }]);
      // No style preset

      await s.propose();
      await s.approve(); // story -> cast
      await s.approve(); // cast -> settings
      await s.approve(); // settings -> technical
      await s.approve(); // technical -> scene
      await s.approve(); // scene -> world

      assert.deepEqual(s.spec.writerStyleConstraints,
                      ["prose knows only what POV can see", "no weather as metaphor"]);
    });

    it("trims and filters blank constraints", async () => {
      const SETTINGS_WITH_BLANKS = {
        writer_style: "Third person.",
        writer_style_constraints: ["  ", "a real constraint  ", "", "another  "],
      };
      const s = stage([STORY_STAGE, CAST_STAGE, SETTINGS_WITH_BLANKS, TECHNICAL_STAGE, SCENE_STAGE,
                       { edits: [], note: "verified" },
                       { timeline: [] }]);
      // No style preset

      await s.propose();
      await s.approve(); // story -> cast
      await s.approve(); // cast -> settings

      assert.equal(s.spec.writerStyle, "Third person.");
      assert.deepEqual(s.spec.writerStyleConstraints, ["a real constraint", "another"]);
    });
  });
});

// -- THE SCAFFOLD'S OWN EDIT SURFACE ---------------------------------------
// A gate the author can refine is a gate whose field names the architect has been told. The world
// gate shipped without them: every refinement round came back as {"field": "timeline"} -- the only
// spelling the world stage teaches -- and was ignored as unknown.
describe("the [CHANGE] field list covers every collection applyEdits accepts", () => {
  const system = P.architectSystem({}, {}, "");

  it("names the world-event ledger", () => {
    assert.match(system, /beat_<n>\.chapter/);
    assert.match(system, /beat_<n>\.memories/);
    assert.match(system, /add_beat/);
    assert.match(system, /remove_beat/);
  });

  it("names the story facts", () => {
    assert.match(system, /add_fact/);
    assert.match(system, /remove_fact/);
    assert.match(system, /fact_<n>/);
  });

  it("steers toward the additive beat fields over resending the ledger whole", () => {
    assert.match(system, /Reach for add_beat and beat_<n>\s+before resending "timeline" whole/);
  });
});
