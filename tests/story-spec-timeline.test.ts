/**
 * Story spec tests — viewing, editing, and validating the world-event timeline.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadStory } from "../engine/story-format.ts";
import { normalizeSpec, applyEdits, specView, sceneDrift, timelineDrift, timelineBeatProblems, timelineOrderProblems, renderStory, type SceneDef } from "../engine/story-spec.ts";
import { StoryJson } from "../engine/story-schema.ts";
import { quiet, quietSync } from "./helpers.ts";

describe("specView against the story schema", () => {
  // The new-story editor validates its draft with the strict StoryJson schema. specView carries two
  // shapes the schema rejects — `scene` as an alias for scenes[0], and skills split into
  // {text, meaning} — and the editor's scaffoldStory() reconciles them. When it did not drop
  // `scene`, every check failed with `Unrecognized key: "scene"` and the write button went dead on
  // the first edit with nothing on screen to say why. This pins the contract that fix relies on.
  const spec = normalizeSpec({
    title: "Doorway", premise: "A corridor at 3am.", writer_style: "Plain.",
    scene: { place: "Behind Kessel's", question: "Does she get in?", pov: "RIVEN", length: 700,
             roster: ["RIVEN"] },
    characters: [{ name: "RIVEN", persona: "A courier.", knows: "The code changed.", goal: "Get in.",
                   belief: "Doors open.", impulse: "when stopped → talk", voice: ["Let me in."],
                   skills: ["lockpicking"], restrictions: ["sight"] }],
  }).spec;

  /** story-edit.js scaffoldStory(), which is the only reconciliation between the two shapes. */
  const asEditorDraft = () => {
    const d: any = JSON.parse(JSON.stringify(specView(spec)));
    delete d.scene;
    d.characters = d.characters.map((c: any) => ({
      ...c,
      skills: (c.skills || []).map((s: any) =>
        typeof s === "string" ? s : [s.text, s.meaning].filter(Boolean).join(" :: ")),
    }));
    return d;
  };

  it("carries a `scene` alias the schema rejects, so the editor has to drop it", () => {
    const raw = StoryJson.safeParse(JSON.parse(JSON.stringify(specView(spec))));
    assert.equal(raw.success, false, "specView is a view, not a story.json");
    assert.match(raw.error!.issues.map(i => i.message).join(" "), /scene/);
  });

  it("validates once the editor has reconciled it", () => {
    const r = StoryJson.safeParse(asEditorDraft());
    assert.equal(r.success, true,
                 `the new-story draft must validate as loaded: ${JSON.stringify(r.error?.issues)}`);
  });

  it("still validates after the edits an author actually makes", () => {
    const d = asEditorDraft();
    d.characters[0].restrictions = [];             // the edit from the bug report
    d.characters[0].skills = [];
    d.scenes[0].roster = [];
    assert.equal(StoryJson.safeParse(d).success, true,
                 "clearing a list field must not invalidate the draft");
  });
});

describe("sceneDrift", () => {
  const base: SceneDef = { place: "A room", question: "Does she leave?", pov: "MAYA", length: 700, roster: ["MAYA", "IVAN"], reach: {}, presence: {} };

  it("returns [] for identical scenes", () => {
    const after: SceneDef = { place: "A room", question: "Does she leave?", pov: "MAYA", length: 700, roster: ["MAYA", "IVAN"], reach: {}, presence: {} };
    assert.deepEqual(sceneDrift(base, after), []);
  });

  it("returns a changed question", () => {
    const after: SceneDef = { ...base, question: "Does she stay?" };
    assert.deepEqual(sceneDrift(base, after), ["question"]);
  });

  it("returns multiple changed fields in stable order", () => {
    const after: SceneDef = { place: "Outside", question: "Does she leave?", pov: "IVAN", length: 800, roster: ["MAYA", "IVAN"], reach: {}, presence: {} };
    assert.deepEqual(sceneDrift(base, after), ["place", "pov", "length"]);
  });

  it("ignores roster reordering", () => {
    const after: SceneDef = { ...base, roster: ["IVAN", "MAYA"] };
    assert.deepEqual(sceneDrift(base, after), []);
  });

  it("detects an added name in the roster", () => {
    const after: SceneDef = { ...base, roster: ["MAYA", "IVAN", "LARS"] };
    assert.deepEqual(sceneDrift(base, after), ["roster"]);
  });

  it("returns [] when either side is undefined", () => {
    assert.deepEqual(sceneDrift(undefined, base), []);
    assert.deepEqual(sceneDrift(base, undefined), []);
    assert.deepEqual(sceneDrift(undefined, undefined), []);
  });

  it("detects a change in length as a number", () => {
    const after: SceneDef = { ...base, length: 850 };
    assert.deepEqual(sceneDrift(base, after), ["length"]);
  });

  it("ignores whitespace differences in strings", () => {
    const after: SceneDef = { place: "  A room  ", question: "  Does she leave?  ", pov: "  MAYA  ", length: 700, roster: ["MAYA", "IVAN"], reach: {}, presence: {} };
    assert.deepEqual(sceneDrift(base, after), []);
  });
});

