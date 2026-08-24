/**
 * WARNINGS — the engine's warning sink. Warnings are ambient by design (loaders and parsers emit
 * them while they work), but they must not be side effects on global `console`: anyone capturing or
 * silencing them swaps `WARN.sink` instead of monkey-patching anything shared. A bare exported
 * `let` can't be reassigned from outside its defining module, so — like ENGINE and LIVE — the sink
 * is a field on one exported object.
 */
export const WARN = {
  sink: (msg: string) => { console.warn(msg); },
};

/** Emit an engine warning through the current sink. The message arrives fully formatted. */
export function warn(msg: string) {
  WARN.sink(msg);
}
