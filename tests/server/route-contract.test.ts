/** Route contract snapshot: the status code and `{ok:false}` envelope every route answers
 *  outside its happy path, as docs/GUI-SPEC.md documents them. A change here is a client-visible
 *  change — update GUI-SPEC.md alongside, never just the expectation.
 *
 *  Convention under test: mutating POSTs answer `{ok:true,…}` or `{ok:false,reason}` with a 4xx;
 *  validation-shaped answers (issues/problems, the catalog assistant's expected failures) are 200
 *  with `ok:false`; unknown actions are 404; known paths refuse other methods with 405. */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { resetLive } from "../../live.ts";
import { handleCatalogRoutes } from "../../server/routes/catalog-routes.ts";
import { handleStoryEditRoutes } from "../../server/routes/story-edit-routes.ts";
import { handleStoryReadRoutes } from "../../server/routes/story-read-routes.ts";
import { handleScaffoldRoutes } from "../../server/routes/scaffold-routes.ts";
import { handleNextChapterRoutes } from "../../server/routes/next-chapter-routes.ts";
import { handleRunControl } from "../../server/routes/run-control-routes.ts";
import { handleRunLogRoutes } from "../../server/routes/run-log-routes.ts";
import { handleSessionRoutes } from "../../server/routes/session-routes.ts";
import { callRoute, callGet, makeHost } from "../helpers.ts";

afterEach(() => resetLive());

function err(code: number, body: any) {
  assert.equal(body.ok, false, `expected an {ok:false} envelope, got ${JSON.stringify(body)}`);
  assert.ok("reason" in body || "error" in body || "issues" in body,
    `expected reason/error/issues in ${JSON.stringify(body)}`);
  return code;
}

describe("catalog contract", () => {
  it("unknown kind is a client error; schema trouble is a 200 validation answer", async () => {
    const badKind = await callRoute(handleCatalogRoutes, "/catalog/check", { kind: "nope", entry: {} }, makeHost());
    assert.equal(err(badKind.code, badKind.body), 400);
    const badEntry = await callRoute(handleCatalogRoutes, "/catalog/check",
      { kind: "characters", entry: {} },
      makeHost({ catalogCheck: async () => ({ ok: false, issues: ["name is required"] }) }));
    assert.equal(err(badEntry.code, badEntry.body), 200);
  });

  it("missing ids and shapes are 400", async () => {
    for (const [path, body] of [
      ["/catalog/delete", {}],
      ["/catalog/visibility", { id: "x", hidden: "yes" }],
      ["/catalog/assist", {}],
    ] as const) {
      const r = await callRoute(handleCatalogRoutes, path, body, makeHost());
      assert.equal(err(r.code, r.body), 400, path);
    }
    const noId = await callGet(handleCatalogRoutes, "/catalog/entry", makeHost());
    assert.equal(err(noId.code, noId.json()), 400);
  });
});

describe("story editor contract", () => {
  it("unknown stories are 400; check/suggest validation is a 200 answer", async () => {
    const save = await callRoute(handleStoryEditRoutes, "/story/save", { dir: "nope", story: {} }, makeHost());
    assert.equal(err(save.code, save.body), 400);
    const discard = await callRoute(handleStoryEditRoutes, "/story/discard", { dir: "nope", n: 2 }, makeHost());
    assert.equal(err(discard.code, discard.body), 400);
    const check = await callRoute(handleStoryEditRoutes, "/story/check", { story: {} }, makeHost());
    assert.equal(err(check.code, check.body), 200);
    const suggest = await callRoute(handleStoryEditRoutes, "/story/suggest", { spec: {}, text: "x" }, makeHost());
    assert.equal(err(suggest.code, suggest.body), 200);
  });
});

describe("story read contract", () => {
  it("unknown stories are 400, unwritten chapters 404, wrong methods 405", async () => {
    const cast = await callGet(handleStoryReadRoutes, "/cast?dir=nope", makeHost());
    assert.equal(err(cast.code, cast.json()), 400);
    const chapter = await callGet(handleStoryReadRoutes, "/chapter?dir=doorway&n=9",
      makeHost({ selectableStory: async () => "doorway", writtenChapters: async () => [1] }));
    assert.equal(err(chapter.code, chapter.json()), 404);
  });
});

