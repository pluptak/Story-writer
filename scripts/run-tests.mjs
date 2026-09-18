// Test runner: collects every `*.test.ts` under tests/ and runs them with tsx --test.
//
// Why a script instead of a glob in package.json: neither cmd.exe nor tsx expands a quoted
// `tests/**/*.test.ts` on Windows, so a new test file would silently never run. Expanding here
// with readdir keeps "add a file, it runs" true on every shell.
//
// `.spec.ts` (Playwright, under tests/gui/) is deliberately NOT matched — that suite runs under
// `npm run test:gui`. Run: `npm test`.
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = fileURLToPath(new URL("../tests", import.meta.url));

function collect(dir) {
  const out = [];
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...collect(p));
    else if (e.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const files = collect(TESTS_DIR);
if (!files.length) {
  console.error("run-tests: no *.test.ts files found under tests/");
  process.exit(1);
}

const r = spawnSync("npx", ["tsx", "--test", ...files], { encoding: "utf8", shell: true });
// Relay through our own stdio (not inherit) so callers that capture this script's output —
// e.g. scripts/check.mjs, which reads `npm test`'s `# pass`/`# fail` lines — still see it.
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
process.exit(r.status ?? 1);
