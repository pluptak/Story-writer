/**
 * ScaffoldSession tests — the new-story interview and its staged checklist. Shared prompts are covered in architect-handoff.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadStory, type Defaults,
} from "../engine/story-format.ts";
import { normalizeSpec, applyEdits } from "../engine/story-spec.ts";
import * as P from "../prompts.ts";
import { ScaffoldSession, type ImportedCharacter } from "../engine/architect.ts";
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
    // The two automatic passes after propose()'s proposal each consume one script entry first.
    const s = scaffold([STORY, { edits: [] }, { edits: [] },
      { edits: [{ field: "scene.length", value: 800 }], note: "shortened the premise", ask: "Colder or warmer?" }]);
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
    // The two automatic passes after propose()'s proposal each consume one script entry first.
    const s = scaffold([STORY, { edits: [] }, { edits: [] }, { edits: [{ field: "scene.length", value: 900 }] }]);
    await s.propose();

    const req = s.request("make it longer");
    assert.match(req, /\[CHANGE\] make it longer/);
    assert.match(req, /\[THE STORY AS IT STANDS\]/);
    assert.match(req, /Reply with edits only/);
    assert.match(req, /The Fog Signal/, "the engine's spec, not the architect's memory of it");

    const r = await s.say("make it longer");
    assert.equal(r.kind, "edits");
    assert.deepEqual((r as { applied: { field: string }[] }).applied.map(a => a.field), ["scene.length"]);
    assert.deepEqual((r as { flags: string[] }).flags, []);
    assert.equal(s.spec.scenes[0].length, 900);
    assert.equal(s.spec.title, "The Fog Signal", "everything not named survived the round");
    assert.equal(s.spec.characters.length, 2);
  });

  it("feeds refused edits into the next refinement round, and stops once they apply cleanly", async () => {
    // The two automatic passes after propose()'s proposal each consume one script entry first.
    const s = scaffold([STORY, { edits: [] }, { edits: [] },
      { edits: [{ field: "scene_1", value: "sharper" }] },          // unknown field — refused
      { edits: [{ field: "scene.length", value: 900 }] },           // applies cleanly, clears the list
      { edits: [] }]);
    await s.propose();
    const bad = await s.say("sharpen scene one");
    assert.equal(bad.kind, "edits");
    assert.match((bad as { ignored: string[] }).ignored.join(" "), /unknown field/);

    const users = () => s.architect.history.filter(m => m.role === "user").map(m => m.content);
    await s.say("make it longer");
    assert.match(users().at(-1)!, /\[REFUSED LAST TIME\]/);
    assert.match(users().at(-1)!, /unknown field "scene_1"/);
    assert.match(users().at(-1)!, /Sending any of them back unchanged/);

    const clean = await s.say("once more");
    assert.equal(clean.kind, "edits");
    assert.doesNotMatch(users().at(-1)!, /\[REFUSED LAST TIME\]/);
  });

  it("changes nothing when the architect asks a question mid-refinement", async () => {
    // The two automatic passes after propose()'s proposal each consume one script entry first.
    const s = scaffold([STORY, { edits: [] }, { edits: [] }, { ask: "Longer how — more beats, or slower ones?" }]);
    await s.propose();
    const before = structuredClone(s.spec);
    const r = await s.say("make it longer");
    assert.equal(r.kind, "question");
    assert.deepEqual(s.spec, before);
    assert.equal(s.pendingAsk, "Longer how — more beats, or slower ones?");
  });

  it("clears the outstanding question once a round answers it", async () => {
    // The two automatic passes after propose()'s proposal each consume one script entry first.
    const s = scaffold([STORY, { edits: [] }, { edits: [] },
      { ask: "Longer how?" }, { edits: [{ field: "scene.length", value: 1200 }] }]);
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

describe("ScaffoldSession automatic fill-gaps/verify passes", () => {
  it("fills roster and facts automatically after a proposal, then verifies them", async () => {
    const s = scaffold([STORY,
      { edits: [{ field: "scene.roster", value: ["ASTER", "BRAE"] },
                { field: "add_fact", value: "The lamp has not gone dark in forty years." }] },
      { edits: [], note: "nothing needed fixing" }]);
    const r = await s.propose();
    assert.equal(r.kind, "proposal");
    assert.deepEqual(s.spec.scenes[0].roster, ["ASTER", "BRAE"]);
    assert.deepEqual(s.spec.facts, ["The lamp has not gone dark in forty years."]);
    const auto = (r as { auto?: { stage: string; outcome: string }[] }).auto;
    assert.deepEqual(auto?.map(a => a.stage), ["fillGaps", "verify"]);
    assert.deepEqual(auto?.map(a => a.outcome), ["edits", "edits"]);   // an empty edits list is still "edits"
  });

  it("aborts the automatic passes and surfaces a question, but keeps the proposal that already landed", async () => {
    const s = scaffold([STORY, { ask: "Is Brae in this scene?" }]);
    const r = await s.propose();
    assert.equal(r.kind, "question");
    assert.equal(s.pendingAsk, "Is Brae in this scene?");
    assert.equal(s.spec.title, "The Fog Signal", "pass 1's proposal survives even though pass 2 had to ask");
  });

  it("keeps the proposal when the fill-gaps and verify passes themselves fail outright", async () => {
    const s = scaffold([STORY]);   // nothing scripted for either automatic pass
    const r = await s.propose();
    assert.equal(r.kind, "proposal");
    const auto = (r as { auto?: { stage: string; outcome: string }[] }).auto;
    assert.deepEqual(auto?.map(a => a.outcome), ["failed", "failed"]);
  });

  it("records a verify pass that found nothing to fix", async () => {
    const s = scaffold([STORY,
      { edits: [{ field: "scene.roster", value: ["ASTER", "BRAE"] }] },
      { note: "looks consistent" }]);
    const r = await s.propose();
    const auto = (r as { auto?: { stage: string; outcome: string }[] }).auto;
    assert.deepEqual(auto?.map(a => a.outcome), ["edits", "nothing"]);
  });

  it("runs the automatic passes when a proposal arrives via say() after a clarifying question, not only via propose()", async () => {
    const s = scaffold([{ ask: "Is this a ghost story or a fraud story?" }, STORY,
      { edits: [{ field: "scene.roster", value: ["ASTER", "BRAE"] }] },
      { edits: [] }]);
    await s.propose();
    const r = await s.say("a fraud story");
    assert.equal(r.kind, "proposal");
    assert.deepEqual(s.spec.scenes[0].roster, ["ASTER", "BRAE"]);
    const auto = (r as { auto?: { stage: string }[] }).auto;
    assert.equal(auto?.length, 2);
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

  it("keeps nothing on disk when the accepted story does not load", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "scaffold-"));
    try {
      const s = scaffold([STORY, { edits: [] }, { edits: [] },
        { edits: [{ field: "premise", value: "" }] }], tmp);
      await s.propose();
      const e = await s.say("empty the premise");
      assert.equal(e.kind, "edits");
      const r = await quiet(() => s.accept());
      assert.ok(r.kind === "unloadable", `expected unloadable, got ${r.kind}`);
      assert.match(r.error, /premise/i);

      const wrote = await readFile(join(tmp, "the-fog-signal", "story.json"), "utf8")
        .then(() => true).catch(() => false);
      assert.equal(wrote, false, "a scaffold whose preflight fails must leave nothing behind");
    } finally { await rm(tmp, { recursive: true, force: true }); }
  });
});

// -- THE STAGED CHECKLIST ---------------------------------------------------
describe("ScaffoldSession, staged", () => {
  const STORY_STAGE = {
    title: STORY.title,
    premise: STORY.premise,
    tension: "Aster wants the log kept honest; Brae wants the night buried.",
    facts: ["The lamp has not gone dark in forty years."],
  };
  const CAST_STAGE = { characters: STORY.characters };
  const SETTINGS_STAGE = { writer_style: STORY.writer_style };
  const TECHNICAL_STAGE = {
    config: { retries: 3, clarifications: 1, maxSteps: 30, maxProseWords: 120,
              thinking: { writer: "medium" }, maxCharacterRetries: 5 },
    characters: [{ name: STORY.characters[0].name, maxRetries: 2 }],
    scenes: [{ writerThink: "high" }],
  };
  const SCENE_STAGE = { scene: STORY.scene, later_scenes: [{ question: "Does the relief boat come?" }] };

  // The cast gate consults a judge, a fresh one per verdict — so the factory hands back a new
  // one-reply ScriptedAgent each time rather than one agent that would run out.
  const judgeSaying = (verdict: unknown) => () => new ScriptedAgent([JSON.stringify(verdict)]);
  const passingJudge = judgeSaying({ ok: true });

  const stage = (script: unknown[], newJudge: () => ScriptedAgent = passingJudge) =>
    new ScaffoldSession(new ScriptedAgent(script.map(s => JSON.stringify(s))),
                        SCAFFOLD_DEFAULTS, "two lighthouse keepers", undefined, "staged", newJudge);
  const gateOf = (r: { kind: string; stage?: string }) => r.stage;

  it("walks the checklist one approved gate at a time, merging as it goes", async () => {
    const s = stage([STORY_STAGE, CAST_STAGE, SETTINGS_STAGE, TECHNICAL_STAGE, SCENE_STAGE,
                     { edits: [], note: "it holds together" }, // verify pass
                     { timeline: [] }]); // world stage

    const first = await s.propose();
    assert.equal(first.kind, "proposal");
    assert.equal(gateOf(first), "story");
    assert.equal(s.spec.title, "The Fog Signal");
    assert.deepEqual(s.spec.facts, ["The lamp has not gone dark in forty years."]);
    assert.equal(s.tension, STORY_STAGE.tension);
    assert.equal(s.haveStory(), false);

    const cast = await s.approve();
    assert.equal(gateOf(cast), "cast");
    assert.equal(s.spec.characters.length, 2);
    assert.equal(s.spec.title, "The Fog Signal", "earlier stages survive the merge");
    assert.equal(s.asks, 0, "passing a gate resets the question budget");

    await s.approve();                                   // settings
    assert.equal(s.spec.writerStyle, SETTINGS_STAGE.writer_style);

    const tech = await s.approve();                      // technical
    assert.equal(gateOf(tech), "technical");
    assert.equal(s.spec.config.retries, 3, "technical config overrides land");
    assert.equal(s.spec.config.maxCharacterRetries, 5);
    assert.equal(s.spec.characters[0].maxRetries, 2, "per-character maxRetries land");
    assert.equal(s.spec.scenes[0].writerThink, "high", "per-scene writerThink lands");

    const scene = await s.approve();
    assert.equal(gateOf(scene), "scene");
    assert.equal(s.spec.scenes[0].question, STORY.scene.question);
    assert.equal(s.spec.scenes[1]?.question, "Does the relief boat come?", "later sketches land as scenes");
    assert.equal(s.spec.scenes[1]?.place, "", "a sketch carries nothing but its question");

    // The verify pass runs after the scene lands; fill-gaps has no job in a staged run.
    assert.deepEqual((scene as { auto?: { stage: string }[] }).auto?.map(a => a.stage), ["verify"]);
    const heard = s.architect.history.map(h => h.content).join("\n");
    assert.match(heard, /\[VERIFY\]/);
    assert.doesNotMatch(heard, /\[FILL\]/);

    const world = await s.approve();
    assert.equal(gateOf(world), "world");
    assert.deepEqual(s.spec.timeline, []);

    const done = await s.approve();
    assert.equal(done.kind, "nothing");
    assert.match((done as { why: string }).why, /review the draft and accept/);
  });

  describe("the cast gate", () => {
    // propose() opens the story gate and the first approve() passes it, landing on cast — so the
    // *next* approve() is the one the gate judges.
    const walkToCast = async (judge: () => ScriptedAgent) => {
      const s = stage([STORY_STAGE, CAST_STAGE, SETTINGS_STAGE], judge);
      await s.propose();
      await s.approve();
      assert.equal(s.stage, "cast");
      return s;
    };

    it("blocks the cast gate when the asymmetry does not bite on the tension", async () => {
      const s = await walkToCast(judgeSaying({ ok: false, why: "neither keeper is kept from the log" }));
      const r = await s.approve();
      assert.equal(r.kind, "blocked");
      assert.equal(gateOf(r), "cast");
      assert.match((r as { why: string }).why, /neither keeper is kept from the log/);
      assert.equal(s.stage, "cast", "a blocked gate does not advance");
      assert.equal(s.spec.writerStyle, "", "and the next stage was never proposed");
    });

    it("carries past a blocked gate on an explicit override", async () => {
      const s = await walkToCast(judgeSaying({ ok: false, why: "nobody is restricted" }));
      assert.equal((await s.approve()).kind, "blocked");
      const forced = await s.approve(undefined, true);
      assert.equal(forced.kind, "proposal");
      assert.equal(s.stage, "settings", "the override passes the gate it was blocked on");
      assert.equal(s.spec.writerStyle, SETTINGS_STAGE.writer_style);
    });

    // Every other model-in-the-loop check in this engine accepts when the call fails; an outage must
    // not stand between an author and the rest of their checklist.
    it("fails open when the judge is unreachable or answers with no verdict", async () => {
      const outage = await walkToCast(() => {
        const a = new ScriptedAgent([]);                 // throws: ran out of replies
        return a;
      });
      assert.equal((await outage.approve()).kind, "proposal", "an outage passes the gate");
      assert.equal(outage.stage, "settings");

      const garbage = await walkToCast(() => new ScriptedAgent(["I could not say."]));
      assert.equal((await garbage.approve()).kind, "proposal", "an unparseable verdict passes too");
      assert.equal(garbage.stage, "settings");
    });

    it("judges the cast gate and no other", async () => {
      let calls = 0;
      const counting = () => { calls++; return new ScriptedAgent([JSON.stringify({ ok: true })]); };
      const s = stage([STORY_STAGE, CAST_STAGE, SETTINGS_STAGE, TECHNICAL_STAGE, SCENE_STAGE,
                       { edits: [], note: "it holds together" }], counting);
      await s.propose();
      for (let i = 0; i < 4; i++) await s.approve();     // cast, settings, technical, scene
      assert.equal(s.stage, "scene", "the whole checklist was walked");
      assert.equal(calls, 1, "only the cast gate consults the judge");
    });

    it("asks the judge about the tension and the cast, and never about the architect's own draft", async () => {
      let seen = "";
      const spy = () => {
        const a = new ScriptedAgent([JSON.stringify({ ok: true })]);
        const orig = a.generate.bind(a);
        a.generate = async (_label?: unknown, _site?: unknown, extra?: { role: string; content: string }[]) => {
          seen = (extra ?? []).map(m => m.content).join("\n");
          return orig();
        };
        return a;
      };
      const s = await walkToCast(spy);
      await s.approve();
      assert.match(seen, /\[THE TENSION\]/);
      assert.match(seen, /Aster wants the log kept honest/, "the tension the story stage coined");
      assert.match(seen, /\[THE CAST\]/);
      assert.match(seen, /restrictions:/, "the cast arrives as a sheet, not as prose");
      assert.doesNotMatch(seen, /premise/i, "the judge is not handed the architect's whole draft");
    });

    it("an imported cast makes an empty character list a real answer", async () => {
      const IVET: ImportedCharacter = {
        libraryId: "lib-ivet", version: 2, name: "IVET",
        portablePersona: "Ex-locksmith, keeps every key on a labelled ring.",
        belief: "Every lock has a polite way in.",
        impulse: "when watched, slow down and narrate the work",
        voice: ["Hold the door? I'd rather hold the lock."],
        skills: ["lockpicking :: opening a mechanical lock without its key"],
        restrictions: ["sight"],
        origin: "",
      };

      const s = new ScaffoldSession(
        new ScriptedAgent([JSON.stringify(STORY_STAGE), JSON.stringify({ characters: [] }), JSON.stringify(SETTINGS_STAGE)]),
        SCAFFOLD_DEFAULTS, "test idea", undefined, "staged",
        () => new ScriptedAgent([JSON.stringify({ ok: true })])
      );
      s.imported = [IVET];
      await s.propose();
      await s.approve();
      assert.equal(s.stage, "cast");

      const r = await s.approve();
      assert.equal(r.kind, "proposal", "an empty character list with imports is content");
      assert.equal(s.stage, "settings", "the gate advanced");
      assert.equal(s.spec.characters.length, 1, "IVET was added from the import");
      assert.equal(s.spec.characters[0].name, "IVET");
    });

    it("without an imported cast, an empty character list is still nothing", async () => {
      const s = new ScaffoldSession(
        new ScriptedAgent([JSON.stringify(STORY_STAGE), JSON.stringify({ characters: [] }), JSON.stringify(SETTINGS_STAGE)]),
        SCAFFOLD_DEFAULTS, "test idea", undefined, "staged",
        () => new ScriptedAgent([JSON.stringify({ ok: true })])
      );
      // imported is not set, stays []
      await s.propose();
      await s.approve();
      assert.equal(s.stage, "cast");

      const r = await s.approve();
      assert.equal(r.kind, "nothing", "an empty character list without imports is nothing");
      assert.equal(s.stage, "cast", "the gate did not advance");
    });
  });

  it("does not report a half-built draft's missing pieces as problems", async () => {
    const s = stage([STORY_STAGE]);
    await s.propose();
    for (const noise of [/no characters at all/, /has no question/, /not one of the characters/])
      assert.ok(!s.problems.some(p => noise.test(p)), `${noise} leaked: ${JSON.stringify(s.problems)}`);
    assert.ok(s.problems.length === 0, `unexpected problems: ${JSON.stringify(s.problems)}`);

    const full = stage([STORY_STAGE, { characters: [{ name: "ASTER" }] }]);
    await full.propose();
    await full.approve();
    assert.ok(full.problems.some(p => /ASTER has no persona/.test(p)),
              "real warnings about a landed stage show verbatim");
  });

  it("a question pins its gate, and the author's answer re-runs that stage", async () => {
    const s = stage([{ ask: "Ghost story or fraud story?" }, STORY_STAGE]);
    const first = await s.propose();
    assert.equal(first.kind, "question");
    assert.equal(gateOf(first), "story");
    assert.equal(s.pendingAsk, "Ghost story or fraud story?");

    const blocked = await s.approve();
    assert.equal(blocked.kind, "nothing");
    assert.match((blocked as { why: string }).why, /answer the architect's question/);
    assert.equal(s.stage, "story", "the gate did not move");

    const second = await s.say("a fraud story");
    assert.equal(second.kind, "proposal");
    assert.equal(s.stage, "story", "the answer re-proposed the same gate");
    assert.equal(s.spec.title, "The Fog Signal");
    assert.match(s.architect.history[2].content, /\[THE AUTHOR ANSWERS\] a fraud story/);
  });

  it("refuses to start the checklist twice", async () => {
    const s = stage([STORY_STAGE]);
    await s.propose();
    const again = await s.propose();
    assert.equal(again.kind, "nothing");
    assert.match((again as { why: string }).why, /already started/);
  });

  it("will not pass a gate whose content never landed", async () => {
    const s = stage([STORY_STAGE, { note: "hm, thinking" }]);
    await s.propose();
    const first = await s.approve();            // the cast round comes back as neither content nor question
    assert.equal(first.kind, "nothing");
    assert.equal(s.stage, "cast");
    const blocked = await s.approve();          // the gate is still empty
    assert.equal(blocked.kind, "nothing");
    assert.match((blocked as { why: string }).why, /"cast" has not landed \(no cast yet\)/);
    assert.equal(s.stage, "cast");
  });

  it("say() refines within the open gate and may reach back to an earlier stage", async () => {
    const s = stage([STORY_STAGE, CAST_STAGE, { edits: [{ field: "premise", value: "Revised premise." }] }]);
    await s.propose();
    await s.approve();
    const r = await s.say("sharpen the premise");
    assert.equal(r.kind, "edits");
    assert.equal(gateOf(r), "cast", "refinement never advances the gate");
    assert.equal(s.spec.premise, "Revised premise.");
    assert.equal(s.spec.characters.length, 2, "the landed cast survived the back-edit");
  });

  it("lets refinement rounds re-coin the tension the story stage named", async () => {
    const s = stage([STORY_STAGE, CAST_STAGE,
      { edits: [{ field: "tension", value: "Brae wants the log kept honest instead." },
                { field: "premise", value: "Revised premise." }] }]);
    await s.propose();
    await s.approve();
    const r = await s.say("swap who wants what");
    assert.equal(r.kind, "edits");
    assert.deepEqual((r as { applied: { field: string }[] }).applied.map(a => a.field), ["tension", "premise"]);
    assert.equal((r as { ignored: string[] }).ignored.join(" "), "", `unexpected ignores`);
    assert.equal(s.tension, "Brae wants the log kept honest instead.");

    // The re-coined tension steers the next stage's prompt.
    await s.approve();
    assert.match(s.architect.history.at(-2)!.content, /Brae wants the log kept honest instead\./);
  });

  it("insists once a gate has asked three times without proposing", async () => {
    const ask = { ask: "Which of the two is it?" };
    const s = stage([ask, ask, ask, STORY_STAGE]);
    assert.equal((await s.propose()).kind, "question");
    await s.say("a");
    await s.say("b");
    const r = await s.say("c");
    assert.equal(r.kind, "proposal");
    assert.match(s.architect.history.at(-2)!.content, /OVERRIDE: you have asked several times/);
    assert.equal(s.asks, 0);
  });

  describe("the world stage", () => {
    const WORLD_WITH_BEAT = {
      timeline: [{
        chapter: 1,
        at: 0.45,
        hold: "the panel is still dark",
        fired: "The alarm on the panel flashed red.",
        memories: { ASTER: "The signal has a fault condition we have never seen." },
      }],
    };

    // The one that proves the wiring rather than the wording: a proposed beat has to survive
    // mergedRaw and normalizeSpec to reach the spec, memories and trigger intact.
    it("folds a proposed beat onto the spec, with its trigger and memories", async () => {
      const s = stage([STORY_STAGE, CAST_STAGE, SETTINGS_STAGE, TECHNICAL_STAGE, SCENE_STAGE,
                       { edits: [], note: "it holds together" }, WORLD_WITH_BEAT]);
      await s.propose();
      for (const _ of ["cast", "settings", "technical", "scene"]) await s.approve();

      const world = await s.approve();
      assert.equal(world.kind, "proposal", "a well-formed beat is content, not nothing");
      assert.equal(gateOf(world), "world");
      assert.equal(s.spec.timeline.length, 1);
      assert.equal(s.spec.timeline[0].fired, "The alarm on the panel flashed red.");
      assert.equal(s.spec.timeline[0].hold, "the panel is still dark");
      assert.equal(s.spec.timeline[0].at, 0.45);
      assert.deepEqual(s.spec.timeline[0].memories,
        { ASTER: "The signal has a fault condition we have never seen." });
    });

    // The one-shot format proposes a whole story in one reply, so it needs the same beat rules the
    // staged gate has. They share one const rather than two copies that drift apart.
    it("the one-shot format offers a timeline and marks it optional", () => {
      assert.match(P.ARCHITECT_FORMAT, /"timeline": \[\]/);
      assert.match(P.ARCHITECT_FORMAT, /timeline\s+-- OPTIONAL, and usually empty/);
    });

    it("both authoring surfaces carry the same beat rules, from one source", () => {
      const staged = P.architectWorldStage("(so far)");
      for (const rule of [/IT NAMES A SPECIFIC COST/, /IT AGREES WITH THE EVENT/,
                          /IT OPENS AN ACTION/, /IT GOES TO WHOEVER MUST MOVE/,
                          /MOST STORIES DO NOT NEED ONE/, /AT MOST ONE PER CHAPTER/,
                          /No dialogue and no quotation marks/]) {
        assert.match(staged, rule, `staged stage is missing ${rule}`);
        assert.match(P.ARCHITECT_FORMAT, rule, `one-shot format is missing ${rule}`);
      }
    });

    it("reports the world stage as stage 6 of 6 in the checklist", () => {
      const text = P.architectWorldStage("(so far)");
      assert.match(text, /stage 6 of 6/);
    });

    it("carries the story-so-far to the world stage", () => {
      const text = P.architectWorldStage("(the story so far)");
      assert.match(text, /\(the story so far\)/);
    });

    it("tells the architect that an empty timeline is a complete and correct answer", () => {
      const text = P.architectWorldStage("(so far)");
      assert.match(text, /MOST STORIES DO NOT NEED ONE/);
      assert.match(text, /"timeline": \[\]/);
    });

    it("lists all four memory constraints: COST, AGREEMENT, ACTION, AUDIENCE", () => {
      const text = P.architectWorldStage("(so far)");
      assert.match(text, /IT NAMES A SPECIFIC COST/);
      assert.match(text, /IT AGREES WITH THE EVENT/);
      assert.match(text, /IT OPENS AN ACTION/);
      assert.match(text, /IT GOES TO WHOEVER MUST MOVE/);
    });

    it("forbids quoted speech in the fired form", () => {
      const text = P.architectWorldStage("(so far)");
      assert.match(text, /No dialogue and no quotation marks/);
    });

    it("checklistLine() now reports six stages", () => {
      const storyText = P.architectStoryStage("idea");
      assert.match(storyText, /stage 1 of 6/);
    });

    it("the imported cast stage states the contract and names the people", () => {
      const IVET: ImportedCharacter = {
        libraryId: "lib-ivet", version: 2, name: "IVET",
        portablePersona: "Ex-locksmith, keeps every key on a labelled ring.",
        belief: "Every lock has a polite way in.",
        impulse: "when watched, slow down and narrate the work",
        voice: ["Hold the door? I'd rather hold the lock."],
        skills: ["lockpicking :: opening a mechanical lock without its key"],
        restrictions: ["sight"],
        origin: "",
      };

      const text = P.architectCastImportStage("p", "t", "{}", [IVET]);
      assert.match(text, /\[THE AUTHOR'S CAST\]/);
      assert.match(text, /IVET/);
      assert.match(text, /Ex-locksmith, keeps every key on a labelled ring\./);
      assert.match(text, /PRESERVE, unchanged/);
      assert.match(text, /RESOLVE for this story/);
      assert.match(text, /COMPOSE the persona/);
      assert.match(text, /DO NOT ADD ANYONE/);
    });

    it("both cast stages document goal and knows from the same source", () => {
      const IVET: ImportedCharacter = {
        libraryId: "lib-ivet", version: 2, name: "IVET",
        portablePersona: "Ex-locksmith, keeps every key on a labelled ring.",
        belief: "Every lock has a polite way in.",
        impulse: "when watched, slow down and narrate the work",
        voice: ["Hold the door? I'd rather hold the lock."],
        skills: ["lockpicking :: opening a mechanical lock without its key"],
        restrictions: ["sight"],
        origin: "",
      };

      const regular = P.architectCastStage("p", "t", "{}");
      const imported = P.architectCastImportStage("p", "t", "{}", [IVET]);

      // Check distinctive phrase from goal doc appears in both
      assert.match(regular, /ZERO-SUM TEST/);
      assert.match(imported, /ZERO-SUM TEST/);

      // Check distinctive phrase from knows doc appears in both
      assert.match(regular, /This is where a scene/);
      assert.match(imported, /This is where a scene/);
    });

    it("the story stage carries the author's tags, and says nothing when there are none", () => {
      assert.doesNotMatch(P.architectStoryStage("idea"), /\[THE TAGS\]/);
      const withTags = P.architectStoryStage("idea", ["survival horror", "bleak"]);
      assert.match(withTags, /\[THE TAGS\]/);
      assert.match(withTags, /survival horror, bleak/);
    });

    it("an empty concept leaves the story stage byte-identical", () => {
      assert.equal(P.architectStoryStage("idea"), P.architectStoryStage("idea", []));
    });

    it("the cast stage names the author's opening cast size only when they chose one", () => {
      assert.doesNotMatch(P.architectCastStage("p", "t", "{}"), /The author asked for/);
      const withSize = P.architectCastStage("p", "t", "{}", 3);
      assert.match(withSize, /The author asked for 3 in/);
      assert.match(withSize, /a target, not a quota/);
    });
  });

  // Refining the open world gate. The architect authors the ledger as {"timeline": [...]}, so a
  // refinement round a turn later reaches for that shape again -- observed live, with a beat
  // correct in every field but the name it arrived under. While that gate is open the shape is
  // the gate's own, so it folds through the stage's merge path rather than being refused.
  describe("refining the open world gate", () => {
    const BEAT = {
      chapter: 1, at: 0.45,
      hold: "the proximity alarm's first chime",
      fired: "A proximity alert blares as an asteroid enters the flight path.",
      memories: { ASTER: "The last rock through this sector took the west module and three people." },
    };
    const walkToWorld = async (...after: unknown[]) => {
      const s = stage([STORY_STAGE, CAST_STAGE, SETTINGS_STAGE, TECHNICAL_STAGE, SCENE_STAGE,
                       { edits: [], note: "it holds together" }, { timeline: [] }, ...after]);
      await s.propose();
      for (let i = 0; i < 5; i++) await s.approve();
      assert.equal(s.stage, "world");
      assert.deepEqual(s.spec.timeline, []);
      return s;
    };

    it("takes a ledger sent as an edit named timeline", async () => {
      const s = await walkToWorld({ edits: [{ field: "timeline", value: [BEAT] }], note: "the asteroid" });
      const r = await s.say("Asteroid incoming");
      assert.equal(r.kind, "proposal");
      assert.equal((r as { stage?: string }).stage, "world");
      assert.equal(s.spec.timeline.length, 1);
      assert.equal(s.spec.timeline[0].fired, BEAT.fired);
      assert.equal(s.spec.timeline[0].memories.ASTER, BEAT.memories.ASTER);
    });

    it("takes a ledger sent in the stage's own top-level shape", async () => {
      const s = await walkToWorld({ timeline: [BEAT] });
      assert.equal((await s.say("Asteroid incoming")).kind, "proposal");
      assert.equal(s.spec.timeline.length, 1);
    });

    it("empties the ledger when the round says the story wants no events after all", async () => {
      const s = await walkToWorld({ edits: [{ field: "timeline", value: [BEAT] }] },
                                  { edits: [{ field: "timeline", value: [] }] });
      await s.say("Asteroid incoming");
      assert.equal(s.spec.timeline.length, 1);
      await s.say("Drop it, the pressure is between them");
      assert.deepEqual(s.spec.timeline, []);
    });

    it("keeps the other edits in a round that changed the ledger and something else", async () => {
      const s = await walkToWorld({ edits: [
        { field: "timeline", value: [BEAT] },
        { field: "title", value: "Ghost in Hull" },
      ] });
      const r = await s.say("Asteroid incoming, and rename it");
      assert.equal(r.kind, "edits");
      assert.equal(s.spec.timeline.length, 1, "the ledger still folded in");
      assert.equal(s.spec.title, "Ghost in Hull", "and the edit beside it applied");
      assert.deepEqual((r as { ignored: string[] }).ignored, []);
    });

    it("leaves every other gate refusing timeline as an unknown field", async () => {
      const s = stage([STORY_STAGE, CAST_STAGE,
                       { edits: [{ field: "timeline", value: [BEAT] }] }]);
      await s.propose();
      await s.approve();
      assert.equal(s.stage, "cast");
      const r = await s.say("Asteroid incoming");
      assert.equal(r.kind, "edits");
      assert.match((r as { ignored: string[] }).ignored.join(" "), /unknown field "timeline"/);
      assert.deepEqual(s.spec.timeline, []);
    });
  });
});
