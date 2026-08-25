/**
 * JSON extraction tests — extractJson, topLevelObjects, salvageProse.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractJson, balancedObjectEnd, salvageProse, topLevelObjects } from "../engine/json-extract.ts";

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

  it("reports which path a reply took: JSON, prose fallback, or nothing at all", () => {
    const seen: string[] = [];
    const r = (raw: string) => { seen.length = 0; return extractJson(raw, how => seen.push(how)); };
    r(`{"speech":"hi"}`);
    assert.deepEqual(seen, ["json"]);
    r(`**speech**: Early enough.`);
    assert.deepEqual(seen, ["prose_fallback"]);
    r("no json at all { unclosed");
    assert.deepEqual(seen, ["failed"]);
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
