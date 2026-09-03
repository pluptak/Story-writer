/** Routes for the scaffold interview: the staged checklist (start/approve/say) and cleanup. */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { ScaffoldSession } from "../engine/architect.ts";
import type { Defaults } from "../engine/story-format.ts";
import type { Concept } from "../server/server.ts";
import { LIVE, resetLive } from "../live.ts";
import { handleScaffoldRoutes } from "../server/scaffold-routes.ts";
import type { ServerHost } from "../server/server.ts";
import { callRoute, quiet, ScriptedAgent } from "./helpers.ts";

const DEFAULTS: Defaults = {
  models: { default: "none", architect: "none" },
  thinking: { architect: "low" },
  requestTimeout: 120, attempts: 3, maxTokens: 2000, stream: false, debug: false,
};

const STORY_STAGE = {
  title: "The Fog Signal",
  premise: "Two keepers, one lamp.",
  tension: "Aster wants the log kept honest; Brae wants the night buried.",
};
const CAST_STAGE = {
  characters: [
    { name: "ASTER", persona: "Keeps the log.", knows: "It did not fire.", goal: "An honest log",
      belief: "Logs are sacred.", impulse: "when doubted, quotes the book", voice: ["The log is the log."],
      skills: [], restrictions: [] },
    { name: "BRAE", persona: "From the boats.", knows: "", goal: "A quiet winter", belief: "Paper sinks men",
      impulse: "when cornered, gets friendlier", voice: ["Weather beats paperwork."], skills: [],
      restrictions: ["hearing"] },
  ],
};

