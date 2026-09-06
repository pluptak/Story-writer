/**
 * Deterministic suite for the character catalog's field-scoped assistant (engine/catalog-assist.ts).
 * Follows architect.test.ts's "STATELESS SUGGEST" pattern: `assistCharacter` builds its own Agent
 * internally, so a test replaces `Agent.prototype.generate` for the call rather than injecting one.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { assistCharacter, type AssistRequest } from "../engine/catalog-assist.ts";
import { Agent } from "../engine/agent.ts";
import type { Defaults } from "../engine/story-format.ts";

const DEFAULTS: Defaults = {
  models: { default: "none", architect: "none", assistant: "assistant-model" },
  thinking: { architect: "low", assistant: "low" },
  requestTimeout: 120, attempts: 3, maxTokens: 2000, stream: false, debug: false,
};

const NO_ASSISTANT: Defaults = { ...DEFAULTS, models: { ...DEFAULTS.models, assistant: "" } };

const character = () => ({
  id: "ivet", name: "IVET", portablePersona: "An ex-locksmith.", belief: "Every lock has a way in.",
  impulse: "When watched, slow down.", voice: ["Hold the door?"], origin: "",
  skills: ["lockpicking"], restrictions: [],
});

const req = (over: Partial<AssistRequest> = {}): AssistRequest => ({
  mode: "revise", fields: ["belief"], instruction: "make it sharper", character: character(), ...over,
});

/** Runs `fn` with Agent.prototype.generate replaced by `reply`, then always restores it — the same
 *  shape architect.test.ts's suggestEdits tests use. */
async function withScriptedReply<T>(reply: () => Promise<string> | string, fn: () => Promise<T>): Promise<T> {
  const orig = Agent.prototype.generate;
  Agent.prototype.generate = async function () { return reply(); };
  try { return await fn(); } finally { Agent.prototype.generate = orig; }
}

