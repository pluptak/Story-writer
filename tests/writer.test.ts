/**
 * Deterministic suite — `npm test` (node --test via tsx). No model calls, ever.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  loadStory, discoverStories, chooseStory, selectableStory, NEW_STORY, loadDefaults, readChapters, ROOT,
  type Defaults,
} from "../engine/story-format.ts";
import { StoryJson } from "../engine/story-schema.ts";
import { splitMeaning, resolveSkills, SKILL_CATALOG, type Skill } from "../engine/skills.ts";
import { num, bool, enumOf, slugify } from "../engine/config-util.ts";
import { extractJson, balancedObjectEnd, salvageProse, topLevelObjects } from "../engine/json-extract.ts";
import {
  consult, normalizeConsult, canonWants, CONSULT_WANTS, type ConsultEvent, type ConsultRequest,
} from "../engine/consult.ts";
import { wrapCharacter, wrapWriter, writerCast, neglectedCast, runChapter } from "../engine/scene-loop.ts";
import { Agent, llmFilenameFor, llmLogEntry } from "../engine/agent.ts";
import { normalizeSpec, applyEdits, directEdit, renderStory } from "../engine/story-spec.ts";
import { architectNextChapter } from "../prompts.ts";
import { complete, completeStream } from "../engine/llm-client.ts";
import { ScaffoldSession, NextChapterSession, openNextChapter } from "../engine/architect.ts";
import { runDirs, retainedRuns } from "../engine/preflight.ts";
import { LIVE, runState, resetLive, RUN, stopRun, armRun, StoppedError } from "../live.ts";
import { handleNextChapterRoutes } from "../server/next-chapter-routes.ts";
import { handleRunControl } from "../server/run-control-routes.ts";
import { HttpError, readJsonBody } from "../server/http-util.ts";
import type { ServerHost } from "../server/server.ts";

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
    const s = quietSync(() => resolveSkills("X", "lockpicking :: picking locks | climbing", "sight"));    assert.ok(!names(s).includes("sight"));
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

  it("a name in BOTH skills and restrictions ends up present, and says so", () => {
    const w = warnings(() => resolveSkills("X", "sight :: they can see after all", "sight"));
    assert.match(w.join(" "), /both skills and restrictions/);
    assert.ok(resolveSkills("X", "sight :: they can see after all", "sight").some(x => x.name === "sight"));
  });
});

function quietSync<T>(fn: () => T): T {
  const orig = console.warn;
  console.warn = () => {};
  try { return fn(); } finally { console.warn = orig; }
}

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
    stopRun();
    await assert.rejects(() => complete("none", [{ role: "user", content: "x" }], 0),
                         (e: Error) => e instanceof StoppedError);
    armRun();
  });

  it("propagates out of a consult instead of being repaired or flagged", async () => {
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

describe("LIVE.interactive", () => {
  it("defaults on and rides runState()", () => {
    assert.equal(LIVE.interactive, true);
    assert.equal(runState().interactive, true);
    LIVE.interactive = false;
    assert.equal(runState().interactive, false);
    LIVE.interactive = true;
  });

  it("resetLive() leaves it untouched — a second story keeps what you set it to", () => {
    LIVE.interactive = false;
    resetLive();
    assert.equal(LIVE.interactive, false, "a session preference, not a fact about one run");
    LIVE.interactive = true;
    resetLive();
    assert.equal(LIVE.interactive, true);
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
describe("neglectedCast", () => {
  it("names nobody before the cast has had a fair chance", () => {
    assert.deepEqual(neglectedCast(["RIVEN", "MERRITT"], new Map(), 0, 3), []);
    assert.deepEqual(neglectedCast(["RIVEN", "MERRITT"], new Map(), 2, 3), []);
  });

  it("names a cast member never consulted, once the gap has passed", () => {
    const lastAsked = new Map([["riven", 1]]);
    assert.deepEqual(neglectedCast(["RIVEN", "MERRITT"], lastAsked, 3, 3), ["MERRITT"]);
  });

  it("stops naming someone once they are asked again, and resumes after another full gap", () => {
    const lastAsked = new Map([["riven", 4], ["merritt", 6]]);
    assert.deepEqual(neglectedCast(["RIVEN", "MERRITT"], lastAsked, 6, 3), []);
    assert.deepEqual(neglectedCast(["RIVEN", "MERRITT"], lastAsked, 8, 3), ["RIVEN"]);
  });

  it("is case-insensitive against how lastAsked is keyed", () => {
    assert.deepEqual(neglectedCast(["Merritt"], new Map([["merritt", 3]]), 6, 3), ["Merritt"]);
  });
});

describe("canonWants", () => {
  it("takes the four exactly", () => {
    for (const w of CONSULT_WANTS) assert.equal(canonWants(w), w);
    assert.equal(canonWants("  Speech "), "speech");
  });

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
    characters: [{ name: "RIVEN", persona: "A courier.", knows: "The code changed.", skills: ["lockpicking :: picks locks"], restrictions: [] }],
  };

  it("accepts a well-formed proposal with no complaints", () => {
    const { spec, problems } = normalizeSpec(base);
    assert.deepEqual(problems, []);
    assert.equal(spec.scenes[0].pov, "RIVEN");
    assert.deepEqual(spec.characters[0].skills, ["lockpicking :: picks locks"]);
  });

  it("drops a restriction that names no general skill, and says why", () => {
    const { spec, problems } = normalizeSpec({
      ...base, characters: [{ ...base.characters[0], restrictions: ["telepathy", "sight"] }] });
    assert.deepEqual(spec.characters[0].restrictions, ["sight"]);
    assert.match(problems.join(" "), /telepathy/);
  });

  it("clears a pov that is not one of the characters", () => {
    const { spec, problems } = normalizeSpec({ ...base, scene: { ...base.scene, pov: "NOBODY" } });
    assert.equal(spec.scenes[0].pov, "");
    assert.match(problems.join(" "), /NOBODY/);
  });

  it("takes skills and restrictions as a pipe-separated string too", () => {
    const { spec } = normalizeSpec({
      ...base, characters: [{ ...base.characters[0], skills: "climbing | keys :: by feel", restrictions: "sight" }] });
    assert.deepEqual(spec.characters[0].skills, ["climbing", "keys :: by feel"]);
    assert.deepEqual(spec.characters[0].restrictions, ["sight"]);
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

  it("notices a cast where nobody has any restrictions", () => {
    const flat = { ...base, scene: { ...base.scene, pov: "" },
      characters: [{ ...base.characters[0], name: "A", restrictions: [] }, { ...base.characters[0], name: "B", restrictions: [] }] };
    assert.match(normalizeSpec(flat).problems.join(" "), /asymmetry/);
    const sharp = { ...flat, characters: [flat.characters[0], { ...flat.characters[1], restrictions: ["sight"] }] };
    assert.ok(!normalizeSpec(sharp).problems.some(p => /asymmetry/.test(p)));
    // A single character has nobody to be asymmetric with; do not nag about it.
    assert.ok(!normalizeSpec(base).problems.some(p => /asymmetry/.test(p)));
  });

  it("notices a persona that restates the structured fields", () => {
    const bled = { ...base, characters: [{ ...base.characters[0],
      persona: "A courier. VOICE: economical. KNOWS: the code changed. RESTRICTIONS: None." }] };
    assert.match(normalizeSpec(bled).problems.join(" "), /restates/);
    // A persona using the labelled headings the format actually asks for is fine.
    const ok = { ...base, characters: [{ ...base.characters[0],
      persona: "A courier. VOICE: economical. UNDER PRESSURE: politer, not louder." }] };
    assert.ok(!normalizeSpec(ok).problems.some(p => /restates/.test(p)));
  });

  it("an ask-only reply yields no usable story", () => {
    const { spec } = normalizeSpec({ ask: "Who are these two people, and what do they want?" });
    assert.equal(spec.characters.length, 0);
    assert.equal(spec.title, "");
  });

  it("reports an empty proposal rather than throwing", () => {
    const { spec, problems } = normalizeSpec({});
    assert.equal(spec.scenes[0].length, 700);
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
      { name: "RIVEN", persona: "A courier.", knows: "The code changed.", skills: ["lockpicking"], restrictions: [] },
      { name: "MERRITT", persona: "A porter.", knows: "The lock sticks.", skills: [], restrictions: ["sight"] },
    ],
  }).spec;
  const edit = (field: string, value: any) => quietSync(() => applyEdits(spec, { edits: [{ field, value }] }));

  it("changes only the field named and leaves the rest untouched", () => {
    const r = edit("scene.place", "A stairwell");
    assert.equal(r.spec.scenes[0].place, "A stairwell");
    assert.equal(r.spec.premise, spec.premise);
    assert.deepEqual(r.spec.characters.map(c => c.name), ["RIVEN", "MERRITT"]);
    assert.deepEqual(r.applied, ["scene.place"]);
    assert.deepEqual(r.ignored, []);
    assert.equal(spec.scenes[0].place, "Behind Kessel's", "the input spec must not be mutated");
  });

  it("edits a character by name, case-insensitively", () => {
    const r = edit("characters.merritt.persona", "Older than they look.");
    assert.equal(r.spec.characters[1].persona, "Older than they look.");
    assert.deepEqual(r.applied, ["MERRITT.persona"]);
  });

  it("takes skills and restrictions as a list or a pipe-separated string", () => {
    assert.deepEqual(edit("characters.RIVEN.skills", ["climbing", "keys :: by feel"]).spec.characters[0].skills,
                     ["climbing", "keys :: by feel"]);
    assert.deepEqual(edit("characters.RIVEN.restrictions", "hearing | smell").spec.characters[0].restrictions,
                     ["hearing", "smell"]);
  });

  it("reports an unknown field instead of guessing at it", () => {
    const r = edit("scene.mood", "tense");
    assert.deepEqual(r.applied, []);
    assert.match(r.ignored.join(" "), /unknown field "scene\.mood"/);
    assert.deepEqual(r.spec, spec);
  });

  it("adds and removes characters, and refuses the impossible ones", () => {
    const added = edit("add_character", { name: "TOVA", persona: "A cook.", knows: "", skills: [], restrictions: ["hearing"] });
    assert.deepEqual(added.spec.characters.map(c => c.name), ["RIVEN", "MERRITT", "TOVA"]);
    assert.match(edit("add_character", { name: "RIVEN", persona: "x" }).ignored.join(" "), /already in the cast/);
    assert.match(edit("remove_character", "NOBODY").ignored.join(" "), /not in the cast/);
  });

  it("removing the pov character clears the pov rather than leaving it dangling", () => {
    const r = edit("remove_character", "RIVEN");
    assert.deepEqual(r.spec.characters.map(c => c.name), ["MERRITT"]);
    assert.equal(r.spec.scenes[0].pov, "");
    assert.match(r.problems.join(" "), /RIVEN/);
  });

  it("re-validates after editing, so a bad restriction is caught in the round that caused it", () => {
    const r = edit("characters.MERRITT.restrictions", ["telepathy"]);
    assert.deepEqual(r.spec.characters[1].restrictions, []);
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

  it("adds a scene at the end and edits it by number", () => {
    const grown = edit("add_scene", { place: "The yard", question: "Does he follow?", pov: "MERRITT", length: 800, roster: ["MERRITT"] });
    assert.equal(grown.spec.scenes.length, 2);
    assert.deepEqual(grown.applied, ["added scene 2"]);
    assert.equal(grown.spec.scenes[1].question, "Does he follow?");
    assert.deepEqual(grown.spec.scenes[1].roster, ["MERRITT"]);
    assert.equal(grown.spec.scenes[0].question, "Does she get in?", "the scene already there is untouched");

    const r = quietSync(() => applyEdits(grown.spec, { edits: [{ field: "scene_2.place", value: "The alley" }] }));
    assert.equal(r.spec.scenes[1].place, "The alley");
    assert.equal(r.spec.scenes[0].place, "Behind Kessel's");
  });

  it("fills a scene added with nothing in it from the schema defaults", () => {
    const r = edit("add_scene", {});
    assert.equal(r.spec.scenes.length, 2);
    assert.equal(r.spec.scenes[1].length, 700);
    assert.deepEqual(r.spec.scenes[1].roster, []);
    assert.match(r.problems.join(" "), /scene 2 has no question/);
  });

  it("refuses an add_scene that is not a scene object", () => {
    for (const v of ["a scene", 3, null, ["place"]]) {
      const r = edit("add_scene", v);
      assert.equal(r.spec.scenes.length, 1, String(v));
      assert.match(r.ignored.join(" "), /must be a scene object/);
    }
  });

  it("removes a scene by number, and never the only one there is", () => {
    const two = edit("add_scene", { question: "Does he follow?" }).spec;
    const r = quietSync(() => applyEdits(two, { edits: [{ field: "remove_scene", value: 1 }] }));
    assert.equal(r.spec.scenes.length, 1);
    assert.equal(r.spec.scenes[0].question, "Does he follow?");
    assert.deepEqual(r.applied, ["removed scene 1"]);

    const last = edit("remove_scene", 1);
    assert.equal(last.spec.scenes.length, 1);
    assert.match(last.ignored.join(" "), /a story needs at least one scene/);
  });

  it("ignores a remove_scene that names no scene", () => {
    for (const v of [0, 2, -1, "second", 1.5, null]) {
      const r = edit("remove_scene", v);
      assert.equal(r.spec.scenes.length, 1, String(v));
      assert.deepEqual(r.applied, [], String(v));
      assert.match(r.ignored.join(" "), /there is no scene/);
    }
  });

  it("survives an edits list that is missing, empty, or malformed", () => {
    for (const raw of [{}, { edits: [] }, { edits: [{ value: "x" }] }, { edits: "nonsense" }]) {
      const r = quietSync(() => applyEdits(spec, raw));
      assert.deepEqual(r.spec, spec);
    }
  });

  describe("directEdit", () => {
    it("sets the one field it is allowed to, through applyEdits", () => {
      const r = quietSync(() => directEdit(spec, "scene.length", 1200));
      assert.ok(r.ok);
      assert.equal(r.spec.scenes[0].length, 1200);
      assert.deepEqual(r.applied, ["scene.length"]);
      assert.equal(spec.scenes[0].length, 700, "the input spec must not be mutated");
    });

    it("rounds what it is given", () => {
      const r = quietSync(() => directEdit(spec, "scene.length", "850.6"));
      assert.ok(r.ok);
      assert.equal(r.spec.scenes[0].length, 851);
    });

    it("refuses every other field, however well-formed", () => {
      for (const f of ["premise", "title", "scene.place", "characters.RIVEN.persona", "scene.mood", ""]) {
        const r = quietSync(() => directEdit(spec, f, "anything"));
        assert.equal(r.ok, false, f);
      }
    });

    it("refuses a length it cannot use instead of silently substituting 700", () => {
      for (const v of [0, 12, 99, 10001, "", "soon", NaN, null, undefined]) {
        const r = quietSync(() => directEdit(spec, "scene.length", v));
        assert.equal(r.ok, false, String(v));
        if (!r.ok) assert.match(r.reason, /100/);
      }
    });
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

describe("renderStory round trip", () => {
  const spec = normalizeSpec({
    title: "The Unwritten Tide",
    premise: "Midwinter on a sea-stack lighthouse.\n\nThe relief boat is nine days overdue.",
    scene: { place: "The watchroom, 2am", question: "Does Elias catch her reading it?", pov: "MARA", length: 850 },
    writer_style: "Third person limited. Present tense.",
    characters: [
      { name: "ELIAS", persona: "The senior keeper.\n\nThirty years of it.", knows: "The radio only receives.",
        skills: ["writelog :: drafting entries in correct naval syntax"], restrictions: [] },
      { name: "MARA", persona: "The junior keeper.", knows: "The fog signal has not fired in eleven days.",
        skills: [], restrictions: ["hearing"] },
    ],
  }).spec;

  it("renders to a single story.json", () => {
    const files = renderStory(spec, { default: "some-model" });
    assert.deepEqual(Object.keys(files), ["story.json"]);
    assert.doesNotThrow(() => JSON.parse(files["story.json"]));
  });

  it("survives spec -> files -> loadStory unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      for (const [name, body] of Object.entries(renderStory(spec, { default: "some-model" })))
        await writeFile(join(dir, name), body, "utf8");
      const sc = await quiet(() => loadStory(dir));

      assert.equal(sc.premise, spec.premise, "paragraph breaks and all");
      assert.deepEqual(sc.scenes[0], spec.scenes[0]);
      assert.equal(sc.writerStyle.includes("Third person limited. Present tense."), true);
      assert.equal(sc.models.default, "some-model");
      assert.deepEqual(sc.characters.map(c => c.name), ["ELIAS", "MARA"]);

      const elias = sc.characters[0], mara = sc.characters[1];
      assert.equal(elias.knows, spec.characters[0].knows);
      assert.ok(elias.persona.includes("Thirty years of it."));
      // The two things that would silently change the SCENE if they were lost:
      assert.ok(elias.skills.some(s => s.name === "writelog" && s.meaning.startsWith("drafting entries")));
      assert.ok(!mara.skills.some(s => s.name === "hearing"), "a restriction must survive as a real absence");
      assert.ok(mara.skills.some(s => s.name === "sight"), "and must not take anything else with it");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("round-trips a multi-line knows: literally — JSON needs no flattening", async () => {
    const messy = { ...spec, characters: [{ ...spec.characters[0], knows: "One thing.\nAnd another." }, spec.characters[1]] };
    const dir = await mkdtemp(join(tmpdir(), "story-writer-test-"));
    try {
      for (const [name, body] of Object.entries(renderStory(messy, { default: "m" })))
        await writeFile(join(dir, name), body, "utf8");
      const sc = await quiet(() => loadStory(dir));
      assert.equal(sc.characters[0].knows, "One thing.\nAnd another.");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("renders back every config key, models block and per-character model the story file declared", async () => {
    const original = JSON.parse(await readFile(join(ROOT, "stories/doorway/story.json"), "utf8"));
    const { spec } = normalizeSpec(original);
    const rendered = JSON.parse(renderStory(spec, { default: "unused-fallback" })["story.json"]);

    for (const [key, value] of Object.entries(original.config))
      assert.deepEqual(rendered.config[key], value, `config.${key} must survive the round trip`);
    assert.deepEqual(rendered.models, original.models);
    assert.deepEqual(rendered.characters.map((c: any) => c.model),
                     original.characters.map((c: any) => c.model));
  });

  it("an unrelated edit does not disturb config or models", () => {
    const withConfig = normalizeSpec({
      title: "Title", premise: "A premise.",
      scene: { question: "Q?" },
      config: { maxProseWords: 200, maxSteps: 30 },
      models: { default: "model-a", writer: "model-w" },
      characters: [{ name: "SOLO", persona: "Alone.", model: "model-c" }],
    }).spec;

    const edited = quietSync(() => applyEdits(withConfig, { edits: [{ field: "title", value: "New Title" }] })).spec;
    assert.equal(edited.title, "New Title");
    assert.equal(edited.config.maxProseWords, 200, "maxProseWords must be preserved");
    assert.equal(edited.config.maxSteps, 30, "maxSteps must be preserved");
    assert.equal(edited.models.default, "model-a", "models.default must be preserved");
    assert.equal(edited.models.writer, "model-w", "models.writer must be preserved");
    assert.equal(edited.characters[0].model, "model-c", "per-character model must be preserved");
  });

  it("a fresh proposal with no config still renders with schema defaults and fallback model", () => {
    const fresh = normalizeSpec({}).spec;
    const rendered = renderStory(fresh, { default: "fallback-model" });
    const story = JSON.parse(rendered["story.json"]);
    assert.equal(story.config.maxProseWords, 140, "schema default for maxProseWords");
    assert.equal(story.config.maxSteps, 24, "schema default for maxSteps");
    assert.equal(story.models.default, "fallback-model", "fallback model from argument");
    assert.ok(!story.models.writer, "empty writer should not be emitted");
    assert.ok(!story.models.summary, "empty summary should not be emitted");
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
        { t: "scene_start" }, { t: "scene_end", steps: 4, words: 900, done: true, stopped: false },
      ]);
      await addRun(dir, "2026-01-02T00-00-00-000Z", [
        { t: "scene_start" }, { t: "scene_end", steps: 2, words: 300, done: false, stopped: true },
      ]);
      const runs = await retainedRuns(dir);
      assert.deepEqual(runs.map(r => r.id), ["2026-01-02T00-00-00-000Z", "2026-01-01T00-00-00-000Z"]);
      assert.equal(runs[0].stopped, true);
      assert.equal(runs[1].done, true);
      assert.equal(runs[1].words, 900);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("still lists a run killed mid-scene, with its outcome fields simply absent", async () => {
    const dir = await withOut();
    try {
      await addRun(dir, "2026-01-01T00-00-00-000Z", [{ t: "scene_start" }, { t: "draft", step: 1 }]);
      const runs = await retainedRuns(dir);
      assert.equal(runs.length, 1);
      assert.equal(runs[0].done, undefined);
      assert.equal(runs[0].stopped, undefined);
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

describe("LLM interaction log", () => {
  it("llmLogEntry: WRITER gets role writer, anyone else gets role character", () => {
    const w = llmLogEntry({ name: "WRITER", model: "m" }, "2026-01-01T00-00-00.000Z", [], "resp");
    assert.equal(w.role, "writer");
    const c = llmLogEntry({ name: "Anne", model: "m" }, "2026-01-01T00-00-00.000Z", [], "resp");
    assert.equal(c.role, "character");
  });

  it("llmLogEntry: fields pass through unchanged", () => {
    const prompt = [{ role: "system" as const, content: "sys" }];
    const e = llmLogEntry({ name: "Anne", model: "some-model" }, "2026-01-01T00-00-00.000Z", prompt, "raw reply");
    assert.equal(e.ts, "2026-01-01T00-00-00.000Z");
    assert.equal(e.agent, "Anne");
    assert.equal(e.model, "some-model");
    assert.deepEqual(e.prompt, prompt);
    assert.equal(e.response, "raw reply");
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

// -- PROMPTS ---------------------------------------------------------------
describe("prompt construction", () => {
  it("a character is told its skills and its place, and NOT the premise", async () => {
    const sc = await quiet(() => loadStory("stories/doorway"));
    const merritt = sc.characters.find(c => c.name === "MERRITT")!;
    const p = wrapCharacter(merritt, sc.scenes[0].place);
    assert.match(p, /hearing/);
    assert.match(p, /Kessel/);                       // the place
    assert.ok(!p.includes("sight"), "a character must not be shown a skill it lacks");
    assert.ok(!p.includes(sc.premise.slice(0, 40)), "the premise is the author's, not the character's");
  });

  it("the writer is told what each character cannot do, and no personas", async () => {
    const sc = await quiet(() => loadStory("stories/doorway"));
    const p = wrapWriter(sc.premise, sc.scenes[0], writerCast(sc.characters, sc.scenes[0].roster), sc.writerStyle);
    assert.match(p, /MERRITT[\s\S]{0,200}CANNOT: sight/);
    assert.ok(!p.includes("night porter at Kessel's for nine years"),
              "the writer must not be handed the personas");
  });

  it("the writer is told that stillness is a choice and that pressure may not be resolved first", async () => {
    const sc = await quiet(() => loadStory("stories/doorway"));
    const p = wrapWriter(sc.premise, sc.scenes[0], writerCast(sc.characters, sc.scenes[0].roster), sc.writerStyle);
    assert.match(p, /HOLDING STILL IS A CHOICE/);
    assert.match(p, /YOU MAY NOT RESOLVE THE PRESSURE BEFORE YOU ASK ABOUT IT/);
  });

  it("the writer is given the closed `wants` vocabulary, not an invitation to phrase one", async () => {
    const sc = await quiet(() => loadStory("stories/doorway"));
    const p = wrapWriter(sc.premise, sc.scenes[0], writerCast(sc.characters, sc.scenes[0].roster), sc.writerStyle);
    for (const w of CONSULT_WANTS) assert.match(p, new RegExp(`\\b${w}\\b`));
    assert.match(p, /EXACTLY ONE of these four words/);
  });
});

// -- PACING ----------------------------------------------------------------
describe("max_prose_words", () => {
  it("defaults to a real ceiling — several pieces inside one scene's length", async () => {
    const sc = await quiet(() => loadStory("stories/doorway"));
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

// -- THE SCAFFOLD INTERVIEW ------------------------------------------------
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

// -- CHAPTER VALIDATION ----
describe("runChapter validation", () => {
  it("rejects a chapter number below 1, naming the valid range", async () => {
    const sc = await quiet(() => loadStory("stories/doorway"));
    await assert.rejects(() => runChapter(sc, 0, () => {}),
                         (e: Error) => {
                           assert.match(e.message, /1\.\.1/);
                           return true;
                         });
  });

  it("rejects a chapter number above the scene count", async () => {
    const sc = await quiet(() => loadStory("stories/doorway"));
    await assert.rejects(() => runChapter(sc, 2, () => {}),
                         (e: Error) => {
                           assert.match(e.message, /1\.\.1/);
                           return true;
                         });
  });

  it("rejects a non-integer chapter number", async () => {
    const sc = await quiet(() => loadStory("stories/doorway"));
    await assert.rejects(() => runChapter(sc, 1.5, () => {}),
                         (e: Error) => {
                           assert.match(e.message, /integer/);
                           return true;
                         });
  });
});

describe("renderStory shape", () => {
  const bare = normalizeSpec({
    title: "Bare", premise: "A room.", scene: { question: "Does it end?" },
    characters: [{ name: "SOLO", persona: "Alone." }],
  }).spec;

  it("renders exactly one file, regardless of what was left blank", () => {
    const files = renderStory(bare, { default: "m" });
    assert.deepEqual(Object.keys(files), ["story.json"]);
  });

  it("writes empty fields as empty JSON values rather than omitting them, and fills in scene defaults", () => {
    const story = JSON.parse(renderStory(bare, { default: "m" })["story.json"]);
    assert.equal(story.writerStyle, "");
    assert.equal(story.scenes[0].place, "");
    assert.equal(story.scenes[0].pov, "");
    assert.equal(story.scenes[0].length, 700);
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

// -- THE HANDOFF, OVER HTTP ------------------------------------------------
describe("/next-chapter routes", () => {
  const spec = normalizeSpec(STORY).spec;
  const opened: string[] = [];

  const host = (open?: () => Promise<NextChapterSession>): ServerHost => ({
    storyCards: async () => [],
    selectableStory: async (dir: string) => (dir === "stories/doorway" ? "stories/doorway" : null),
    resolveStoryDir: (dir: string) => dir,
    runDirs: async () => [],
    loadedModelIds: async () => null,
    architectModel: async () => "none",
    newScaffoldSession: async () => { throw new Error("not in this test"); },
    newHandoffSession: async (dir: string) => { opened.push(dir); return open ? open() : session([]); },
    directEdit: () => ({ ok: false, reason: "not in this test" }),
    specView: (s) => s,
    outDir: () => "",
  });

  const session = (script: unknown[]) =>
    new NextChapterSession(new ScriptedAgent(script.map(x => JSON.stringify(x))), SCAFFOLD_DEFAULTS,
                           "stories/doorway", spec, [{ n: 1, text: "It happened." }]);

  /** Drive one route call with a fake request/response pair, and hand back what it replied. */
  async function call(path: string, body: unknown, h: ServerHost, method = "POST") {
    const req = Readable.from([JSON.stringify(body ?? {})]) as unknown as IncomingMessage;
    (req as { method?: string }).method = method;
    let code = 0, sent = "";
    const res = {
      writeHead(c: number) { code = c; return res; },
      end(s?: string) { sent = s ?? ""; },
    } as unknown as ServerResponse;
    const handled = await handleNextChapterRoutes(req, res, path, h);
    return { handled, code, body: sent ? JSON.parse(sent) : null };
  }

  it("leaves a path that is not one of its own to the rest of the server", async () => {
    assert.equal((await call("/scaffold/say", {}, host())).handled, false);
    assert.equal((await call("/next-chapter", {}, host(), "GET")).body.active, false);
  });

  it("refuses a story it did not discover, and never opens a session for it", async () => {
    opened.length = 0;
    const r = await call("/next-chapter/start", { dir: "../elsewhere" }, host());
    assert.equal(r.code, 400);
    assert.match(r.body.reason, /no such story/);
    assert.deepEqual(opened, []);
  });

  it("reports why a story cannot be handed off, and stays closed", async () => {
    const h = host(async () => { throw new Error("No chapters written yet in stories/doorway"); });
    const r = await call("/next-chapter/start", { dir: "stories/doorway" }, h);
    assert.equal(r.code, 400);
    assert.match(r.body.reason, /No chapters written yet/);
    assert.equal((await call("/next-chapter", {}, h, "GET")).body.active, false);
    assert.equal((await call("/next-chapter/say", { text: "go on" }, h)).body.reason, "no handoff is open");
  });

  it("will not rewrite the story a run is reading", async () => {
    LIVE.running = true;
    try {
      const r = await call("/next-chapter/start", { dir: "stories/doorway" }, host());
      assert.equal(r.code, 409);
      assert.match(r.body.reason, /a run is in flight/);
    } finally { LIVE.running = false; }
  });

  it("opens, proposes, and publishes the chapter it is preparing", async () => {
    const h = host(async () => session([{ edits: [{ field: "characters.ASTER.goal", value: "Leave." }] }]));
    const r = await quiet(() => call("/next-chapter/start", { dir: "stories/doorway" }, h));
    assert.equal(r.code, 200);
    assert.equal(r.body.active, true);
    assert.equal(r.body.chapter, 2);
    assert.equal(r.body.dir, "stories/doorway");
    assert.equal(r.body.edited, true);
    assert.equal(r.body.last.kind, "edits");
    assert.equal(r.body.spec.characters[0].goal, "Leave.");

    assert.equal((await call("/next-chapter/abandon", {}, h)).body.ok, true);
    assert.equal((await call("/next-chapter", {}, h, "GET")).body.active, false);
  });

  it("names an action it does not have instead of silently doing nothing", async () => {
    const r = await call("/next-chapter/write", {}, host());
    assert.equal(r.code, 404);
    assert.match(r.body.reason, /no such handoff action/);
  });
});