describe("/scaffold routes", () => {
  afterEach(() => resetLive());

  const LIB = [
    { id: "lib-ivet", version: 2, name: "IVET", portablePersona: "Ex-locksmith.", belief: "b",
      impulse: "i", voice: ["v"], skills: ["lockpicking :: opening a lock"], restrictions: ["sight"] },
    { id: "lib-merritt", version: 1, name: "MERRITT", portablePersona: "From the boats.", belief: "b2",
      impulse: "i2", voice: [], skills: [], restrictions: [] },
  ];

  const host = (script: unknown[], knownTags: string[] = ["bleak", "adventure"]): ServerHost => ({
    availableModelIds: async () => null,
    specView: (s: unknown) => s,
    unknownTags: async (tags: string[]) =>
      tags.filter(t => !knownTags.includes(t.trim().toLowerCase())),
    importCharacters: async (ids: string[]) => {
      const byId = new Map(LIB.map(e => [e.id, e]));
      const imported = [];
      const missing = [];
      for (const id of ids) {
        const e = byId.get(id);
        if (!e) { missing.push(id); continue; }
        imported.push({
          libraryId: e.id, version: e.version, name: e.name, portablePersona: e.portablePersona,
          belief: e.belief, impulse: e.impulse,
          voice: [...e.voice], skills: [...e.skills], restrictions: [...e.restrictions],
        });
      }
      return { imported, missing };
    },
    newScaffoldSession: async (idea: string, _model?: string, mode?: "oneshot" | "staged", concept?: Concept) =>
      new ScaffoldSession(new ScriptedAgent(script.map(s => JSON.stringify(s))),
                          DEFAULTS, idea, undefined, mode ?? "staged", undefined,
                          concept?.tags ?? [], concept?.castSize ?? 0),
  }) as unknown as ServerHost;

  const post = (path: string, body?: unknown, h: ServerHost = host([])) =>
    quiet(() => callRoute(handleScaffoldRoutes, path, body ?? {}, h));

  it("opens a staged checklist and passes one approved gate at a time", async () => {
    const h = host([STORY_STAGE, CAST_STAGE]);
    LIVE.awaitingPick = true;
    const opened = await post("/scaffold/start", { idea: "two lighthouse keepers" }, h);
    assert.equal(opened.handled, true);
    assert.equal(opened.body.active, true);
    assert.equal(opened.body.mode, "staged");
    assert.equal(opened.body.gate, "story");
    assert.equal(opened.body.haveDraft, true);
    assert.equal(opened.body.spec.title, "The Fog Signal", "the first gate is visible before the cast lands");
    assert.equal(opened.body.spec.premise, "Two keepers, one lamp.");
    assert.equal(opened.body.haveStory, false);

    const next = await post("/scaffold/approve", {}, h);
    assert.equal(next.body.gate, "cast");
    assert.equal(next.body.spec.characters.length, 2);
    assert.equal(next.body.spec.title, "The Fog Signal", "earlier stages survive the merge");
    assert.equal(next.body.haveStory, true);

    const state = await callRoute(handleScaffoldRoutes, "/scaffold", {}, h, "GET");
    assert.equal(state.body.gate, "cast", "GET reports where the checklist stands");
  });

  it("defaults to the staged walk when no mode is named", async () => {
    LIVE.awaitingPick = true;
    const opened = await post("/scaffold/start", { idea: "two lighthouse keepers" }, host([STORY_STAGE]));
    assert.equal(opened.body.mode, "staged");
  });

  it("keeps the draft hidden when the architect asks before authoring anything", async () => {
    LIVE.awaitingPick = true;
    const opened = await post("/scaffold/start", { idea: "two lighthouse keepers" }, host([{ ask: "Which keeper lied?" }]));
    assert.equal(opened.body.haveDraft, false);
    assert.equal(opened.body.spec, null);
    assert.equal(opened.body.pendingAsk, "Which keeper lied?");
  });

  it("approve on a one-shot session is a failed round, not a crash", async () => {
    LIVE.awaitingPick = true;
    const opened = await post("/scaffold/start",
                              { idea: "two lighthouse keepers", mode: "oneshot" }, host([{ ask: "?" }]));
    assert.equal(opened.body.mode, "oneshot");
    assert.equal(opened.body.gate, null, "a one-shot session has no gate");
    const r = await post("/scaffold/approve", {});
    assert.equal(r.body.last.kind, "failed");
    assert.match(r.body.last.error, /not running the staged checklist/);
  });

  it("an empty gate cannot be waved through", async () => {
    const h = host([STORY_STAGE, { note: "thinking about it" }]);
    LIVE.awaitingPick = true;
    await post("/scaffold/start", { idea: "two lighthouse keepers" }, h);
    const first = await post("/scaffold/approve", {}, h);   // the cast round lands as nothing
    assert.equal(first.body.gate, "cast");
    const blocked = await post("/scaffold/approve", {}, h); // the gate is still empty
    assert.equal(blocked.body.last.kind, "nothing");
    assert.match(blocked.body.last.why, /has not landed/);
    assert.equal(blocked.body.gate, "cast");
  });

  // -- ABANDON VERSUS WORK IN FLIGHT -----------------------------------------
  // An abandon landing while an architect round is still awaiting must strip that round of its
  // right to commit: no resurrected session, no picker resolution, no success report.
  const yieldMicrotasks = () => new Promise(r => setTimeout(r, 0));

  it("abandon during start means the arriving session is discarded, not resurrected", async () => {
    LIVE.awaitingPick = true;
    let release!: (s: ScaffoldSession) => void;
    const gated = new Promise<ScaffoldSession>(r => { release = r; });
    const h = { ...host([]), newScaffoldSession: () => gated } as unknown as ServerHost;

    const startP = post("/scaffold/start", { idea: "two lighthouse keepers" }, h);
    await yieldMicrotasks();                       // let start reach its await
    await post("/scaffold/abandon", {}, h);        // the user walks away mid-build
    release(new ScaffoldSession(new ScriptedAgent([]), DEFAULTS, "two lighthouse keepers"));
    const started = await startP;

    assert.equal(started.code, 409);
    assert.match(started.body.reason, /abandoned/);
    const state = await callRoute(handleScaffoldRoutes, "/scaffold", {}, h, "GET");
    assert.equal(state.body.active, false, "the late session must not reopen the interview");
    const approve = await post("/scaffold/approve", {}, h);
    assert.equal(approve.body.reason, "no interview is open");
  });

  it("abandon during accept neither resolves the pick nor reports success", async () => {
    LIVE.awaitingPick = true;
    let picked: unknown = undefined;
    LIVE.pickResolve = (p: unknown) => { picked = p; };
    try {
      // Open a session whose accept hangs until the test releases it.
      let fireAccept!: (r: unknown) => void;
      const gated = new Promise(r => { fireAccept = r; });
      const session = {
        idea: "two lighthouse keepers", mode: "staged", stage: "", tension: "",
        pendingAsk: null, problems: [], edited: [], imported: [],
        defaults: { models: { architect: "none" } },
        // scaffoldState reads these fields directly, exactly as it does on a real early-session
        spec: { title: "", premise: "", characters: [], writerStyle: "", facts: [], scenes: [] },
        haveStory: () => true,
        bibleCandidates: () => [],
        propose: async () => ({ kind: "edits", applied: [], ignored: [], flags: [], note: "" }),
        say: async () => ({ kind: "edits", applied: [], ignored: [], flags: [], note: "" }),
        approve: async () => ({ kind: "edits", applied: [], ignored: [], flags: [], note: "" }),
        accept: () => gated,
        setSpec: () => ({}),
      } as unknown as ScaffoldSession;
      const h = { ...host([]),
        newScaffoldSession: async () => session } as unknown as ServerHost;
      await post("/scaffold/start", { idea: "two lighthouse keepers" }, h);

      const acceptP = post("/scaffold/accept", { folder: "the-fog-signal" }, h);
      await yieldMicrotasks();
      await post("/scaffold/abandon", {}, h);
      fireAccept({ kind: "written", dir: "stories/the-fog-signal", files: [], warnings: [] });
      const accepted = await acceptP;

      assert.equal(accepted.code, 409);
      assert.match(accepted.body.reason, /abandoned while accepting/);
      assert.equal(picked, undefined, "the parked pick must stay parked");
      assert.equal(LIVE.awaitingPick, true, "and still armed");
      const state = await callRoute(handleScaffoldRoutes, "/scaffold", {}, h, "GET");
      assert.equal(state.body.active, false);
    } finally {
      LIVE.pickResolve = null; LIVE.awaitingPick = false;
    }
  });

  describe("the author's concept", () => {
    it("carries the author's tags and cast size onto the session", async () => {
      LIVE.awaitingPick = true;
      const opened = await post("/scaffold/start", { idea: "...", tags: ["bleak"], castSize: 3 }, host([STORY_STAGE]));
      assert.equal(opened.body.active, true);
      assert.deepEqual(opened.body.concept.tags, ["bleak"]);
      assert.equal(opened.body.concept.castSize, 3);
      assert.deepEqual(opened.body.concept.unknownTags, []);
    });

    it("reports a tag the catalog does not hold, and opens anyway", async () => {
      LIVE.awaitingPick = true;
      const opened = await post("/scaffold/start", { idea: "...", tags: ["bleak", "sasquatch"] }, host([STORY_STAGE]));
      assert.equal(opened.body.active, true);
      assert.deepEqual(opened.body.concept.unknownTags, ["sasquatch"]);
    });

    it("refuses a cast size the cast stage could not honour", async () => {
      LIVE.awaitingPick = true;
      const h = host([STORY_STAGE]);
      await post("/scaffold/abandon", {}, h);  // clear any prior session
      const result = await post("/scaffold/start", { idea: "...", castSize: 9 }, h);
      assert.equal(result.code, 400);
      assert.equal(result.body.ok, false);
      assert.match(result.body.reason, /0 to 4/);
    });

    it("refuses more tags than a prompt should carry", async () => {
      LIVE.awaitingPick = true;
      const tags = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
      const result = await post("/scaffold/start", { idea: "...", tags }, host([STORY_STAGE]));
      assert.equal(result.code, 400);
      assert.equal(result.body.ok, false);
      assert.match(result.body.reason, /at most 8/);
    });

    it("the concept can be revised while the session is open", async () => {
      LIVE.awaitingPick = true;
      const h = host([STORY_STAGE]);
      const opened = await post("/scaffold/start", { idea: "..." }, h);
      assert.equal(opened.body.active, true);
      const revised = await post("/scaffold/concept", { tags: ["adventure"], castSize: 2 }, h);
      assert.equal(revised.body.active, true);
      assert.deepEqual(revised.body.concept.tags, ["adventure"]);
      assert.equal(revised.body.concept.castSize, 2);
    });

    // Each half is spent when the stage that reads it has produced content — not when its gate
    // opens. Cast size is at its most live during the STORY gate, because the cast prompt that
    // will read it has not been built yet.
    it("each half of the concept stops steering once the stage that reads it has landed", async () => {
      const h = host([STORY_STAGE, CAST_STAGE]);
      LIVE.awaitingPick = true;
      const opened = await post("/scaffold/start", { idea: "...", tags: ["bleak"], castSize: 2 }, h);
      assert.equal(opened.body.concept.tagsSteer, true, "the story gate is open, so tags still steer it");
      assert.equal(opened.body.concept.castSizeSteers, true, "no cast yet, so the cast prompt is still ahead");
      const next = await post("/scaffold/approve", {}, h);
      assert.equal(next.body.concept.tagsSteer, false, "the story stage has landed; no later prompt reads tags");
      assert.equal(next.body.concept.castSizeSteers, false, "the cast has landed; the size was already spent");
    });

    it("a one-shot walk has no gate for the concept to steer", async () => {
      LIVE.awaitingPick = true;
      const opened = await post("/scaffold/start", { idea: "...", mode: "oneshot", tags: ["bleak"], castSize: 3 }, host([{ ask: "?" }]));
      assert.equal(opened.body.concept.tagsSteer, false);
      assert.equal(opened.body.concept.castSizeSteers, false);
    });

    it("revising the concept before an interview is open is refused", async () => {
      const h = host([]);
      await post("/scaffold/abandon", {}, h);  // ensure no session is open
      const result = await post("/scaffold/concept", { tags: ["adventure"] }, h);
      assert.equal(result.body.reason, "no interview is open");
    });

    it("an imported cast reaches the session's tray", async () => {
      LIVE.awaitingPick = true;
      const opened = await post("/scaffold/start", { idea: "...", importIds: ["lib-ivet"] }, host([STORY_STAGE]));
      assert.equal(opened.body.active, true);
      assert.deepEqual(opened.body.concept.imported, [{ libraryId: "lib-ivet", version: 2, name: "IVET" }]);
      assert.deepEqual(opened.body.concept.missingImports, []);
    });

    it("an id the catalog no longer holds is reported, and the session still opens", async () => {
      LIVE.awaitingPick = true;
      const opened = await post("/scaffold/start", { idea: "...", importIds: ["lib-ivet", "gone"] }, host([STORY_STAGE]));
      assert.equal(opened.body.active, true);
      assert.equal(opened.body.concept.imported.length, 1);
      assert.deepEqual(opened.body.concept.missingImports, ["gone"]);
    });

    it("the tray refuses more characters than the cast stage could hold", async () => {
      LIVE.awaitingPick = true;
      const h = host([]);
      const result = await post("/scaffold/start", { idea: "...", importIds: ["a", "b", "c", "d", "e"] }, h);
      assert.equal(result.code, 400);
      assert.match(result.body.reason, /at most 4/);
    });

    it("an imported tray takes over from the cast size", async () => {
      LIVE.awaitingPick = true;
      const opened = await post("/scaffold/start", { idea: "...", importIds: ["lib-ivet"], castSize: 3 }, host([STORY_STAGE]));
      assert.equal(opened.body.concept.castSizeSteers, false, "castSizeSteers is false when tray is populated");
      assert.equal(opened.body.concept.importsSteer, true, "importsSteer is true when no cast exists yet");

      // Also test the other direction: with NO imports and castSize: 3
      LIVE.awaitingPick = true;
      const h = host([STORY_STAGE]);
      await post("/scaffold/abandon", {}, h);  // clear prior session
      const plain = await post("/scaffold/start", { idea: "...", importIds: [], castSize: 3 }, h);
      assert.equal(plain.body.concept.castSizeSteers, true, "castSizeSteers is true when tray is empty");
      assert.equal(plain.body.concept.importsSteer, true, "importsSteer is true when no cast exists");
    });

    it("the tray can be replaced on an open session", async () => {
      LIVE.awaitingPick = true;
      const h = host([STORY_STAGE]);
      await post("/scaffold/start", { idea: "..." }, h);

      const updated = await post("/scaffold/import", { importIds: ["lib-merritt"] }, h);
      assert.equal(updated.body.active, true);
      assert.equal(updated.body.concept.imported.length, 1);
      assert.deepEqual(updated.body.concept.imported[0].name, "MERRITT");

      const cleared = await post("/scaffold/import", { importIds: [] }, h);
      assert.equal(cleared.body.concept.imported.length, 0, "replacement, not accumulation");
    });

    // `start` overwrites the session in place, so anything it does not reassign belongs to the
    // interview before it. A report of a character the author never asked for is exactly the kind
    // of leak that reads as a real problem with the story in front of them.
    it("a fresh interview does not inherit the last one's missing imports", async () => {
      LIVE.awaitingPick = true;
      const h = host([STORY_STAGE]);
      const first = await post("/scaffold/start", { idea: "...", importIds: ["gone"] }, h);
      assert.deepEqual(first.body.concept.missingImports, ["gone"]);

      LIVE.awaitingPick = true;
      const second = await post("/scaffold/start", { idea: "...", importIds: [] }, host([STORY_STAGE]));
      assert.deepEqual(second.body.concept.missingImports, [], "the new session starts clean");
      assert.deepEqual(second.body.concept.imported, []);
    });

    it("importing before an interview is open is refused", async () => {
      const h = host([]);
      await post("/scaffold/abandon", {}, h);  // ensure no session is open
      const result = await post("/scaffold/import", { importIds: ["lib-ivet"] }, h);
      assert.equal(result.body.reason, "no interview is open");
    });
  });

  describe("promoting a bespoke skill", () => {
    it("a candidate can be promoted, and stops being one", async () => {
      const CAST_WITH_SKILL = {
        characters: [
          { name: "A", persona: "Keeper.", knows: "", goal: "",
            belief: "Lights matter.", impulse: "when doubtful, tends the lamp", voice: ["The lamp is all."],
            skills: ["tidewalking :: reading the turn of a tide"], restrictions: [] },
        ],
      };
      const SETTINGS_STAGE = { writer_style: "Plain prose." };
      const h = {
        ...host([STORY_STAGE, CAST_WITH_SKILL, SETTINGS_STAGE]),
        promoteSkill: async (name: string, meaning: string) => {
          // The fake returns a bible that knows the promoted skill, so it ceases being a candidate.
          const newBible = { tidewalking: meaning };
          return { ok: true as const, bible: (n: string) => newBible[n as keyof typeof newBible], problems: [] };
        },
      } as unknown as ServerHost;
      LIVE.awaitingPick = true;
      const opened = await post("/scaffold/start", { idea: "..." }, h);
      assert.equal(opened.body.gate, "story");

      // Approve story gate to get to cast gate
      const atCast = await post("/scaffold/approve", {}, h);
      assert.equal(atCast.body.gate, "cast");
      assert.equal(atCast.body.bibleCandidates.length, 1);
      assert.equal(atCast.body.bibleCandidates[0].name, "tidewalking");

      // Promote the skill
      const promoted = await post("/scaffold/promote", { name: "tidewalking" }, h);
      assert.equal(promoted.body.bibleCandidates.length, 0, "the skill stops being a candidate");
    });

    it("a skill the session is not offering cannot be promoted", async () => {
      const h = host([STORY_STAGE, CAST_STAGE]);
      LIVE.awaitingPick = true;
      await post("/scaffold/start", { idea: "..." }, h);
      const result = await post("/scaffold/promote", { name: "unknown-skill" }, h);
      assert.equal(result.code, 400);
      assert.equal(result.body.ok, false);
      assert.match(result.body.reason, /not a promotion candidate/);
    });
  });
});
