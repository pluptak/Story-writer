/** LLAMA.CPP ADAPTER — the minimal shape: chat and the OpenAI-compatible model list, nothing
 *  more. The server manages exactly one model by its own flags (`-m`/`-a`), so there is no
 *  load state to inspect and nothing for the app to load or unload; `reasoning_effort` is a
 *  server-side flag there (`--reasoning-effort`), so the per-request field is omitted. */
import { openAiListModels, type InferenceProvider } from "./provider-util.ts";

export function newLlamacppProvider(baseUrl: string, auth: Record<string, string>): InferenceProvider {
  return {
    id: "llamacpp",
    displayName: "llama.cpp",
    baseUrl,
    chatUrl: `${baseUrl}/chat/completions`,
    modelsUrl: `${baseUrl}/models`,
    capabilities: {
      modelRuntimeInspection: false, modelPreparation: false,
      reasoningEffort: false, explicitLoad: false, explicitUnload: false,
    },
    headers: () => ({ ...auth }),
    listModels: (timeoutMs) => openAiListModels(baseUrl, timeoutMs, auth),
    inspectModels: async () => null,
  };
}
