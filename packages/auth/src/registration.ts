/**
 * DWN registration flow.
 *
 * Registers the agent DID and connected DID with DWN endpoints.
 * Supports two registration paths:
 * 1. Provider auth (`provider-auth-v0`) — OAuth-style with tokens
 * 2. Proof of Work (default) — PoW challenge-response
 *
 * This matches the registration logic from `Enbox.connect()` but as a
 * standalone, reusable function.
 * @module
 */

import type { EnboxUserAgent, SecretStore } from '@enbox/agent';

import { Convert } from '@enbox/common';
import { DwnRegistrar } from '@enbox/dwn-clients';

import { STORAGE_KEYS } from './types.js';

import type {
  RegistrationOptions,
  RegistrationTokenData,
  StorageAdapter,
} from './types.js';

/** @internal */
export interface RegistrationContext {
  /** The user agent with RPC access for getServerInfo(). */
  userAgent: EnboxUserAgent;

  /** DWN endpoints to register with. */
  dwnEndpoints: string[];

  /** The agent DID URI. */
  agentDid: string;

  /** The connected DID URI (the identity's DID). */
  connectedDid: string;

  /**
   * Vault-backed secret store for encrypted token persistence.
   *
   * When provided **and** the vault is unlocked, registration tokens are
   * stored here instead of in the plaintext `StorageAdapter`, keeping
   * bearer credentials out of `localStorage`.
   */
  secretStore?: SecretStore;

  /**
   * Plaintext storage adapter for automatic token persistence.
   *
   * @deprecated Prefer {@link secretStore} when the vault is available.
   *             This field is retained for backwards compatibility with
   *             callers that have not yet migrated.
   */
  storage?: StorageAdapter;

  /** Throws when session teardown invalidated this registration attempt. */
  assertActive?: () => void;

  /** Serializes token and tenant mutations against session teardown. */
  runMutation?: <T>(operation: () => Promise<T>) => Promise<T>;
}

function assertRegistrationActive(ctx: RegistrationContext): void {
  ctx.assertActive?.();
}

async function runRegistrationMutation<T>(
  ctx: RegistrationContext,
  operation: () => Promise<T>,
): Promise<T> {
  return ctx.runMutation === undefined ? operation() : ctx.runMutation(operation);
}

/**
 * Register the agent and connected DIDs with the configured DWN endpoints.
 *
 * For each endpoint:
 * 1. Fetches server info to check registration requirements.
 * 2. If the server requires `provider-auth-v0` and the app provides
 *    `onProviderAuthRequired`, runs the OAuth flow (with token refresh).
 * 3. Otherwise falls back to PoW registration.
 * 4. Calls `onSuccess` when all endpoints succeed, `onFailure` on error.
 *
 * @internal
 */
