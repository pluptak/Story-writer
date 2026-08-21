/** LLM streaming and parsing. */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { complete, completeStream } from "../engine/llm-client.ts";
import { RUN, stopRun, armRun } from "../live.ts";

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
