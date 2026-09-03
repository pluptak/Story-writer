/** PROVIDER-UTIL — the leaf half of the provider boundary: types every adapter shares, URL
 *  normalization, and the one JSON GET helper. Imports nothing, so the adapters and the
 *  selection module (provider.ts) can both build on it with no cycles. */

/** Which local inference server the engine talks to. */
export type ProviderId = "lmstudio" | "ollama" | "llamacpp";

/** How one model sits on the server right now. `loading` only appears when a server can report
 *  it (LM Studio's older native API); a server that cannot inspect runtime state simply never
 *  answers these questions, which the capability flags say up front. */
export interface ModelRuntime {
  state: "loaded" | "loading" | "not-loaded" | "unknown";
  /** The context window the loaded instance actually runs with (0 when unknown). */
  loadedContext: number;
  /** The largest context the model could be loaded with (0 when unknown). */
  maxContext: number;
}

/** What a provider can and cannot do, decided once at selection so call sites never guess. */
export interface ProviderCapabilities {
  /** Whether the server can report per-model load state and context lengths at all. */
  modelRuntimeInspection: boolean;
  /** Whether the app can ask the server to load a model ahead of a call. */
  modelPreparation: boolean;
  /** Whether `reasoning_effort` belongs on chat requests at all. */
  reasoningEffort: boolean;
  explicitLoad: boolean;
  explicitUnload: boolean;
}

/** One inference server: where it lives, what it can do, and the two model questions it may
 *  or may not be able to answer. Chat itself is OpenAI-compatible everywhere — the adapters
 *  differ only in these URLs, capabilities, and the model-state answers. */
export interface InferenceProvider {
  id: ProviderId;
  /** The name user-facing messages use ("LM Studio", "Ollama", "llama.cpp"). */
  displayName: string;
  /** Base URL ending in /v1; chat and the OpenAI-compatible model list derive from it. */
  baseUrl: string;
  chatUrl: string;
  modelsUrl: string;
  capabilities: ProviderCapabilities;
  /** Headers every provider request carries — auth only, for now. */
  headers(): Record<string, string>;
  /** The OpenAI-compatible model list: ids the server will accept as `model`. `null` means
   *  unreachable (distinct from an empty list). */
  listModels(timeoutMs: number): Promise<string[] | null>;
  /** Whether the server answers AT ALL — any HTTP status counts, because "500 on /models" is
   *  still a server standing. Metadata only: never generation, never preemption. */
  health(timeoutMs: number): Promise<boolean>;
  /** Per-model runtime state from the server's native API, or `null` when it cannot report
   *  one (capability off, endpoint missing, or unreachable). Never cached here — the callers
   *  own their cache policy. */
  inspectModels(timeoutMs: number): Promise<Map<string, ModelRuntime> | null>;
}

/** The per-provider default endpoint, used when neither LLM_BASE_URL nor the LM_STUDIO_URL
 *  alias is set. */
export const DEFAULT_BASE: Record<ProviderId, string> = {
  lmstudio: "http://localhost:1234/v1",
  ollama: "http://localhost:11434/v1",
  llamacpp: "http://localhost:8080/v1",
};

/** Turn whatever the environment called the endpoint into the base URL the provider shape
 *  wants: trimmed, any trailing `/chat/completions` (the old LM_STUDIO_URL form) stripped,
 *  empty replaced by the provider's default, and `/v1` appended when missing — every adapter
 *  hangs its native API off the same root the OpenAI-compatible `/v1` lives under. */
export function normalizeBaseUrl(raw: string, fallback: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  url = url.replace(/\/chat\/completions$/i, "");
  if (!url) url = fallback;
  if (!/\/v1$/.test(url)) url += "/v1";
  return url;
}

/** The root the provider's own (non-OpenAI) API hangs off — `…/v1` gone. */
export const openAiRoot = (baseUrl: string) => baseUrl.replace(/\/v1\/?$/, "");

/** The shared `Authorization` header from LLM_API_KEY, or none. Ollama ignores the key, and
 *  llama.cpp only checks it when the server was started with `--api-key`. */
export function authHeaders(): Record<string, string> {
  const key = process.env.LLM_API_KEY?.trim();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/** GET a JSON body, or `null` on any failure — status, parse, timeout, refusal. Every model
 *  question is advisory, so "could not answer" and "answered no" both arrive as `null` and
 *  the callers degrade the same way they always have. */
export async function getJson(url: string, timeoutMs: number,
                              auth: Record<string, string>): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: auth });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/** Whether the server answers at all: any HTTP status (even 500 on /models) is a standing
 *  server; only a transport failure — refused, timed out, reset — reads as down. */
export async function openAiHealth(baseUrl: string, timeoutMs: number,
                                   auth: Record<string, string>): Promise<boolean> {
  try {
    await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(timeoutMs), headers: auth });
    return true;
  } catch { return false; }
}

/** The OpenAI-compatible model list, shared by every adapter: ids the server will accept.
 *  An empty list reads as "unreachable" — the same call the old LM Studio-only code made. */
export async function openAiListModels(baseUrl: string, timeoutMs: number,
                                       auth: Record<string, string>): Promise<string[] | null> {
  const body = await getJson(`${baseUrl}/models`, timeoutMs, auth);
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return null;
  const ids = data.map(m => String((m as { id?: unknown })?.id ?? "")).filter(Boolean);
  return ids.length ? ids : null;
}
