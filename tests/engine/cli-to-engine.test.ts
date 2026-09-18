/** CLI-to-engine mapping: parseCli(argv) -> CliOptions -> engineOptionsFromCli -> EngineOptions.
 *  The mapping is pure; only applyEngineOptions touches the singleton (save/restore here). */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseCli, type CliOptions } from "../../cli-flags.ts";
import { engineOptionsFromCli } from "../../cli-to-engine.ts";
import { ENGINE, applyEngineOptions } from "../../engine/engine-state.ts";

function cliWith(overrides: Partial<CliOptions> = {}): CliOptions {
  const base = parseCli([]);
  assert.ok(base.ok);
  return { ...base.options, ...overrides };
}

function optionsOf(argv: string[]): CliOptions {
  const r = parseCli(argv);
  assert.ok(r.ok, `expected ok for ${JSON.stringify(argv)}`);
  return r.options;
}

describe("engineOptionsFromCli", () => {
  it("echoes by default; plain --serve goes quiet; headless echoes", () => {
    assert.equal(engineOptionsFromCli(cliWith()).echoConsole, true);
    assert.equal(engineOptionsFromCli(optionsOf(["--serve"])).echoConsole, false);
    assert.equal(engineOptionsFromCli(optionsOf(["--serve", "--headless"])).echoConsole, true);
    assert.equal(engineOptionsFromCli(optionsOf(["--headless"])).echoConsole, true);
  });

  it("--no-cast-echo trims only the cast echo", () => {
    assert.equal(engineOptionsFromCli(cliWith()).echoCast, true);
    assert.equal(engineOptionsFromCli(optionsOf(["--no-cast-echo"])).echoCast, false);
  });

  it("passes the experiment arms through, with free-consult precedence from parseCli", () => {
    const opts = engineOptionsFromCli(optionsOf([
      "--free-consult", "--free-consult-v2", "--free-consult-v3",
      "--split-judge", "--consult-since", "--heard-channel",
      "--cannot-meaning", "--cannot-none", "--cannot-testimony",
    ]));
    assert.equal(opts.freeConsult, "v3");
    assert.equal(opts.splitJudge, true);
    assert.equal(opts.consultSince, true);
    assert.equal(opts.heardChannel, true);
    assert.equal(opts.cannotMeaning, true);
    assert.equal(opts.cannotNone, true);
    assert.equal(opts.cannotTestimony, true);
  });

  it("defaults every experiment arm to off", () => {
    const opts = engineOptionsFromCli(cliWith());
    assert.equal(opts.freeConsult, false);
    assert.equal(opts.splitJudge, false);
    assert.equal(opts.consultSince, false);
    assert.equal(opts.heardChannel, false);
    assert.equal(opts.cannotMeaning, false);
    assert.equal(opts.cannotNone, false);
    assert.equal(opts.cannotTestimony, false);
  });
});

describe("applyEngineOptions", () => {
  it("writes the mapped knobs onto ENGINE and nothing else observable", () => {
    const saved = {
      echoConsole: ENGINE.echoConsole, echoCast: ENGINE.echoCast,
      freeConsult: ENGINE.freeConsult, splitJudge: ENGINE.splitJudge,
      consultSince: ENGINE.consultSince, heardChannel: ENGINE.heardChannel,
      cannotMeaning: ENGINE.cannotMeaning, cannotNone: ENGINE.cannotNone,
      cannotTestimony: ENGINE.cannotTestimony, stream: ENGINE.stream,
    };
    try {
      applyEngineOptions(engineOptionsFromCli(optionsOf(["--serve", "--split-judge"])));
      assert.equal(ENGINE.echoConsole, false);
      assert.equal(ENGINE.splitJudge, true);
      assert.equal(ENGINE.stream, saved.stream);
    } finally {
      applyEngineOptions({
        echoConsole: saved.echoConsole, echoCast: saved.echoCast,
        freeConsult: saved.freeConsult, splitJudge: saved.splitJudge,
        consultSince: saved.consultSince, heardChannel: saved.heardChannel,
        cannotMeaning: saved.cannotMeaning, cannotNone: saved.cannotNone,
        cannotTestimony: saved.cannotTestimony,
      });
    }
    assert.equal(ENGINE.echoConsole, saved.echoConsole);
  });
});
