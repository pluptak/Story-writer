/** CLI-TO-ENGINE — the pure mapping from parsed command-line options to engine knobs.
 *
 *  This is the second half of the two testable pure-ish functions:
 *    parseCli(argv) -> CliOptions        (cli-flags.ts: argv grammar + precedence)
 *    engineOptionsFromCli(cli) -> EngineOptions (here: CLI shape -> engine shape)
 *
 *  All CLI compatibility logic lives in these two: the free-consult v3>v2>v1 precedence and the
 *  architect-debug enable derivation already happened in parseCli; the two echo derivations
 *  (!serve || headless, !noCastEcho) happen here. Everything else is a passthrough. The actual
 *  mutation is one call — applyEngineOptions() in engine/engine-state.ts — so story-writer.ts
 *  configures the engine without touching its fields.
 *
 *  Type-only imports: erased before anything runs, so this creates no runtime edge between the
 *  root and engine/ layers. */
import type { CliOptions } from "./cli-flags.ts";
import type { EngineOptions } from "./engine/engine-state.ts";

export function engineOptionsFromCli(cli: CliOptions): EngineOptions {
  return {
    // Plain --serve goes quiet (the viewer is the monitor); headless serves AND echoes.
    echoConsole: !cli.serve || cli.headless,
    // --no-cast-echo trims just the characters' acts/reactions/answers; prose stays.
    echoCast: !cli.run.noCastEcho,
    freeConsult: cli.experiments.freeConsult,
    splitJudge: cli.experiments.splitJudge,
    consultSince: cli.experiments.consultSince,
    heardChannel: cli.experiments.heardChannel,
    cannotMeaning: cli.experiments.cannotMeaning,
    cannotNone: cli.experiments.cannotNone,
    cannotTestimony: cli.experiments.cannotTestimony,
  };
}
