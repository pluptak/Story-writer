/** APP — the boundary the CLI-to-GUI transition rests on: the shutdown signal, the loading-window
 *  invariant, and the real server handle (bind, SSE replay, close). The pick → run → pick loop
 *  itself needs a live model and a browser; the owner's smoke run stands in for it. */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createServer as netCreateServer, type AddressInfo } from "node:net";

import { createShutdownSignal, startChapterRun } from "../app.ts";
import { startServer, type ServerHandle } from "../server/server.ts";
import { LIVE, RUN, resetLive, armRun, publish } from "../live.ts";
import type { ServerHost } from "../server/server.ts";
import { quiet } from "./helpers.ts";
import { ROOT } from "../engine/story-format.ts";

const noopHost = {} as ServerHost;

const liveHandles: ServerHandle[] = [];
afterEach(async () => {
  while (liveHandles.length) await liveHandles.pop()!.close().catch(() => {});
  resetLive(); LIVE.running = false; LIVE.port = 8080;
});

describe("createShutdownSignal", () => {
  it("with nothing in flight: closes the viewer and exits 0 on the first signal", async () => {
    resetLive(); LIVE.running = false;
    const events: string[] = [];
    let exitCode = -1;
    const onSignal = createShutdownSignal({
      closeServer: async () => { events.push("close"); },
      onShutdown: () => { events.push("shutdown"); },
      exit: code => { exitCode = code; events.push("exit"); },
    });
    onSignal();
    await new Promise(r => setImmediate(r));   // closeServer().then(exit) is microtask-ordered
    assert.deepEqual(events, ["shutdown", "close", "exit"]);
    assert.equal(exitCode, 0);
    assert.equal(RUN.stopped, false, "nothing was running, so nothing was stopped");
  });

  it("with a run in flight: takes the /stop path — aborts and releases what the loop is parked on — and exits only via the loop", async () => {
    resetLive(); LIVE.running = true; armRun();
    const released: unknown[] = [];
    let exitCalled = false, closed = false;
    LIVE.awaitingContinue = { steps: 8, budget: 24 };
    LIVE.continueResolve = n => released.push(["continue", n]);
    LIVE.readerResolve = a => released.push(["reader", a]);
    LIVE.pauseResolve = () => released.push(["pause"]);
    const onSignal = createShutdownSignal({
      closeServer: async () => { closed = true; },
      onShutdown: () => {},
      exit: () => { exitCalled = true; },
    });
    onSignal();
    assert.equal(RUN.stopped, true, "the model calls are aborted the way /stop aborts them");
    assert.deepEqual(released, [["continue", 0], ["reader", ""], ["pause"]]);
    assert.equal(LIVE.awaitingContinue, null);
    assert.equal(LIVE.readerArmed, false);
    assert.equal(closed, false, "the viewer closes only after the loop has unwound and flushed");
    assert.equal(exitCalled, false);
  });

  it("a second signal exits immediately, mid-grace, and shutdown is reported once", () => {
    resetLive(); LIVE.running = true; armRun();
    let exitCode = -1, shutdowns = 0;
    const onSignal = createShutdownSignal({
      closeServer: async () => {},
      onShutdown: () => { shutdowns++; },
      exit: code => { exitCode = code; },
    });
    onSignal();
    onSignal();
    assert.equal(exitCode, 1);
    assert.equal(shutdowns, 1);
  });
});

describe("startChapterRun's loading-window invariant", () => {
  it("closes the loading window when the run refuses before starting", async () => {
    const cli = { serve: false, headless: false, port: 0, oneShot: true, storyDir: "",
                  consultCli: async () => {} };
    resetLive();
    LIVE.loading = true;   // as awaitPick leaves it the moment the pick resolves
    await quiet(() => startChapterRun(join(ROOT, "tests/fixtures/doorway"), 99, cli));
    assert.equal(LIVE.loading, false, "a window left open blocks every story-mutating route for the rest of the session");
    assert.equal(process.exitCode, 1, "the out-of-range chapter is reported");
    process.exitCode = 0;
  });
});

