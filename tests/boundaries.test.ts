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

// Blocks 5-6 (PLANS.md, the decoupling program): the scaffold AND handoff domains are fully behind
// ServerHost now — no route module knows what a ScaffoldSession or a NextChapterSession is, not
// even as a type, and neither engine/architect.ts nor engine/story-spec.ts (the last of it retired
// once host.ts's own snapshot builders stopped needing specView/storyJsonShape as ServerHost
// methods) is imported anywhere under server/ at all.
describe("server/ has no dependency on engine/architect.ts or engine/story-spec.ts, even as a type", () => {
  for (const file of serverFiles()) {
    it(`${file} does not import either module`, () => {
      const lines = readFileSync(join(SERVER_DIR, file), "utf8").split("\n");
      lines.forEach((line, i) => {
        const m = line.match(IMPORT_LINE);
        if (!m) return;
        const [, , spec] = m;
        assert.ok(!spec.includes("/engine/architect.ts") && !spec.includes("/engine/story-spec.ts"),
          `server/${file}:${i + 1} imports "${spec}" — the scaffold and handoff domains are `
          + `supposed to be entirely behind ServerHost now (PLANS.md, Blocks 5-6)`);
      });
    });
  }
});

describe("scaffold-routes.ts and next-chapter-routes.ts never name their session objects", () => {
  // "SCAFFOLD ROUTES" / "NEXT-CHAPTER ROUTES" are the files' own headers, matching every other
  // route module's naming convention (CATALOG ROUTES, STORY EDIT ROUTES, ...) — allowed. Actual use
  // of a module-level session variable always appears as SCAFFOLD/HANDOFF followed by a property
  // access, assignment, or call, never followed by "ROUTES".
  const cases: { file: string; type: string; varName: string; varException: RegExp }[] = [
    { file: "scaffold-routes.ts", type: "ScaffoldSession", varName: "SCAFFOLD", varException: /\bSCAFFOLD\b(?!\s+ROUTES)/ },
    { file: "next-chapter-routes.ts", type: "NextChapterSession", varName: "HANDOFF", varException: /\bHANDOFF\b(?!\s+ROUTES)/ },
  ];
  for (const { file, type, varName, varException } of cases) {
    it(`${file} never mentions ${type} or the ${varName} session variable`, () => {
      const text = readFileSync(join(SERVER_DIR, file), "utf8");
      assert.ok(!new RegExp(`\\b${type}\\b`).test(text),
        `${file} names ${type} — that type is private to host.ts now`);
      assert.ok(!varException.test(text),
        `${file} names ${varName} — the session and its bookkeeping are private to host.ts now`);
    });
  }
});