export async function registerWithDwnEndpoints(
  ctx: RegistrationContext,
  registration: RegistrationOptions,
): Promise<void> {
  const { userAgent, dwnEndpoints, agentDid, connectedDid, secretStore, storage } = ctx;

  try {
    // Load initial tokens: when persistTokens is enabled, try the
    // vault-backed SecretStore first, then fall back to the legacy plaintext
    // StorageAdapter. This ensures upgraded clients that already have tokens
    // in localStorage can still read them (and migrate them on the next save).
    let seedTokens: Record<string, RegistrationTokenData> = {};

    if (registration.persistTokens) {
      seedTokens = await runRegistrationMutation(ctx, async (): Promise<Record<string, RegistrationTokenData>> => {
        let storedTokens: Record<string, RegistrationTokenData> = {};
        if (secretStore) {
          storedTokens = await loadTokensFromSecretStore(secretStore);
        }
        if (Object.keys(storedTokens).length === 0 && storage) {
          storedTokens = await loadTokensFromStorage(storage);
        }
        return storedTokens;
      });
    } else {
      seedTokens = registration.registrationTokens ?? {};
    }

    const updatedTokens: Record<string, RegistrationTokenData> = { ...seedTokens };

    for (const dwnEndpoint of dwnEndpoints) {
      assertRegistrationActive(ctx);
      const serverInfo = await userAgent.rpc.getServerInfo(dwnEndpoint);
      assertRegistrationActive(ctx);

      if (serverInfo.registrationRequirements.length === 0) {
        continue;
      }

      // Deduplicate DIDs to register.
      const didsToRegister = [agentDid, connectedDid]
        .filter((did, i, arr): did is string => arr.indexOf(did) === i);

      const hasProviderAuth =
        serverInfo.registrationRequirements.includes('provider-auth-v0')
        && serverInfo.providerAuth !== undefined;

      if (hasProviderAuth && registration.onProviderAuthRequired) {
        // --- Provider Auth Path ---
        let tokenData = updatedTokens[dwnEndpoint] as RegistrationTokenData | undefined;

        // Refresh expired tokens.
        if (tokenData?.expiresAt !== undefined && tokenData.expiresAt < Date.now()) {
          if (tokenData.refreshUrl && tokenData.refreshToken) {
            const expiredToken = tokenData;
            tokenData = await runRegistrationMutation(ctx, async (): Promise<RegistrationTokenData> => {
              const refreshed = await DwnRegistrar.refreshRegistrationToken(
                expiredToken.refreshUrl!, expiredToken.refreshToken!,
              );
              return {
                registrationToken : refreshed.registrationToken,
                refreshToken      : refreshed.refreshToken,
                expiresAt         : refreshed.expiresIn === undefined
                  ? undefined : Date.now() + (refreshed.expiresIn * 1000),
                tokenUrl   : expiredToken.tokenUrl,
                refreshUrl : expiredToken.refreshUrl,
              };
            });
            updatedTokens[dwnEndpoint] = tokenData;
          } else {
            tokenData = undefined;
          }
        }

        // Run the auth flow if no valid token exists.
        if (tokenData === undefined) {
          const state = crypto.randomUUID();
          const providerAuth = serverInfo.providerAuth!;
          const separator = providerAuth.authorizeUrl.includes('?') ? '&' : '?';
          const authorizeUrl = `${providerAuth.authorizeUrl}${separator}`
            + `redirect_uri=${encodeURIComponent(dwnEndpoint)}`
            + `&state=${encodeURIComponent(state)}`;

          const authResult = await registration.onProviderAuthRequired({
            authorizeUrl,
            dwnEndpoint,
            state,
          });
          assertRegistrationActive(ctx);

          if (authResult.state !== state) {
            throw new Error('Provider auth state mismatch \u2014 possible CSRF attack.');
          }

          tokenData = await runRegistrationMutation(ctx, async (): Promise<RegistrationTokenData> => {
            const tokenResponse = await DwnRegistrar.exchangeAuthCode(
              providerAuth.tokenUrl, authResult.code, dwnEndpoint,
            );
            return {
              registrationToken : tokenResponse.registrationToken,
              refreshToken      : tokenResponse.refreshToken,
              expiresAt         : tokenResponse.expiresIn === undefined
                ? undefined : Date.now() + (tokenResponse.expiresIn * 1000),
              tokenUrl   : providerAuth.tokenUrl,
              refreshUrl : providerAuth.refreshUrl,
            };
          });
          updatedTokens[dwnEndpoint] = tokenData;
        }

        // Register each DID using the provider auth token.
        await runRegistrationMutation(ctx, async (): Promise<void> => {
          for (const did of didsToRegister) {
            await DwnRegistrar.registerTenantWithToken(
              dwnEndpoint, did, tokenData.registrationToken,
            );
          }
        });
      } else {
        // --- Default Path (PoW / general registration) ---
        await runRegistrationMutation(ctx, async (): Promise<void> => {
          for (const did of didsToRegister) {
            await DwnRegistrar.registerTenant(dwnEndpoint, did);
          }
        });
      }
    }

    // Persist tokens: prefer vault-backed SecretStore over plaintext StorageAdapter.
    // When migrating to SecretStore, also clear the legacy plaintext copy so
    // bearer tokens no longer sit in localStorage.
    if (registration.persistTokens) {
      await runRegistrationMutation(ctx, async (): Promise<void> => {
        if (secretStore) {
          await saveTokensToSecretStore(secretStore, updatedTokens);
          // Best-effort cleanup: remove the legacy plaintext copy so bearer
          // tokens no longer sit in localStorage. A failure here must not
          // turn a successful registration into an error.
          if (storage) {
            try { await storage.remove(STORAGE_KEYS.REGISTRATION_TOKENS); } catch { /* best-effort */ }
          }
        } else if (storage) {
          await saveTokensToStorage(storage, updatedTokens);
        }
      });
    }

    assertRegistrationActive(ctx);

    // Notify app of updated tokens (always, even when auto-persisting).
    if (registration.onRegistrationTokens) {
      registration.onRegistrationTokens(updatedTokens);
    }

    registration.onSuccess();
  } catch (error: unknown) {
    // Lifecycle invalidation is a cancellation signal, not a registration
    // failure callback. Re-throw it before invoking app-owned code.
    assertRegistrationActive(ctx);
    registration.onFailure(error);
  }
}

// ─── Storage helpers ──────────────────────────────────────────────

/**
 * Load registration tokens from a `StorageAdapter`.
 *
 * Returns an empty record if no tokens are stored or the stored value
 * is corrupt (best-effort — never throws).
 *
 * @internal
 */
export async function loadTokensFromStorage(
  storage: StorageAdapter,
): Promise<Record<string, RegistrationTokenData>> {
  try {
    const raw = await storage.get(STORAGE_KEYS.REGISTRATION_TOKENS);
    if (!raw) { return {}; }
    return JSON.parse(raw) as Record<string, RegistrationTokenData>;
  } catch {
    return {};
  }
}

/**
 * Save registration tokens to a `StorageAdapter`.
 * @internal
 */
export async function saveTokensToStorage(
  storage: StorageAdapter,
  tokens: Record<string, RegistrationTokenData>,
): Promise<void> {
  await storage.set(STORAGE_KEYS.REGISTRATION_TOKENS, JSON.stringify(tokens));
}

// ─── SecretStore helpers ─────────────────────────────────────────

/**
 * Load registration tokens from the vault-backed {@link SecretStore}.
 *
 * Returns an empty record if no tokens are stored, the stored value is
 * corrupt, or the vault is locked (best-effort — never throws).
 *
 * @internal
 */
export async function loadTokensFromSecretStore(
  secretStore: SecretStore,
): Promise<Record<string, RegistrationTokenData>> {
  try {
    const bytes = await secretStore.get(STORAGE_KEYS.REGISTRATION_TOKENS);
    if (!bytes) { return {}; }
    const json = Convert.uint8Array(bytes).toString();
    return JSON.parse(json) as Record<string, RegistrationTokenData>;
  } catch {
    return {};
  }
}

/**
 * Save registration tokens to the vault-backed {@link SecretStore}.
 * @internal
 */
export async function saveTokensToSecretStore(
  secretStore: SecretStore,
  tokens: Record<string, RegistrationTokenData>,
): Promise<void> {
  const bytes = Convert.string(JSON.stringify(tokens)).toUint8Array();
  await secretStore.put(STORAGE_KEYS.REGISTRATION_TOKENS, bytes);
}
