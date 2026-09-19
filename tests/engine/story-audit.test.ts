/**
 * Story-audit tests — how current an authored story is against today's engine, in three tiers.
 * Deterministic: no model, no provider call. Stories are written to a temp folder per case, so
 * nothing here depends on whatever the author happens to keep under data/stories/.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { auditStory, auditStories, passesBar, AUDIT_LEVELS } from "../../engine/story-audit.ts";

let root = "";
before(async () => { root = await mkdtemp(join(tmpdir(), "story-audit-")); });
after(async () => { await rm(root, { recursive: true, force: true }); });

/** A story whose only gaps are the ones a case asks for: everything else is filled, so a finding
 *  in a result is the case's own doing and not the fixture's. */
const CURRENT = {
  title: "T", premise: "P",
  writerStyleConstraints: ["keep the corridor cold"],
  facts: ["the door is locked"],
  timeline: [{ chapter: 1, hold: "a knock is coming", fired: "a knock lands" }],
  scenes: [{ place: "a corridor", question: "Does she open it?", pov: "ADA", length: 400 }],
  characters: [{
    name: "ADA", persona: "a courier", knows: "the route", goal: "get in",
    belief: "nobody checks", impulse: "when challenged → smile", voice: ["Evening."],
    pronouns: { subject: "she", object: "her", possessive: "her", reflexive: "herself" },
  }],
};

async function story(name: string, patch: (s: any) => void = () => {}) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  const s = structuredClone(CURRENT) as any;
  patch(s);
  await writeFile(join(dir, "story.json"), JSON.stringify(s), "utf8");
  return dir;
}

const checks = (a: { findings: { check: string }[] }) => a.findings.map(f => f.check);

describe("passesBar", () => {
  it("is strictly better than the bar, so a bar can exclude its own tier", () => {
    assert.equal(passesBar("dated", "degraded"), true);
    assert.equal(passesBar("degraded", "degraded"), false, "a bar must exclude the tier it names");
    assert.equal(passesBar("broken", "broken"), false, "otherwise broken could never be excluded");
    assert.equal(passesBar("current", "dated"), true);
  });

  it("orders the levels worst-first", () => {
    assert.deepEqual([...AUDIT_LEVELS], ["broken", "degraded", "dated", "current"]);
  });
});

describe("auditStory — broken", () => {
  it("reports a folder with no story.json rather than throwing", async () => {
    const dir = join(root, "empty");
    await mkdir(dir, { recursive: true });
    const a = await auditStory(dir);
    assert.equal(a.level, "broken");
    assert.deepEqual(checks(a), ["unreadable"]);
    assert.match(a.error!, /no story\.json/);
  });

  it("reports unparseable JSON as broken, with the parser's own reason", async () => {
    const dir = join(root, "broken-json");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "story.json"), "{ not json", "utf8");
    const a = await auditStory(dir);
    assert.equal(a.level, "broken");
    assert.match(a.error!, /not valid JSON/);
  });

  it("reports a schema failure as broken, and never as a pile of feature gaps", async () => {
    const a = await auditStory(await story("invalid", s => { s.scenes = []; }));
    assert.equal(a.level, "broken");
    assert.deepEqual(checks(a), ["invalid"], "one verdict, not one per unreachable check");
  });

  it("leaves the cast-less refusal to the loader, and carries its wording", async () => {
    const a = await auditStory(await story("nocast", s => { s.characters = []; s.scenes[0].pov = ""; }));
    assert.equal(a.level, "broken");
    assert.deepEqual(checks(a), ["invalid"], "one verdict — the audit adds no second opinion here");
    assert.match(a.error!, /nobody to consult/);
  });
});

