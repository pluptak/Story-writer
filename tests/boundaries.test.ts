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

// Block 5 (PLANS.md, the decoupling program): the scaffold domain is fully behind ServerHost now —
// scaffold-routes.ts should not know what a ScaffoldSession is, not even as a type. This is scoped
// to scaffold-routes.ts alone, not the whole `server/ never imports engine/ at runtime` check above:
// next-chapter-routes.ts still legitimately imports engine/architect.ts (Block 6 is what retires
// that), and server.ts still imports engine/story-spec.ts's StorySpec type for specView/
// storyJsonShape, which the handoff still calls through ServerHost.
describe("server/scaffold-routes.ts never reaches into the scaffold domain directly", () => {
  const SCAFFOLD_ROUTES = join(SERVER_DIR, "scaffold-routes.ts");

  it("does not import engine/architect.ts or engine/story-spec.ts, even as a type", () => {
    const lines = readFileSync(SCAFFOLD_ROUTES, "utf8").split("\n");
    lines.forEach((line, i) => {
      const m = line.match(IMPORT_LINE);
      if (!m) return;
      const [, , spec] = m;
      assert.ok(!spec.includes("/engine/architect.ts") && !spec.includes("/engine/story-spec.ts"),
        `scaffold-routes.ts:${i + 1} imports "${spec}" — the scaffold domain is supposed to be `
        + `entirely behind ServerHost.scaffold*() now (PLANS.md, Block 5)`);
    });
  });

  it("never mentions ScaffoldSession or the SCAFFOLD session variable", () => {
    // "SCAFFOLD ROUTES" is the file's own header, matching every other route module's naming
    // convention (CATALOG ROUTES, STORY EDIT ROUTES, ...) — allowed. Actual use of the module-level
    // session variable always appears as SCAFFOLD followed by a property access, assignment, or
    // call, never followed by "ROUTES".
    const text = readFileSync(SCAFFOLD_ROUTES, "utf8");
    assert.ok(!/\bScaffoldSession\b/.test(text),
      "scaffold-routes.ts names ScaffoldSession — that type is private to host.ts now");
    assert.ok(!/\bSCAFFOLD\b(?!\s+ROUTES)/.test(text),
      "scaffold-routes.ts names SCAFFOLD — the session and its bookkeeping are private to host.ts now");
  });
});
