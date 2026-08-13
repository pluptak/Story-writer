/**
 * Deterministic suite — `npm test` (node --test via tsx). No model calls, ever.
 *
 * Scope: the invariants CODE enforces. Story parsing, skill resolution, config validation, JSON
 * extraction, the consult protocol's control flow (clarification budget, the forced answer, the
 * repair pass, skill flagging), the stop path, and the scaffold interview.
 *
 * The consult and scaffold tests work because `Agent.generate` is an ordinary method on an exported
 * class: a subclass with scripted replies makes the whole protocol testable without a model. What is
 * NOT in here is whether the writer asks good questions or the prose is any good — that is
 * judgement, not an invariant, and it belongs in a live run.
 *
 * Two deliberate exceptions to "nothing but pure functions": `ScaffoldSession.accept` writes into a
 * temp directory (cleaned up), and the pre-flight it then runs makes a localhost model-list request
 * that fails fast when nothing is listening and is never fatal either way.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseStoryMd, splitMeaning, resolveSkills, SKILL_CATALOG,
  num, bool, enumOf, extractJson, balancedObjectEnd, salvageProse, topLevelObjects,
  loadStory, discoverStories, chooseStory, NEW_STORY, consult, wrapCharacter, wrapWriter, Agent,
  normalizeSpec, loadDefaults, applyEdits, renderStory, slugify,
  RUN, stopRun, armRun, StoppedError, complete, selectableStory, ScaffoldSession,
  normalizeConsult, canonWants, CONSULT_WANTS,
  type Skill, type ConsultEvent, type ConsultRequest, type Defaults,
} from "../story-writer.ts";

// Several loaders warn by design; keep the test output readable.
async function quiet<T>(fn: () => Promise<T> | T): Promise<T> {
  const orig = console.warn;
  console.warn = () => {};
  try { return await fn(); } finally { console.warn = orig; }
}
function warnings(fn: () => void): string[] {
  const out: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  try { fn(); } finally { console.warn = orig; }
  return out;
}

// `new URL(...).pathname` is wrong on Windows and this repo's path may contain a space.
const FIXTURE = fileURLToPath(new URL("./fixtures/badstory", import.meta.url));

// -- STORY PARSING ---------------------------------------------------------
describe("parseStoryMd", () => {
  const SRC = `# Title
## Premise
First line.

Second line.
## Scene
place: A corridor
length: 700   # inline comment stripped here
## Characters
### RIVEN
file: riven.md
knows: The code changed # this is NOT a comment, it is prose
### MERRITT
file: merritt.md
lacks: sight
## Config
retries: 2
`;

  it("collects premise prose, section keys and character sub-blocks", () => {
    const p = parseStoryMd(SRC);
    // Paragraph breaks in the premise are KEPT — it is prose the writer reads, and it is what lets
    // a scaffolded story round-trip through story.md unchanged.
    assert.equal(p.premise, "First line.\n\nSecond line.");
    assert.equal(parseStoryMd(`## Premise\n\n\nA.\n\n\n\nB.\n\n\n`).premise, "A.\n\nB.",
                 "runs of blank lines collapse to one, and the ends are trimmed");
    assert.equal(p.kv["scene.place"], "A corridor");
    assert.equal(p.kv["config.retries"], "2");
    assert.equal(p.characters.length, 2);
    assert.deepEqual(p.characters.map(c => c.name), ["RIVEN", "MERRITT"]);
    assert.equal(p.characters[1].lacks, "sight");
  });

  it("strips inline comments in structured sections but never inside a character block", () => {
    const p = parseStoryMd(SRC);
    assert.equal(p.kv["scene.length"], "700");
    assert.equal(p.characters[0].knows, "The code changed # this is NOT a comment, it is prose");
  });

  it("ignores ### headings outside ## Characters", () => {
    const p = parseStoryMd(`## Premise\nx\n## Scene\n### NOT A CHARACTER\nplace: here\n`);
    assert.equal(p.characters.length, 0);
    assert.equal(p.kv["scene.place"], "here");
  });
});

describe("splitMeaning", () => {
  it("splits on the first :: and tolerates a missing meaning", () => {
    assert.deepEqual(splitMeaning("lockpicking :: opening a lock :: really"),
                     { text: "lockpicking", meaning: "opening a lock :: really" });
    assert.deepEqual(splitMeaning("  climbing  "), { text: "climbing", meaning: "" });
  });
});

// -- SKILLS ----------------------------------------------------------------
describe("resolveSkills", () => {
  const names = (s: Skill[]) => s.map(x => x.name);
  const general = Object.keys(SKILL_CATALOG);

  it("gives every general skill when nothing is declared", () => {
    const s = resolveSkills("X", "", "");
    assert.deepEqual(names(s), general);
    assert.ok(s.every(x => x.source === "general" && x.meaning));
  });

  it("removes what a character lacks and adds what the story gives them", () => {
    const s = quietSync(() => resolveSkills("X", "lockpicking :: picking locks | climbing", "sight"));
    assert.ok(!names(s).includes("sight"));
    assert.deepEqual(names(s).slice(-2), ["lockpicking", "climbing"]);
    assert.equal(s.find(x => x.name === "lockpicking")!.meaning, "picking locks");
    assert.equal(s.length, general.length - 1 + 2);
  });

  it("matches names case- and spacing-insensitively so one skill cannot become two", () => {
    const s = quietSync(() => resolveSkills("X", "", "  Sight  "));
    assert.ok(!names(s).includes("sight"));
    const dup = quietSync(() => resolveSkills("X", "Lock Picking | lockpicking", ""));
    assert.equal(dup.filter(x => /lock/i.test(x.name)).length, 1);
  });

  it("warns about a lacks: entry that removes nothing, and keeps going", () => {
    const w = warnings(() => resolveSkills("X", "", "telepathy"));
    assert.equal(w.length, 1);
    assert.match(w[0], /telepathy/);
    assert.equal(resolveSkills("X", "", "telepathy").length, Object.keys(SKILL_CATALOG).length);
  });

  it("warns when a story redeclares a general skill, and the story's wording wins", () => {
    const w = warnings(() => resolveSkills("X", "sight :: seeing in the dark", ""));
    assert.match(w.join(" "), /redeclares/);
    const s = resolveSkills("X", "sight :: seeing in the dark", "");
    assert.equal(s.find(x => x.name === "sight")!.meaning, "seeing in the dark");
    assert.equal(s.length, Object.keys(SKILL_CATALOG).length);
  });

  it("a name in BOTH skills and lacks ends up present, and says so", () => {
    const w = warnings(() => resolveSkills("X", "sight :: they can see after all", "sight"));
    assert.match(w.join(" "), /both skills and lacks/);
    assert.ok(resolveSkills("X", "sight :: they can see after all", "sight").some(x => x.name === "sight"));
  });
});

function quietSync<T>(fn: () => T): T {
  const orig = console.warn;
  console.warn = () => {};
  try { return fn(); } finally { console.warn = orig; }
}

// -- CONFIG VALIDATION -----------------------------------------------------
// Policy: reject the whole value and use the documented default; warn, never throw. The fixture's
// numeric prefixes differ from the defaults on purpose, so half-coercion and correct rejection
// cannot look alike.
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

  it("a malformed story loads, warns about every bad value, and keeps the defaults", async () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
    let sc;
    try { sc = await loadStory(FIXTURE); } finally { console.warn = orig; }
    assert.equal(sc.maxSteps, 24);          // fixture says 99garbage
    assert.equal(sc.retries, 2);            // fixture says 7.5
    assert.equal(sc.clarifications, 2);     // fixture says 0
    assert.equal(sc.stream, true);          // fixture says flase
    assert.equal(sc.thinking.writer, "low");// fixture says highh
    assert.ok(warns.length >= 5, `expected a warning per bad value, got ${warns.length}`);
  });
});

// -- JSON EXTRACTION -------------------------------------------------------
describe("extractJson", () => {
  it("takes the LAST top-level object, not a nested one", () => {
    assert.deepEqual(extractJson(`Example: {"prose":"no"}\nHere it is:\n{"prose":"yes","meta":{"prose":"inner"}}`),
                     { prose: "yes", meta: { prose: "inner" } });
  });

  it("is not fooled by braces inside strings", () => {
    assert.deepEqual(extractJson(`{"speech":"use the } carefully"}`), { speech: "use the } carefully" });
    assert.equal(balancedObjectEnd(`{"a":"}"}`, 0), 9);
  });

  it("strips <think> blocks", () => {
    assert.deepEqual(extractJson(`<think>I should say...</think>{"answer":"two paces"}`), { answer: "two paces" });
  });

  it("falls back to labelled prose using THIS mode's keys", () => {
    const o = extractJson(`**speech**: Early enough.\n**action**: I shift my weight.`);
    assert.equal(o.speech, "Early enough.");
    assert.equal(o.action, "I shift my weight.");
  });

  it("returns {} rather than throwing on garbage", () => {
    assert.deepEqual(extractJson("no json at all { unclosed"), {});
  });
});

// The streaming transport keeps a reply that broke off mid-stream if it had already finished an
// object. That decision is this function, and it must NOT accept a half-written reply.
describe("topLevelObjects", () => {
  it("finds each complete object and skips nested ones", () => {
    const found = topLevelObjects(`{"a":1} noise {"b":{"c":2}}`);
    assert.equal(found.length, 2);
    assert.deepEqual(found[1], { b: { c: 2 } });
  });

  it("finds nothing in a reply that was cut off", () => {
    assert.equal(topLevelObjects(`{"prose": "half a sentence`).length, 0);
    assert.equal(topLevelObjects(`{"a":1`).length, 0);
  });

  it("is not fooled by a labelled prose line the way the fallback would be", () => {
    const partial = `speech: Early enough.\naction: I shift my`;
    assert.equal(topLevelObjects(partial).length, 0);
    assert.ok(Object.keys(extractJson(partial)).length > 0, "the fallback WOULD accept this");
  });
});

// Regression: a draft cut off at the token cap parses to nothing, and the written words are the
// product. Recover them rather than losing the whole draft to a missing closing brace.
describe("salvageProse", () => {
  const truncated = `{"prose": "The wall bites cold.\\n\\nShe shifts her weight. The package is heavier than it looks, wrapped in brown paper,`;

  it("recovers a truncated draft up to the last finished sentence", () => {
    assert.deepEqual(extractJson(truncated), {}, "precondition: this really is unparseable");
    // The half-written last sentence is dropped; the escaped newlines come back as newlines.
    assert.equal(salvageProse(truncated), "The wall bites cold.\n\nShe shifts her weight.");
  });

  it("keeps nothing when no sentence ever finished", () => {
    assert.equal(salvageProse(`{"prose": "The wall bites`), "");
  });

  it("stays out of the way when there is no prose field", () => {
    assert.equal(salvageProse(`{"verdict": "accept"}`), "");
  });
});

// -- CONSULT PROTOCOL ------------------------------------------------------
// A scripted agent: same class, replies from a list instead of a model.
class ScriptedAgent extends Agent {
  calls: number = 0;
  constructor(public script: string[]) { super("TESTER", "none", "system", 0); }
  async generate(): Promise<string> {
    const r = this.script[this.calls++];
    if (r === undefined) throw new Error(`ScriptedAgent ran out of replies after ${this.calls - 1}`);
    return r;
  }
}
const REQ: ConsultRequest = { character: "TESTER", situation: "s", question: "q", wants: "" };
const SKILLS: Skill[] = [
  { name: "movement", meaning: "", source: "general" },
  { name: "speech", meaning: "", source: "general" },
];
const run = (script: string[], clarifications = 2, clarify = async () => "two paces") => {
  const events: ConsultEvent[] = [];
  const agent = new ScriptedAgent(script);
  return consult(agent, REQ, SKILLS, { clarifications, clarify, log: e => events.push(e) })
    .then(reply => ({ reply, events, agent }));
};

// -- STOPPING A RUN --------------------------------------------------------
// The interesting half of "stop" is what it refuses to do: no retry, no salvage, no swallowing it
// into a repair pass. All three are reachable without a model, because a stop is decided before the
// transport ever calls out.
describe("stopRun", () => {
  it("is idempotent, and armRun makes the next run stoppable again", () => {
    armRun();
    assert.equal(RUN.stopped, false);
    assert.equal(stopRun(), true, "the first stop is the one that takes effect");
    assert.equal(stopRun(), false, "a second click must not be a second stop");
    assert.equal(RUN.abort.signal.aborted, true, "the call in flight is cut, not just the loop");
    armRun();
    assert.equal(RUN.stopped, false);
    assert.equal(RUN.abort.signal.aborted, false, "an AbortController is single-use — a stale one would refuse the next run");
    assert.equal(stopRun(), true);
    armRun();
  });

  it("refuses to start a model call at all, rather than starting one and retrying it", async () => {
    // No network in this suite: reaching fetch would fail differently (and slowly), so the error
    // type IS the assertion that the transport short-circuited.
    stopRun();
    await assert.rejects(() => complete("none", [{ role: "user", content: "x" }], 0),
                         (e: Error) => e instanceof StoppedError);
    armRun();
  });

  it("propagates out of a consult instead of being repaired or flagged", async () => {
    // A character call that dies on a stop must not look like "returned nothing usable" — that would
    // spend a repair pass, and then write a stall into the log as if the character had misbehaved.
    class Stopping extends Agent {
      constructor() { super("TESTER", "none", "system", 0); }
      async generate(): Promise<string> { throw new StoppedError(); }
    }
    const events: ConsultEvent[] = [];
    await assert.rejects(
      () => consult(new Stopping(), REQ, SKILLS, { clarifications: 2, clarify: async () => "", log: e => events.push(e) }),
      (e: Error) => e instanceof StoppedError);
    assert.deepEqual(events.map(e => e.t), ["consult"], "nothing is recorded as having been answered");
  });
});

describe("consult", () => {
  it("answers straight through and reports the skills used", async () => {
    const { reply, agent } = await run([`{"speech":"Early enough.","skills_used":["speech"]}`]);
    assert.equal(agent.calls, 1);
    assert.equal(reply.speech, "Early enough.");
    assert.deepEqual(reply.skillsUsed, ["speech"]);
    assert.deepEqual(reply.unverified, []);
    assert.equal(reply.forced, false);
  });

  it("relays a clarifying question and feeds the answer back", async () => {
    const { reply, events } = await run([
      `{"need":"Can I reach the door handle?"}`,
      `{"action":"I reach for it.","skills_used":["movement"]}`,
    ]);
    assert.deepEqual(reply.clarifications, [{ question: "Can I reach the door handle?", answer: "two paces" }]);
    assert.deepEqual(events.map(e => e.t), ["consult", "need", "clarify", "answer"]);
  });

  it("stops asking once the clarification budget is spent and answers anyway", async () => {
    const { reply, events } = await run([
      `{"need":"one?"}`, `{"need":"two?"}`, `{"action":"I go anyway.","skills_used":["movement"]}`,
    ], 1);
    assert.equal(reply.clarifications.length, 1);      // only the first was answered
    assert.equal(reply.forced, true);
    assert.ok(events.some(e => e.t === "forced"));
  });

  it("an unanswerable clarification does not stall the consult", async () => {
    const { reply } = await run([`{"need":"anything?"}`, `{"action":"I decide.","skills_used":["movement"]}`],
                                2, async () => "");
    assert.equal(reply.clarifications[0].answer, "(no answer)");
    assert.equal(reply.action, "I decide.");
  });

  it("re-asks once when a skill is claimed that the character does not have", async () => {
    const { reply, events, agent } = await run([
      `{"action":"I pick the lock.","skills_used":["lockpicking"]}`,
      `{"action":"I knock instead.","skills_used":["movement"]}`,
    ]);
    assert.equal(agent.calls, 2);
    assert.deepEqual(reply.unverified, []);
    assert.equal(reply.action, "I knock instead.");
    assert.ok(events.some(e => e.t === "repair"));
    assert.ok(!events.some(e => e.t === "skill_flag"));
  });

  it("flags rather than silently accepts when the repair fails too", async () => {
    const { reply, events } = await run([
      `{"action":"I pick the lock.","skills_used":["lockpicking"]}`,
      `{"action":"I pick it anyway.","skills_used":["lockpicking","movement"]}`,
    ]);
    assert.deepEqual(reply.unverified, ["lockpicking"]);
    assert.equal(reply.action, "I pick it anyway.");   // the answer still reaches the author
    assert.ok(events.some(e => e.t === "skill_flag"));
  });

  it("repairs a reply with no thought, speech or action", async () => {
    const { reply, events } = await run([`{"skills_used":["speech"]}`, `{"speech":"Fine."}`]);
    assert.equal(reply.speech, "Fine.");
    assert.ok(events.some(e => e.t === "repair" && e.why.includes("nothing usable")));
  });

  // Regression: every branch out of `need` must consume a budget. A character that only ever asks
  // used to loop forever at one model call per turn — a slow infinite loop that reads as a slow model.
  it("gives up on a character that will not stop asking, in a bounded number of calls", async () => {
    const forever = Array(50).fill(`{"need":"but where exactly?"}`);
    const { reply, agent } = await run(forever, 2);
    assert.equal(agent.calls, 5, "2 clarifications + 1 forced + 1 repair + the reply that is read");
    assert.equal(reply.thought + reply.speech + reply.action, "");
    assert.match(reply.note, /kept asking/);
    assert.equal(reply.forced, true);
  });

  it("never touches the agent's history — the caller owns what becomes memory", async () => {
    const { agent } = await run([
      `{"need":"where?"}`, `{"action":"I move.","skills_used":["movement"]}`,
    ]);
    assert.equal(agent.history.length, 0);
  });

  it("a fork carries the persona and none of the history", () => {
    const a = new Agent("RIVEN", "m", "persona", 0.9);
    a.think = "high";
    a.hear("something that happened");
    const f = a.fork();
    assert.equal(f.system, a.system);
    assert.equal(f.model, a.model);
    assert.equal(f.think, a.think);
    assert.equal(f.history.length, 0);
    assert.equal(a.history.length, 1);
  });
});

// -- WHAT A CONSULT MUST CONTAIN ------------------------------------------
// The gate in front of `consult()`. A malformed request costs a character call, up to
// `clarifications` more and a judge call, and buys filler — so it is refused before anyone is asked.
// Every rejected shape here was logged verbatim in a real run under `stories/*/out/`.
describe("canonWants", () => {
  it("takes the four exactly", () => {
    for (const w of CONSULT_WANTS) assert.equal(canonWants(w), w);
    assert.equal(canonWants("  Speech "), "speech");
  });

  // Near-miss recovery, not a paraphrase engine: the writer is told to send one of the four words,
  // and these are the shapes it sends instead when it does not.
  it("canonicalizes what a writer actually writes", () => {
    assert.equal(canonWants("what they do next"), "action");        // 4 of 5 logged consults
    assert.equal(canonWants("what they say"), "speech");
    assert.equal(canonWants("whether they move aside"), "decision", "a fork beats the verb in it");
    assert.equal(canonWants("how she reacts"), "reaction");
  });

  it("returns null rather than guessing when there is no shape in it", () => {
    assert.equal(canonWants(""), null);
    assert.equal(canonWants("   "), null);
    assert.equal(canonWants(undefined), null);
    assert.equal(canonWants("please"), null);
    assert.equal(canonWants("how she takes it"), null, "a paraphrase with no keyword is refused, not guessed at");
  });
});

describe("normalizeConsult", () => {
  const good = { character: "RIVEN", situation: "You are kneeling by the steel service door, wrench in the cylinder.",
                 question: "Do you turn it, or ease off?", wants: "decision" };

  it("passes a real consult through, canonicalizing wants", () => {
    const r = normalizeConsult({ ...good, wants: "what they decide" });
    assert.ok(r.ok);
    assert.equal(r.req.wants, "decision");
    assert.equal(r.req.question, good.question);
    assert.equal(r.req.character, "RIVEN");
  });

  // The observed bug: stories/glass-womb sent a consult with a zero-character situation. The
  // character — whose only world IS the situation — answered with filler, and the exchange was spent.
  it("refuses an empty situation", () => {
    const r = normalizeConsult({ ...good, situation: "" });
    assert.ok(!r.ok);
    assert.match(r.why, /only world/);
  });

  it("refuses a situation too thin to answer from", () => {
    const r = normalizeConsult({ ...good, situation: "It is dark." });
    assert.ok(!r.ok);
    assert.match(r.why, /3 words/);
  });

  it("refuses an empty question", () => {
    assert.ok(!normalizeConsult({ ...good, question: "" }).ok);
  });

  // "What do you do?" names no fork and no stake, so the safest answer is always correct — and the
  // safest answer is the one that does not move the scene. All four were logged.
  it("refuses the questions that ask for nothing", () => {
    for (const q of ["What do you do?", "What does Elara do?", "What does Riven do next with the pick?",
                     "What happens next?", "Your move?"]) {
      const r = normalizeConsult({ ...good, question: q });
      assert.ok(!r.ok, `"${q}" should have been refused`);
      assert.match(r.why, /fork|stake/);
    }
  });

  it("keeps the questions that name a fork or a cost", () => {
    for (const q of ["Do you type the abort command?",
                     "Do you wake him or let him sleep?",
                     "Do you shift to get more comfortable, or stay perfectly still?",
                     "What do you say when he asks you directly?",
                     "Do you say the name, knowing what it admits?"]) {
      assert.ok(normalizeConsult({ ...good, question: q }).ok, `"${q}" should have been allowed`);
    }
  });

  it("refuses a wants it cannot make sense of, and names the four", () => {
    const r = normalizeConsult({ ...good, wants: "" });
    assert.ok(!r.ok);
    for (const w of CONSULT_WANTS) assert.match(r.why, new RegExp(w));
  });

  it("says what is wrong in terms the writer can act on", () => {
    // The rejection goes straight back into the writer's history. One it cannot act on is one it
    // repeats, and three sterile steps in a row end the scene.
    for (const bad of [{ situation: "" }, { situation: "Dark." }, { question: "What do you do?" }, { wants: "" }]) {
      const r = normalizeConsult({ ...good, ...bad });
      assert.ok(!r.ok);
      assert.ok(r.why.length > 60, "a one-word complaint teaches nothing");
    }
  });
});

// -- STORY SPEC (scaffolding, SPEC-S §3) -----------------------------------
describe("normalizeSpec", () => {
  const base = {
    title: "Doorway", premise: "A corridor at 3am.",
    scene: { place: "Behind Kessel's", question: "Does she get in?", pov: "RIVEN", length: 700 },
    characters: [{ name: "RIVEN", persona: "A courier.", knows: "The code changed.", skills: ["lockpicking :: picks locks"], lacks: [] }],
  };

  it("accepts a well-formed proposal with no complaints", () => {
    const { spec, problems } = normalizeSpec(base);
    assert.deepEqual(problems, []);
    assert.equal(spec.scene.pov, "RIVEN");
    assert.deepEqual(spec.characters[0].skills, ["lockpicking :: picks locks"]);
  });

  it("drops a lacks: that names no general skill, and says why", () => {
    const { spec, problems } = normalizeSpec({
      ...base, characters: [{ ...base.characters[0], lacks: ["telepathy", "sight"] }] });
    assert.deepEqual(spec.characters[0].lacks, ["sight"]);
    assert.match(problems.join(" "), /telepathy/);
  });

  it("clears a pov that is not one of the characters", () => {
    const { spec, problems } = normalizeSpec({ ...base, scene: { ...base.scene, pov: "NOBODY" } });
    assert.equal(spec.scene.pov, "");
    assert.match(problems.join(" "), /NOBODY/);
  });

  it("takes skills and lacks as a pipe-separated string too", () => {
    const { spec } = normalizeSpec({
      ...base, characters: [{ ...base.characters[0], skills: "climbing | keys :: by feel", lacks: "sight" }] });
    assert.deepEqual(spec.characters[0].skills, ["climbing", "keys :: by feel"]);
    assert.deepEqual(spec.characters[0].lacks, ["sight"]);
  });

  it("enforces the cast bounds and rejects duplicates", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ ...base.characters[0], name: `C${i}` }));
    const { spec, problems } = normalizeSpec({ ...base, scene: { ...base.scene, pov: "" }, characters: many });
    assert.equal(spec.characters.length, 4);
    assert.match(problems.join(" "), /keeping the first 4/);

    const dup = normalizeSpec({ ...base, characters: [base.characters[0], { ...base.characters[0], persona: "other" }] });
    assert.equal(dup.spec.characters.length, 1);
    assert.match(dup.problems.join(" "), /two characters called/i);
  });

  // Observed: the architect proposed two keepers who could both do everything, which reads fine and
  // gives the consult almost nothing to bite on.
  it("notices a cast where nobody lacks anything", () => {
    const flat = { ...base, scene: { ...base.scene, pov: "" },
      characters: [{ ...base.characters[0], name: "A", lacks: [] }, { ...base.characters[0], name: "B", lacks: [] }] };
    assert.match(normalizeSpec(flat).problems.join(" "), /asymmetry/);
    const sharp = { ...flat, characters: [flat.characters[0], { ...flat.characters[1], lacks: ["sight"] }] };
    assert.ok(!normalizeSpec(sharp).problems.some(p => /asymmetry/.test(p)));
    // A single character has nobody to be asymmetric with; do not nag about it.
    assert.ok(!normalizeSpec(base).problems.some(p => /asymmetry/.test(p)));
  });

  // Observed: the architect wrote "LACKS: None." into a persona while the engine had given that
  // character a skill list with something missing — a contradiction inside the character's prompt.
  it("notices a persona that restates the structured fields", () => {
    const bled = { ...base, characters: [{ ...base.characters[0],
      persona: "A courier. VOICE: economical. KNOWS: the code changed. LACKS: None." }] };
    assert.match(normalizeSpec(bled).problems.join(" "), /restates/);
    // A persona using the labelled headings the format actually asks for is fine.
    const ok = { ...base, characters: [{ ...base.characters[0],
      persona: "A courier. VOICE: economical. UNDER PRESSURE: politer, not louder." }] };
    assert.ok(!normalizeSpec(ok).problems.some(p => /restates/.test(p)));
  });

  // The scaffolder decides "propose" vs "patch" by whether a usable story exists. An ambiguous idea
  // makes the architect ask a question INSTEAD of proposing, so this must come back unusable — that
  // emptiness is the signal, and treating it as a story to patch is what used to collapse the loop.
  it("an ask-only reply yields no usable story", () => {
    const { spec } = normalizeSpec({ ask: "Who are these two people, and what do they want?" });
    assert.equal(spec.characters.length, 0);
    assert.equal(spec.title, "");
  });

  it("reports an empty proposal rather than throwing", () => {
    const { spec, problems } = normalizeSpec({});
    assert.equal(spec.scene.length, 700);
    assert.equal(spec.characters.length, 0);
    assert.ok(problems.length >= 4, problems.join(" · "));
  });
});

describe("applyEdits", () => {
  const spec = normalizeSpec({
    title: "Doorway", premise: "A corridor at 3am.",
    scene: { place: "Behind Kessel's", question: "Does she get in?", pov: "RIVEN", length: 700 },
    writer_style: "Close third.",
    characters: [
      { name: "RIVEN", persona: "A courier.", knows: "The code changed.", skills: ["lockpicking"], lacks: [] },
      { name: "MERRITT", persona: "A porter.", knows: "The lock sticks.", skills: [], lacks: ["sight"] },
    ],
  }).spec;
  const edit = (field: string, value: any) => quietSync(() => applyEdits(spec, { edits: [{ field, value }] }));

  it("changes only the field named and leaves the rest untouched", () => {
    const r = edit("scene.place", "A stairwell");
    assert.equal(r.spec.scene.place, "A stairwell");
    assert.equal(r.spec.premise, spec.premise);
    assert.deepEqual(r.spec.characters.map(c => c.name), ["RIVEN", "MERRITT"]);
    assert.deepEqual(r.applied, ["scene.place"]);
    assert.deepEqual(r.ignored, []);
    assert.equal(spec.scene.place, "Behind Kessel's", "the input spec must not be mutated");
  });

  it("edits a character by name, case-insensitively", () => {
    const r = edit("characters.merritt.persona", "Older than they look.");
    assert.equal(r.spec.characters[1].persona, "Older than they look.");
    assert.deepEqual(r.applied, ["MERRITT.persona"]);
  });

  it("takes skills and lacks as a list or a pipe-separated string", () => {
    assert.deepEqual(edit("characters.RIVEN.skills", ["climbing", "keys :: by feel"]).spec.characters[0].skills,
                     ["climbing", "keys :: by feel"]);
    assert.deepEqual(edit("characters.RIVEN.lacks", "hearing | smell").spec.characters[0].lacks,
                     ["hearing", "smell"]);
  });

  it("reports an unknown field instead of guessing at it", () => {
    const r = edit("scene.mood", "tense");
    assert.deepEqual(r.applied, []);
    assert.match(r.ignored.join(" "), /unknown field "scene\.mood"/);
    assert.deepEqual(r.spec, spec);
  });

  it("adds and removes characters, and refuses the impossible ones", () => {
    const added = edit("add_character", { name: "TOVA", persona: "A cook.", knows: "", skills: [], lacks: ["hearing"] });
    assert.deepEqual(added.spec.characters.map(c => c.name), ["RIVEN", "MERRITT", "TOVA"]);
    assert.match(edit("add_character", { name: "RIVEN", persona: "x" }).ignored.join(" "), /already in the cast/);
    assert.match(edit("remove_character", "NOBODY").ignored.join(" "), /not in the cast/);
  });

  it("removing the pov character clears the pov rather than leaving it dangling", () => {
    const r = edit("remove_character", "RIVEN");
    assert.deepEqual(r.spec.characters.map(c => c.name), ["MERRITT"]);
    assert.equal(r.spec.scene.pov, "");
    assert.match(r.problems.join(" "), /RIVEN/);
  });

  it("re-validates after editing, so a bad lacks: is caught in the round that caused it", () => {
    const r = edit("characters.MERRITT.lacks", ["telepathy"]);
    assert.deepEqual(r.spec.characters[1].lacks, []);
    assert.match(r.problems.join(" "), /telepathy/);
  });

  it("holds the cast bound when a fifth character is added", () => {
    let grown = spec;
    for (const n of ["TOVA", "KESS", "WREN"])
      grown = quietSync(() => applyEdits(grown, { edits: [{ field: "add_character", value: { name: n, persona: "x" } }] })).spec;
    assert.equal(grown.characters.length, 4);
    const r = quietSync(() => applyEdits(grown, { edits: [{ field: "add_character", value: { name: "EXTRA", persona: "x" } }] }));
    assert.equal(r.spec.characters.length, 4);
    assert.match(r.problems.join(" "), /keeping the first 4/);
  });

  it("survives an edits list that is missing, empty, or malformed", () => {
    for (const raw of [{}, { edits: [] }, { edits: [{ value: "x" }] }, { edits: "nonsense" }]) {
      const r = quietSync(() => applyEdits(spec, raw));
      assert.deepEqual(r.spec, spec);
    }
  });
});

describe("slugify", () => {
  it("derives a safe folder name, or nothing at all", () => {
    assert.equal(slugify("The Unwritten Tide"), "the-unwritten-tide");
    assert.equal(slugify("  Bay 4 — Hatches!  "), "bay-4-hatches");
    assert.equal(slugify("../../etc/passwd"), "etc-passwd");
    assert.equal(slugify("???"), "", "nothing usable must yield nothing, not a fallback");
    assert.ok(slugify("x".repeat(80)).length <= 40);
    assert.ok(!slugify("Ends with punctuation ---").endsWith("-"));
  });
});

// THE invariant the scaffolder rests on (SPEC-S §1): what the architect designed is what the run
// loads. Everything else about scaffolding is a convenience; if this breaks, a generated story is
// quietly not the story that was accepted.
describe("renderStory round trip", () => {
  const spec = normalizeSpec({
    title: "The Unwritten Tide",
    premise: "Midwinter on a sea-stack lighthouse.\n\nThe relief boat is nine days overdue.",
    scene: { place: "The watchroom, 2am", question: "Does Elias catch her reading it?", pov: "MARA", length: 850 },
    writer_style: "Third person limited. Present tense.",
    characters: [
      { name: "ELIAS", persona: "The senior keeper.\n\nThirty years of it.", knows: "The radio only receives.",
        skills: ["writelog :: drafting entries in correct naval syntax"], lacks: [] },
      { name: "MARA", persona: "The junior keeper.", knows: "The fog signal has not fired in eleven days.",
        skills: [], lacks: ["hearing"] },
    ],
  }).spec;

  it("survives spec -> files -> loadStory unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      for (const [name, body] of Object.entries(renderStory(spec, { default: "some-model" })))
        await writeFile(join(dir, name), body, "utf8");
      const sc = await quiet(() => loadStory(dir));

      assert.equal(sc.premise, spec.premise, "paragraph breaks and all");
      assert.deepEqual(sc.scene, spec.scene);
      assert.equal(sc.writerStyle.includes("Third person limited. Present tense."), true);
      assert.equal(sc.models.default, "some-model");
      assert.deepEqual(sc.characters.map(c => c.name), ["ELIAS", "MARA"]);

      const elias = sc.characters[0], mara = sc.characters[1];
      assert.equal(elias.knows, spec.characters[0].knows);
      assert.ok(elias.persona.includes("Thirty years of it."));
      // The two things that would silently change the SCENE if they were lost:
      assert.ok(elias.skills.some(s => s.name === "writelog" && s.meaning.startsWith("drafting entries")));
      assert.ok(!mara.skills.some(s => s.name === "hearing"), "a lacks: must survive as a real absence");
      assert.ok(mara.skills.some(s => s.name === "sight"), "and must not take anything else with it");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("flattens a multi-line knows: rather than letting it end the field", async () => {
    const messy = { ...spec, characters: [{ ...spec.characters[0], knows: "One thing.\nAnd another." }, spec.characters[1]] };
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      for (const [name, body] of Object.entries(renderStory(messy, { default: "m" })))
        await writeFile(join(dir, name), body, "utf8");
      const sc = await quiet(() => loadStory(dir));
      assert.equal(sc.characters[0].knows, "One thing. And another.");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("gives two characters that slug alike separate files", () => {
    const clash = { ...spec, characters: [
      { ...spec.characters[0], name: "MARA JAY" }, { ...spec.characters[1], name: "Mara-Jay" }] };
    const files = renderStory(clash, { default: "m" });
    assert.ok(files["mara-jay.md"] && files["mara-jay-2.md"], Object.keys(files).join(", "));
    assert.notEqual(files["mara-jay.md"], files["mara-jay-2.md"]);
  });
});

// -- MODEL OVERRIDE (the GUI's dropdown/pause feature, GUI-SPEC §4.4) ------
// loadStory()'s only new surface: an override applied BEFORE models.default's fallbacks resolve, so
// it reaches a character or role that would otherwise have inherited the default, and nothing that
// named its own model. This is the one piece of that feature pure enough to unit test; pause/resume
// and the live-agent swap are server wiring, exercised by hand like the reader consult's is.
describe("loadStory model override", () => {
  async function withStory(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    await writeFile(join(dir, "story.md"), [
      "## Premise", "A premise.", "",
      "## Characters", "", "### A", "file: a.md", "", "### B", "file: b.md", "model: b-own-model", "",
      "## Models", "default: story-default",
    ].join("\n"), "utf8");
    await writeFile(join(dir, "a.md"), "A's persona.", "utf8");
    await writeFile(join(dir, "b.md"), "B's persona.", "utf8");
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

describe("loadDefaults", () => {
  it("reads defaults.md, and --model overrides everything in it", async () => {
    const d = await quiet(() => loadDefaults());
    assert.ok(d.models.default);
    assert.ok(d.models.architect);
    const o = await quiet(() => loadDefaults("forced-model"));
    assert.equal(o.models.default, "forced-model");
    assert.equal(o.models.architect, "forced-model");
  });
});

// -- PROMPTS ---------------------------------------------------------------
describe("prompt construction", () => {
  it("a character is told its skills and its place, and NOT the premise", async () => {
    const sc = await quiet(() => loadStory("stories/doorway"));
    const merritt = sc.characters.find(c => c.name === "MERRITT")!;
    const p = wrapCharacter(merritt, sc.scene.place);
    assert.match(p, /hearing/);
    assert.match(p, /Kessel/);                       // the place
    assert.ok(!p.includes("sight"), "a character must not be shown a skill it lacks");
    assert.ok(!p.includes(sc.premise.slice(0, 40)), "the premise is the author's, not the character's");
  });

  it("the writer is told what each character cannot do, and no personas", async () => {
    const sc = await quiet(() => loadStory("stories/doorway"));
    const p = wrapWriter(sc);
    assert.match(p, /MERRITT[\s\S]{0,200}CANNOT: sight/);
    assert.ok(!p.includes("night porter at Kessel's for nine years"),
              "the writer must not be handed the personas");
  });

  // THE ONE RULE's two blind spots, both found in the logs under `stories/*/out/`. Neither is
  // machine-checkable in the prose the writer returns — the guarantee the code CAN give is that the
  // contract states them, so a run that stalls this way was not a run that was never told.
  it("the writer is told that stillness is a choice and that pressure may not be resolved first", async () => {
    const p = wrapWriter(await quiet(() => loadStory("stories/doorway")));
    assert.match(p, /HOLDING STILL IS A CHOICE/);
    assert.match(p, /YOU MAY NOT RESOLVE THE PRESSURE BEFORE YOU ASK ABOUT IT/);
  });

  it("the writer is given the closed `wants` vocabulary, not an invitation to phrase one", async () => {
    const p = wrapWriter(await quiet(() => loadStory("stories/doorway")));
    for (const w of CONSULT_WANTS) assert.match(p, new RegExp(`\\b${w}\\b`));
    assert.match(p, /EXACTLY ONE of these four words/);
  });
});

// -- PACING ----------------------------------------------------------------
// A scene has a fixed word budget and two things to spend it on: narration and consults. Four
// measured runs averaged ~300 words of prose per draft and bought 4 character decisions out of 1119
// words. The cap is the dial that converts the same budget into more choices.
describe("max_prose_words", () => {
  it("defaults to a real ceiling — several pieces inside one scene's length", async () => {
    const sc = await quiet(() => loadStory("stories/doorway"));
    assert.equal(sc.maxProseWords, 140);
    assert.ok(sc.maxProseWords * 3 <= sc.scene.length,
              "a cap that a scene fits into in one or two pieces is not a cap");
  });

  it("is read from the story, and holds the same line every other config value does", () => {
    assert.equal(num({ "config.max_prose_words": "90" }, "config.max_prose_words", 140), 90);
    assert.equal(warnings(() => num({ "config.max_prose_words": "0" }, "config.max_prose_words", 140)).length, 1);
    assert.equal(num({ "config.max_prose_words": "lots" }, "config.max_prose_words", 140), 140);
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
    assert.ok(sc.scene.question);
    assert.ok(sc.premise.length > 100);
  });

  it("is discoverable, and the fixture is not", async () => {
    const found = await discoverStories();
    assert.ok(found.includes("stories/doorway"));
    assert.ok(!found.some(d => d.includes("badstory")));
  });

  // Without a terminal there is nobody to interview, so the picker must never return NEW_STORY —
  // a scripted or piped run has to behave exactly as it did before scaffolding existed.
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
// `POST /select` takes a directory from a browser. A path that arrives over HTTP is a request to
// read one, not a path — so the only thing that can be selected is something `discoverStories()`
// itself found. This is the read-side twin of `slugify()` owning where scaffolds get written.
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

// -- THE SCAFFOLD INTERVIEW ------------------------------------------------
// `ScaffoldSession` is the interview with no console in it, so a scripted architect drives the whole
// state machine. This is the half of SPEC-S that could not be tested while the loop was welded to
// readline: the proposal-vs-patch rule (§4.2), the ask budget, and the folder-collision path §5
// listed as "not covered, deliberately, because it needs a terminal".
const SCAFFOLD_DEFAULTS: Defaults = {
  models: { default: "none", architect: "none" },
  thinking: { architect: "low" },
  requestTimeout: 120, attempts: 3, maxTokens: 2000, stream: false, debug: false,
};

// A proposal that `normalizeSpec` has nothing to complain about: everyone has a persona, none of
// them restates the structured fields, and BRAE genuinely lacks something out of the catalog.
const STORY = {
  title: "The Fog Signal",
  premise: "Two keepers, one lamp, and a night that did not happen the way the log says it did.",
  scene: { place: "the lamp room", question: "Does Aster admit the signal never fired?", pov: "ASTER", length: 700 },
  writer_style: "Plain sentences. No weather as metaphor.",
  characters: [
    { name: "ASTER", persona: "Keeps the log in a small clear hand and has never once falsified it.",
      knows: "The signal did not fire.", skills: ["lamp-tending :: trimming and lighting the great lens"], lacks: [] },
    { name: "BRAE", persona: "Came up from the boats and trusts the weather over anyone's paperwork.",
      knows: "", skills: [], lacks: ["hearing"] },
  ],
};
const scaffold = (script: unknown[], storiesDir?: string) =>
  new ScaffoldSession(new ScriptedAgent(script.map(s => JSON.stringify(s))),
                      SCAFFOLD_DEFAULTS, "two lighthouse keepers", storiesDir);

describe("ScaffoldSession", () => {
  // The bug SPEC-S §4.2 exists for: the loop used to decide proposal-vs-patch by "is this the first
  // call", so an idea vague enough to earn a question was then sent "reply with edits only" against
  // an EMPTY spec. It patched a void and every later round inherited the emptiness.
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

  // The format says ask INSTEAD of proposing, and the model routinely does both. Read strictly, the
  // question was landing on the floor — `ask` was only honoured when nothing else came back.
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
    assert.equal(s.spec.scene.length, 900);
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
    // Left set, the prompt goes on asking for an answer that has already been given.
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

// Acceptance writes files, so these run against a temp directory rather than the repo's stories/.
// They are also the only tests that reach the pre-flight's model-list ping — a localhost call that
// fails fast when nothing is listening and is never fatal either way.
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
      assert.deepEqual(w.files, ["aster.md", "brae.md", "story.md", "writer.md"]);
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

describe("renderStory shape", () => {
  const bare = normalizeSpec({
    title: "Bare", premise: "A room.", scene: { question: "Does it end?" },
    characters: [{ name: "SOLO", persona: "Alone." }],
  }).spec;

  it("omits ## Writer entirely when no house style was proposed", () => {
    const files = renderStory(bare, { default: "m" });
    assert.ok(!("writer.md" in files));
    assert.ok(!files["story.md"].includes("## Writer"));
    assert.deepEqual(Object.keys(files).sort(), ["solo.md", "story.md"]);
  });

  it("omits scene keys it has no value for, rather than writing empty ones", () => {
    const md = renderStory(bare, { default: "m" })["story.md"];
    assert.ok(!md.includes("place:"));
    assert.ok(!md.includes("pov:"));
    assert.match(md, /length: 700/);
  });
});
