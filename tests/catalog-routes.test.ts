/** Catalog routes: GET and POST operations on the global character catalog. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleCatalogRoutes } from "../server/catalog-routes.ts";
import type { ServerHost } from "../server/server.ts";
import { callRoute, callGet } from "./helpers.ts";

const CHAR_ONE = {
  id: "char-one",
  name: "Alice",
  portablePersona: "A curious explorer",
  belief: "Curiosity is virtue",
  impulse: "investigate",
  voice: [] as string[],
  skills: [] as string[],
  restrictions: [] as string[],
};

const CHAR_TWO = {
  id: "char-two",
  name: "Bob",
  portablePersona: "A cautious keeper",
  belief: "Safety first",
  impulse: "protect",
  voice: [] as string[],
  skills: [] as string[],
  restrictions: [] as string[],
};

function makeHost(overrides?: Partial<ServerHost>): ServerHost {
  return {
    catalogEntries: async (kind: string) => {
      if (kind === "characters") {
        return { ok: true as const, entries: [CHAR_ONE, CHAR_TWO] };
      }
      return { ok: false as const, reason: "unknown kind" };
    },
    catalogCheck: (entry: any) => {
      if (!entry.name) {
        return { ok: false as const, issues: ["name is required"] };
      }
      const problems: string[] = [];
      if (!entry.portablePersona) {
        problems.push("no portable persona");
      }
      return { ok: true as const, problems };
    },
    catalogSave: async (kind: string, entry: any) => {
      if (!entry.name) {
        return { ok: false as const, reason: "validation failed", issues: ["name is required"] };
      }
      if (kind !== "characters") {
        return { ok: false as const, reason: "unknown kind" };
      }
      return { ok: true as const, entry: { ...entry, version: 1 }, problems: [] };
    },
    catalogDelete: async (kind: string, id: string) => {
      if (kind !== "characters") {
        return { ok: false as const, reason: "unknown kind" };
      }
      if (id === "char-one" || id === "char-two") {
        return { ok: true as const };
      }
      return { ok: false as const, reason: `entry "${id}" not found`, status: 404 };
    },
    // Unused by these routes
    selectableStory: async () => null,
    storyForEdit: async () => ({ ok: false, error: "unused" }),
    checkStory: () => ({ ok: false, error: "unused", issues: [] }),
    saveStory: async () => ({ ok: false, reason: "unused" }),
    discardScene: async () => ({ ok: false, reason: "unused", status: 400 }),
    suggestEdits: async () => ({ ok: false, error: "unused" }),
    storyCards: async () => [],
    resolveStoryDir: (d: string) => d,
    runDirs: async () => [],
    runLlmLogs: async () => [],
    readLlmLog: async () => null,
    writtenChapters: async () => [],
    loadedModelIds: async () => null,
    architectModel: async () => "none",
    newScaffoldSession: async () => { throw new Error("unused"); },
    newHandoffSession: async () => { throw new Error("unused"); },
    directEdit: () => ({ ok: false, reason: "unused" }),
    specView: (s: unknown) => s,
    outDir: () => "",
    fullCast: async () => ({ ok: false, error: "unused" }),
    ...overrides,
  } as unknown as ServerHost;
}

// -- SECTION ----
describe("/catalog (GET)", () => {
  it("leaves other paths alone", async () => {
    const r = await callGet(handleCatalogRoutes, "/catalogs", makeHost());
    assert.equal(r.handled, false);
  });

  it("returns entries from the catalog", async () => {
    const r = await callGet(handleCatalogRoutes, "/catalog", makeHost());
    assert.equal(r.code, 200);
    const body = r.json();
    assert.equal(body.ok, true);
    assert.equal(body.entries.length, 2);
    assert.equal(body.entries[0].id, "char-one");
    assert.equal(body.entries[1].id, "char-two");
  });

  it("defaults kind to 'characters' when query param is absent", async () => {
    let capturedKind = "";
    const h = makeHost({
      catalogEntries: async (kind: string) => {
        capturedKind = kind;
        return { ok: true as const, entries: [] };
      },
    });
    await callGet(handleCatalogRoutes, "/catalog", h);
    assert.equal(capturedKind, "characters");
  });

  it("passes kind query param to the host", async () => {
    let capturedKind = "";
    const h = makeHost({
      catalogEntries: async (kind: string) => {
        capturedKind = kind;
        return { ok: true as const, entries: [] };
      },
    });
    await callGet(handleCatalogRoutes, "/catalog?kind=companions", h);
    assert.equal(capturedKind, "companions");
  });

  it("returns 400 when the host rejects the kind", async () => {
    const h = makeHost({
      catalogEntries: async () => ({ ok: false as const, reason: "unknown kind" }),
    });
    const r = await callGet(handleCatalogRoutes, "/catalog?kind=invalid", h);
    assert.equal(r.code, 400);
    assert.equal(r.json().ok, false);
    assert.match(r.json().reason, /unknown kind/);
  });
});

// -- SECTION ----
describe("/catalog/entry (GET)", () => {
  it("returns one entry by id", async () => {
    const r = await callGet(handleCatalogRoutes, "/catalog/entry?id=char-one", makeHost());
    assert.equal(r.code, 200);
    const body = r.json();
    assert.equal(body.ok, true);
    assert.equal(body.entry.id, "char-one");
    assert.equal(body.entry.name, "Alice");
  });

  it("defaults kind to 'characters' when query param is absent", async () => {
    let capturedKind = "";
    const h = makeHost({
      catalogEntries: async (kind: string) => {
        capturedKind = kind;
        return { ok: true as const, entries: [CHAR_ONE] };
      },
    });
    await callGet(handleCatalogRoutes, "/catalog/entry?id=char-one", h);
    assert.equal(capturedKind, "characters");
  });

  it("is 400 when no id is provided", async () => {
    const r = await callGet(handleCatalogRoutes, "/catalog/entry", makeHost());
    assert.equal(r.code, 400);
    assert.match(r.json().reason, /no id/);
  });

  it("is 404 when an unknown id is requested", async () => {
    const r = await callGet(handleCatalogRoutes, "/catalog/entry?id=nonexistent", makeHost());
    assert.equal(r.code, 404);
    assert.match(r.json().reason, /no such entry/);
  });

  it("returns 400 when the host rejects the kind", async () => {
    const h = makeHost({
      catalogEntries: async () => ({ ok: false as const, reason: "unknown kind" }),
    });
    const r = await callGet(handleCatalogRoutes, "/catalog/entry?kind=invalid&id=char-one", h);
    assert.equal(r.code, 400);
    assert.equal(r.json().ok, false);
  });
});

// -- SECTION ----
describe("/catalog/check (POST)", () => {
  it("passes problems through on validation success", async () => {
    const h = makeHost({
      catalogCheck: (entry: any) => ({
        ok: true as const,
        problems: ["some advisory"],
      }),
    });
    const r = await callRoute(handleCatalogRoutes, "/catalog/check",
      { entry: CHAR_ONE }, h);
    assert.equal(r.code, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.problems[0], "some advisory");
  });

  it("passes issues through on validation failure, still as HTTP 200", async () => {
    const r = await callRoute(handleCatalogRoutes, "/catalog/check",
      { entry: { noName: true } }, makeHost());
    assert.equal(r.code, 200);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.issues[0], "name is required");
  });
});

// -- SECTION ----
describe("/catalog/save (POST)", () => {
  it("saves a valid entry", async () => {
    const r = await callRoute(handleCatalogRoutes, "/catalog/save",
      { entry: CHAR_ONE }, makeHost());
    assert.equal(r.code, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.entry.id, "char-one");
    assert.equal(r.body.entry.version, 1);
    assert.equal(r.body.problems.length, 0);
  });

  it("returns problems alongside a successful save", async () => {
    const h = makeHost({
      catalogSave: async (kind: string, entry: any) => ({
        ok: true as const,
        entry: { ...entry, version: 1 },
        problems: ["some advisory warning"],
      }),
    });
    const r = await callRoute(handleCatalogRoutes, "/catalog/save",
      { entry: CHAR_ONE }, h);
    assert.equal(r.code, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.problems[0], "some advisory warning");
  });

  it("is 400 when save fails due to validation", async () => {
    const r = await callRoute(handleCatalogRoutes, "/catalog/save",
      { entry: { noName: true } }, makeHost());
    assert.equal(r.code, 400);
    assert.equal(r.body.ok, false);
    assert.match(r.body.reason, /validation/);
    assert.equal(r.body.issues[0], "name is required");
  });

  it("passes kind to the host when provided", async () => {
    let capturedKind = "";
    const h = makeHost({
      catalogSave: async (kind: string) => {
        capturedKind = kind;
        return { ok: true as const, entry: CHAR_ONE, problems: [] };
      },
    });
    await callRoute(handleCatalogRoutes, "/catalog/save",
      { kind: "companions", entry: CHAR_ONE }, h);
    assert.equal(capturedKind, "companions");
  });

  it("defaults kind to 'characters' when not provided", async () => {
    let capturedKind = "";
    const h = makeHost({
      catalogSave: async (kind: string) => {
        capturedKind = kind;
        return { ok: true as const, entry: CHAR_ONE, problems: [] };
      },
    });
    await callRoute(handleCatalogRoutes, "/catalog/save",
      { entry: CHAR_ONE }, h);
    assert.equal(capturedKind, "characters");
  });

  it("is 400 when an unknown kind is requested", async () => {
    const h = makeHost({
      catalogSave: async (kind: string) => {
        if (kind !== "characters") {
          return { ok: false as const, reason: `no such catalog "${kind}"` };
        }
        return { ok: true as const, entry: CHAR_ONE, problems: [] };
      },
    });
    const r = await callRoute(handleCatalogRoutes, "/catalog/save",
      { kind: "invalid", entry: CHAR_ONE }, h);
    assert.equal(r.code, 400);
    assert.equal(r.body.ok, false);
    assert.match(r.body.reason, /no such catalog/);
  });
});

// -- SECTION ----
describe("/catalog/delete (POST)", () => {
  it("deletes an existing entry", async () => {
    const r = await callRoute(handleCatalogRoutes, "/catalog/delete",
      { id: "char-one" }, makeHost());
    assert.equal(r.code, 200);
    assert.equal(r.body.ok, true);
  });

  it("is 400 when no id is provided", async () => {
    const r = await callRoute(handleCatalogRoutes, "/catalog/delete",
      { }, makeHost());
    assert.equal(r.code, 400);
    assert.match(r.body.reason, /no id/);
  });

  it("is 404 when the entry does not exist", async () => {
    const r = await callRoute(handleCatalogRoutes, "/catalog/delete",
      { id: "nonexistent" }, makeHost());
    assert.equal(r.code, 404);
    assert.match(r.body.reason, /not found/);
  });

  it("passes kind to the host when provided", async () => {
    let capturedKind = "";
    const h = makeHost({
      catalogDelete: async (kind: string) => {
        capturedKind = kind;
        return { ok: true as const };
      },
    });
    await callRoute(handleCatalogRoutes, "/catalog/delete",
      { kind: "companions", id: "char-one" }, h);
    assert.equal(capturedKind, "companions");
  });

  it("defaults kind to 'characters' when not provided", async () => {
    let capturedKind = "";
    const h = makeHost({
      catalogDelete: async (kind: string) => {
        capturedKind = kind;
        return { ok: true as const };
      },
    });
    await callRoute(handleCatalogRoutes, "/catalog/delete",
      { id: "char-one" }, h);
    assert.equal(capturedKind, "characters");
  });

  it("is 400 when an unknown kind is requested", async () => {
    const h = makeHost({
      catalogDelete: async (kind: string) => {
        if (kind !== "characters") {
          return { ok: false as const, reason: `no such catalog "${kind}"` };
        }
        return { ok: true as const };
      },
    });
    const r = await callRoute(handleCatalogRoutes, "/catalog/delete",
      { kind: "invalid", id: "char-one" }, h);
    assert.equal(r.code, 400);
    assert.equal(r.body.ok, false);
    assert.match(r.body.reason, /no such catalog/);
  });

  it("is 404 when entry is not found but kind is valid", async () => {
    const h = makeHost({
      catalogDelete: async (kind: string, id: string) => {
        if (kind !== "characters") {
          return { ok: false as const, reason: `no such catalog "${kind}"` };
        }
        if (id === "nonexistent") {
          return { ok: false as const, reason: `entry "${id}" not found`, status: 404 };
        }
        return { ok: true as const };
      },
    });
    const r = await callRoute(handleCatalogRoutes, "/catalog/delete",
      { id: "nonexistent" }, h);
    assert.equal(r.code, 404);
    assert.equal(r.body.ok, false);
    assert.match(r.body.reason, /not found/);
  });
});

// -- SECTION ----
describe("route dispatch edge cases", () => {
  it("returns false for routes it does not handle", async () => {
    const r = await callRoute(handleCatalogRoutes, "/scaffold/say", {}, makeHost());
    assert.equal(r.handled, false);
  });

  it("returns false for /catalog POST (not GET)", async () => {
    const r = await callRoute(handleCatalogRoutes, "/catalog", {}, makeHost());
    assert.equal(r.handled, false);
  });

  it("returns false for /catalog/entry POST (not GET)", async () => {
    const r = await callRoute(handleCatalogRoutes, "/catalog/entry", {}, makeHost());
    assert.equal(r.handled, false);
  });

  it("returns false for /catalog/check GET (not POST)", async () => {
    const r = await callGet(handleCatalogRoutes, "/catalog/check", makeHost());
    assert.equal(r.handled, false);
  });

  it("returns false for /catalog/save GET (not POST)", async () => {
    const r = await callGet(handleCatalogRoutes, "/catalog/save", makeHost());
    assert.equal(r.handled, false);
  });

  it("returns false for /catalog/delete GET (not POST)", async () => {
    const r = await callGet(handleCatalogRoutes, "/catalog/delete", makeHost());
    assert.equal(r.handled, false);
  });
});