// -- HTTP UTILITIES -------------------------------------------------------
describe("readJsonBody", () => {
  it("resolves to {} when the body is empty", async () => {
    const req = Readable.from([]) as unknown as IncomingMessage;
    const result = await readJsonBody(req);
    assert.deepEqual(result, {});
  });

  it("parses valid JSON", async () => {
    const req = Readable.from([JSON.stringify({ key: "value", num: 42 })]) as unknown as IncomingMessage;
    const result = await readJsonBody(req);
    assert.deepEqual(result, { key: "value", num: 42 });
  });

  it("rejects malformed JSON with HttpError status 400", async () => {
    const req = Readable.from(["{invalid json"]) as unknown as IncomingMessage;
    await assert.rejects(
      () => readJsonBody(req),
      (e: Error) => e instanceof HttpError && (e as HttpError).status === 400);
  });

  it("rejects a body over 1 MiB with HttpError status 413", async () => {
    const oversized = "x".repeat(1024 * 1024 + 1);
    const req = Readable.from([oversized]) as unknown as IncomingMessage;
    await assert.rejects(
      () => readJsonBody(req),
      (e: Error) => e instanceof HttpError && (e as HttpError).status === 413);
  });

  it("accepts a missing Content-Type header (viewer's no-body POSTs send none)", async () => {
    const req = Readable.from([JSON.stringify({ data: "test" })]) as unknown as IncomingMessage;
    (req as { headers?: any }).headers = {};
    const result = await readJsonBody(req);
    assert.deepEqual(result, { data: "test" });
  });

  it("accepts Content-Type: application/json", async () => {
    const req = Readable.from([JSON.stringify({ ok: true })]) as unknown as IncomingMessage;
    (req as { headers?: any }).headers = { "content-type": "application/json" };
    const result = await readJsonBody(req);
    assert.deepEqual(result, { ok: true });
  });

  it("rejects unsupported Content-Type like text/plain with HttpError status 400", async () => {
    const req = Readable.from([JSON.stringify({ data: "test" })]) as unknown as IncomingMessage;
    (req as { headers?: any }).headers = { "content-type": "text/plain" };
    await assert.rejects(
      () => readJsonBody(req),
      (e: Error) => e instanceof HttpError && (e as HttpError).status === 400);
  });
});

