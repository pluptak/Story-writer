/** RUN-GATE — the startup check between a picked story and its run: is the provider there, and
 *  does it know every model the story names? Refusing here beats failing call-by-call three
 *  minutes in. The gate refuses on unreachable and on definitively unavailable models; a model
 *  the provider HAS but has not loaded is only warned about (the transport waits out a JIT load
 *  or reports the server's refusal itself), and a standing server whose model list cannot be
 *  read starts anyway — the calls will speak for themselves. */
import { warn } from "./warnings.ts";
import { PROVIDER } from "./provider.ts";
import { NET } from "./llm-client.ts";

/** Mutable so tests can stand the gate down; nothing else should write it. */
export const RUN_GATE = { enabled: true };

/** Why the run must not start, or null when it may. */
export async function startupRefusal(wanted: string[]): Promise<string | null> {
  if (!RUN_GATE.enabled) return null;
  const models = [...new Set(wanted.map(m => m.trim()).filter(Boolean))];
  if (!models.length) return null;
  if (!(await PROVIDER.health(NET.probeTimeoutMs)))
    return `${PROVIDER.displayName} at ${PROVIDER.baseUrl} is not answering — start its server, then run again`;
  const ids = await PROVIDER.listModels(NET.probeTimeoutMs);
  if (ids === null) return null;
  const missing = models.filter(m => !ids.includes(m));
  if (!missing.length) return null;
  // A model the OpenAI list omits may still exist natively, downloaded but not loaded (LM
  // Studio without just-in-time loading). Only a provider whose native inventory is the full
  // catalog gets to make that distinction; everywhere else the list is the whole truth.
  const rt = PROVIDER.capabilities.fullInventory ? await PROVIDER.inspectModels(NET.probeTimeoutMs) : null;
  const notLoaded = rt ? missing.filter(m => rt.has(m)) : [];
  const unavailable = missing.filter(m => !notLoaded.includes(m));
  if (unavailable.length)
    return `${PROVIDER.displayName} does not have ${unavailable.map(m => `"${m}"`).join(", ")} — make `
      + `${unavailable.length > 1 ? "them" : "it"} available there, or fix the story's models, then run again`;
  if (notLoaded.length)
    warn(`   (available but not loaded in ${PROVIDER.displayName}: ${notLoaded.join(", ")} — the first `
      + `call will wait on a just-in-time load, or fail fast if JIT loading is off)`);
  return null;
}
