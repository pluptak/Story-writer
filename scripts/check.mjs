// One command for the fast static checks that gate a hand-off: type-check, the node test suite, and
// lint. Runs all three even when an earlier one fails, so a single invocation prints every problem
// at once instead of costing a command (and an output to read) per check. Exits non-zero if any
// hard check failed. The environment-gated checks are deliberately NOT here: `npm run test:gui`
// needs a browser and `@playwright/test`, and `npm run preflight` needs a live inference server.
//
// The commands come from package.json's own scripts, so this stays in step with them by construction.
//
// Run: `npm run check`.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const BOLD = "\x1b[1m", DIM = "\x1b[2m", RED = "\x1b[31m", GREEN = "\x1b[32m", YELLOW = "\x1b[33m", OFF = "\x1b[0m";
const run = cmd => {
  const r = spawnSync(cmd, { shell: true, encoding: "utf8" });
  return { status: r.status ?? 1, out: (r.stdout || "") + (r.stderr || "") };
};

/** tsc, minus the diagnostics that belong to the GUI specs. tsconfig type-checks `tests/gui/*` and
 *  `playwright.config.ts`, but those are really validated by `npm run test:gui` (playwright's own
 *  runner) — and when `@playwright/test` is not installed they error en masse and drown out a real
 *  app/engine/node-test type error. So set those aside, report them as deferred, and let this step's
 *  pass/fail turn on everything else. A genuine type error outside `tests/gui/` still fails here. */
function typecheck() {
  const { out } = run(pkg.scripts.typecheck);
  const errors = out.split(/\r?\n/).filter(l => /: error TS\d+/.test(l));
  const isGui = l => /^(tests[/\\]gui[/\\]|playwright\.config\.ts)/.test(l);
  const appErrors = errors.filter(l => !isGui(l));
  const guiCount = errors.length - appErrors.length;
  const note = guiCount
    ? `${YELLOW}${guiCount} GUI-spec diagnostic(s) deferred to \`npm run test:gui\`${OFF}` +
      `${DIM} (install @playwright/test to type-check those here)${OFF}`
    : "";
  return { ok: appErrors.length === 0, detail: appErrors.join("\n"),
           pass: `app/engine/tests type-check clean${note ? " · " + note : ""}` };
}

/** A plain pass/fail step. `summary` pulls a one-line result out of the captured output. */
function plain(cmd, summary) {
  const { status, out } = run(cmd);
  return { ok: status === 0, detail: out.trimEnd(), pass: summary(out) };
}

const testSummary = out => {
  const pass = out.match(/^# pass (\d+)/m)?.[1];
  const fail = out.match(/^# fail (\d+)/m)?.[1];
  return pass != null ? `${pass} passed, ${fail ?? "0"} failed` : "test suite ran";
};

const steps = [
  ["typecheck", typecheck],
  ["test", () => plain(pkg.scripts.test, testSummary)],
  ["lint", () => plain(pkg.scripts.lint, () => "no problems")],
];

console.log(`${BOLD}running ${steps.length} checks: ${steps.map(s => s[0]).join(", ")}${OFF}\n`);

const results = [];
for (const [name, fn] of steps) {
  process.stdout.write(`${BOLD}── ${name} ──${OFF}  ${DIM}${pkgCmd(name)}${OFF}\n`);
  const r = fn();
  if (r.ok) console.log(`${GREEN}✓${OFF} ${r.pass}\n`);
  else console.log(`${RED}✗ failed${OFF}\n${r.detail}\n`);
  results.push([name, r.ok]);
}

function pkgCmd(name) {
  return name === "typecheck" ? pkg.scripts.typecheck
    : name === "test" ? "npm test"
    : pkg.scripts.lint;
}

const failed = results.filter(([, ok]) => !ok).map(([n]) => n);
console.log(`${BOLD}── summary ──${OFF}`);
for (const [name, ok] of results) console.log(`  ${ok ? GREEN + "✓" : RED + "✗"}${OFF} ${name}`);
if (failed.length) {
  console.log(`\n${RED}${BOLD}FAILED: ${failed.join(", ")}${OFF}`);
  process.exit(1);
}
console.log(`\n${GREEN}${BOLD}all checks passed${OFF}`);
