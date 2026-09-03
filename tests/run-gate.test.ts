/**
 * The startup gate: refuse when the provider is unreachable or a wanted model is unknown to
 * it, warn (not refuse) when a model exists but is not loaded, and stand down when disabled.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { startupRefusal, RUN_GATE } from "../engine/run-gate.ts";
import { PROVIDER } from "../engine/provider.ts";
import type { ModelRuntime } from "../engine/provider-util.ts";
import { WARN } from "../engine/warnings.ts";

const WANTED = ["gemma", "qwen"];

/** Swap the provider's answers for the length of a test. */
function fakeProvider(over: Partial<Pick<typeof PROVIDER, "health" | "listModels" | "inspectModels">> & {
  fullInventory?: boolean;
}) {
  const saved = {
    health: PROVIDER.health, listModels: PROVIDER.listModels, inspectModels: PROVIDER.inspectModels,
    fullInventory: PROVIDER.capabilities.fullInventory,
  };
  if (over.health) PROVIDER.health = over.health;
  if (over.listModels) PROVIDER.listModels = over.listModels;
  if (over.inspectModels) PROVIDER.inspectModels = over.inspectModels;
  if (over.fullInventory !== undefined) PROVIDER.capabilities.fullInventory = over.fullInventory;
  return () => {
    PROVIDER.health = saved.health;
    PROVIDER.listModels = saved.listModels;
    PROVIDER.inspectModels = saved.inspectModels;
    PROVIDER.capabilities.fullInventory = saved.fullInventory;
  };
}

const ids = (...list: string[]) => async () => list;
const inventory = (entries: Record<string, ModelRuntime["state"]>) => async () =>
  new Map(Object.entries(entries).map(([k, state]) =>
    [k, { state, loadedContext: state === "loaded" ? 4096 : 0, maxContext: 8192 }]));

describe("the startup gate", () => {
  let restore: () => void = () => {};
  const lines: string[] = [];
  let origSink: ((msg: string) => void) | null = null;
  afterEach(() => {
    restore();
    RUN_GATE.enabled = true;
    if (origSink) { WARN.sink = origSink; origSink = null; }
  });

  it("refuses when the provider is not answering, naming the endpoint", async () => {
    restore = fakeProvider({ health: async () => false });
    const refusal = await startupRefusal(WANTED);
    assert.match(refusal!, /not answering/);
    assert.match(refusal!, new RegExp(PROVIDER.baseUrl.replace(/[.\\/]/g, "\\$&")));
  });

  it("starts anyway when the server stands but its model list cannot be read", async () => {
    restore = fakeProvider({ health: async () => true, listModels: async () => null });
    assert.equal(await startupRefusal(WANTED), null);
  });

  it("refuses when the server stands but reports an empty catalog", async () => {
    restore = fakeProvider({ health: async () => true, listModels: ids() });
    const refusal = (await startupRefusal(WANTED))!;
    assert.match(refusal, /reports no available models/);
  });

  it("starts when every wanted model is known to the provider", async () => {
    restore = fakeProvider({ health: async () => true, listModels: ids("gemma", "qwen", "other") });
    assert.equal(await startupRefusal(WANTED), null);
  });

  it("refuses naming the models the provider has never heard of", async () => {
    restore = fakeProvider({ health: async () => true, listModels: ids("other") });
    const refusal = await startupRefusal(WANTED);
    assert.match(refusal!, /does not have "gemma", "qwen"/);
    assert.match(refusal!, /or fix the story's models/);
  });

  it("only warns when a model exists natively but is not loaded — full-inventory providers", async () => {
    origSink = WARN.sink;
    WARN.sink = (msg: string) => { lines.push(msg); };
    restore = fakeProvider({
      health: async () => true, listModels: ids("other"), fullInventory: true,
      inspectModels: inventory({ gemma: "not-loaded", qwen: "loading" }),
    });
    assert.equal(await startupRefusal(WANTED), null,
      "downloaded-but-unloaded is the transport's problem, not a refusal");
    assert.ok(lines.some(l => /available but not loaded/.test(l) && /gemma, qwen/.test(l)));
  });

  it("still refuses on a full-inventory provider when the model is not even downloaded", async () => {
    restore = fakeProvider({
      health: async () => true, listModels: ids("other"), fullInventory: true,
      inspectModels: inventory({}),
    });
    assert.match((await startupRefusal(WANTED))!, /does not have "gemma", "qwen"/);
  });

  it("does not consult a native inventory when the provider has none — the list is the truth", async () => {
    restore = fakeProvider({
      health: async () => true, listModels: ids("other"), fullInventory: false,
      inspectModels: async () => { throw new Error("must not be asked"); },
    });
    assert.match((await startupRefusal(WANTED))!, /does not have "gemma"/);
  });

  it("ignores blanks and duplicates in the wanted list", async () => {
    restore = fakeProvider({ health: async () => true, listModels: ids("other") });
    const refusal = (await startupRefusal(["", "gemma", "gemma"]))!;
    assert.match(refusal, /does not have "gemma"/);
    assert.doesNotMatch(refusal, /"gemma", "gemma"/, "the refusal names the model once");
  });

  it("says nothing at all when the story names no models", async () => {
    restore = fakeProvider({ health: async () => { throw new Error("must not be asked"); } });
    assert.equal(await startupRefusal([]), null);
    assert.equal(await startupRefusal(["", "  "]), null);
  });

  it("stands down entirely when disabled, asking the provider nothing", async () => {
    restore = fakeProvider({ health: async () => { throw new Error("must not be asked"); } });
    RUN_GATE.enabled = false;
    assert.equal(await startupRefusal(WANTED), null);
  });
});
