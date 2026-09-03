/** LLM streaming and parsing. */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { complete, completeStream, NET, SITE_HEADER, AGENT_HEADER } from "../engine/llm-client.ts";
import { stopRun, armRun } from "../live.ts";

/** Build a ReadableStream from an array of chunks. */
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

// -- SECTION ----
describe("completeStream SSE frame parsing", () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
    armRun();
  });

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
    assert.equal(result.text, "Hello world");
    assert.deepEqual(deltas, ["Hello", " world"]);
    assert.equal(result.brokenOff, false, "a clean stream is not marked as broken off");
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
    assert.equal(result.text, "Thinking...");
    assert.deepEqual(deltas, ["Thinking..."]);
    assert.equal(result.reasoningOnly, true, "a reply that arrived only via reasoning is flagged");
    assert.equal(result.reasoning, null);
  });

  it("keeps streamed reasoning frames out of the answer text when content follows", async () => {
    armRun();
    const deltas: string[] = [];
    globalThis.fetch = async () => new Response(
      chunkedStream([
        new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning_content":"Let me think."}}]}\n\n'),
        new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning_content":" Yes."}}]}\n\n'),
        new TextEncoder().encode('data: {"choices":[{"delta":{"content":"{\\"prose\\":\\"Hi\\"}"}}]}\n\n'),
        new TextEncoder().encode('data: [DONE]\n\n'),
      ]),
      { headers: { "content-type": "text/event-stream" } },
    ) as any;
    const result = await completeStream("test-model", [{ role: "user", content: "test" }], 0.8,
                                        (d) => deltas.push(d));
    assert.equal(result.text, '{"prose":"Hi"}', "the answer is content alone, never reasoning + content");
    assert.equal(result.reasoning, "Let me think. Yes.", "the excluded CoT is captured");
    assert.equal(result.reasoningOnly, false);
    assert.deepEqual(deltas, ["Let me think.", " Yes.", '{"prose":"Hi"}'],
      "the preview still shows every delta as it arrives");
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
    assert.equal(result.text, "Split text");
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
    assert.equal(result.text, "beforeafter");
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
    assert.equal(result.text, "Incomplete");
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
    assert.equal(result.text, '{"result":"kept"}');
    assert.deepEqual(deltas, ['{"result":"kept"}']);
    assert.equal(result.brokenOff, true, "a salvaged reply is marked as broken off");
  });

  it("does not abort a slow but steadily-streaming generation (idle timeout, not total duration)", async () => {
    // The window is short and each chunk lands inside it, but the whole stream runs past it: only
    // an idle deadline reset per chunk survives this. A total-duration cap would abort mid-stream.
    const saved = { timeoutMs: NET.timeoutMs, retries: NET.retries, backoffMs: NET.backoffMs };
    NET.timeoutMs = 250; NET.retries = 0; NET.backoffMs = 0;
    armRun();
    const N = 15, gap = 25; // ~375ms of steady streaming vs a 250ms window
    try {
      globalThis.fetch = (async (_url: unknown, opts: { signal?: AbortSignal }) => {
        const signal = opts?.signal;
        let i = 0;
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            await new Promise((r) => setTimeout(r, gap));
            if (signal?.aborted) { controller.error(new Error("aborted")); return; }  // real fetch does this
            if (i < N) {
              controller.enqueue(new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"${i}."}}]}\n\n`));
              i++;
            } else {
              controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
              controller.close();
            }
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }) as any;
      const result = await completeStream("test-model", [{ role: "user", content: "test" }], 0.8, () => {});
      assert.equal(result.text, Array.from({ length: N }, (_, i) => `${i}.`).join(""));
    } finally {
      Object.assign(NET, saved);
    }
  });

  it("rethrows stream error when RUN.stopped (stops recovery on line 122)", async () => {
    armRun();
    const encoder = new TextEncoder();

    globalThis.fetch = (async (_url: any) => {
      // The readiness probes ask the models route first; only the chat call gets the broken stream.
      if (String(_url).endsWith("/models")) return new Response("{}", { status: 200 }) as any;
      let pulls = 0;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          if (pulls === 1) {
            // Send text with complete JSON so recovery would normally keep it
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"{\\"result\\":\\"ok\\"}"}}]}\n'));
          } else {
            // Second attempt: error the stream
            controller.error(new Error("stream broke mid-transmission"));
          }
        },
      }), { headers: { "content-type": "text/event-stream" } }) as any;
    }) as any;

    // Stop the run before starting the stream, so RUN.stopped=true
    // when the stream error is caught on line 122
    stopRun();

    // The stream then errors — RUN.stopped is true, so the error
    // is rethrown (line 122) instead of recovered (line 128)
    await assert.rejects(
      () => completeStream("test-model", [{ role: "user", content: "test" }], 0.8, () => {}),
      (e: Error) => e instanceof Error);

    armRun();
  });
});

// -- USAGE PARSING ----
describe("completion usage parsing", () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
    armRun();
  });

  it("complete() captures usage from a buffered response", async () => {
    armRun();
    globalThis.fetch = async () => new Response(
      JSON.stringify({
        choices: [{ message: { content: "hello" } }],
        usage: { prompt_tokens: 42, completion_tokens: 7 },
      }),
      { headers: { "content-type": "application/json" } },
    ) as any;
    const result = await complete("test-model", [{ role: "user", content: "test" }], 0.8);
    assert.equal(result.text, "hello");
    assert.equal(result.usage?.promptTokens, 42);
    assert.equal(result.usage?.completionTokens, 7);
  });

  it("complete() returns null usage when the server omits it", async () => {
    armRun();
    globalThis.fetch = async () => new Response(
      JSON.stringify({ choices: [{ message: { content: "hello" } }] }),
      { headers: { "content-type": "application/json" } },
    ) as any;
    const result = await complete("test-model", [{ role: "user", content: "test" }], 0.8);
    assert.equal(result.text, "hello");
    assert.equal(result.usage, null);
  });

  it("completeStream() captures usage from the final usage-only frame", async () => {
    armRun();
    globalThis.fetch = async () => new Response(
      chunkedStream([
        new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'),
        new TextEncoder().encode('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3}}\n\n'),
        new TextEncoder().encode('data: [DONE]\n\n'),
      ]),
      { headers: { "content-type": "text/event-stream" } },
    ) as any;
    const result = await completeStream("test-model", [{ role: "user", content: "test" }], 0.8, () => {});
    assert.equal(result.text, "Hi");
    assert.equal(result.usage?.promptTokens, 10);
    assert.equal(result.usage?.completionTokens, 3);
  });

  it("completeStream() returns null usage when no usage frame arrives", async () => {
    armRun();
    globalThis.fetch = async () => new Response(
      chunkedStream([
        new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'),
        new TextEncoder().encode('data: [DONE]\n\n'),
      ]),
      { headers: { "content-type": "text/event-stream" } },
    ) as any;
    const result = await completeStream("test-model", [{ role: "user", content: "test" }], 0.8, () => {});
    assert.equal(result.text, "Hi");
    assert.equal(result.usage, null);
  });

  it("completeStream() ignores a malformed usage field rather than failing", async () => {
    armRun();
    globalThis.fetch = async () => new Response(
      chunkedStream([
        new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'),
        new TextEncoder().encode('data: {"choices":[],"usage":{"prompt_tokens":"not a number"}}\n\n'),
        new TextEncoder().encode('data: [DONE]\n\n'),
      ]),
      { headers: { "content-type": "text/event-stream" } },
    ) as any;
    const result = await completeStream("test-model", [{ role: "user", content: "test" }], 0.8, () => {});
    assert.equal(result.text, "Hi");
    assert.equal(result.usage, null);
  });
});

// -- REPLY ASSEMBLY ----
describe("reply assembly (reasoning vs content, finish_reason)", () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
    armRun();
  });

  it("complete() takes content as the answer and carries separately-delivered reasoning alongside it", async () => {
    armRun();
    globalThis.fetch = async () => new Response(
      JSON.stringify({
        choices: [{
          message: { content: "the answer", reasoning_content: "because the model thought so" },
          finish_reason: "stop",
        }],
      }),
      { headers: { "content-type": "application/json" } },
    ) as any;
    const result = await complete("test-model", [{ role: "user", content: "test" }], 0.8);
    assert.equal(result.text, "the answer");
    assert.equal(result.reasoning, "because the model thought so");
    assert.equal(result.finishReason, "stop");
    assert.equal(result.reasoningOnly, false);
  });

  it("complete() surfaces a length cutoff through finish_reason instead of looking like a clean stop", async () => {
    armRun();
    globalThis.fetch = async () => new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"prose":"cut of' }, finish_reason: "length" }],
      }),
      { headers: { "content-type": "application/json" } },
    ) as any;
    const result = await complete("test-model", [{ role: "user", content: "test" }], 0.8);
    assert.equal(result.text, '{"prose":"cut of');
    assert.equal(result.finishReason, "length");
  });

  it("completeStream() captures finish_reason from its final frame", async () => {
    armRun();
    globalThis.fetch = async () => new Response(
      chunkedStream([
        new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'),
        new TextEncoder().encode('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n'),
        new TextEncoder().encode('data: [DONE]\n\n'),
      ]),
      { headers: { "content-type": "text/event-stream" } },
    ) as any;
    const result = await completeStream("test-model", [{ role: "user", content: "test" }], 0.8, () => {});
    assert.equal(result.text, "Hi");
    assert.equal(result.finishReason, "length");
  });

  it("complete() leaves finish_reason null when the server does not send one", async () => {
    armRun();
    globalThis.fetch = async () => new Response(
      JSON.stringify({ choices: [{ message: { content: "hello" } }] }),
      { headers: { "content-type": "application/json" } },
    ) as any;
    const result = await complete("test-model", [{ role: "user", content: "test" }], 0.8);
    assert.equal(result.finishReason, null);
    assert.equal(result.reasoning, null);
    assert.equal(result.reasoningOnly, false);
  });
});

// -- RETRY CLASSIFICATION ----
describe("retry classification (non-JSON reply bodies)", () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
    armRun();
  });

  it("retries a 200 whose body will not parse, then succeeds", async () => {
    const saved = { timeoutMs: NET.timeoutMs, retries: NET.retries, backoffMs: NET.backoffMs };
    NET.timeoutMs = 250; NET.retries = 1; NET.backoffMs = 0;
    armRun();
    let calls = 0, probes = 0;
    try {
      globalThis.fetch = (async (_url: any) => {
        if (String(_url).endsWith("/models")) { probes++; return new Response("{}", { status: 200 }) as any; }
        calls++;
        if (calls === 1) return new Response("<!doctype html><html>proxy error page</html>",
                                            { headers: { "content-type": "text/html" } }) as any;
        return new Response(JSON.stringify({ choices: [{ message: { content: "second try" } }] })) as any;
      }) as any;
      const result = await complete("test-model", [{ role: "user", content: "test" }], 0.8);
      assert.equal(calls, 2, "the unparseable body spent a retry instead of killing the call");
      assert.ok(probes >= 1, "the health gate asked the provider between the attempts");
      assert.equal(result.text, "second try");
    } finally {
      Object.assign(NET, saved);
    }
  });

  it("gives up after retries on a persistently non-JSON reply, naming the model and showing a snippet", async () => {
    const saved = { timeoutMs: NET.timeoutMs, retries: NET.retries, backoffMs: NET.backoffMs };
    NET.timeoutMs = 250; NET.retries = 0; NET.backoffMs = 0;
    armRun();
    try {
      globalThis.fetch = async () => new Response("<!doctype html><html>gateway timeout page</html>",
                                                  { headers: { "content-type": "text/html" } }) as any;
      await assert.rejects(
        () => complete("test-model", [{ role: "user", content: "test" }], 0.8),
        (e: Error) => /test-model sent a non-JSON reply/.test(e.message)
          && e.message.includes("gateway timeout page"));
    } finally {
      Object.assign(NET, saved);
    }
  });

  it("treats an empty 200 body like an empty completion — retryable, not fatal", async () => {
    const saved = { timeoutMs: NET.timeoutMs, retries: NET.retries, backoffMs: NET.backoffMs };
    NET.timeoutMs = 250; NET.retries = 0; NET.backoffMs = 0;
    armRun();
    try {
      globalThis.fetch = async () => new Response("", { headers: { "content-type": "application/json" } }) as any;
      await assert.rejects(
        () => complete("test-model", [{ role: "user", content: "test" }], 0.8),
        (e: Error) => /empty body/.test(e.message));
    } finally {
      Object.assign(NET, saved);
    }
  });
});

// -- THE CALL-SITE HEADER ----
// The site rides as a header, never in the body: the model must not see it, and a fake or a replay
// must be able to tell callers apart without reading the prompt (which drifts).
describe("the X-SW-Site header", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; armRun(); });

  /** Capture what one completion put on the wire. */
  async function wireOf(run: () => Promise<unknown>) {
    let headers = new Headers(), body: any = null;
    globalThis.fetch = (async (_url: string, init: any) => {
      headers = new Headers(init.headers);
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    }) as any;
    armRun();
    await run();
    return { headers, body };
  }

  it("carries the call site when one is given, and never puts it in the body", async () => {
    const { headers, body } = await wireOf(() =>
      complete("m", [{ role: "user", content: "x" }], 0.5, "low", { site: "writer.draft", agent: "WRITER" }));
    assert.equal(headers.get(SITE_HEADER), "writer.draft");
    assert.equal(headers.get(AGENT_HEADER), "WRITER", "who called, beside where from");
    assert.doesNotMatch(JSON.stringify(body), /writer\.draft|WRITER/,
      "neither may reach the model — not as a message, not as a parameter");
  });

  it("is absent rather than empty when a caller names no site", async () => {
    const { headers } = await wireOf(() => complete("m", [{ role: "user", content: "x" }], 0.5));
    assert.equal(headers.get(SITE_HEADER), null);
    assert.equal(headers.get(AGENT_HEADER), null);
  });

  it("distinguishes two characters sharing one site — the pair is the key", async () => {
    const a = await wireOf(() => complete("m", [{ role: "user", content: "x" }], 0.5, "low",
                                          { site: "character.consult", agent: "RIVEN" }));
    const b = await wireOf(() => complete("m", [{ role: "user", content: "x" }], 0.5, "low",
                                          { site: "character.consult", agent: "MERRITT" }));
    assert.equal(a.headers.get(SITE_HEADER), b.headers.get(SITE_HEADER), "same call site");
    assert.notEqual(a.headers.get(AGENT_HEADER), b.headers.get(AGENT_HEADER),
      "and only the agent tells them apart");
  });

  it("rides the streaming path too", async () => {
    let headers = new Headers();
    globalThis.fetch = (async (_url: string, init: any) => {
      headers = new Headers(init.headers);
      return new Response(chunkedStream([
        new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'),
        new TextEncoder().encode('data: [DONE]\n\n'),
      ]), { headers: { "content-type": "text/event-stream" } });
    }) as any;
    armRun();
    await completeStream("m", [{ role: "user", content: "x" }], 0.5, () => {}, "low",
                         { site: "judge.answer", agent: "JUDGE" });
    assert.equal(headers.get(SITE_HEADER), "judge.answer");
    assert.equal(headers.get(AGENT_HEADER), "JUDGE");
  });
});
