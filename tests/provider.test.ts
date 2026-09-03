/**
 * The provider boundary: selection, URL normalization, auth headers, the per-server model
 * parsers, and the capability gate on the request body.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeBaseUrl, openAiRoot, selectProviderId, makeProvider, PROVIDER,
} from "../engine/provider.ts";
import { parseModelInventory, parseModelInfo } from "../engine/provider-lmstudio.ts";
import { parsePsModels } from "../engine/provider-ollama.ts";
import { requestBody } from "../engine/llm-client.ts";

const BASE = "http://localhost:1234/v1";

// -- URL SHAPE ----------------------------------------------------------------
describe("normalizeBaseUrl", () => {
  it("strips a full chat-completions URL back to its base — the old LM_STUDIO_URL form", () => {
    assert.equal(normalizeBaseUrl("http://localhost:1234/v1/chat/completions", "http://x/v1"),
                 "http://localhost:1234/v1");
    assert.equal(normalizeBaseUrl("http://host.docker.internal:1234/v1/chat/completions", "http://x/v1"),
                 "http://host.docker.internal:1234/v1", "the devcontainer's host-gateway form");
  });

  it("appends /v1 to a bare host, so both spellings land on the same endpoints", () => {
    assert.equal(normalizeBaseUrl("http://localhost:1234", "http://x/v1"), "http://localhost:1234/v1");
  });

  it("leaves a /v1 base alone, with or without a trailing slash", () => {
    assert.equal(normalizeBaseUrl("http://localhost:1234/v1", "http://x/v1"), "http://localhost:1234/v1");
    assert.equal(normalizeBaseUrl("http://localhost:1234/v1/", "http://x/v1"), "http://localhost:1234/v1");
  });

  it("falls back when empty", () => {
    assert.equal(normalizeBaseUrl("", "http://x/v1"), "http://x/v1");
    assert.equal(normalizeBaseUrl("   ", "http://x/v1"), "http://x/v1");
  });
});

describe("openAiRoot", () => {
  it("removes the /v1 suffix the native API hangs off", () => {
    assert.equal(openAiRoot("http://localhost:1234/v1"), "http://localhost:1234");
    assert.equal(openAiRoot("http://localhost:1234/v1/"), "http://localhost:1234");
  });
});

// -- SELECTION ----------------------------------------------------------------
describe("selectProviderId", () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; });

  it("defaults to lmstudio", () => {
    delete process.env.LLM_PROVIDER;
    assert.equal(selectProviderId(), "lmstudio");
  });

  it("reads LLM_PROVIDER, case-insensitively", () => {
    process.env.LLM_PROVIDER = "ollama";
    assert.equal(selectProviderId(), "ollama");
    process.env.LLM_PROVIDER = "LLAMACPP";
    assert.equal(selectProviderId(), "llamacpp");
  });

  it("refuses an unknown value rather than silently running against the wrong server", () => {
    process.env.LLM_PROVIDER = "nope";
    assert.throws(() => selectProviderId(), /not one of/);
  });
});

describe("makeProvider", () => {
  it("derives the chat and model-list URLs from the base", () => {
    const p = makeProvider("lmstudio", BASE, {});
    assert.equal(p.displayName, "LM Studio");
    assert.equal(p.chatUrl, "http://localhost:1234/v1/chat/completions");
    assert.equal(p.modelsUrl, "http://localhost:1234/v1/models");
  });

  it("carries the auth header it was given", () => {
    const p = makeProvider("lmstudio", BASE, { Authorization: "Bearer tok" });
    assert.deepEqual(p.headers(), { Authorization: "Bearer tok" });
  });

  it("sends no auth header when none is configured", () => {
    assert.deepEqual(PROVIDER.headers(), {});
  });
});

// -- LM STUDIO MODEL STATE ----------------------------------------------------
describe("the lmstudio adapter's inspectModels", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  it("reads the current /api/v1 inventory and skips embedding models", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      urls.push(String(url));
      return new Response(JSON.stringify({
        models: [
          { type: "llm", key: "gemma", max_context_length: 262144,
            loaded_instances: [{ config: { context_length: 4096 } }] },
          { type: "embedding", key: "nomic-embed" },
          { type: "llm", key: "cold", max_context_length: 8192, loaded_instances: [] },
        ],
      })) as any;
    }) as any;
    const p = makeProvider("lmstudio", BASE, {});
    const info = await p.inspectModels(500);
    assert.equal(urls.length, 1, "a v1 answer ends the probe — no fallback fetch");
    assert.ok(urls[0].endsWith("/api/v1/models"));
    assert.equal(info!.size, 2);
    assert.deepEqual(info!.get("gemma"), { state: "loaded", loadedContext: 4096, maxContext: 262144 });
    assert.deepEqual(info!.get("cold"), { state: "not-loaded", loadedContext: 0, maxContext: 8192 });
  });

  it("falls back to /api/v0 when the v1 endpoint does not exist, and sees a loading model there", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      urls.push(String(url));
      if (String(url).endsWith("/api/v1/models")) return new Response("not found", { status: 404 }) as any;
      return new Response(JSON.stringify({
        data: [{ id: "gemma", state: "loading", max_context_length: 8192 }],
      })) as any;
    }) as any;
    const p = makeProvider("lmstudio", BASE, {});
    const info = await p.inspectModels(500);
    assert.equal(urls.length, 2, "v1 miss, then the legacy endpoint");
    assert.deepEqual(info!.get("gemma"), { state: "loading", loadedContext: 0, maxContext: 8192 });
  });

  it("falls back on a 200 whose body is not a v1 inventory", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      urls.push(String(url));
      return new Response(JSON.stringify({
        data: [{ id: "gemma", state: "loaded", loaded_context_length: 4096, max_context_length: 8192 }],
      })) as any;
    }) as any;
    const p = makeProvider("lmstudio", BASE, {});
    const info = await p.inspectModels(500);
    assert.ok(urls.some(u => u.endsWith("/api/v0/models")));
    assert.deepEqual(info!.get("gemma"), { state: "loaded", loadedContext: 4096, maxContext: 8192 });
  });

  it("answers null when neither endpoint replies", async () => {
    globalThis.fetch = (async () => { throw new Error("refused"); }) as any;
    const p = makeProvider("lmstudio", BASE, {});
    assert.equal(await p.inspectModels(500), null);
  });
});

// -- PARSERS ------------------------------------------------------------------
describe("parseModelInventory (lmstudio v1)", () => {
  it("returns null for a body that is not a v1 inventory — the fallback's cue", () => {
    assert.equal(parseModelInventory({}), null);
    assert.equal(parseModelInventory({ data: [] }), null);
    assert.equal(parseModelInventory(null), null);
  });
});

describe("parseModelInfo (lmstudio v0)", () => {
  it("returns an empty map for non-array data or missing data", () => {
    assert.equal(parseModelInfo({}).size, 0);
    assert.equal(parseModelInfo({ data: null }).size, 0);
    assert.equal(parseModelInfo(null).size, 0);
  });

  it("skips entries with no id", () => {
    const body = { data: [
      { id: "good", state: "loaded" },
      { state: "loaded" },
      { id: "", state: "loaded" },
    ] };
    const result = parseModelInfo(body);
    assert.equal(result.size, 1);
    assert.ok(result.has("good"));
  });

  it("coerces missing lengths to 0 and unknown states to not-loaded", () => {
    const result = parseModelInfo({ data: [{ id: "a" }, { id: "b", state: "loaded", loaded_context_length: 100 }] });
    assert.deepEqual(result.get("a"), { state: "not-loaded", loadedContext: 0, maxContext: 0 });
    assert.deepEqual(result.get("b"), { state: "loaded", loadedContext: 100, maxContext: 0 });
  });
});

// -- OLLAMA -------------------------------------------------------------------
describe("the ollama adapter", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  it("reads /api/ps as the resident models", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      models: [{ name: "qwen3:8b", size_vram: 1000 }],
    })) as any) as any;
    const p = makeProvider("ollama", "http://localhost:11434/v1", {});
    const info = await p.inspectModels(500);
    assert.deepEqual(info!.get("qwen3:8b"), { state: "loaded", loadedContext: 0, maxContext: 0 });
  });

  it("answers null when /api/ps is unreachable", async () => {
    globalThis.fetch = (async () => { throw new Error("refused"); }) as any;
    const p = makeProvider("ollama", "http://localhost:11434/v1", {});
    assert.equal(await p.inspectModels(500), null);
  });

  it("cannot load or unload", () => {
    const p = makeProvider("ollama", "http://localhost:11434/v1", {});
    assert.equal(p.capabilities.modelPreparation, false);
    assert.equal(p.capabilities.explicitLoad, false);
  });
});

describe("parsePsModels", () => {
  it("returns an empty map for a body without models", () => {
    assert.equal(parsePsModels({}).size, 0);
    assert.equal(parsePsModels(null).size, 0);
  });
});

// -- LLAMA.CPP ----------------------------------------------------------------
describe("the llamacpp adapter", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  it("inspects nothing — the server manages its one model itself", async () => {
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("{}") as any; }) as any;
    const p = makeProvider("llamacpp", "http://localhost:8080/v1", {});
    assert.equal(await p.inspectModels(500), null);
    assert.equal(called, false, "no request is spent on a question the server cannot answer");
  });

  it("omits reasoning_effort from chat requests", () => {
    const p = makeProvider("llamacpp", "http://localhost:8080/v1", {});
    assert.equal(p.capabilities.reasoningEffort, false);
  });
});

// -- THE CAPABILITY GATE ON THE REQUEST BODY ---------------------------------
describe("reasoning_effort on the wire", () => {
  const saved = PROVIDER.capabilities.reasoningEffort;
  afterEach(() => { PROVIDER.capabilities.reasoningEffort = saved; });

  const body = (think: any) => JSON.parse(requestBody("m", [], 0.5, false, think));

  it("is sent when the provider accepts it", () => {
    PROVIDER.capabilities.reasoningEffort = true;
    assert.equal(body("low").reasoning_effort, "low");
    assert.equal(body("off").reasoning_effort, "none");
  });

  it("is omitted when the provider does not", () => {
    PROVIDER.capabilities.reasoningEffort = false;
    assert.equal(body("low").reasoning_effort, undefined);
  });

  it("is omitted for the default level either way — send nothing means send nothing", () => {
    PROVIDER.capabilities.reasoningEffort = true;
    assert.equal(body("default").reasoning_effort, undefined);
    PROVIDER.capabilities.reasoningEffort = false;
    assert.equal(body("default").reasoning_effort, undefined);
  });
});
