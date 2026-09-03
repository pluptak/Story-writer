/**
 * Model readiness before the first attempt: waiting out a load in progress, the once-per-model
 * not-loaded warning, the load-timeout budget, and the capability gate that skips it all.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { complete, NET, ModelLoadTimeoutError } from "../engine/llm-client.ts";
import { PROVIDER, makeProvider } from "../engine/provider.ts";
import type { ModelRuntime } from "../engine/provider-util.ts";
import { WARN } from "../engine/warnings.ts";
import { armRun } from "../live.ts";

const MSGS = [{ role: "user" as const, content: "test" }];
const chatReply = () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
const chatUrl = (url: string) => url.endsWith("/chat/completions");

/** Swap in a fake inspection sequence, restore everything on the way out. */
function fakeInspect(seq: Array<Map<string, ModelRuntime> | null>) {
  const orig = PROVIDER.inspectModels;
  let n = 0;
  PROVIDER.inspectModels = async () => seq[Math.min(n++, seq.length - 1)];
  return () => { PROVIDER.inspectModels = orig; };
}

const rt = (state: ModelRuntime["state"], id = "m"): Map<string, ModelRuntime> =>
  new Map([[id, { state, loadedContext: 4096, maxContext: 8192 }]]);

describe("model readiness before the first attempt", () => {
  const origFetch = globalThis.fetch;
  let restore: () => void = () => {};
  const savedCap = PROVIDER.capabilities.modelRuntimeInspection;
  afterEach(() => {
    globalThis.fetch = origFetch;
    restore();
    PROVIDER.capabilities.modelRuntimeInspection = savedCap;
    armRun();
  });

  it("waits while the server loads the model, then sends the call", async () => {
    PROVIDER.capabilities.modelRuntimeInspection = true;
    NET.loadWaitMs = 5_000;
    restore = fakeInspect([rt("loading"), rt("loading"), rt("loaded")]);
    let chat = 0;
    globalThis.fetch = (async (url: any) => {
      if (!chatUrl(String(url))) return new Response("{}", { status: 200 }) as any;
      chat++;
      return chatReply();
    }) as any;
    armRun();
    const result = await complete("m", MSGS, 0.5);
    assert.equal(result.text, "ok");
    assert.equal(chat, 1);
  });

  it("stops waiting when the load never finishes, without spending the chat call", async () => {
    PROVIDER.capabilities.modelRuntimeInspection = true;
    NET.loadWaitMs = 30;
    restore = fakeInspect([rt("loading")]);
    let chat = 0;
    globalThis.fetch = (async () => { chat++; return chatReply(); }) as any;
    armRun();
    await assert.rejects(
      () => complete("m", MSGS, 0.5),
      (e: Error) => e instanceof ModelLoadTimeoutError && /still loading/.test(e.message));
    assert.equal(chat, 0);
  });

  it("warns once per model when the server reports it not loaded, and sends the call anyway", async () => {
    PROVIDER.capabilities.modelRuntimeInspection = true;
    restore = fakeInspect([rt("not-loaded", "never-loaded-model")]);
    let chat = 0;
    globalThis.fetch = (async (url: any) => {
      if (!chatUrl(String(url))) return new Response("{}", { status: 200 }) as any;
      chat++;
      return chatReply();
    }) as any;
    armRun();
    const lines: string[] = [];
    const origSink = WARN.sink;
    WARN.sink = (...a: unknown[]) => lines.push(a.map(String).join(" "));
    try {
      await complete("never-loaded-model", MSGS, 0.5);
      await complete("never-loaded-model", MSGS, 0.5);
    } finally {
      WARN.sink = origSink;
    }
    assert.equal(chat, 2, "the engine never loads models itself — the call goes out as-is");
    const warns = lines.filter(l => /not loaded in/.test(l));
    assert.equal(warns.length, 1, "the not-loaded warning fires once per model, not once per call");
  });

  it("is skipped entirely when the provider cannot inspect runtime state", async () => {
    PROVIDER.capabilities.modelRuntimeInspection = false;
    restore = fakeInspect([rt("loading")]);
    globalThis.fetch = (async () => chatReply()) as any;
    armRun();
    const result = await complete("m", MSGS, 0.5);
    assert.equal(result.text, "ok");
  });

  // -- THE FIRST-CALL GRACE FOR A COLD MODEL ----------------------------------
  const savedNet = () => ({ timeoutMs: NET.timeoutMs, loadWaitMs: NET.loadWaitMs, retries: NET.retries, backoffMs: NET.backoffMs });

  /** A chat fetch that answers after `ms` — aborting early if the transport gave up on it. */
  const slowChat = (ms: number) => (async (_url: any, opts: { signal?: AbortSignal }) => {
    if (String(_url).endsWith("/models")) return new Response("{}", { status: 200 }) as any;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      opts.signal?.addEventListener("abort",
        () => { clearTimeout(t); reject(new DOMException("aborted", "AbortError")); }, { once: true });
    });
    return chatReply();
  }) as any;

  it("grants a cold model's first attempt the load deadline — a JIT load is not a stall", async () => {
    const saved = savedNet();
    NET.timeoutMs = 80; NET.loadWaitMs = 5_000; NET.retries = 0;
    PROVIDER.capabilities.modelRuntimeInspection = true;
    restore = fakeInspect([rt("not-loaded")]);
    globalThis.fetch = slowChat(200);   // longer than the ordinary idle deadline, shorter than the grace
    armRun();
    try {
      const result = await complete("m", MSGS, 0.5);
      assert.equal(result.text, "ok", "the load window outlived the ordinary deadline");
    } finally { Object.assign(NET, saved); }
  });

  it("reads absence from a runtime-only view as cold too — not resident means JIT is coming", async () => {
    const saved = savedNet();
    NET.timeoutMs = 80; NET.loadWaitMs = 5_000; NET.retries = 0;
    PROVIDER.capabilities.modelRuntimeInspection = true;
    const savedFull = PROVIDER.capabilities.fullInventory;
    PROVIDER.capabilities.fullInventory = false;
    restore = fakeInspect([new Map()]);   // Ollama's /api/ps: the model is not resident
    globalThis.fetch = slowChat(200);
    armRun();
    try {
      const result = await complete("resident-elsewhere", MSGS, 0.5);
      assert.equal(result.text, "ok");
    } finally {
      PROVIDER.capabilities.fullInventory = savedFull;
      Object.assign(NET, saved);
    }
  });

  it("grants no grace to a model a full inventory has never heard of — fail fast instead", async () => {
    const saved = savedNet();
    NET.timeoutMs = 80; NET.loadWaitMs = 5_000; NET.retries = 0; NET.backoffMs = 0;
    PROVIDER.capabilities.modelRuntimeInspection = true;
    restore = fakeInspect([new Map()]);   // LM Studio's inventory: absence means unknown
    globalThis.fetch = slowChat(200);
    armRun();
    try {
      await assert.rejects(() => complete("typo-model", MSGS, 0.5),
        (e: Error) => e instanceof Error && /no reply within/.test(e.message),
        "the ordinary deadline applies — an unknown model must not hang for the load window");
    } finally { Object.assign(NET, saved); }
  });
});

// -- THE ADAPTER SURFACE -----------------------------------------------------
describe("every adapter answers the questions its capabilities claim", () => {
  const make = (id: "lmstudio" | "ollama" | "llamacpp") =>
    makeProvider(id, id === "ollama" ? "http://localhost:11434/v1"
      : id === "llamacpp" ? "http://localhost:8080/v1" : "http://localhost:1234/v1", {});

  it("llamacpp inspects nothing — null by capability, no request spent", async () => {
    const p = make("llamacpp");
    assert.equal(p.capabilities.modelRuntimeInspection, false);
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("must not be called"); }) as any;
    try { assert.equal(await p.inspectModels(100), null); }
    finally { globalThis.fetch = origFetch; }
  });

  it("lmstudio and ollama both carry a health probe and inspect runtime state", () => {
    for (const id of ["lmstudio", "ollama"] as const) {
      const p = make(id);
      assert.equal(p.capabilities.modelRuntimeInspection, true, `${id} capability`);
      assert.equal(typeof p.health, "function", `${id} has a health probe`);
    }
  });
});