// -- RUN CONTROL ROUTES ---------------------------------------------------
describe("handleRunControl", () => {
  /** Helper to drive one route call with a fake request/response pair. */
  async function call(path: string, body: unknown, method = "POST") {
    const req = Readable.from([JSON.stringify(body ?? {})]) as unknown as IncomingMessage;
    (req as { method?: string }).method = method;
    let code = 0, sent = "";
    const res = {
      writeHead(c: number) { code = c; return res; },
      end(s?: string) { sent = s ?? ""; },
    } as unknown as ServerResponse;
    const host = {
      loadedModelIds: async () => ["qwen-new", "qwen-test", "qwen-old"],
    } as unknown as ServerHost;
    const handled = await handleRunControl(req, res, path, host);
    return { handled, code, body: sent ? JSON.parse(sent) : null };
  }

  describe("/stop", () => {
    it("refuses when no run is in progress", async () => {
      resetLive(); LIVE.running = false;
      const r = await call("/stop", {});
      assert.equal(r.code, 400);
      assert.equal(r.body.reason, "no run in progress");
    });

    it("stops the first call and marks it as the first stop", async () => {
      resetLive(); LIVE.running = true; armRun();
      const r = await call("/stop", {});
      assert.equal(r.code, 200);
      assert.equal(r.body.ok, true);
      assert.equal(r.body.already, false, "first stop should return already: false");
      resetLive(); LIVE.running = false;
    });

    it("refuses a second stop rather than being a second stop", async () => {
      resetLive(); LIVE.running = true; armRun();
      await call("/stop", {});
      const r2 = await call("/stop", {});
      assert.equal(r2.code, 200);
      assert.equal(r2.body.ok, true);
      assert.equal(r2.body.already, true, "second stop should return already: true");
      resetLive(); LIVE.running = false;
    });

    it("clears pause-related state when stopping", async () => {
      resetLive(); LIVE.running = true; armRun(); LIVE.pausing = true; LIVE.paused = true;
      await call("/stop", {});
      assert.equal(LIVE.pausing, false);
      assert.equal(LIVE.paused, false);
      resetLive(); LIVE.running = false;
    });
  });

  describe("/pause", () => {
    it("refuses when no run is in progress", async () => {
      resetLive(); LIVE.running = false;
      const r = await call("/pause", {});
      assert.equal(r.code, 400);
      assert.equal(r.body.reason, "no run in progress");
    });

    it("sets pausing flag when run is in progress", async () => {
      resetLive(); LIVE.running = true; armRun();
      const r = await call("/pause", {});
      assert.equal(r.code, 200);
      assert.equal(r.body.ok, true);
      assert.equal(LIVE.pausing, true);
      resetLive(); LIVE.running = false;
    });

    it("returns already: true when already pausing", async () => {
      resetLive(); LIVE.running = true; armRun(); LIVE.pausing = true;
      const r = await call("/pause", {});
      assert.equal(r.code, 200);
      assert.equal(r.body.already, true);
      resetLive(); LIVE.running = false;
    });

    it("returns already: true when already paused", async () => {
      resetLive(); LIVE.running = true; armRun(); LIVE.paused = true;
      const r = await call("/pause", {});
      assert.equal(r.code, 200);
      assert.equal(r.body.already, true);
      resetLive(); LIVE.running = false;
    });
  });

  describe("/resume", () => {
    it("refuses when not paused", async () => {
      resetLive(); LIVE.running = false;
      const r = await call("/resume", {});
      assert.equal(r.code, 400);
      assert.equal(r.body.reason, "not paused");
    });

    it("clears the pausing flag when pausing", async () => {
      resetLive(); LIVE.pausing = true;
      const r = await call("/resume", {});
      assert.equal(r.code, 200);
      assert.equal(r.body.ok, true);
      assert.equal(LIVE.pausing, false);
      resetLive(); LIVE.running = false;
    });

    it("clears the paused flag and calls pauseResolve when paused", async () => {
      resetLive();
      let resolved = false;
      LIVE.paused = true;
      LIVE.pauseResolve = () => { resolved = true; };
      const r = await call("/resume", {});
      assert.equal(r.code, 200);
      assert.equal(LIVE.paused, false);
      assert.equal(resolved, true);
      resetLive(); LIVE.running = false;
    });
  });

  describe("/model", () => {
    it("sets modelOverride when no run is in progress", async () => {
      resetLive(); LIVE.running = false;
      const r = await call("/model", { model: "qwen-test" });
      assert.equal(r.code, 200);
      assert.equal(r.body.ok, true);
      assert.equal(LIVE.modelOverride, "qwen-test");
      LIVE.modelOverride = null;
    });

    it("clears modelOverride when given an empty model string", async () => {
      resetLive(); LIVE.running = false; LIVE.modelOverride = "qwen-test";
      const r = await call("/model", { model: "" });
      assert.equal(r.code, 200);
      assert.equal(r.body.ok, true);
      assert.equal(LIVE.modelOverride, null);
    });

    it("refuses to change model while run is active and not paused", async () => {
      resetLive(); LIVE.running = true; armRun();
      const r = await call("/model", { model: "qwen-test" });
      assert.equal(r.code, 400);
      assert.match(r.body.reason, /pause the run before/);
      resetLive(); LIVE.running = false;
    });

    it("allows model change when run is paused", async () => {
      resetLive(); LIVE.running = true; LIVE.paused = true; armRun();
      const r = await call("/model", { model: "qwen-test" });
      assert.equal(r.code, 200);
      assert.equal(r.body.ok, true);
      LIVE.modelOverride = null;
      resetLive(); LIVE.running = false;
    });

    it("updates writer and agents models when paused with live writer/agents", async () => {
      resetLive(); LIVE.running = true; LIVE.paused = true; armRun();
      const writer = new Agent("writer", "qwen-old", "system", 0.8);
      LIVE.writer = writer;
      LIVE.agents = new Map([["char", new Agent("char", "qwen-old", "system", 0.9)]]);
      const r = await call("/model", { model: "qwen-new" });
      assert.equal(r.code, 200);
      assert.equal(writer.model, "qwen-new");
      assert.equal(LIVE.agents.get("char")!.model, "qwen-new");
      LIVE.modelOverride = null;
      resetLive(); LIVE.running = false;
    });
  });

  describe("/interactive", () => {
    it("toggles interactive on", async () => {
      resetLive(); LIVE.interactive = false;
      const r = await call("/interactive", { on: true });
      assert.equal(r.code, 200);
      assert.equal(LIVE.interactive, true);
      resetLive(); LIVE.interactive = true;
    });

    it("toggles interactive off", async () => {
      resetLive(); LIVE.interactive = true;
      const r = await call("/interactive", { on: false });
      assert.equal(r.code, 200);
      assert.equal(LIVE.interactive, false);
      resetLive(); LIVE.interactive = true;
    });

    it("disarms reader when interactive is turned off", async () => {
      resetLive(); LIVE.interactive = true; LIVE.readerArmed = true;
      const r = await call("/interactive", { on: false });
      assert.equal(r.code, 200);
      assert.equal(LIVE.readerArmed, false);
      resetLive(); LIVE.interactive = true;
    });
  });

  describe("/consult-me (reader consult seat)", () => {
    it("refuses when no run is in progress", async () => {
      resetLive(); LIVE.running = false;
      const r = await call("/consult-me", {});
      assert.equal(r.code, 400);
      assert.equal(r.body.reason, "no run in progress");
    });

    it("refuses when interactive is off", async () => {
      resetLive(); LIVE.running = true; armRun(); LIVE.interactive = false;
      const r = await call("/consult-me", {});
      assert.equal(r.code, 400);
      assert.equal(r.body.reason, "interactive is off");
      LIVE.interactive = true;
      resetLive(); LIVE.running = false;
    });

    it("arms the reader when run is active and interactive", async () => {
      resetLive(); LIVE.running = true; armRun();
      const r = await call("/consult-me", {});
      assert.equal(r.code, 200);
      assert.equal(r.body.ok, true);
      assert.equal(LIVE.readerArmed, true);
      resetLive(); LIVE.running = false;
    });

    it("returns already: true if reader is already armed", async () => {
      resetLive(); LIVE.running = true; armRun(); LIVE.readerArmed = true;
      const r = await call("/consult-me", {});
      assert.equal(r.code, 200);
      assert.equal(r.body.already, true);
      resetLive(); LIVE.running = false;
    });

    it("returns already: true if reader has a resolve callback", async () => {
      resetLive(); LIVE.running = true; armRun(); LIVE.readerResolve = () => {};
      const r = await call("/consult-me", {});
      assert.equal(r.code, 200);
      assert.equal(r.body.already, true);
      LIVE.readerResolve = null;
      resetLive(); LIVE.running = false;
    });
  });

  describe("/reader-answer", () => {
    it("refuses when no reader prompt is pending", async () => {
      resetLive();
      const r = await call("/reader-answer", { answer: "test" });
      assert.equal(r.code, 400);
      assert.equal(r.body.reason, "no reader prompt pending");
    });

    it("refuses an empty answer", async () => {
      resetLive();
      let answered = false;
      LIVE.readerResolve = () => { answered = true; };
      const r = await call("/reader-answer", { answer: "" });
      assert.equal(r.code, 400);
      assert.equal(r.body.reason, "empty answer");
      assert.equal(answered, false);
      resetLive();
    });

    it("accepts and resolves a non-empty answer", async () => {
      resetLive();
      let answer = "";
      LIVE.readerResolve = (a: string) => { answer = a; };
      const r = await call("/reader-answer", { answer: "  the answer  " });
      assert.equal(r.code, 200);
      assert.equal(r.body.ok, true);
      assert.equal(answer, "the answer");
      assert.equal(LIVE.readerResolve, null, "readerResolve should be cleared after resolving");
      resetLive();
    });
  });

  it("returns false for routes it does not handle", async () => {
    const r = await call("/unknown-route", {});
    assert.equal(r.handled, false);
  });

  it("only handles POST and GET methods", async () => {
    resetLive(); LIVE.running = true; armRun();
    const rPut = await call("/stop", {}, "PUT");
    assert.equal(rPut.handled, false);
    resetLive();
  });
});

