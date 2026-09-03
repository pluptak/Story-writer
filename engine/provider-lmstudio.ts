/** LM STUDIO ADAPTER — chat plus both native model-state APIs. The current REST API lives at
 *  `/api/v1/models` (an inventory of everything downloaded, with `loaded_instances` per model);
 *  older installs only answer `/api/v0/models` (`state`/`loaded_context_length`). The adapter
 *  tries v1 first and falls back to v0, so either install reports the same shape. */
import { getJson, openAiRoot, openAiListModels,
         type InferenceProvider, type ModelRuntime } from "./provider-util.ts";

/** Parse the current inventory (GET /api/v1/models). Returns `null` when the body is not that
 *  shape — the caller's cue to try the older endpoint. A model with no loaded instance is
 *  `not-loaded`; this endpoint cannot see one that is still loading. */
export function parseModelInventory(body: unknown): Map<string, ModelRuntime> | null {
  const models = (body as { models?: unknown })?.models;
  if (!Array.isArray(models)) return null;
  const out = new Map<string, ModelRuntime>();
  for (const m of models as Record<string, any>[]) {
    const id = String(m?.key ?? m?.id ?? "");
    if (!id) continue;
    if (m?.type !== undefined && m.type !== "llm") continue;   // embeddings never serve a scene
    const inst = Array.isArray(m?.loaded_instances) ? m.loaded_instances[0] : undefined;
    out.set(id, {
      state: inst ? "loaded" : "not-loaded",
      loadedContext: Number(inst?.config?.context_length) || 0,
      maxContext: Number(m?.max_context_length) || 0,
    });
  }
  return out;
}

/** Parse the older native API (GET /api/v0/models) — the shape the engine read before there
 *  was a provider boundary. This one CAN see a model mid-load. */
export function parseModelInfo(body: unknown): Map<string, ModelRuntime> {
  const out = new Map<string, ModelRuntime>();
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return out;
  for (const m of data as Record<string, any>[]) {
    const id = String(m?.id ?? "");
    if (!id) continue;
    out.set(id, {
      state: m?.state === "loaded" ? "loaded" : m?.state === "loading" ? "loading" : "not-loaded",
      loadedContext: Number(m?.loaded_context_length) || 0,
      maxContext: Number(m?.max_context_length) || 0,
    });
  }
  return out;
}

export function newLmStudioProvider(baseUrl: string, auth: Record<string, string>): InferenceProvider {
  const root = openAiRoot(baseUrl);
  return {
    id: "lmstudio",
    displayName: "LM Studio",
    baseUrl,
    chatUrl: `${baseUrl}/chat/completions`,
    modelsUrl: `${baseUrl}/models`,
    capabilities: {
      modelRuntimeInspection: true, modelPreparation: true,
      reasoningEffort: true, explicitLoad: true, explicitUnload: true,
    },
    headers: () => ({ ...auth }),
    listModels: (timeoutMs) => openAiListModels(baseUrl, timeoutMs, auth),
    async inspectModels(timeoutMs) {
      const v1 = await getJson(`${root}/api/v1/models`, timeoutMs, auth);
      if (v1) {
        const parsed = parseModelInventory(v1);
        if (parsed) return parsed;
      }
      const v0 = await getJson(`${root}/api/v0/models`, timeoutMs, auth);
      return v0 ? parseModelInfo(v0) : null;
    },
  };
}