describe("scaffold/handoff contract", () => {
  it("empty says, unknown actions, and undiscovered stories keep their codes", async () => {
    const say = await callRoute(handleScaffoldRoutes, "/scaffold/say", { text: "  " }, makeHost());
    assert.equal(err(say.code, say.body), 400);
    const bogus = await callRoute(handleScaffoldRoutes, "/scaffold/bogus", {}, makeHost());
    assert.equal(err(bogus.code, bogus.body), 404);
    const start = await callRoute(handleScaffoldRoutes, "/scaffold/start", { idea: "x" }, makeHost());
    assert.equal(err(start.code, start.body), 400);
    const hsay = await callRoute(handleNextChapterRoutes, "/next-chapter/say", { text: "" }, makeHost());
    assert.equal(err(hsay.code, hsay.body), 400);
    const hstart = await callRoute(handleNextChapterRoutes, "/next-chapter/start", { dir: "nope" }, makeHost());
    assert.equal(err(hstart.code, hstart.body), 400);
    const hbogus = await callRoute(handleNextChapterRoutes, "/next-chapter/bogus", {}, makeHost());
    assert.equal(err(hbogus.code, hbogus.body), 404);
  });
});

describe("run control contract", () => {
  it("steering with nothing to steer is 400; toggles answer 200", async () => {
    resetLive();
    for (const [path, body] of [
      ["/stop", {}],
      ["/pause", {}],
      ["/resume", {}],
      ["/continue", {}],
      ["/consult-me", {}],
      ["/reader-answer", { answer: "x" }],
      ["/lint-decision", { choice: "bogus" }],
    ] as const) {
      const r = await callRoute(handleRunControl, path, body, makeHost());
      assert.equal(err(r.code, r.body), 400, path);
    }
    const toggle = await callRoute(handleRunControl, "/interactive", { on: false }, makeHost());
    assert.equal(toggle.code, 200);
    assert.equal(toggle.body.ok, true);
  });
});

describe("run log contract", () => {
  it("no run yet and unknown runs are 404; unknown stories 400", async () => {
    const current = await callGet(handleRunLogRoutes, "/log.jsonl", makeHost());
    assert.equal(err(current.code, current.json()), 404);
    const retained = await callGet(handleRunLogRoutes, "/runs/log?dir=nope&id=x", makeHost());
    assert.equal(err(retained.code, retained.json()), 400);
  });

  it("read routes refuse other methods with 405", async () => {
    const current = await callRoute(handleRunLogRoutes, "/log.jsonl", {}, makeHost());
    assert.equal(current.handled, true);
    assert.equal(current.code, 405);
    const retained = await callRoute(handleRunLogRoutes, "/runs/log", {}, makeHost());
    assert.equal(retained.handled, true);
    assert.equal(retained.code, 405);
  });

  it("mutating POSTs refuse other methods with 405, not 404", async () => {
    resetLive();
    const cases = [
      await callRoute(handleRunControl, "/stop", {}, makeHost(), "GET"),
      await callGet(handleStoryEditRoutes, "/story/save?dir=doorway", makeHost()),
      await callGet(handleCatalogRoutes, "/catalog/save", makeHost()),
      await callRoute(handleSessionRoutes, "/select", { dir: "x" }, makeHost(), "GET"),
      await callRoute(handleStoryReadRoutes, "/cast", { dir: "x" }, makeHost(), "POST"),
      await callGet(handleScaffoldRoutes, "/scaffold/say", makeHost()),
      await callGet(handleNextChapterRoutes, "/next-chapter/say", makeHost()),
    ];
    for (const r of cases) {
      assert.equal(r.handled, true);
      assert.equal(r.code, 405);
    }
  });

  it("state reads refuse non-GET methods with 405", async () => {
    const scaffoldPut = await callRoute(handleScaffoldRoutes, "/scaffold", {}, makeHost(), "PUT");
    assert.equal(scaffoldPut.handled, true);
    assert.equal(scaffoldPut.code, 405);
    const handoffPut = await callRoute(handleNextChapterRoutes, "/next-chapter", {}, makeHost(), "PUT");
    assert.equal(handoffPut.handled, true);
    assert.equal(handoffPut.code, 405);
  });
});

describe("session contract", () => {
  it("select with no pending pick is 400; reads refuse other methods", async () => {
    resetLive();
    const select = await callRoute(handleSessionRoutes, "/select", { dir: "x" }, makeHost());
    assert.equal(err(select.code, select.body), 400);
    const runPost = await callRoute(handleSessionRoutes, "/run", {}, makeHost());
    assert.equal(runPost.code, 405);
    const run = await callGet(handleSessionRoutes, "/run", makeHost());
    assert.equal(run.code, 200);
    const models = await callGet(handleSessionRoutes, "/models", makeHost());
    assert.equal(models.code, 200);
    assert.deepEqual(models.json().ids, []);
    assert.equal(models.json().reachable, false);
  });
});
