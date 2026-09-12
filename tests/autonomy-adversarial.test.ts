/** Adversarial end-to-end test of the Autonomous Character architecture.
 *
 *  One scripted scene, no models. The setup is deliberately hostile to character autonomy:
 *
 *  - the architect knows a future world event (west-wing fault alarm) and the timeline holds it;
 *  - the writer-facing framing foreshadows that event (premise names it — the recorded
 *    architect-side debt, asserted here as architect-owned, not compensated elsewhere);
 *  - MERRITT is `remote` over the phone line while RIVEN stands in the room;
 *  - RIVEN gets a situation apparently about door-vigil and answers with an unanticipated fork
 *    (takes the ferry keys and walks to the yard gate — abandoning the door the scene orbits);
 *  - MERRITT holds ledger knowledge RIVEN does not, and vice versa;
 *  - the writer is handed every temptation: a fan-out that would read the room to the phone,
 *    and a judge it might hope overrules RIVEN's walkout.
 *
 *  Nothing here asserts a narrative outcome — only which standing each answer, beat, and payload
 *  ends up in. WORLD controls what happens; CHARACTER controls what it means and does; the WRITER
 *  describes the result; the ARCHITECT owns its framing leak at its own layer.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadStory } from "../engine/story-format.ts";
import {
  newCharacterAgent, sceneReach, scenePresence, writeScene, type RunEvent,
} from "../engine/scene-loop.ts";
import { TimelineDef } from "../engine/story-schema.ts";
import { adjudicateChapter } from "../engine/world-repair.ts";
import { ENGINE } from "../engine/engine-state.ts";
import { LIVE, armRun, resetLive } from "../live.ts";
import { quiet, siteFetch, sceneRun } from "./helpers.ts";

const S1 = "You stand beside the steel service door with your palm flat on its cold face. "
  + "Your satchel hangs heavy off your shoulder and the corridor lamp buzzes above you without pause.";
const SHARED = "The service door shudders in its frame as a deep metallic clang rolls down "
  + "the corridor toward you both.";
const S3 = "You hear Riven's voice crackle through the phone line, thin and clipped, as somewhere "
  + "far behind him a dull metallic clang rings out and dies.";
const RIVEN_KNOWS = "The yard gate code changed at midnight.";
const MERRITT_KNOWS = "Head office audits the ledger on Mondays.";
const PREMISE = "A night corridor where a fault alarm will empty the west wing before the crate is settled.";
const HOLD = "the panel going into alarm";
const FIRED = "the fault alarm starts in the west wing";

describe("adversarial autonomy run", () => {
  async function runIt() {
    const sc = await quiet(() => loadStory("tests/fixtures/doorway"));
    sc.premise = PREMISE;
    sc.characters.find(c => c.name === "RIVEN")!.knows = RIVEN_KNOWS;
    sc.characters.find(c => c.name === "MERRITT")!.knows = MERRITT_KNOWS;
    const sd = { ...sc.scenes[0], presence: { MERRITT: "remote :: the phone line" } };
    const beat = TimelineDef.parse({
      chapter: 1, hold: HOLD, fired: FIRED, at: 0.5,
      memories: { RIVEN: "the cage key log ties your name to the wing" },
    });
    const agents = new Map(sc.characters.map(c =>
      [c.name.toLowerCase(),
        newCharacterAgent(c, sd.place, "low", sceneReach(sd, c), scenePresence(sd, c) ?? undefined)] as const));

    const events: RunEvent[] = [];
    let writerCall = 0;
    const writerReplies: Record<string, unknown>[] = [
      { prose: "Cold air moves under the service door while the corridor lamp keeps buzzing.",
        consult: { character: "RIVEN", situation: S1 }, scene_done: false },
      { prose: "Dust drifts down through the lamplight beside the steel door.",
        consult: { reactors: [{ name: "RIVEN" }, { name: "MERRITT" }], situation: SHARED },
        scene_done: false },
      { prose: "The lamp keeps buzzing over the steel door.",
        consult: { character: "MERRITT", situation: S3 }, scene_done: false },
      { prose: "The corridor settles back into its cold quiet.", scene_done: true },
    ];
    // One site, two characters, call order: RIVEN's fork first, MERRITT's answer second. The
    // refused fan-out between them must not cost any character call.
    const characterReplies: Record<string, unknown>[] = [
      { thought: "They can keep their timetable.",
        speech: "No. I am done waiting on this door.",
        action: "She takes the ferry keys from her pocket and walks toward the yard gate, leaving the service door shut.",
        note: "" },
      { thought: "That clang is not mine to chase.",
        speech: "Stay where you are. I am listening.",
        action: "He stays on the line, pen poised over the ledger.",
        note: "" },
    ];
    let characterCall = 0, judgeCall = 0;
    const judgeReplies: Record<string, unknown>[] = [{ verdict: "accept" }, { verdict: "accept" }];
    const { fetchMock, messagesOf, count } = siteFetch({
      "judge.narration": { ok: true },
      "judge.answer": () => judgeReplies[Math.min(judgeCall++, 1)],
      "judge.batch": { verdicts: [] },
      "judge.done": { ok: false, why: "the door question stands open on the last line" },
      "character.consult": () => characterReplies[characterCall++],
      "writer.draft": () => writerReplies[Math.min(writerCall++, 3)],
      "writer.redraft": () => writerReplies[Math.min(writerCall++, 3)],
    });

    const origFetch = globalThis.fetch;
    const origStream = ENGINE.stream;
    ENGINE.stream = false;
    globalThis.fetch = fetchMock;
    armRun();
    try {
      const r = await quiet(() => writeScene(sceneRun(sc, {
        scene: sd, agents, premise: sc.premise, maxSteps: 10,
        timeline: [beat], log: e => events.push(e),
      })));
      return { r, events, sc, sd, beat, writer: LIVE.writer, messagesOf, count };
    } finally {
      globalThis.fetch = origFetch;
      ENGINE.stream = origStream;
      armRun();
      resetLive();
    }
  }

  it("1+2+3. an unanticipated fork is taken, judged usable, and stands — no re-ask", async () => {
    const { events, writer, count } = await runIt();
    const accepts = events.filter(e => e.t === "accept");
    assert.equal(accepts.length, 2, "both answers accepted");
    assert.equal((accepts[0] as any).character, "RIVEN");
    assert.match((accepts[0] as any).speech, /done waiting on this door/,
      "the fork the situation never named is on the record as given");
    assert.ok(!events.some(e => e.t === "retry"),
      "the judge never retried the walkout — inconvenience is not contradiction");
    assert.equal(count("character.consult"), 2, "nobody was re-asked onto the planned path");
    const heard = (writer?.history ?? []).map(m => String(m.content)).join("\n");
    assert.match(heard, /done waiting on this door/,
      "the writer holds the answer it did not anticipate — it has no reject path");
  });

  it("6. presence refuses the room read to the phone, and the attempt costs no answer", async () => {
    const { events, count } = await runIt();
    const bad = events.filter(e => e.t === "bad_consult");
    assert.equal(bad.length, 1, "exactly the shared-text fan-out is refused");
    assert.match((bad[0] as any).why, /MERRITT/);
    assert.match((bad[0] as any).why, /the phone line/);
    assert.equal(count("character.consult"), 2,
      "the refused fan-out reached no character — MERRITT answered only the later projected ask");
  });

  it("4+8. repair and inference stay on their own sides of the choice", async () => {
    const { events, beat } = await runIt();
    // The walkout strands the unfired beat with pressure still live (done flagged unanswered):
    // the ledger re-aims. The standing is harness-declared from the run record — fired/ended are
    // read off events, question-liveness off the done verdict — no character data enters.
    const fired = events.some(e => e.t === "world_beat");
    const live = events.some(e => e.t === "done_flagged");
    const out = adjudicateChapter([beat], 1, () => ({
      fired, landed: null, possible: true, questionLive: live, ended: true,
    }));
    assert.deepEqual(out[0].repair, { op: "re-aim", toChapter: 2, cause: "stranded" });
    // And had the walkout made the beat impossible instead, the same seam voids it — still with
    // no character content in the decision.
    const preempted = adjudicateChapter([beat], 1, () => ({
      fired: false, landed: null, possible: false, questionLive: true, ended: true,
    }));
    assert.deepEqual(preempted[0].repair, { op: "void", cause: "preempted" });
    for (const o of [out[0].repair, preempted[0].repair]) {
      const json = JSON.stringify(o);
      assert.ok(!/RIVEN|MERRITT|retry|believe|suspect|intend|conclude/.test(json),
        `a repair op directs no one: ${json}`);
    }
    // 5. nothing forced anyone back: no retries, no capped ceilings, no re-asks.
    assert.ok(!events.some(e => e.t === "retry" || e.t === "retry_capped"));
    const end = events.find(e => e.t === "scene_end") as any;
    assert.deepEqual(end.retries, {}, "no character spent a single retry");
  });

  it("7. hidden world information reaches nobody it was not given to", async () => {
    const { events, messagesOf } = await runIt();
    assert.ok(!events.some(e => e.t === "world_beat"), "the beat never fired");
    assert.ok(!events.some(e => e.t === "memory_surfaced"), "so no memory implanted");
    const charJoined = [0, 1].map(n => messagesOf("character.consult", n).join("\n")).join("\n---\n");
    assert.ok(!charJoined.includes(FIRED), "the fired form is in no character payload");
    assert.ok(!charJoined.includes(HOLD), "nor is the held form");
    assert.ok(!charJoined.includes("[HOLD]") && !charJoined.includes("[WORLD]"));
    // Asymmetric knowledge does not cross either: neither ask carries the other's knows.
    const rivenAsk = messagesOf("character.consult", 0).join("\n");
    const merrittAsk = messagesOf("character.consult", 1).join("\n");
    assert.ok(!rivenAsk.includes(MERRITT_KNOWS), "MERRITT's ledger knowledge is not in RIVEN's ask");
    assert.ok(!merrittAsk.includes(RIVEN_KNOWS), "RIVEN's gate knowledge is not in MERRITT's ask");
  });

  it("8. inference stays character-owned: no need was spent, no note required", async () => {
    const { events } = await runIt();
    assert.ok(!events.some(e => e.t === "need" || e.t === "clarify" || e.t === "repair"),
      "MERRITT read the clang off the line and RIVEN read the door off the room — both answered outright");
    for (const a of events.filter(e => e.t === "answer")) assert.equal((a as any).note, "");
  });

  it("9. [HOLD] contains the writer; it never enters the character boundary", async () => {
    const { messagesOf } = await runIt();
    const writerJoined = messagesOf("writer.draft", 0).join("\n");
    assert.match(writerJoined, /\[HOLD\]/, "the writer is told what not to start — containment");
    assert.match(writerJoined, new RegExp(HOLD));
    const charJoined = [0, 1].map(n => messagesOf("character.consult", n).join("\n")).join("\n---\n");
    assert.ok(!charJoined.includes(HOLD), "the hold is not projected, translated, or enforced character-side");
    // The judge that accepted the fork is blind to the plan it supposedly broke.
    const judgeJoined = messagesOf("judge.answer", 0).join("\n");
    assert.ok(!judgeJoined.includes(FIRED) && !judgeJoined.includes(HOLD),
      "the verdict cannot prefer the planned direction — it never saw it");
  });

  it("10. premise foreshadow sits in the writer system, not in any consult payload", async () => {
    const { messagesOf, sd } = await runIt();
    const writerSystem = messagesOf("writer.draft", 0)[0] ?? "";
    assert.match(writerSystem, /fault alarm will empty/,
      "the architect's foreshadowing reaches the writer verbatim — architect-owned surface");
    for (const n of [0, 1]) {
      const charAll = messagesOf("character.consult", n).join("\n");
      assert.ok(!charAll.includes("fault alarm will empty"),
        `character payload ${n} carries no premise foreshadow`);
      assert.ok(!charAll.includes("THE PREMISE"));
      assert.ok(!charAll.includes(sd.question),
        `character payload ${n} carries no scene question — nothing downstream compensates`);
    }
  });
});
