/**
 * Context fit checking. The provider-side model parsers live in provider.test.ts now.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { contextShortfall, type ModelInfo } from "../engine/preflight.ts";

// -- CONTEXT SHORTFALL -------------------------------------------------------
describe("contextShortfall", () => {
  const loaded: ModelInfo = {
    loaded: true,
    loadedContext: 10000,
    maxContext: 100000,
  };
  const notLoaded: ModelInfo = {
    loaded: false,
    loadedContext: 0,
    maxContext: 100000,
  };

  it("returns null when the prompt and reply fit", () => {
    const shortfall = contextShortfall(loaded, 5000, 2000);
    assert.equal(shortfall, null);
  });

  it("returns { needs, has } when they do not fit", () => {
    const shortfall = contextShortfall(loaded, 5000, 6000);
    assert.deepEqual(shortfall, { needs: 11000, has: 10000 });
  });

  it("returns null when info is undefined", () => {
    assert.equal(contextShortfall(undefined, 5000, 2000), null);
  });

  it("returns null when the model is not loaded", () => {
    assert.equal(contextShortfall(notLoaded, 5000, 2000), null);
  });

  it("returns null when loadedContext is 0", () => {
    const zeroContext: ModelInfo = { loaded: true, loadedContext: 0, maxContext: 100000 };
    assert.equal(contextShortfall(zeroContext, 5000, 2000), null);
  });

  it("fits exactly at the boundary", () => {
    assert.equal(contextShortfall(loaded, 5000, 5000), null);
  });

  it("fails by one token over the boundary", () => {
    const shortfall = contextShortfall(loaded, 5000, 5001);
    assert.deepEqual(shortfall, { needs: 10001, has: 10000 });
  });
});
