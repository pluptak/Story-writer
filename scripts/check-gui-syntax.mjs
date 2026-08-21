// `tsc`/`npm test` never touch server/gui/viewer/*.js -- browser-loaded ES modules, not part of the
// TS build. A syntax error there (e.g. `await` outside `async`) breaks ES module linking for the
// whole viewer, silently: everything renders as a bare shell with nothing in it. This is the cheap
// substitute for a bundler's parse step, run over each file `node --check` can catch on its own.
import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const dir = join(import.meta.dirname, "..", "server", "gui");
const files = [
  join(dir, "viewer.js"),
  ...readdirSync(join(dir, "viewer")).filter(f => f.endsWith(".js")).map(f => join(dir, "viewer", f)),
];

let failed = false;
for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (e) {
    failed = true;
    console.error(e.stderr.toString());
  }
}
if (failed) process.exit(1);
console.log(`${files.length} GUI modules parse cleanly.`);