// -- SSE FRAME PARSER (completeStream) ----------------------------------------
describe("completeStream SSE frame parsing", () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
    armRun();
  });

  /** Helper to create a ReadableStream from an array of chunks. */
  function chunkedStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    let index = 0;
    return new ReadableStream({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(chunks[index++]);
        } else {
          controller.close();
        }
      },
    });
  }

  it("parses a normal multi-frame stream with onDelta called per chunk", async () => {
    armRun();
    const deltas: string[] = [];
    globalThis.fetch = async () => new Response(
      chunkedStream([
        new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'),
        new TextEncoder().encode('data: {"choices":[{"delta":{"content":" world"}}]}\n\n'),
        new TextEncoder().encode('data: [DONE]\n\n'),
      ]),
      { headers: { "content-type": "text/event-stream" } },
    ) as any;
    const result = await completeStream("test-model", [{ role: "user", content: "test" }], 0.8,
                                        (d) => deltas.push(d));
    assert.equal(result, "Hello world");
    assert.deepEqual(deltas, ["Hello", " world"]);
  });

  it("pulls text from reasoning_content when content is empty (Qwen3 thinking)", async () => {
    armRun();
    const deltas: string[] = [];
    globalThis.fetch = async () => new Response(
      chunkedStream([
        new TextEncoder().encode('data: {"choices":[{"delta":{"content":""}}]}\n\n'),
        new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning_content":"Thinking..."}}]}\n\n'),
        new TextEncoder().encode('data: [DONE]\n\n'),
      ]),
      { headers: { "content-type": "text/event-stream" } },
    ) as any;
    const result = await completeStream("test-model", [{ role: "user", content: "test" }], 0.8,
                                        (d) => deltas.push(d));
    assert.equal(result, "Thinking...");
    assert.deepEqual(deltas, ["Thinking..."]);
  });

  it("handles frame split across chunk boundaries mid-JSON", async () => {
    armRun();
    const deltas: string[] = [];
    // Split a JSON frame across two chunks — realistic network case
    const fullFrame = 'data: {"choices":[{"delta":{"content":"Split text"}}]}\n\n';
    const mid = Math.floor(fullFrame.length / 2);
    globalThis.fetch = async () => new Response(
      chunkedStream([
        new TextEncoder().encode(fullFrame.slice(0, mid)),
        new TextEncoder().encode(fullFrame.slice(mid)),
        new TextEncoder().encode('data: [DONE]\n\n'),
      ]),
      { headers: { "content-type": "text/event-stream" } },
    ) as any;
    const result = await completeStream("test-model", [{ role: "user", content: "test" }], 0.8,
                                        (d) => deltas.push(d));
    assert.equal(result, "Split text");
    assert.deepEqual(deltas, ["Split text"]);
  });

  it("skips malformed data: frames without killing the stream", async () => {
    armRun();
    const deltas: string[] = [];
    globalThis.fetch = async () => new Response(
      chunkedStream([
        new TextEncoder().encode('data: {"choices":[{"delta":{"content":"before"}}]}\n\n'),
        new TextEncoder().encode('data: {broken json without closing\n\n'),
        new TextEncoder().encode('data: {"choices":[{"delta":{"content":"after"}}]}\n\n'),
        new TextEncoder().encode('data: [DONE]\n\n'),
      ]),
      { headers: { "content-type": "text/event-stream" } },
    ) as any;
    const result = await completeStream("test-model", [{ role: "user", content: "test" }], 0.8,
                                        (d) => deltas.push(d));
    assert.equal(result, "beforeafter");
    assert.deepEqual(deltas, ["before", "after"], "malformed frame is silently skipped");
  });

  it("handles stream that ends without [DONE] terminator", async () => {
    armRun();
    const deltas: string[] = [];
    globalThis.fetch = async () => new Response(
      chunkedStream([
        new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Incomplete"}}]}\n\n'),
        // No [DONE] — stream just ends
      ]),
      { headers: { "content-type": "text/event-stream" } },
    ) as any;
    const result = await completeStream("test-model", [{ role: "user", content: "test" }], 0.8,
                                        (d) => deltas.push(d));
    assert.equal(result, "Incomplete");
    assert.deepEqual(deltas, ["Incomplete"]);
  });

  it("recovers when stream breaks after text already arrived (recovery path)", async () => {
    armRun();
    const deltas: string[] = [];
    class BreakingStream extends ReadableStream<Uint8Array> {
      constructor() {
        let sent = false;
        super({
          pull(controller) {
            if (!sent) {
              sent = true;
              // Send a complete JSON object so the recovery path recognizes it
              controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"{\\"result\\":\\"kept\\"}"}}]}\n\n'));
            } else {
              controller.error(new Error("stream broke"));
            }
          },
        });
      }
    }
    globalThis.fetch = async () => new Response(new BreakingStream(),
      { headers: { "content-type": "text/event-stream" } }) as any;
    const result = await completeStream("test-model", [{ role: "user", content: "test" }], 0.8,
                                        (d) => deltas.push(d));
    assert.equal(result, '{"result":"kept"}');
    assert.deepEqual(deltas, ['{"result":"kept"}']);
  });

  it("rethrows stream error when RUN.stopped (stops recovery on line 122)", async () => {
    armRun();
    const encoder = new TextEncoder();
    let readCount = 0;
    let hasErrored = false;

    class BreakAfterData extends ReadableStream<Uint8Array> {
      constructor() {
        super({
          pull(controller) {
            readCount++;
            if (readCount === 1) {
              // Send text with complete JSON so recovery would normally keep it
              controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"{\\"result\\":\\"ok\\"}"}}]}\n'));
            } else if (readCount === 2 && !hasErrored) {
              // Second attempt: error the stream
              hasErrored = true;
              controller.error(new Error("stream broke mid-transmission"));
            }
          },
        });
      }
    }

    globalThis.fetch = async () => new Response(new BreakAfterData(),
      { headers: { "content-type": "text/event-stream" } }) as any;

    // Stop the run BEFORE starting the stream — this ensures RUN.stopped=true
    // when the stream error is caught on line 122
    stopRun();

    // Now start a stream that will error — because RUN.stopped is true, the error
    // must be rethrown (line 122) instead of recovered (line 128)
    await assert.rejects(
      () => completeStream("test-model", [{ role: "user", content: "test" }], 0.8, () => {}),
      (e: Error) => e instanceof Error);

    armRun();
  });
});

