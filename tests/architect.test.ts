/**
 * Architect tests — story scaffolding and the chapter handoff. The routes driving them are covered
 * in scaffold-routes.test.ts.
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
import { architectNextChapter, architectVerify } from "../prompts.ts";
import * as P from "../prompts.ts";
import { ScaffoldSession, NextChapterSession, openNextChapter, buildArchitect, suggestEdits } from "../engine/architect.ts";
import { Agent } from "../engine/agent.ts";
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
                         "characters.<NAME>.persona", "scene_<n>.place", "scene_<n>.reach"])
      assert.ok(p.includes(field), `the handoff must name ${field}`);
    assert.match(p, /scene_3\.place/);       // re-author the scene the story already has
    assert.match(p, /add_scene/);            // or add it when it does not
  });

  it("says reach never travels: last chapter's grants are gone unless the new place re-offers them", () => {
    const p = architectNextChapter("A premise.", spec, chapters);
    assert.match(p, /reach never travels with a person|is gone now; reach never travels/);
    assert.match(p, /scene_3\.reach/, "the re-grant path is named concretely");
  });

  it("counts one written chapter in the singular", () => {
    const p = architectNextChapter("A premise.", spec, [chapters[0]]);
    assert.match(p, /Chapter 1 of this story is written/);
    assert.match(p, /Prepare chapter 2\./);
  });
});

describe("architectVerify: reach rules", () => {
  const specJson = JSON.stringify({
    title: "Dark", characters: [{ name: "AURA" }],
    scenes: [{ place: "the lobby", roster: ["AURA"], reach: { AURA: ["cameras :: seeing through the feed"] } }],
  });

  it("asks whether reach names an interface or a sense, and what establishes it", () => {
    const p = architectVerify(specJson, "scene_1");
    // reach-to-non-roster is now a mechanical check in normalizeSpec, not a model prompt bullet
    assert.ok(!/reach granted to someone who is not in scene_1\.roster/.test(p));
    assert.match(p, /named after the SENSE it substitutes for/);
    assert.match(p, /neither scene_1\.place nor "facts" ever establishes/);
    // I5 stays a judgement call for the model, never a mechanical refusal
    assert.match(p, /This one is a judgement/);
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
                                     SCAFFOLD_DEFAULTS, "stories/doorway", spec, written);
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
      await writeFile(join(dir, "story.json"), storyJson(), "utf8");
      await mkdir(join(dir, "chapters"), { recursive: true });
      for (const n of [1, 2]) await writeFile(join(dir, "chapters", `${n}.md`), `chapter ${n}\n`, "utf8");
      await writeFile(join(dir, "chapters", "2.unfired.json"),
        JSON.stringify([{ beat: "The sounder takes over.", at: 0.45 }]), "utf8");

      const s = await openNextChapter(SCAFFOLD_DEFAULTS, dir);
      assert.deepEqual(s.unfired, [{ n: 2, beat: "The sounder takes over.", at: 0.45 }]);
      assert.match(architectNextChapter(s.spec.premise, "{}", s.chapters, s.unfired),
                   /chapter 2, set for 0\.45 of the way in: The sounder takes over\./);
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
      assert.deepEqual(s.unfired, [], "a broken sidecar must not cost the handoff its opening");
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
// chapter the way it reads everything else. It arrives as its own list or not at all.
describe("stranded world events in the handoff", () => {
  const CH = [{ n: 1, text: "Chapter one prose." }];
  const beat = { n: 1, beat: "The wing evacuation sounder takes over.", at: 0.45 };

  it("names each unfired beat with the chapter and trigger it was waiting on", () => {
    const t = P.architectNextChapter("A depot.", "{}", CH, [beat]);
    assert.match(t, /\[WORLD EVENTS THAT NEVER HAPPENED]/);
    assert.match(t, /chapter 1, set for 0\.45 of the way in: The wing evacuation sounder takes over\./);
  });

  it("tells the architect not to look for it in the prose", () => {
    const t = P.architectNextChapter("A depot.", "{}", CH, [beat]);
    assert.match(t, /none of them is anywhere in the prose/);
    assert.match(t, /a beat aimed at a written chapter can never fire/);
  });

  it("offers re-aim and void, and prefers void to removal", () => {
    const t = P.architectNextChapter("A depot.", "{}", CH, [beat]);
    assert.match(t, /Re-aim it: beat_<n>\.chapter/);
    assert.match(t, /beat_<n>\.state "void"/);
    assert.match(t, /Prefer void\./);
  });

  it("says nothing at all when no beat was stranded", () => {
    const t = P.architectNextChapter("A depot.", "{}", CH);
    assert.doesNotMatch(t, /WORLD EVENTS THAT NEVER HAPPENED/);
    assert.doesNotMatch(t, /never fire/);
  });

  it("lists the ledger's edit fields either way — a beat may be edited without being stranded", () => {
    for (const t of [P.architectNextChapter("A depot.", "{}", CH),
                     P.architectNextChapter("A depot.", "{}", CH, [beat])]) {
      assert.match(t, /beat_<n>\.chapter/);
      assert.match(t, /beat_<n>\.memories/);
      assert.match(t, /remove_beat/);
    }
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

  it("says the schema's own timeline key is not an edit field", () => {
    assert.match(system, /"timeline" is not one of these\s+names/);
  });
});