describe("assistCharacter", () => {
  it("returns model_unavailable without ever calling the model when models.assistant is unset", async () => {
    let called = false;
    const orig = Agent.prototype.generate;
    Agent.prototype.generate = async function () { called = true; return "{}"; };
    try {
      const r = await assistCharacter(NO_ASSISTANT, req());
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.kind, "model_unavailable");
        assert.match(r.reason, /no assistant model/);
      }
      assert.equal(called, false, "must not call the model at all");
    } finally { Agent.prototype.generate = orig; }
  });

  it("uses the configured assistant model, not the story/default model", async () => {
    let capturedModel = "";
    const orig = Agent.prototype.generate;
    Agent.prototype.generate = async function () {
      capturedModel = (this as Agent).model;
      return JSON.stringify({ draft: { belief: "A sharper belief." }, findings: [] });
    };
    try {
      await assistCharacter(DEFAULTS, req());
      assert.equal(capturedModel, "assistant-model");
    } finally { Agent.prototype.generate = orig; }
  });

  it("applies a valid revise reply to only the selected field", async () => {
    const r = await withScriptedReply(
      () => JSON.stringify({ draft: { belief: "A sharper belief." }, findings: [] }),
      () => assistCharacter(DEFAULTS, req({ fields: ["belief"] })),
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.draft.belief, "A sharper belief.");
      assert.equal(r.draft.portablePersona, "An ex-locksmith.", "untouched field kept verbatim");
      assert.deepEqual(r.changes.map(c => c.field), ["belief"]);
      assert.equal(r.changes[0].before, "Every lock has a way in.");
      assert.equal(r.changes[0].after, "A sharper belief.");
    }
  });

  it("discards a change to a field the author did not select, even when the model returns one", async () => {
    const r = await withScriptedReply(
      () => JSON.stringify({
        draft: { belief: "A sharper belief.", portablePersona: "A completely different person." },
        findings: [],
      }),
      () => assistCharacter(DEFAULTS, req({ fields: ["belief"] })),
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.draft.belief, "A sharper belief.");
      assert.equal(r.draft.portablePersona, "An ex-locksmith.", "unselected field is never taken from the model");
      assert.deepEqual(r.changes.map(c => c.field), ["belief"]);
    }
  });

  it("normalizes an array field the model returned as a single newline-joined string", async () => {
    const r = await withScriptedReply(
      () => JSON.stringify({ draft: { voice: "Line one.\nLine two.\n\nLine three." }, findings: [] }),
      () => assistCharacter(DEFAULTS, req({ fields: ["voice"] })),
    );
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.draft.voice, ["Line one.", "Line two.", "Line three."]);
  });

  it("caps voice at the schema's sample limit even if the model returns more", async () => {
    const r = await withScriptedReply(
      () => JSON.stringify({ draft: { voice: ["one", "two", "three", "four"] }, findings: [] }),
      () => assistCharacter(DEFAULTS, req({ fields: ["voice"] })),
    );
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.draft.voice, ["one", "two", "three"]);
  });

  it("create mode can fill an empty field", async () => {
    const blank = { ...character(), portablePersona: "" };
    const r = await withScriptedReply(
      () => JSON.stringify({ draft: { portablePersona: "A locksmith turned locksmith-hunter." }, findings: [] }),
      () => assistCharacter(DEFAULTS, req({ mode: "create", fields: ["portablePersona"], character: blank })),
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.draft.portablePersona, "A locksmith turned locksmith-hunter.");
      assert.equal(r.changes[0].before, "");
    }
  });

  it("review mode returns findings and no draft as a valid, successful outcome", async () => {
    const r = await withScriptedReply(
      () => JSON.stringify({ findings: ["the belief and impulse pull in opposite directions"] }),
      () => assistCharacter(DEFAULTS, req({ mode: "review", fields: ["belief", "impulse"] })),
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual(r.changes, [], "no draft means no changes");
      assert.ok(r.warnings.some(w => w.includes("opposite directions")));
    }
  });

  it("review mode can also propose a concrete correction alongside its findings", async () => {
    const r = await withScriptedReply(
      () => JSON.stringify({
        findings: ["the impulse doesn't name a real pressure"],
        draft: { impulse: "when cornered, offer a trade instead of a fight" },
      }),
      () => assistCharacter(DEFAULTS, req({ mode: "review", fields: ["impulse"] })),
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.draft.impulse, "when cornered, offer a trade instead of a fight");
      assert.equal(r.changes.length, 1);
      assert.ok(r.warnings.some(w => w.includes("doesn't name a real pressure")));
    }
  });

  it("rejects a reply with neither a draft nor a findings key as malformed", async () => {
    const r = await withScriptedReply(() => JSON.stringify({ note: "I have thoughts." }), () => assistCharacter(DEFAULTS, req()));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.kind, "malformed_reply");
  });

  it("rejects prose-only output (no JSON at all) as malformed", async () => {
    const r = await withScriptedReply(() => "I would rather not.", () => assistCharacter(DEFAULTS, req()));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.kind, "malformed_reply");
  });

  it("rejects create/revise output with no draft key, even with findings present", async () => {
    const r = await withScriptedReply(
      () => JSON.stringify({ findings: ["looks fine"] }),
      () => assistCharacter(DEFAULTS, req({ mode: "revise" })),
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.kind, "malformed_reply");
  });

  it("reports a provider/network failure distinctly from a malformed reply", async () => {
    const orig = Agent.prototype.generate;
    Agent.prototype.generate = async () => { throw new Error("connection refused"); };
    try {
      const r = await assistCharacter(DEFAULTS, req());
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.kind, "provider_error");
        assert.match(r.reason, /connection refused/);
      }
    } finally { Agent.prototype.generate = orig; }
  });

  it("rejects a proposal that fails the character schema, with issues", async () => {
    const r = await withScriptedReply(
      () => JSON.stringify({ draft: { name: "" }, findings: [] }),
      () => assistCharacter(DEFAULTS, req({ fields: ["name"] })),
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.kind, "invalid_draft");
      assert.ok(r.issues && r.issues.length > 0);
    }
  });

  it("carries the character schema's own advisory problems as warnings", async () => {
    const noPersona = { ...character(), portablePersona: "" };
    const r = await withScriptedReply(
      () => JSON.stringify({ draft: { belief: "A sharper belief." }, findings: [] }),
      () => assistCharacter(DEFAULTS, req({ fields: ["belief"], character: noPersona })),
    );
    assert.equal(r.ok, true);
    if (r.ok) assert.ok(r.warnings.some(w => w.includes("no portable persona")));
  });
});