// -- THE REAL SERVER HANDLE ------------------------------------------------
/** Read an SSE stream until `until` matches the accumulated text, or time out naming what arrived.
 *  Cancels the stream either way — otherwise it stays locked through the reader. */
async function readSse(res: Response, until: (text: string) => boolean, ms = 3000): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  const finished = (async () => {
    while (!until(text)) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
    return text;
  })();
  try {
    return await Promise.race([
      finished,
      new Promise<string>((_, rej) =>
        setTimeout(() => rej(new Error(`SSE wait timed out; got: ${JSON.stringify(text)}`)), ms)),
    ]);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Fetch until the server answers — startServer exposes no listening callback. */
async function waitUntilListening(port: number, ms = 3000): Promise<Response> {
  const deadline = Date.now() + ms;
  for (;;) {
    try { return await fetch(`http://localhost:${port}/run`); }
    catch (e) {
      if (Date.now() > deadline) throw e;
      await new Promise(r => setTimeout(r, 50));
    }
  }
}

describe("startServer's handle", () => {
  it("binds an ephemeral port, replays the backlog on connect and on reconnect, and close() frees it", async () => {
    resetLive();
    const handle = startServer(0, noopHost);
    liveHandles.push(handle);
    const port = await handle.bound;
    assert.ok(port > 0, "an ephemeral bind reports the port actually bound");

    const up = await waitUntilListening(port);
    assert.equal(up.status, 200);
    await up.body?.cancel();

    publish({ t: "reader_answer", chapter: 1, answer: "hold the door" });

    const first = await fetch(`http://localhost:${port}/events`);
    const text1 = await readSse(first, s => s.includes("run_state"));
    assert.match(text1, /retry: 3000/);
    assert.match(text1, /hold the door/, "the backlog is replayed from the top");
    assert.match(text1, /"t":"run_state"/);

    const second = await fetch(`http://localhost:${port}/events`);
    const text2 = await readSse(second, s => s.includes("run_state"));
    assert.match(text2, /hold the door/, "a reconnecting client gets the same replay");

    await handle.close();
    liveHandles.splice(liveHandles.indexOf(handle), 1);
    await assert.rejects(() => fetch(`http://localhost:${port}/run`), /fetch failed|ECONNREFUSED/,
                         "the port is freed once closed");

    const again = startServer(0, noopHost);
    liveHandles.push(again);
    const reup = await waitUntilListening(await again.bound);
    assert.equal(reup.status, 200, "a fresh startServer binds again after a close");
    await reup.body?.cancel();
    await again.close();
    liveHandles.splice(liveHandles.indexOf(again), 1);
  });

  it("a bind failure rejects `bound` instead of leaving the caller waiting", async () => {
    const occupier = netCreateServer();
    const port = await new Promise<number>((resolve, reject) => {
      occupier.once("error", reject);
      occupier.listen(0, "127.0.0.1", () => resolve((occupier.address() as AddressInfo).port));
    });
    try {
      const handle = startServer(port, noopHost);
      liveHandles.push(handle);
      await assert.rejects(() => handle.bound, /EADDRINUSE/);
    } finally {
      await new Promise<void>(r => occupier.close(() => r()));
    }
  });

  it("/select refuses when the session is not waiting on a choice", async () => {
    resetLive();
    const handle = startServer(0, noopHost);
    liveHandles.push(handle);
    await waitUntilListening(await handle.bound);
    const r = await fetch(`http://localhost:${await handle.bound}/select`,
                          { method: "POST", headers: { "content-type": "application/json" },
                            body: JSON.stringify({ dir: "stories/doorway" }) });
    assert.equal(r.status, 400);
    const body = (await r.json()) as { reason: string };
    assert.equal(body.reason, "the session is not waiting on a choice");
    await handle.close();
    liveHandles.splice(liveHandles.indexOf(handle), 1);
  });
});