// -- TIMELINE (the world-event ledger) ---------------------------------------
describe("timeline", () => {
  const base = {
    title: "Alarm", premise: "A wing under a fault alarm.",
    scene: { place: "the corridor", question: "Who answers the alarm?", length: 700 },
    characters: [
      { name: "HALE", persona: "Holds the contract.", knows: "The cage key.", belief: "Paperwork rules.", impulse: "when pressed → procedural", voice: ["Read me the log."], restrictions: ["sight"] },
      { name: "ODUYA", persona: "Owns the ledger.", knows: "Head office.", belief: "Exceptions cost.", impulse: "when doubted → cite policy", voice: ["Sign first."] },
    ],
  };
  const beat = {
    chapter: 1, hold: "the panel going into alarm", fired: "the fault alarm sounds",
    memories: { HALE: "the wing is insured on occupancy" },
  };

  it("normalizes a well-formed ledger with its defaults, and complains about nothing", () => {
    const { spec, problems } = normalizeSpec({ ...base, timeline: [beat] });
    assert.deepEqual(problems, []);
    assert.equal(spec.timeline.length, 1);
    assert.equal(spec.timeline[0].at, 0.45);
    assert.equal(spec.timeline[0].state, "pending");
  });

  it("reports a memory keyed to nobody and a beat aimed past the last scene, keeping both", () => {
    const { spec, problems } = normalizeSpec({
      ...base,
      timeline: [{ ...beat, memories: { HAIL: "typo" }, chapter: 9 }],
    });
    assert.equal(spec.timeline.length, 1, "a string-checkable problem is reported, never dropped");
    const joined = problems.join(" ");
    assert.match(joined, /memory to "HAIL"/);
    assert.match(joined, /chapter 9, past the story's last scene/);
  });

  it("drops a malformed beat and names the field that failed", () => {
    const { spec, problems } = normalizeSpec({
      ...base, timeline: [{ chapter: 1, hold: "the alarm" }, beat],
    });
    assert.equal(spec.timeline.length, 1, "the malformed entry costs itself, not the ledger");
    assert.equal(spec.timeline[0].fired, beat.fired);
    assert.match(problems.join(" "), /timeline beat 1/);
  });

  it("survives an edit round: applyEdits round-trips a ledger it has no edits for", () => {
    const { spec } = normalizeSpec({ ...base, timeline: [beat] });
    const r = applyEdits(spec, { edits: [{ field: "title", value: "Alarm, revised" }] });
    assert.deepEqual(r.spec.timeline, [{ ...beat, at: 0.45, memories: beat.memories, state: "pending" }]);
    assert.deepEqual(r.ignored, []);
  });

  it("renders into story.json, and omits the field entirely when the ledger is empty", () => {
    const models = { default: "m" };
    const withBeat = JSON.parse(renderStory(normalizeSpec({ ...base, timeline: [beat] }).spec, models)["story.json"]);
    assert.deepEqual(withBeat.timeline, [{ ...beat, at: 0.45, memories: beat.memories, state: "pending" }]);

    const without = JSON.parse(renderStory(normalizeSpec(base).spec, models)["story.json"]);
    assert.equal("timeline" in without, false, "no timeline field on stories that never had one");
  });

  it("renders a ledger a load will accept — normalize and renderStory agree about the shape", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      await writeFile(join(dir, "story.json"), renderStory(normalizeSpec({ ...base, timeline: [beat] }).spec, { default: "m" })["story.json"], "utf8");
      const sc = await quiet(() => loadStory(dir));
      assert.equal(sc.timeline.length, 1);
      assert.equal(sc.timeline[0].hold, beat.hold);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("renders a specView the schema still accepts once the editor drops its aliases", () => {
    const spec = normalizeSpec({ ...base, timeline: [beat] }).spec;
    const d: any = JSON.parse(JSON.stringify(specView(spec)));
    delete d.scene;
    d.characters = d.characters.map((c: any) => ({
      ...c,
      skills: (c.skills || []).map((s: any) =>
        typeof s === "string" ? s : [s.text, s.meaning].filter(Boolean).join(" :: ")),
    }));
    const r = StoryJson.safeParse(d);
    assert.equal(r.success, true, `the editor draft must validate: ${JSON.stringify(r.error?.issues)}`);
    assert.equal(r.success && r.data.timeline.length, 1);
  });

  it("reports a memory keyed to a character absent from that chapter's roster", () => {
    const { spec, problems } = normalizeSpec({
      ...base,
      scenes: [
        { place: "scene 1", question: "q1", roster: ["HALE"] },
        { place: "scene 2", question: "q2", roster: ["ODUYA"] },
      ],
      timeline: [{ chapter: 1, hold: "hold", fired: "fired", memories: { ODUYA: "fact" } }],
    });
    assert.equal(spec.timeline.length, 1, "the beat is kept");
    const joined = problems.join(" ");
    assert.match(joined, /ODUYA/);
    assert.match(joined, /chapter 1/);
    assert.match(joined, /roster/);
  });

  it("does not report a memory keyed to a character when the target scene's roster is empty (whole cast)", () => {
    const { spec, problems } = normalizeSpec({
      ...base,
      scenes: [
        { place: "scene 1", question: "q1", roster: [] },  // empty roster = whole cast
      ],
      timeline: [{ chapter: 1, hold: "hold", fired: "fired", memories: { ODUYA: "fact" } }],
    });
    assert.equal(spec.timeline.length, 1);
    const joined = problems.join(" ");
    assert.ok(!joined.includes("roster"), "no roster complaint when roster is empty");
  });

  it("reports both messages only if the character is not in the cast at all", () => {
    const { spec, problems } = normalizeSpec({
      ...base,
      scenes: [{ place: "scene 1", question: "q1", roster: ["HALE"] }],
      timeline: [{ chapter: 1, hold: "hold", fired: "fired", memories: { UNKNOWN: "fact" } }],
    });
    assert.equal(spec.timeline.length, 1);
    const joined = problems.join(" ");
    assert.match(joined, /not one of the characters/);
    assert.ok(!joined.includes("chapter 1's roster"), "no roster message for a character not in the cast");
  });

  it("survives an order check even with beats in different chapters", () => {
    const { spec, problems } = normalizeSpec({
      ...base,
      scenes: [{ place: "s1", question: "q1" }, { place: "s2", question: "q2" }],
      timeline: [
        { chapter: 1, hold: "h", fired: "f", at: 0.6, memories: {} },
        { chapter: 2, hold: "h", fired: "f", at: 0.3, memories: {} },
      ],
    });
    const joined = problems.join(" ");
    assert.ok(!joined.includes("order"), "beats in different chapters are not out of order");
  });
});

describe("timelineBeatProblems", () => {
  const beat = (over: Partial<{ chapter: number; hold: string; fired: string; at: number;
                                memories: Record<string, string>; state: "pending" | "fired" | "void" }> = {}) => ({
    chapter: 1, hold: "the panel going into alarm", fired: "the fault alarm sounds",
    at: 0.45, memories: {}, state: "pending" as const, ...over,
  });
  const cast = ["HALE", "ODUYA", "WREN"];
  const scenes = (...rosters: string[][]) => rosters.map(roster => ({ roster }));

  it("passes a plain beat aimed at a scene that exists", () => {
    assert.deepEqual(timelineBeatProblems("beat 1", beat(), cast, scenes([])), []);
  });

  it("reports a beat aimed past the last scene", () => {
    assert.match(timelineBeatProblems("beat 1", beat({ chapter: 3 }), cast, scenes([], []))[0],
      /aimed at chapter 3, past the story's last scene/);
  });

  // The one check with no test until it silently broke: a curly-quoted beat passed validation for a
  // while because the character class had been normalized to three ASCII quotes.
  for (const [label, text] of [
    ["straight quotes", `The tannoy says "clear the wing" twice.`],
    ["curly quotes", `The tannoy says "clear the wing" twice.`],
  ] as const) {
    it(`flags a fired form carrying ${label}`, () => {
      assert.match(timelineBeatProblems("beat 1", beat({ fired: text }), cast, scenes([])).join(" "),
        /fired form carries quoted speech/);
    });
    it(`flags a held form carrying ${label}`, () => {
      assert.match(timelineBeatProblems("beat 1", beat({ hold: text }), cast, scenes([])).join(" "),
        /held form carries quoted speech/);
    });
  }

  it("reports a memory keyed to a name that is in no chapter at all, and only that", () => {
    const out = timelineBeatProblems("beat 1", beat({ memories: { GHOST: "x" } }), cast, scenes(["HALE"]));
    assert.equal(out.length, 1, "one message, not both");
    assert.match(out[0], /"GHOST", who is not one of the characters/);
  });

  it("reports a memory keyed to a character absent from that chapter's roster", () => {
    const out = timelineBeatProblems("beat 1", beat({ chapter: 2, memories: { WREN: "x" } }),
      cast, scenes(["HALE", "WREN"], ["HALE", "ODUYA"]));
    assert.equal(out.length, 1);
    assert.match(out[0], /"WREN", who is not in chapter 2's roster/);
  });

  it("says nothing when the target scene's roster is empty — that means the whole cast is in it", () => {
    assert.deepEqual(timelineBeatProblems("beat 1", beat({ memories: { WREN: "x" } }), cast, scenes([])), []);
  });
});

describe("timelineOrderProblems", () => {
  it("reports nothing when beats descend across a chapter boundary — each chapter queues alone", () => {
    const beats = [
      { chapter: 1, hold: "h", fired: "f", at: 0.8, memories: {}, state: "pending" as const },
      { chapter: 2, hold: "h", fired: "f", at: 0.2, memories: {}, state: "pending" as const },
    ];
    assert.deepEqual(timelineOrderProblems(beats), []);
  });

  it("reports a descending pair within one chapter", () => {
    const beats = [
      { chapter: 1, hold: "h", fired: "f", at: 0.6, memories: {}, state: "pending" as const },
      { chapter: 1, hold: "h", fired: "f", at: 0.3, memories: {}, state: "pending" as const },
    ];
    const problems = timelineOrderProblems(beats);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /beat 2.*0\.3.*beat 1.*0\.6/);
  });

  it("reports nothing for ascending beats in the same chapter", () => {
    const beats = [
      { chapter: 1, hold: "h", fired: "f", at: 0.3, memories: {}, state: "pending" as const },
      { chapter: 1, hold: "h", fired: "f", at: 0.6, memories: {}, state: "pending" as const },
    ];
    const problems = timelineOrderProblems(beats);
    assert.deepEqual(problems, []);
  });

  it("ignores void beats", () => {
    const beats = [
      { chapter: 1, hold: "h", fired: "f", at: 0.6, memories: {}, state: "void" as const },
      { chapter: 1, hold: "h", fired: "f", at: 0.3, memories: {}, state: "pending" as const },
    ];
    const problems = timelineOrderProblems(beats);
    assert.deepEqual(problems, [], "void beats are not checked for ordering");
  });

  it("reports nothing for equal at values in the same chapter", () => {
    const beats = [
      { chapter: 1, hold: "h", fired: "f", at: 0.5, memories: {}, state: "pending" as const },
      { chapter: 1, hold: "h", fired: "f", at: 0.5, memories: {}, state: "pending" as const },
    ];
    const problems = timelineOrderProblems(beats);
    assert.deepEqual(problems, []);
  });
});

describe("editing the world-event ledger", () => {
  const beat = (over: Record<string, unknown> = {}) => ({
    chapter: 1, hold: "the panel going into alarm", fired: "The alarm takes over the wing.",
    at: 0.45, memories: { RIVEN: "the cage logs who was inside" }, state: "pending" as const, ...over,
  });
  const withLedger = (...beats: Record<string, unknown>[]) => normalizeSpec({
    title: "Doorway", premise: "A corridor at 3am.",
    scene: { place: "Behind Kessel's", question: "Does she get in?", pov: "RIVEN", length: 700 },
    scenes: [{ place: "Behind Kessel's", question: "Does she get in?", pov: "RIVEN", length: 700 },
             { place: "The yard", question: "Does she leave?", pov: "RIVEN", length: 700 }],
    characters: [{ name: "RIVEN", persona: "A courier.", knows: "The code changed.", skills: [], restrictions: [] }],
    timeline: beats,
  }).spec;
  const edit = (spec: any, field: string, value: any) =>
    quietSync(() => applyEdits(spec, { edits: [{ field, value }] }));

  // Re-aiming a stranded beat at the next chapter is what this surface exists for.
  it("re-aims a beat at another chapter", () => {
    const r = edit(withLedger(beat()), "beat_1.chapter", 2);
    assert.equal(r.spec.timeline[0].chapter, 2);
    assert.equal(r.applied[0].before, 1);
    assert.equal(r.applied[0].after, 2);
    assert.deepEqual(r.ignored, []);
  });

  it("voids a beat without removing it, so the ledger still records it was authored", () => {
    const r = edit(withLedger(beat()), "beat_1.state", "void");
    assert.equal(r.spec.timeline[0].state, "void");
    assert.equal(r.spec.timeline.length, 1);
  });

  it("edits the trigger and both forms", () => {
    let s: any = withLedger(beat());
    for (const [f, v] of [["beat_1.at", 0.8], ["beat_1.hold", "nothing yet"], ["beat_1.fired", "It happened."]] as const)
      s = edit(s, f, v).spec;
    assert.equal(s.timeline[0].at, 0.8);
    assert.equal(s.timeline[0].hold, "nothing yet");
    assert.equal(s.timeline[0].fired, "It happened.");
  });

  it("replaces the memory map wholesale, dropping blank names and blank memories", () => {
    const r = edit(withLedger(beat()), "beat_1.memories",
      { RIVEN: "a new one", "  ": "no name", MERRITT: "   " });
    assert.deepEqual(r.spec.timeline[0].memories, { RIVEN: "a new one" });
  });

  it("adds and removes a beat", () => {
    const added = edit(withLedger(beat()), "add_beat", beat({ chapter: 2, fired: "A second event." }));
    assert.equal(added.spec.timeline.length, 2);
    assert.match(added.applied[0].field, /added beat 2/);

    const removed = edit(added.spec, "remove_beat", 1);
    assert.equal(removed.spec.timeline.length, 1);
    assert.equal(removed.spec.timeline[0].fired, "A second event.");
  });

  it("ignores an edit to a beat that is not there, and says which", () => {
    for (const [field, value, why] of [
      ["beat_3.chapter", 2, /beat 3 does not exist/],
      ["remove_beat", 9, /there is no beat 9/],
      ["add_beat", "not an object", /the value must be a beat object/],
    ] as const) {
      const r = edit(withLedger(beat()), field, value);
      assert.match(r.ignored.join(" "), why);
      assert.equal(r.spec.timeline.length, 1, "and nothing changed");
    }
  });
});

describe("timelineDrift", () => {
  const beat = {
    chapter: 1, hold: "the panel going into alarm", fired: "the fault alarm sounds",
    at: 0.45, memories: { HALE: "the wing is insured on occupancy" }, state: "pending" as const,
  };

  it("returns [] for identical ledgers", () => {
    assert.deepEqual(timelineDrift([beat], [{ ...beat }]), []);
  });

  it("returns [] when both sides are empty", () => {
    assert.deepEqual(timelineDrift([], []), []);
  });

  it("names the beat and the field that changed", () => {
    assert.deepEqual(timelineDrift([beat], [{ ...beat, fired: "the fault alarm sounds again" }]),
      ["beat 1 (fired form)"]);
    assert.deepEqual(timelineDrift([beat], [{ ...beat, at: 0.5, memories: { HALE: "other" } }]),
      ["beat 1 (trigger, memories)"]);
  });

  it("ignores state changes — bookkeeping, not what the prose was written from", () => {
    assert.deepEqual(timelineDrift([beat], [{ ...beat, state: "void" }]), []);
  });

  it("is case-insensitive about memory keys and whitespace about values", () => {
    assert.deepEqual(timelineDrift([beat], [{ ...beat, memories: { hale: "  the wing is insured on occupancy  " } }]), []);
  });

  it("detects an added and a removed beat positionally", () => {
    assert.deepEqual(timelineDrift([], [beat]), ["beat 1 added"]);
    assert.deepEqual(timelineDrift([beat], []), ["beat 1 removed"]);
  });

  it("compares each position in order, not as a set", () => {
    const second = { ...beat, chapter: 2, hold: "the second held event", fired: "the second event lands" };
    assert.deepEqual(timelineDrift([beat, second], [second, beat]),
      ["beat 1 (chapter, held form, fired form)", "beat 2 (chapter, held form, fired form)"]);
  });
});
