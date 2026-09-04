/**
 * The request coordinator: one attempt per slot, no overlap, cancel- and budget-aware waits,
 * and the surfaced QUEUE state. The readiness probes that precede a call are metadata and
 * deliberately outside the queue — the fakes here answer them instantly and count only chat.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ReadableStream } from "node:stream/web";

import { complete, completeStream, NET } from "../engine/llm-client.ts";
import { QUEUE, QUEUE_LIMITS, QueueGaveUpError } from "../engine/req-queue.ts";
import { armRun, stopRun, StoppedError, sseClients } from "../live.ts";

const MSGS = [{ role: "user" as const, content: "test" }];
const reply = () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
const modelsReply = () => new Response("{}", { status: 200 });
const isChat = (url: unknown) => !String(url).endsWith("/models");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("the request queue", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; armRun(); });

  it("never lets two chat requests be on the wire at once", async () => {
    let onWire = 0, overlapped = false;
    globalThis.fetch = (async (url: any) => {
      if (!isChat(url)) return modelsReply();
      if (++onWire > 1) overlapped = true;
      await sleep(15);
      onWire--;
      return reply();
    }) as any;
    armRun();
    await Promise.all([
      complete("m", MSGS, 0.5),
      complete("m", MSGS, 0.5),
      complete("m", MSGS, 0.5),
    ]);
    assert.equal(overlapped, false, "three concurrent calls ran one at a time");
  });

  it("surfaces who holds the slot and how deep the queue is, and empties both after", async () => {
    let release: (() => void) | undefined;
    let held = false;
    globalThis.fetch = (async (url: any) => {
      if (!isChat(url)) return modelsReply();
      if (!held) {
        held = true;
        await new Promise<void>(r => { release = r; });
      }
      return reply();
    }) as any;
    armRun();
    const heldCall = complete("m", MSGS, 0.5, "low", { site: "writer.draft", agent: "WRITER" });
    await sleep(5);   // let the first call take the wire
    const second = complete("m", MSGS, 0.5, "low", { site: "judge.answer" });
    await sleep(5);
    assert.equal(QUEUE.inFlight, 1);
    assert.equal(QUEUE.depth, 1);
    assert.match(QUEUE.current, /WRITER/);
    release!();
    await Promise.all([heldCall, second]);
    assert.equal(QUEUE.inFlight, 0);
    assert.equal(QUEUE.depth, 0);
    assert.equal(QUEUE.current, "");
  });

  it("holds the slot until a stream is fully consumed", async () => {
    const events: string[] = [];
    globalThis.fetch = (async (url: any, init: any) => {
      if (!isChat(url)) return modelsReply();
      const isStream = new Headers(init.headers).get("X-SW-Site") === "writer.draft";
      if (!isStream) { events.push("second-start"); return reply(); }
      events.push("stream-start");
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          await sleep(30);
          events.push("stream-end");
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } });
    }) as any;
    armRun();
    const stream = completeStream("m", MSGS, 0.5, () => {}, "low", { site: "writer.draft" });
    await sleep(5);   // the stream is on the wire but NOT finished
    const second = complete("m", MSGS, 0.5);
    await stream;
    await second;
    assert.deepEqual(events, ["stream-start", "stream-end", "second-start"],
      "the second call waits for the whole stream, not just the fetch");
  });

  it("releases the slot when an attempt fails, so the retry re-queues behind others", async () => {
    const saved = { retries: NET.retries, backoffMs: NET.backoffMs };
    NET.retries = 1; NET.backoffMs = 0;
    let calls = 0;
    const order: string[] = [];
    globalThis.fetch = (async (url: any, init: any) => {
      if (!isChat(url)) return modelsReply();
      const site = new Headers(init.headers).get("X-SW-Site");
      if (site === "retrying") {
        calls++;
        if (calls === 1) throw new Error("ECONNRESET");
        order.push("retry-served");
        return reply();
      }
      order.push("other-served");
      return reply();
    }) as any;
    armRun();
    try {
      const retrying = complete("m", MSGS, 0.5, "low", { site: "retrying" });
      await sleep(2);   // the first attempt throws immediately; the backoff is 0ms, so this is a race —
      // queue the other call regardless of whether the retry already re-acquired
      const other = complete("m", MSGS, 0.5, "low", { site: "other" });
      await Promise.all([retrying, other]);
      assert.ok(order.includes("retry-served"));
      assert.ok(order.includes("other-served"), "the queued call was served, not starved by the retry");
    } finally {
      Object.assign(NET, saved);
    }
  });

  it("gives up when the wait budget runs out, without spending a request or a retry", async () => {
    const savedWait = QUEUE_LIMITS.waitMs;
    QUEUE_LIMITS.waitMs = 40;
    let chatFetches = 0;
    let release: (() => void) | undefined;
    try {
      globalThis.fetch = (async (url: any) => {
        if (!isChat(url)) return modelsReply();
        chatFetches++;
        await new Promise<void>(r => { release = r; });   // the holder never finishes on its own
        return reply();
      }) as any;
      armRun();
      const holder = complete("m", MSGS, 0.5);
      await sleep(5);   // holder takes the wire
      await assert.rejects(
        () => complete("m", MSGS, 0.5),
        (e: Error) => e instanceof QueueGaveUpError && /waiting for its turn/.test(e.message));
      assert.equal(chatFetches, 1, "the queued call never reached the wire");
      release!();
      await holder;
    } finally {
      QUEUE_LIMITS.waitMs = savedWait;
    }
  });

  it("unwinds queued calls when the run stops", async () => {
    let release: (() => void) | undefined;
    let held = false;
    globalThis.fetch = (async (url: any) => {
      if (!isChat(url)) return modelsReply();
      if (!held) {
        held = true;
        await new Promise<void>(r => { release = r; });
      }
      return reply();
    }) as any;
    armRun();
    const holder = complete("m", MSGS, 0.5);
    await sleep(5);
    const queued = complete("m", MSGS, 0.5);
    await sleep(5);
    stopRun();
    await assert.rejects(() => queued, StoppedError);
    release!();
    await holder;
  });

  it("broadcasts provider_state frames as the request line changes", async () => {
    let release: (() => void) | undefined;
    let held = false;
    globalThis.fetch = (async (url: any) => {
      if (!isChat(url)) return modelsReply();
      if (!held) {
        held = true;
        await new Promise<void>(r => { release = r; });
      }
      return reply();
    }) as any;
    const frames: any[] = [];
    const client = { write: (s: string) => frames.push(JSON.parse(s.replace(/^data: /, "").trim())) };
    sseClients.add(client);
    try {
      armRun();
      const holder = complete("m", MSGS, 0.5, "low", { site: "writer.draft", agent: "WRITER" });
      await sleep(5);
      const second = complete("m", MSGS, 0.5);
      await sleep(5);
      release!();
      await Promise.all([holder, second]);
      const states = frames.filter(f => f.t === "provider_state");
      assert.ok(states.length >= 3, "a frame when the slot is taken, when one queues, and when both finish");
      assert.equal(states[0].provider, "LM Studio");
      assert.ok(states.some(f => f.current.includes("WRITER") && f.depth === 1),
        "the queue's busy moment was announced");
      assert.equal(states.at(-1).inFlight, 0);
      assert.equal(states.at(-1).current, "");
    } finally {
      sseClients.delete(client);
    }
  });
});
