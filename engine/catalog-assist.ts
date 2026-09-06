/** CATALOG ASSIST — the character catalog's field-scoped assistant: a stateless, one-shot model
 *  call that proposes a change to a subset of one library character's fields.
 *
 *  Nothing here trusts the model past its own reply text. An unselected field is copied from the
 *  input verbatim regardless of what the model's draft says about it, and the "changes" a caller
 *  shows the author are recomputed here from the constrained result — never the model's own claim
 *  about what it did. This mirrors `applyEdits` in engine/story-spec.ts: the model proposes, a fixed
 *  allowlist (here, `req.fields` plus the character schema) decides what actually lands. */
import * as P from "../prompts.ts";
import type { AssistMode } from "../prompts/catalog-assist.ts";
import { Agent } from "./agent.ts";
import { extractJson } from "./json-extract.ts";
import { checkEntry } from "./catalog.ts";
import { type Catalogs } from "./skills.ts";
import { VOICE_SAMPLE_CAP } from "./story-schema.ts";
import type { Defaults } from "./story-format.ts";

export type { AssistMode };

export const ASSIST_FIELDS = ["name", "portablePersona", "belief", "impulse", "voice", "origin", "skills", "restrictions"] as const;
export type AssistField = typeof ASSIST_FIELDS[number];

/** The wire shape of a character draft as the editor sends it: every portable field, always
 *  present (a brand-new draft has them as empty strings/arrays, never missing keys). */
export type CharacterDraftLike = {
  id: string; name: string; portablePersona: string; belief: string; impulse: string;
  voice: string[]; origin: string; skills: string[]; restrictions: string[];
};

export type AssistRequest = {
  mode: AssistMode;
  fields: readonly AssistField[];
  instruction: string;
  character: CharacterDraftLike;
};

export type AssistProposal = {
  draft: Record<string, unknown>;
  changes: { field: AssistField; before: unknown; after: unknown }[];
  warnings: string[];
};

export type AssistResult =
  | ({ ok: true } & AssistProposal)
  | { ok: false; kind: "model_unavailable" | "provider_error" | "malformed_reply" | "invalid_draft"; reason: string; issues?: string[] };

// Creative enough for persona prose, precise enough not to wander outside the requested fields —
// the three judges in scene-loop.ts use 0.3 because a verdict wants to be repeatable; this call
// still has to write prose sometimes (`create`), so it sits between that and the architect's 0.9.
const TEMPERATURE = 0.7;

function newAssistantAgent(d: Defaults): Agent {
  const a = new Agent("CATALOG-ASSIST", d.models.assistant, P.catalogAssistSystem(), TEMPERATURE);
  a.think = d.thinking.assistant;
  return a;
}

/** A field value the way a model reply may plausibly shape it — an array already, or a single
 *  newline-joined string (what a model asked for "voice" as a JSON value is likelier to produce) —
 *  normalized the way the character editor's own textarea-to-entry conversion does: trimmed, blank
 *  lines dropped, voice capped. Kept local rather than shared with the browser's `entryOf()`, which
 *  the engine cannot import. */
function normalizeField(field: AssistField, value: unknown): string | string[] {
  if (field === "voice" || field === "skills" || field === "restrictions") {
    const lines = Array.isArray(value) ? value.map(v => String(v))
      : typeof value === "string" ? value.split("\n") : [];
    const cleaned = lines.map(l => l.trim()).filter(Boolean);
    return field === "voice" ? cleaned.slice(0, VOICE_SAMPLE_CAP) : cleaned;
  }
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

/** Propose a change to one library character, scoped to `req.fields`. Pure with respect to the
 *  catalog — it never saves; the caller still applies the returned draft through the ordinary
 *  catalog save path, same as an assistant proposal in the editor is Apply-then-Save, never either
 *  alone. */
export async function assistCharacter(d: Defaults, req: AssistRequest, catalogs?: Catalogs): Promise<AssistResult> {
  if (!d.models.assistant) {
    return { ok: false, kind: "model_unavailable", reason: "no assistant model is configured — set models.assistant in defaults.json" };
  }

  const agent = newAssistantAgent(d);
  const characterJson = JSON.stringify(req.character, null, 1);
  agent.hear(P.catalogAssistPrompt(req.mode, req.fields, req.instruction, characterJson));

  let reply: string;
  try {
    reply = await agent.generate("CATALOG-ASSIST", "catalog.assist");
  } catch (e) {
    return { ok: false, kind: "provider_error", reason: (e as Error).message };
  }

  const out = extractJson(reply);
  const hasDraft = !!out.draft && typeof out.draft === "object";
  // A `review` with nothing to propose still answers with `"findings": []` -- the key's presence is
  // what marks a reply as a completed review, not whether the list happens to be empty.
  const hasFindingsKey = "findings" in out;
  if (!hasDraft && !(req.mode === "review" && hasFindingsKey)) {
    return { ok: false, kind: "malformed_reply", reason: "the model's reply did not contain a usable proposal" };
  }

  const merged: Record<string, unknown> = { ...req.character };
  if (hasDraft) {
    for (const field of req.fields) {
      if (field in out.draft) merged[field] = normalizeField(field, out.draft[field]);
    }
  }

  const checked = checkEntry("characters", merged, catalogs);
  if (!checked.ok) {
    return { ok: false, kind: "invalid_draft", reason: "the proposal did not pass validation", issues: checked.issues };
  }

  const before = req.character as Record<string, unknown>;
  const after = checked.entry as Record<string, unknown>;
  const changes = req.fields
    .map(field => ({ field, before: before[field], after: after[field] }))
    .filter(c => JSON.stringify(c.before) !== JSON.stringify(c.after));

  const findings = Array.isArray(out.findings) ? out.findings.map((f: unknown) => String(f)).filter(Boolean) : [];
  const note = typeof out.note === "string" ? out.note.trim() : "";
  const warnings = [...checked.problems, ...findings, ...(note ? [note] : [])];

  return { ok: true, draft: checked.entry, changes, warnings };
}
