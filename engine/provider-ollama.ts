/** OLLAMA ADAPTER — chat plus `/api/ps` for runtime state. Ollama loads a pulled model on
 *  demand and unloads it after idle, so absence from `/api/ps` means "not resident right
 *  now", never "unavailable" — availability is what `/v1/models` (every pulled model) says.
 *  Context length is fixed per-model by its Modelfile (`num_ctx`) and `/api/ps` does not
 *  report it, so both context numbers read as unknown and the fit checks degrade the way
 *  they do for any model the engine knows nothing about. */
import { getJson, openAiHealth, openAiRoot, openAiListModels,
         type InferenceProvider, type ModelRuntime } from "./provider-util.ts";

/** Parse GET /api/ps — the models currently resident in memory. */
export function parsePsModels(body: unknown): Map<string, ModelRuntime> {
  const out = new Map<string, ModelRuntime>();
  const models = (body as { models?: unknown })?.models;
  if (!Array.isArray(models)) return out;
  for (const m of models as Record<string, any>[]) {
    const id = String(m?.name ?? m?.model ?? "");
    if (!id) continue;
    out.set(id, { state: "loaded", loadedContext: 0, maxContext: 0 });
  }
  return out;
}

export function newOllamaProvider(baseUrl: string, auth: Record<string, string>): InferenceProvider {
  return {
    id: "ollama",
    displayName: "Ollama",
    baseUrl,
    chatUrl: `${baseUrl}/chat/completions`,
    modelsUrl: `${baseUrl}/models`,
    capabilities: {
      modelRuntimeInspection: true, modelPreparation: false,
      reasoningEffort: true, explicitLoad: false, explicitUnload: false,
    },
    headers: () => ({ ...auth }),
    listModels: (timeoutMs) => openAiListModels(baseUrl, timeoutMs, auth),
    health: (timeoutMs) => openAiHealth(baseUrl, timeoutMs, auth),
    async inspectModels(timeoutMs) {
      const body = await getJson(`${openAiRoot(baseUrl)}/api/ps`, timeoutMs, auth);
      return body ? parsePsModels(body) : null;
    },
  };
}
