import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseBenchmarkArgs } from "../scripts/benchmark-args.ts";
import { THINK_LEVELS } from "../engine/story-schema.ts";

const extra = { values: ["case", "mode"], booleans: ["split", "cannot-meaning", "cannot-none", "cannot-testimony"] };

describe("parseBenchmarkArgs", () => {
  it("leaves defaults and absent experiment flags to the caller", () => {
    const parsed = parseBenchmarkArgs([]);
    for (const name of ["model", "story", "out", "case", "mode"]) assert.equal(parsed.get(name), undefined);
    assert.equal(parsed.samples, undefined);
    assert.equal(parsed.think, undefined);
    assert.equal(parsed.has("split"), false);
  });

  it("accepts equals and separated values without truncating paths or model ids", () => {
    const args = ["--model=provider/model=variant", "--story", "a story", "--out=a=b.json", "--samples", "20", "--case=one"];
    const parsed = parseBenchmarkArgs(args, { values: ["case"] });
    assert.equal(parsed.get("model"), "provider/model=variant");
    assert.equal(parsed.get("story"), "a story");
    assert.equal(parsed.get("out"), "a=b.json");
    assert.equal(parsed.get("case"), "one");
    assert.equal(parsed.samples, 20);
    assert.equal(args.length, 7);
  });

  it("accepts every supported thinking level", () => {
    for (const think of THINK_LEVELS) assert.equal(parseBenchmarkArgs([`--think=${think}`]).think, think);
  });

  it("rejects invalid thinking levels", () => {
    for (const think of ["LOW", "none", "bogus", " low "]) {
      assert.throws(() => parseBenchmarkArgs([`--think=${think}`]), /--think must be one of/);
    }
  });

  it("accepts positive safe integer sample counts including the boundary", () => {
    for (const samples of [1, 5, 20, Number.MAX_SAFE_INTEGER]) {
      assert.equal(parseBenchmarkArgs([`--samples=${samples}`]).samples, samples);
    }
  });

  it("rejects zero, negatives, fractions, non-numbers and unsafe sample counts", () => {
    for (const samples of ["0", "-1", "1.5", "NaN", "Infinity", "-Infinity", "abc", "5junk", "9007199254740992", "1e100"]) {
      assert.throws(() => parseBenchmarkArgs([`--samples=${samples}`]), /--samples must be a positive safe integer/);
    }
  });

  it("rejects missing and empty values for common and locally declared flags", () => {
    for (const name of ["model", "samples", "story", "out", "think", "case", "mode"]) {
      for (const args of [[`--${name}`], [`--${name}=`], [`--${name}`, ""], [`--${name}= \t`], [`--${name}`, "--split"]]) {
        assert.throws(() => parseBenchmarkArgs(args, extra), new RegExp(`--${name}`));
      }
    }
  });

  it("rejects unknown flags and positional arguments", () => {
    for (const args of [["--sample=20"], ["--unknown"], ["-x"], ["story"], ["--", "--unknown"]]) {
      assert.throws(() => parseBenchmarkArgs(args));
    }
  });

  it("only accepts explicitly declared experiment flags and never values on booleans", () => {
    for (const name of extra.booleans) {
      assert.throws(() => parseBenchmarkArgs([`--${name}`]));
      assert.equal(parseBenchmarkArgs([`--${name}`], extra).has(name), true);
      for (const value of ["", "true", "false"]) {
        assert.throws(() => parseBenchmarkArgs([`--${name}=${value}`], extra));
      }
    }
    assert.throws(() => parseBenchmarkArgs(["--case=one"]));
    assert.throws(() => parseBenchmarkArgs(["--mode=all"]));
    assert.equal(parseBenchmarkArgs(["--mode=repair"], extra).get("mode"), "repair");
  });
});

describe("benchmark CLI rejection regressions", () => {
  for (const script of ["revision-benchmark", "judge-diagnostic", "done-judge-bench"]) {
    it(`${script} rejects bad arguments before loading a story or running inference`, () => {
      const path = fileURLToPath(new URL(`../scripts/${script}.ts`, import.meta.url));
      for (const [arg, message] of [
        ["--sample=20", /Unknown option.*--sample/],
        ["--samples=0", /--samples must be a positive safe integer/],
        ["--think=invalid", /--think must be one of/],
        ["--model", /--model/],
        ["--out=", /--out requires a non-empty value/],
        [script === "judge-diagnostic" ? "--split" : "--cannot-meaning", /Unknown option/],
      ] as const) {
        const result = spawnSync(process.execPath, [...process.execArgv, path, "--story=benchmark-parser-nonexistent-story", arg], {
          encoding: "utf8", timeout: 15_000,
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, message);
        assert.doesNotMatch(result.stderr, /ENOENT|fetch failed/);
        assert.equal(result.stdout, "");
      }
    });
  }
});
