/**
 * Context fit checking. The provider-side model parsers live in provider.test.ts now.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { contextShortfall, runPreflight, type ModelInfo } from "../engine/preflight.ts";
import { PROVIDER, type ModelRuntime } from "../engine/provider.ts";

describe("runPreflight scene writer models", () => {
  it("checks overrides in every scene, deduplicates them, and ignores unset or empty overrides", async t => {
    const dir = await mkdtemp(join(tmpdir(), "preflight-models-"));
    let now = Date.now();
    let ids: string[] | null = ["base", "scene-loaded"];
    t.mock.method(Date, "now", () => now);
    const list = t.mock.method(PROVIDER, "listModels", async () => ids);
    const inspect = t.mock.method(PROVIDER, "inspectModels", async () => new Map<string, ModelRuntime>([
      ["scene-loaded", { state: "loaded", loadedContext: 4096, maxContext: 32768 }],
    ]));
    try {
      await writeFile(join(dir, "story.json"), JSON.stringify({
        premise: "A premise.", characters: [{ name: "A" }], models: { default: "base" },
        scenes: [
          { question: "Q?" }, { question: "Q?", writerModel: "" },
          { question: "Q?", writerModel: "scene-loaded" },
          { question: "Q?", writerModel: "scene-missing" },
          { question: "Q?", writerModel: "scene-missing" },
          { question: "Q?", writerModel: "scene-loaded" },
        ],
      }));
      const missing = await runPreflight(dir);
      assert.equal(missing.ok, true);
      assert.equal(missing.summary?.modelCheck, "missing");
      assert.deepEqual(missing.summary?.missingModels, ["scene-missing"]);
      assert.match(missing.warnings.join("\n"), /not available.*scene-missing/);
      assert.equal(missing.warnings.filter(w => /scene-loaded is loaded with only 4096/.test(w)).length, 1);
      assert.match(missing.warnings.join("\n"), /3 distinct models/);

      now += 6000;
      ids = ["base", "scene-loaded", "scene-missing"];
      const available = await runPreflight(dir);
      assert.equal(available.summary?.modelCheck, "ok");
      assert.deepEqual(available.summary?.missingModels, []);

      now += 6000;
      ids = null;
      const unreachable = await runPreflight(dir);
      assert.equal(unreachable.summary?.modelCheck, "unreachable");
      assert.match(unreachable.warnings.join("\n"), /model check skipped/);
      assert.equal(list.mock.callCount(), 3);
      assert.equal(inspect.mock.callCount(), 3);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("static check runner", () => {
  const gui = "tests/gui/example.spec.ts(1,2): error TS2304: Cannot find name 'document'.";
  type Result = { status: number | null; stdout?: string; stderr?: string; error?: Error; signal?: string | null };
  const cases: { name: string; result: Result; ok: boolean; detail?: RegExp; step?: string }[] = [
    { name: "clean compiler", result: { status: 0 }, ok: true },
    { name: "global compiler diagnostic", result: { status: 1, stdout: "error TS18003: No inputs were found." }, ok: false, detail: /TS18003/ },
    { name: "diagnostic despite zero exit", result: { status: 0, stdout: "error TS5023: Unknown compiler option." }, ok: false },
    { name: "silent compiler failure", result: { status: 1 }, ok: false, detail: /status 1/ },
    { name: "missing compiler", result: { status: 127, stderr: "tsc: command not found" }, ok: false, detail: /command not found/ },
    { name: "application diagnostic", result: { status: 2, stdout: "engine/preflight.ts(1,1): error TS2322: Bad type." }, ok: false },
    { name: "GUI diagnostic", result: { status: 2, stdout: gui }, ok: true, detail: /1 GUI-spec diagnostic/ },
    { name: "Windows GUI path", result: { status: 1, stdout: gui.replaceAll("/", "\\") }, ok: true },
    { name: "GUI diagnostic continuation", result: { status: 2, stdout: gui + "\r\n  Property 'x' is missing.\r\n    Required here.\r\n" }, ok: true },
    { name: "Playwright config diagnostic", result: { status: 2, stdout: "playwright.config.ts(1,1): error TS2307: Cannot find module." }, ok: true },
    { name: "similar config filename", result: { status: 2, stdout: "playwright.config.tsx(1,1): error TS2307: Cannot find module." }, ok: false },
    { name: "GUI plus global error", result: { status: 2, stdout: gui + "\nerror TS18003: No inputs were found." }, ok: false },
    { name: "GUI plus indented global error", result: { status: 2, stdout: gui + "\n  error TS18003: No inputs were found." }, ok: false },
    { name: "GUI plus shell failure", result: { status: 2, stdout: gui, stderr: "\ncommand not found" }, ok: false },
    { name: "GUI plus unexpected exit", result: { status: 127, stdout: gui }, ok: false },
    { name: "spawn failure", result: { status: null, error: new Error("spawn ENOENT") }, ok: false, detail: /spawn ENOENT/ },
    { name: "truncated GUI output", result: { status: 2, stdout: gui, error: new Error("spawn ENOBUFS") }, ok: false, detail: /ENOBUFS/ },
    { name: "signal after GUI diagnostic", result: { status: null, stdout: gui, signal: "SIGTERM" }, ok: false, detail: /SIGTERM/ },
    { name: "null status", result: { status: null }, ok: false },
    { name: "test failure", step: "test", result: { status: 1, stdout: "# fail 1" }, ok: false },
    { name: "lint spawn error despite status zero", step: "lint", result: { status: 0, error: new Error("spawn failed") }, ok: false },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const source = await readFile(new URL("../scripts/check.mjs", import.meta.url), "utf8");
      const output: string[] = [], calls: string[] = [];
      let exitCode = 0;
      const exit = new Error("exit");
      try {
        runInNewContext(source.replace(/^import .*;\r?$/gm, "")
          .replaceAll("import.meta.url", JSON.stringify(import.meta.url)), {
          URL,
          readFileSync: () => JSON.stringify({ scripts: { typecheck: "typecheck", test: "test", lint: "lint" } }),
          spawnSync: (cmd: string) => {
            calls.push(cmd);
            return cmd === (c.step ?? "typecheck") ? c.result : { status: 0, stdout: "" };
          },
          console: { log: (...args: unknown[]) => output.push(args.join(" ")) },
          process: {
            stdout: { write: (s: string) => output.push(s) },
            exit: (code: number) => { exitCode = code; throw exit; },
          },
        });
      } catch (e) { if (e !== exit) throw e; }
      assert.deepEqual(calls, ["typecheck", "test", "lint"]);
      assert.equal(exitCode, c.ok ? 0 : 1, output.join("\n"));
      assert.equal(output.join("\n").includes("all checks passed"), c.ok);
      if (c.detail) assert.match(output.join("\n"), c.detail);
    });
  }
});

// -- CONTEXT SHORTFALL -------------------------------------------------------
describe("contextShortfall", () => {
  const loaded: ModelInfo = {
    loaded: true,
    loadedContext: 10000,
    maxContext: 100000,
  };
  const notLoaded: ModelInfo = {
    loaded: false,
    loadedContext: 0,
    maxContext: 100000,
  };

  it("returns null when the prompt and reply fit", () => {
    const shortfall = contextShortfall(loaded, 5000, 2000);
    assert.equal(shortfall, null);
  });

  it("returns { needs, has } when they do not fit", () => {
    const shortfall = contextShortfall(loaded, 5000, 6000);
    assert.deepEqual(shortfall, { needs: 11000, has: 10000 });
  });

  it("returns null when info is undefined", () => {
    assert.equal(contextShortfall(undefined, 5000, 2000), null);
  });

  it("returns null when the model is not loaded", () => {
    assert.equal(contextShortfall(notLoaded, 5000, 2000), null);
  });

  it("returns null when loadedContext is 0", () => {
    const zeroContext: ModelInfo = { loaded: true, loadedContext: 0, maxContext: 100000 };
    assert.equal(contextShortfall(zeroContext, 5000, 2000), null);
  });

  it("fits exactly at the boundary", () => {
    assert.equal(contextShortfall(loaded, 5000, 5000), null);
  });

  it("fails by one token over the boundary", () => {
    const shortfall = contextShortfall(loaded, 5000, 5001);
    assert.deepEqual(shortfall, { needs: 10001, has: 10000 });
  });
});
