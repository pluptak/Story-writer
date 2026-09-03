/**
 * The transport's failure taxonomy: classification, the health gate between retries, the
 * fail-fast when the provider is down, and the total call budget.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { complete, NET, failureKind, ProviderDownError, CallBudgetError } from "../engine/llm-client.ts";
import { PROVIDER } from "../engine/provider.ts";
import { WARN } from "../engine/warnings.ts";
import { armRun } from "../live.ts";

const MSGS = [{ role: "user" as const, content: "test" }];
const chatReply = () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const savedNet = () => ({ timeoutMs: NET.timeoutMs, retries: NET.retries, backoffMs: NET.backoffMs,
                          probeTimeoutMs: NET.probeTimeoutMs, recoveryProbes: NET.recoveryProbes,
                          maxCallMs: NET.maxCallMs });

describe("failureKind", () => {
  it("reads the fetch cause for refused and dropped connections", () => {
    const refused = new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:1234") });
    assert.equal(failureKind(refused), "unreachable");
    const dropped = new TypeError("fetch failed", { cause: new Error("socket hang up") });
    assert.equal(failureKind(dropped), "connection-dropped");
  });

  it("says unknown for an error it cannot name", () => {
    assert.equal(failureKind(new Error("something else")), "unknown");
  });
});

describe("the health gate between retries", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; armRun(); });

  it("gives up at once when the provider stays unreachable, naming the endpoint", async () => {
    const saved = savedNet();
    NET.retries = 2; NET.backoffMs = 0; NET.recoveryProbes = 0;
    let chat = 0, probes = 0;
    try {
      globalThis.fetch = (async (url: any) => {
        if (String(url).endsWith("/models")) { probes++; throw new TypeError("fetch failed"); }
        chat++;
        throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:1234") });
      }) as any;
      armRun();
      await assert.rejects(
        () => complete("m", MSGS, 0.5),
        (e: Error) => e instanceof ProviderDownError
          && e.message.includes(PROVIDER.baseUrl) && /is its server running/.test(e.message));
      assert.equal(chat, 1, "no attempt was spent beyond the first refusal");
      assert.equal(probes, 1);
    } finally {
      Object.assign(NET, saved);
    }
  });

  it("keeps retrying when the provider comes back within its recovery chances", async () => {
    const saved = savedNet();
    NET.retries = 2; NET.backoffMs = 0; NET.recoveryProbes = 1; NET.probeTimeoutMs = 200;
    let chat = 0, probes = 0;
    try {
      globalThis.fetch = (async (url: any) => {
        if (String(url).endsWith("/models")) {
          probes++;
          if (probes === 1) throw new TypeError("fetch failed");   // mid-restart
          return new Response("{}", { status: 200 }) as any;
        }
        chat++;
        if (chat === 1) throw new TypeError("fetch failed",
                                           { cause: new Error("connect ECONNREFUSED 127.0.0.1:1234") });
        return chatReply();
      }) as any;
      armRun();
      const result = await complete("m", MSGS, 0.5);
      assert.equal(result.text, "ok");
      assert.equal(probes, 2, "one failed recovery probe, then the server was back");
    } finally {
      Object.assign(NET, saved);
    }
  });

  it("notes the alive-but-silent case: the server answers, the model stopped replying", async () => {
    const saved = savedNet();
    NET.timeoutMs = 60; NET.retries = 1; NET.backoffMs = 0;
    let chat = 0;
    const lines: string[] = [];
    const origSink = WARN.sink;
    WARN.sink = (...a: unknown[]) => lines.push(a.map(String).join(" "));
    try {
      // First chat call ignores its deadline until the idle abort fires; the retry answers.
      globalThis.fetch = (async (url: any, opts: { signal?: AbortSignal }) => {
        if (String(url).endsWith("/models")) return new Response("{}", { status: 200 }) as any;
        chat++;
        if (chat === 1) {
          await new Promise((_, reject) => {
            opts.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")),
                                          { once: true });
          });
        }
        return chatReply();
      }) as any;
      armRun();
      const result = await complete("m", MSGS, 0.5);
      assert.equal(result.text, "ok");
      assert.ok(lines.some(l => /alive but the model stopped replying/.test(l)),
        "the preemption warning was raised");
    } finally {
      WARN.sink = origSink;
      Object.assign(NET, saved);
    }
  });

  it("treats a 500 on the model list as a standing server — the retry proceeds", async () => {
    const saved = savedNet();
    NET.retries = 1; NET.backoffMs = 0;
    let chat = 0;
    try {
      globalThis.fetch = (async (url: any) => {
        if (String(url).endsWith("/models")) return new Response("boom", { status: 500 }) as any;
        chat++;
        if (chat === 1) return new Response("boom", { status: 500 }) as any;
        return chatReply();
      }) as any;
      armRun();
      const result = await complete("m", MSGS, 0.5);
      assert.equal(result.text, "ok", "an erroring-but-standing server is still retried");
    } finally {
      Object.assign(NET, saved);
    }
  });
});

describe("the total call budget", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; armRun(); });

  it("ends a call whose attempts spent its whole wall clock, instead of retrying forever", async () => {
    const saved = savedNet();
    NET.timeoutMs = 50; NET.retries = 5; NET.backoffMs = 0; NET.maxCallMs = 30;
    let chat = 0;
    try {
      globalThis.fetch = (async (url: any, opts: { signal?: AbortSignal }) => {
        if (String(url).endsWith("/models")) return new Response("{}", { status: 200 }) as any;
        chat++;
        await new Promise((_, reject) => {
          opts.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")),
                                        { once: true });
        });
        return chatReply();
      }) as any;
      armRun();
      await assert.rejects(
        () => complete("m", MSGS, 0.5),
        (e: Error) => e instanceof CallBudgetError && /total budget/.test(e.message));
      assert.equal(chat, 1, "the budget ended the call before a second attempt");
    } finally {
      Object.assign(NET, saved);
    }
  });
});
