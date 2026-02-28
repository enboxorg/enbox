/**
 * Local DWN discovery integration for the `dwn://register` browser flow.
 *
 * This module bridges the `dwn://register` protocol handler (implemented in
 * `@enbox/agent`) with the `@enbox/auth` storage and session lifecycle:
 *
 * 1. **On page load**: Check the URL fragment for a `DwnDiscoveryPayload`
 *    delivered by the `dwn://register` redirect from electrobun-dwn.
 * 2. **Persist the endpoint** in the auth storage so subsequent page loads
 *    can restore it without re-triggering the redirect.
 * 3. **Inject the endpoint** into the agent's `AgentDwnApi` so that
 *    `LocalDwnDiscovery` uses it for routing.
 *
 * @see https://github.com/enboxorg/enbox/issues/589
 * @module
 */

import type { Web5UserAgent } from '@enbox/agent';

import { readDwnDiscoveryPayloadFromUrl } from '@enbox/agent';

import { STORAGE_KEYS } from '../types.js';
import type { StorageAdapter } from '../types.js';

/**
 * Check the current page URL for a `DwnDiscoveryPayload` in the fragment.
 *
 * This is called once at the start of a connection flow to detect whether
 * the user was just redirected back from a `dwn://register` handler. If a
 * valid payload is found, the endpoint is persisted and the fragment is
 * cleared to prevent double-reads.
 *
 * @returns The discovered endpoint string, or `undefined` if no payload
 *   was found in the URL.
 */
export function checkUrlForDwnDiscoveryPayload(): string | undefined {
  if (typeof globalThis.location === 'undefined') {
    return undefined;
  }

  const payload = readDwnDiscoveryPayloadFromUrl(globalThis.location.href);
  if (!payload) {
    return undefined;
  }

  // Clear the fragment to prevent re-reading on subsequent calls or
  // if the user refreshes the page after the redirect.
  if (typeof globalThis.history !== 'undefined' && globalThis.history.replaceState) {
    const cleanUrl = globalThis.location.href.split('#')[0];
    globalThis.history.replaceState(null, '', cleanUrl);
  }

  return payload.endpoint;
}

/**
 * Persist a discovered local DWN endpoint in auth storage.
 *
 * @param storage - The auth storage adapter.
 * @param endpoint - The local DWN server base URL.
 */
export async function persistLocalDwnEndpoint(
  storage: StorageAdapter,
  endpoint: string,
): Promise<void> {
  await storage.set(STORAGE_KEYS.LOCAL_DWN_ENDPOINT, endpoint);
}

/**
 * Clear the persisted local DWN endpoint from auth storage.
 *
 * Call this when the cached endpoint is found to be stale (server no
 * longer running).
 *
 * @param storage - The auth storage adapter.
 */
export async function clearLocalDwnEndpoint(
  storage: StorageAdapter,
): Promise<void> {
  await storage.remove(STORAGE_KEYS.LOCAL_DWN_ENDPOINT);
}

/**
 * Restore a previously persisted local DWN endpoint and inject it into the
 * agent's discovery cache.
 *
 * The endpoint is validated by the agent (via `GET /info`) before being
 * accepted. If validation fails, the stale entry is removed from storage.
 *
 * @param agent - The running Web5UserAgent.
 * @param storage - The auth storage adapter.
 * @returns `true` if an endpoint was restored and validated, `false` otherwise.
 */
export async function restoreLocalDwnEndpoint(
  agent: Web5UserAgent,
  storage: StorageAdapter,
): Promise<boolean> {
  const endpoint = await storage.get(STORAGE_KEYS.LOCAL_DWN_ENDPOINT);
  if (!endpoint) {
    return false;
  }

  const accepted = await agent.dwn.setCachedLocalDwnEndpoint(endpoint);
  if (!accepted) {
    // The server is no longer running — remove the stale entry.
    await clearLocalDwnEndpoint(storage);
    return false;
  }

  return true;
}

/**
 * Run the full local DWN discovery sequence for a browser connection flow.
 *
 * 1. Check the URL fragment for a fresh `dwn://register` payload.
 * 2. If not found, try to restore a previously persisted endpoint.
 * 3. If a fresh payload is found, persist it and inject it into the agent.
 *
 * This should be called after the agent has been started (vault unlocked,
 * `agentDid` available) so that `setCachedLocalDwnEndpoint()` can
 * validate the endpoint.
 *
 * @param agent - The running Web5UserAgent.
 * @param storage - The auth storage adapter.
 * @returns `true` if a local DWN endpoint was discovered and injected.
 */
export async function applyLocalDwnDiscovery(
  agent: Web5UserAgent,
  storage: StorageAdapter,
): Promise<boolean> {
  // Step 1: Check for a fresh payload in the URL fragment (redirect just happened).
  const freshEndpoint = checkUrlForDwnDiscoveryPayload();

  if (freshEndpoint) {
    const accepted = await agent.dwn.setCachedLocalDwnEndpoint(freshEndpoint);
    if (accepted) {
      await persistLocalDwnEndpoint(storage, freshEndpoint);
      return true;
    }
    // Payload was in the URL but the server is not reachable — fall through.
  }

  // Step 2: Try restoring from storage.
  return restoreLocalDwnEndpoint(agent, storage);
}
