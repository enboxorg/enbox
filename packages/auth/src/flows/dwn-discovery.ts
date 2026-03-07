/**
 * Local DWN discovery integration for browser and CLI environments.
 *
 * This module bridges the local DWN discovery mechanisms (implemented in
 * `@enbox/agent`) with the `@enbox/auth` storage, session lifecycle, and
 * event system.
 *
 * ## Discovery channels (browser, highest to lowest priority)
 *
 * 1. **URL fragment payload** — A `dwn://connect` redirect just landed
 *    on the page with the endpoint in `#`. Highest priority because it's
 *    fresh and explicit.
 * 2. **Persisted endpoint** (localStorage) — A previously discovered
 *    endpoint restored and re-validated via `GET /info`.
 *
 * ## Discovery channels (CLI / native, all transparent)
 *
 * In Node/Bun environments, the agent's `LocalDwnDiscovery` reads the
 * `~/.enbox/dwn.json` discovery file automatically inside
 * `AgentDwnApi.getLocalDwnEndpoint()`. The browser-specific functions
 * in this module (`checkUrlForDwnDiscoveryPayload`, `requestLocalDwnDiscovery`)
 * are not needed in those environments.
 *
 * @see https://github.com/enboxorg/enbox/issues/677
 * @module
 */

import type { EnboxUserAgent } from '@enbox/agent';

import { buildDwnConnectUrl, readDwnDiscoveryPayloadFromUrl } from '@enbox/agent';

import type { AuthEventEmitter } from '../events.js';
import { STORAGE_KEYS } from '../types.js';
import type { StorageAdapter } from '../types.js';

/**
 * Check the current page URL for a `DwnDiscoveryPayload` in the fragment.
 *
 * This is called once at the start of a connection flow to detect whether
 * the user was just redirected back from a `dwn://connect` handler. If a
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
 * @param agent - The running EnboxUserAgent.
 * @param storage - The auth storage adapter.
 * @returns `true` if an endpoint was restored and validated, `false` otherwise.
 */
export async function restoreLocalDwnEndpoint(
  agent: EnboxUserAgent,
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
 * This function handles the **receiving** side of local DWN discovery in
 * the browser. It does NOT trigger the `dwn://connect` redirect — use
 * {@link requestLocalDwnDiscovery} for that.
 *
 * The discovery channels, from highest to lowest priority:
 *
 * 1. **URL fragment payload** — A `dwn://connect` redirect just landed on
 *    this page with the DWN endpoint in `#`. This is the highest-priority
 *    signal because it's fresh and explicit.
 *
 * 2. **Persisted endpoint** (localStorage) — A previously discovered
 *    endpoint is restored and re-validated via `GET /info`.
 *
 * When an `emitter` is provided, this function emits:
 * - `'local-dwn-available'` with the endpoint when discovery succeeds.
 * - `'local-dwn-unavailable'` when no local DWN could be reached.
 *
 * @param agent - The running EnboxUserAgent.
 * @param storage - The auth storage adapter.
 * @param emitter - Optional event emitter for local DWN status notifications.
 * @returns `true` if a local DWN endpoint was discovered and injected.
 */
export async function applyLocalDwnDiscovery(
  agent: EnboxUserAgent,
  storage: StorageAdapter,
  emitter?: AuthEventEmitter,
): Promise<boolean> {
  // Step 1: Check for a fresh payload in the URL fragment (redirect just happened).
  const freshEndpoint = checkUrlForDwnDiscoveryPayload();

  if (freshEndpoint) {
    const accepted = await agent.dwn.setCachedLocalDwnEndpoint(freshEndpoint);
    if (accepted) {
      await persistLocalDwnEndpoint(storage, freshEndpoint);
      emitter?.emit('local-dwn-available', { endpoint: freshEndpoint });
      return true;
    }
    // Payload was in the URL but the server is not reachable — fall through.
  }

  // Step 2: Try restoring from storage.
  const restored = await restoreLocalDwnEndpoint(agent, storage);

  if (restored) {
    const endpoint = await storage.get(STORAGE_KEYS.LOCAL_DWN_ENDPOINT);
    if (endpoint) {
      emitter?.emit('local-dwn-available', { endpoint });
    }
  } else {
    emitter?.emit('local-dwn-unavailable', {});
  }

  return restored;
}

// ─── dwn://connect trigger ──────────────────────────────────────

/**
 * Initiate the `dwn://connect` flow by opening the connect URL.
 *
 * This asks the operating system to route `dwn://connect?callback=<url>`
 * to the registered handler (electrobun-dwn), which will redirect the
 * user's browser back to `callbackUrl` with the local DWN endpoint
 * encoded in the URL fragment.
 *
 * **Note:** There is no reliable cross-browser API to detect whether a
 * `dwn://` handler is installed. If no handler is registered, this call
 * will silently fail or show an OS-level error dialog.
 *
 * @param callbackUrl - The URL to redirect back to. Defaults to the
 *   current page URL (without its fragment) if running in a browser.
 * @returns `true` if the connect URL was opened, `false` if no
 *   callback URL could be determined (e.g. no `globalThis.location`).
 *
 * @example
 * ```ts
 * // Trigger the dwn://connect flow to discover a local DWN.
 * requestLocalDwnDiscovery();
 * // The page will reload with the endpoint in the URL fragment.
 * // On the next connect/restore, applyLocalDwnDiscovery() reads it.
 * ```
 */
export function requestLocalDwnDiscovery(callbackUrl?: string): boolean {
  const resolvedCallback = callbackUrl ?? currentPageUrl();
  if (!resolvedCallback) {
    return false;
  }

  const registerUrl = buildDwnConnectUrl(resolvedCallback);

  // Open the dwn:// URL. Use window.open() rather than location.href
  // assignment to avoid navigating away from the current page if the
  // OS handler isn't installed.
  if (typeof globalThis.open === 'function') {
    globalThis.open(registerUrl);
    return true;
  }

  // Fallback for environments with location but no window.open.
  if (typeof globalThis.location !== 'undefined') {
    globalThis.location.href = registerUrl;
    return true;
  }

  return false;
}

// ─── Internal helpers ───────────────────────────────────────────

/** Return the current page URL without the fragment, or `undefined`. */
function currentPageUrl(): string | undefined {
  if (typeof globalThis.location === 'undefined') {
    return undefined;
  }
  return globalThis.location.href.split('#')[0];
}