// -- PAUSE/RESUME HANDSHAKE (loop↔route promise coordination) ---------------
describe("pause/resume handshake", () => {
  /** Helper to call handleRunControl (mimics the one in handleRunControl suite). */
  async function callControl(path: string, body: unknown, method = "POST") {
    const req = Readable.from([JSON.stringify(body ?? {})]) as unknown as IncomingMessage;
    (req as { method?: string }).method = method;
    let code = 0, sent = "";
    const res = {
      writeHead(c: number) { code = c; return res; },
      end(s?: string) { sent = s ?? ""; },
    } as unknown as ServerResponse;
    const host = {
      loadedModelIds: async () => ["test-model"],
    } as unknown as ServerHost;
    const handled = await handleRunControl(req, res, path, host);
    return { handled, code, body: sent ? JSON.parse(sent) : null };
  }

  /** A waiter that is never released would hang the whole suite; fail it instead. Clearing the
   *  timer matters: an uncleared one keeps the loop alive for its full second after the test. */
  function releasedWithin<T>(p: Promise<T>, ifNot: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const guard = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(ifNot)), 1000);
    });
    return Promise.race([p, guard]).finally(() => clearTimeout(timer));
  }

  it("/resume resolves the paused waiter and clears state", async () => {
    resetLive();
    LIVE.running = true;
    LIVE.paused = true;
    armRun();

    let pauseResolvedFlag = false;
    const pauseWaiter = new Promise<void>(res => {
      LIVE.pauseResolve = res;
    }).then(() => { pauseResolvedFlag = true; });

    // Call /resume — should call pauseResolve() to wake the loop
    const r = await callControl("/resume", {});
    assert.equal(r.code, 200);

    await releasedWithin(pauseWaiter, "Pause waiter did not resolve within 1s");

    assert.equal(pauseResolvedFlag, true, "paused waiter must have resolved");
    assert.equal(LIVE.paused, false, "/resume clears paused");
    assert.equal(LIVE.pausing, false, "/resume clears pausing");
    assert.equal(LIVE.pauseResolve, null, "/resume clears pauseResolve");
    resetLive(); LIVE.running = false;
  });

  it("/stop releases a paused waiter to prevent deadlock", async () => {
    resetLive();
    LIVE.running = true;
    LIVE.paused = true;
    armRun();

    let pauseResolvedFlag = false;
    const pauseWaiter = new Promise<void>(res => {
      LIVE.pauseResolve = res;
    }).then(() => { pauseResolvedFlag = true; });

    // Call /stop — must release the paused loop or it will hang forever
    const r = await callControl("/stop", {});
    assert.equal(r.code, 200);

    await releasedWithin(pauseWaiter, "Stop did not release paused waiter — deadlock risk");

    assert.equal(pauseResolvedFlag, true, "stop must release paused waiter to prevent deadlock");
    resetLive(); LIVE.running = false;
  });

  it("resetLive clears all pause state", () => {
    LIVE.pausing = true;
    LIVE.paused = true;
    LIVE.pauseResolve = () => {};
    resetLive();
    assert.equal(LIVE.pausing, false);
    assert.equal(LIVE.paused, false);
    assert.equal(LIVE.pauseResolve, null);
  });
});
