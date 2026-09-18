/** The boundary CLAUDE.md states as an invariant: server/ never imports engine/ at runtime —
 *  everything a route needs arrives through narrow host interfaces (server/route-hosts.ts),
 *  satisfied by the one object built in host.ts. Only `import type` (erased before anything runs)
 *  may reach into engine/ from here; any other import would hand a route module a live engine
 *  value the host interfaces were supposed to be the sole channel for. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const SERVER_DIR = fileURLToPath(new URL("../server", import.meta.url));

const IMPORT_LINE = /^\s*import\s+(type\s+)?.*from\s+["'](.+?)["']/;

function serverFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name), prefix + e.name + "/");
      else if (e.name.endsWith(".ts")) out.push(prefix + e.name);
    }
  };
  walk(SERVER_DIR, "");
  return out.sort();
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
          + `a runtime import of engine/ from server/ breaks the route-host boundary`);
      });
    });
  }
});

// The scaffold AND handoff domains are fully behind narrow host interfaces — no route module
// knows what a ScaffoldSession or a NextChapterSession is, not even as a type, and neither
// engine/architect.ts nor engine/story-spec.ts is imported anywhere under server/ at all.
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
          + `supposed to be entirely behind host interfaces (CLAUDE.md: routes never import engine/)`);
      });
    });
  }
});

describe("every server/*.ts module is type-checked (tsconfig covers it)", () => {
  // Regression guard: server/routes/catalog-routes.ts once shipped without a tsconfig entry,
  // so `npx tsc` never checked it. The include list uses globs, so match each file
  // against them instead of asserting exact entries.
  const tsconfig = JSON.parse(
    readFileSync(fileURLToPath(new URL("../tsconfig.json", import.meta.url)), "utf8"),
  ) as { include?: string[] };
  const patterns = tsconfig.include ?? [];
  const globToRegExp = (glob: string) => new RegExp(
    "^" + glob.split("/").map((seg) => {
      if (seg === "**") return ".*";
      return seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
    }).join("/") + "$",
  );
  const covered = (file: string) =>
    patterns.some((p) => globToRegExp(p).test(`server/${file}`) || globToRegExp(p).test(file));
  for (const file of serverFiles()) {
    it(`${file} matches a tsconfig include pattern`, () => {
      assert.ok(covered(file),
        `server/${file} matches no tsconfig include pattern — \`npx tsc\` skips it`);
    });
  }
});
describe("no god host interface: `ServerHost` appears in no .ts file", () => {
  // Each route module takes only its narrow slice (server/route-hosts.ts); the single runtime
  // object is typed as their `RouteHosts` intersection. Resurrecting the god interface re-couples
  // every route to every domain, so its name fails here.
  it("no .ts file names ServerHost, even in a comment", () => {
    const roots = [
      fileURLToPath(new URL("../server", import.meta.url)),
      fileURLToPath(new URL("../tests", import.meta.url)),
      fileURLToPath(new URL("../engine", import.meta.url)),
    ];
    const tsFiles: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts") && p !== fileURLToPath(import.meta.url)) tsFiles.push(p);
      }
    };
    roots.forEach(walk);
    const offenders = tsFiles.filter((f) => /\bServerHost\b/.test(readFileSync(f, "utf8")));
    assert.deepEqual(offenders, [], `these files still name ServerHost: ${offenders.join(", ")}`);
  });
});
describe("scaffold-routes.ts and next-chapter-routes.ts never name their session objects", () => {
  // "SCAFFOLD ROUTES" / "NEXT-CHAPTER ROUTES" are the files' own headers, matching every other
  // route module's naming convention (CATALOG ROUTES, STORY EDIT ROUTES, ...) — allowed. Actual use
  // of a module-level session variable always appears as SCAFFOLD/HANDOFF followed by a property
  // access, assignment, or call, never followed by "ROUTES".
  const cases: { file: string; type: string; varName: string; varException: RegExp }[] = [
    { file: "routes/scaffold-routes.ts", type: "ScaffoldSession", varName: "SCAFFOLD", varException: /\bSCAFFOLD\b(?!\s+ROUTES)/ },
    { file: "routes/next-chapter-routes.ts", type: "NextChapterSession", varName: "HANDOFF", varException: /\bHANDOFF\b(?!\s+ROUTES)/ },
  ];
  for (const { file, type, varName, varException } of cases) {
    it(`${file} never mentions ${type} or the ${varName} session variable`, () => {
      const text = readFileSync(join(SERVER_DIR, file), "utf8");
      assert.ok(!new RegExp(`\\b${type}\\b`).test(text),
        `${file} names ${type} — that type is private to host/ now`);
      assert.ok(!varException.test(text),
        `${file} names ${varName} — the session and its bookkeeping are private to host/ now`);
    });
  }
});
