/** PROVIDER — which local inference server the engine talks to, decided once at import from
 *  the environment and exposed as the one `PROVIDER` the transport (llm-client.ts) and the
 *  model checks (preflight.ts) go through. Chat is OpenAI-compatible everywhere; what differs
 *  per server — model-state APIs, load control, reasoning effort — lives behind the adapters'
 *  capability flags, so a call site never names a server. */
import { authHeaders, DEFAULT_BASE, normalizeBaseUrl,
         type InferenceProvider, type ProviderId } from "./provider-util.ts";
import { newLmStudioProvider } from "./provider-lmstudio.ts";
import { newOllamaProvider } from "./provider-ollama.ts";
import { newLlamacppProvider } from "./provider-llamacpp.ts";

export { normalizeBaseUrl, openAiRoot } from "./provider-util.ts";
export type { InferenceProvider, ModelRuntime, ProviderCapabilities, ProviderId } from "./provider-util.ts";

/** Read LLM_PROVIDER, defaulting to lmstudio. An unknown value is a configuration error, not
 *  a fallback: the engine would otherwise run against a server nobody pointed it at. */
export function selectProviderId(): ProviderId {
  const raw = (process.env.LLM_PROVIDER ?? "lmstudio").trim().toLowerCase();
  if (raw === "lmstudio" || raw === "ollama" || raw === "llamacpp") return raw;
  throw new Error(`LLM_PROVIDER="${raw}" is not one of: lmstudio, ollama, llamacpp`);
}

/** Build one provider. `auth` is injectable so tests can exercise the header without env. */
export function makeProvider(id: ProviderId, baseUrl: string,
                             auth: Record<string, string> = authHeaders()): InferenceProvider {
  if (id === "ollama") return newOllamaProvider(baseUrl, auth);
  if (id === "llamacpp") return newLlamacppProvider(baseUrl, auth);
  return newLmStudioProvider(baseUrl, auth);
}

/** The one provider this process talks to. LM_STUDIO_URL — the old full-chat-URL variable —
 *  still works through normalizeBaseUrl's suffix stripping, but LLM_BASE_URL is canonical. */
export const PROVIDER: InferenceProvider = (() => {
  const id = selectProviderId();
  const raw = process.env.LLM_BASE_URL ?? process.env.LM_STUDIO_URL ?? "";
  return makeProvider(id, normalizeBaseUrl(raw, DEFAULT_BASE[id]));
})();
