/** The boundary CLAUDE.md states as an invariant: server/ never imports engine/ at runtime —
 *  everything a route needs arrives through ServerHost, built once in story-writer.ts. Only
 *  `import type` (erased before anything runs) may reach into engine/ from here; any other import
 *  would hand a route module a live engine value ServerHost was supposed to be the sole channel for. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const SERVER_DIR = fileURLToPath(new URL("../server", import.meta.url));

const IMPORT_LINE = /^\s*import\s+(type\s+)?.*from\s+["'](.+?)["']/;

function serverFiles(): string[] {
  return readdirSync(SERVER_DIR).filter(f => f.endsWith(".ts"));
}

describe("server/ never imports engine/ at runtime", () => {
  for (const file of serverFiles()) {
    it(`${file} imports engine/ only as a type`, () => {
      const lines = readFileSync(join(SERVER_DIR, file), "utf8").split("\n");
      lines.forEach((line, i) => {
        const m = line.match(IMPORT_LINE);
        if (!m) return;
        const [, isType, spec] = m;
        if (!spec.includes("/engine/")) return;
        assert.ok(isType, `server/${file}:${i + 1} imports "${spec}" without "import type" — `
          + `a runtime import of engine/ from server/ breaks the ServerHost boundary`);
      });
    });
  }
});