describe("auditStory — degraded: a shipped check cannot see the story", () => {
  it("flags missing pronouns, which nothing else reports at any point", async () => {
    const a = await auditStory(await story("nopronouns", s => { delete s.characters[0].pronouns; }));
    assert.equal(a.level, "degraded");
    assert.ok(checks(a).includes("no-pronouns"));
    assert.match(a.findings.find(f => f.check === "no-pronouns")!.effect, /pronoun-lint skips them/);
  });

  it("names only the characters missing them when the cast is mixed", async () => {
    const a = await auditStory(await story("mixed", s => {
      s.characters.push({ ...structuredClone(s.characters[0]), name: "BEN" });
      delete s.characters[1].pronouns;
    }));
    const f = a.findings.find(x => x.check === "no-pronouns")!;
    assert.equal(f.where, "BEN");
    assert.match(f.what, /1 of 2/);
  });

  it("flags a restriction with no :: meaning, per character", async () => {
    const a = await auditStory(await story("bareLimit", s => { s.characters[0].restrictions = ["sight"]; }));
    assert.equal(a.level, "degraded");
    const f = a.findings.find(x => x.check === "restriction-no-meaning")!;
    assert.equal(f.where, "ADA");
    assert.match(f.what, /"sight"/);
  });

  it("passes a restriction that carries one", async () => {
    const a = await auditStory(await story("goodLimit", s => {
      s.characters[0].restrictions = ["sight :: she reads the room by sound and draught"];
    }));
    assert.ok(!checks(a).includes("restriction-no-meaning"));
  });

  it("flags a scene with no question, and one whose pov is nobody", async () => {
    const a = await auditStory(await story("thinscene", s => {
      s.scenes[0].question = ""; s.scenes[0].pov = "NOBODY";
    }));
    assert.equal(a.level, "degraded");
    assert.deepEqual(checks(a).filter(c => c.startsWith("no-question") || c === "pov-not-cast"),
      ["no-question", "pov-not-cast"]);
    assert.equal(a.findings.find(f => f.check === "no-question")!.where, "scene 1");
  });
});

describe("auditStory — dated: it works, it predates something", () => {
  it("does not call an absent timeline, facts or style constraint a defect", async () => {
    const a = await auditStory(await story("dated", s => {
      s.timeline = []; s.facts = []; s.writerStyleConstraints = [];
    }));
    assert.equal(a.level, "dated", "nothing here stops a check running");
    assert.deepEqual(checks(a).sort(), ["no-facts", "no-style-constraints", "no-timeline"]);
  });

  it("reuses the cast-sheet wording for thin psychology rather than restating it", async () => {
    const a = await auditStory(await story("thin", s => { s.characters[0].belief = ""; }));
    assert.equal(a.level, "dated");
    assert.match(a.findings.find(f => f.check === "thin-psychology")!.what, /has no belief/);
  });

  it("is `current` when nothing is missing at all", async () => {
    const a = await auditStory(await story("full"));
    assert.equal(a.level, "current");
    assert.deepEqual(a.findings, []);
  });
});

describe("auditStory — the record it hands back", () => {
  it("carries the loader's own warnings verbatim, unclassified", async () => {
    const a = await auditStory(await story("warns", s => { s.characters[0].restrictions = ["sight"]; }));
    assert.ok(a.loadWarnings.some(w => /no ":: meaning"/.test(w)),
      "the loader's wording travels as-is, so the audit never has to keep a copy in step");
  });

  it("restores the warning sink, so an audit cannot silence the next caller", async () => {
    const seen: string[] = [];
    const { WARN } = await import("../../engine/warnings.ts");
    const orig = WARN.sink;
    WARN.sink = (m: string) => { seen.push(m); };
    try {
      await auditStory(await story("sink", s => { s.characters[0].restrictions = ["sight"]; }));
      assert.deepEqual(seen, [], "captured during the audit, not leaked");
      WARN.sink("after");
      assert.deepEqual(seen, ["after"], "and the caller's own sink is back");
    } finally { WARN.sink = orig; }
  });

  it("takes the worst finding as the level, not the commonest", async () => {
    const a = await auditStory(await story("worst", s => {
      s.timeline = []; s.facts = []; s.writerStyleConstraints = [];
      delete s.characters[0].pronouns;
    }));
    assert.equal(a.level, "degraded");
    assert.equal(a.findings.filter(f => f.level === "dated").length, 3);
  });

  it("audits several stories in order, and one bad folder does not stop the rest", async () => {
    const dirs = [await story("a"), join(root, "missing"), await story("b")];
    const all = await auditStories(dirs);
    assert.deepEqual(all.map(x => x.level), ["current", "broken", "current"]);
  });
});
