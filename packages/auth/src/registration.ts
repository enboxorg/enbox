/**
 * DWN registration flow.
 *
 * Registers DID-scoped targets with their respective DWN endpoints.
 * Supports two registration paths:
 * 1. Provider auth (`provider-auth-v0`) — OAuth-style with tokens
 * 2. Proof of Work (default) — PoW challenge-response
 *
 * This matches the registration logic from `Enbox.connect()` but as a
 * standalone, reusable function.
 * @module
 */

import type { ServerInfo } from '@enbox/dwn-clients';
import type { EnboxUserAgent, SecretStore } from '@enbox/agent';

import { Convert } from '@enbox/common';
import { DwnRegistrar } from '@enbox/dwn-clients';
import { validateDwnServiceEndpointUrls } from '@enbox/dids';

import { STORAGE_KEYS } from './types.js';

import type {
  RegistrationOptions,
  RegistrationTokenData,
  StorageAdapter,
} from './types.js';

/** One DID and the authoritative endpoints at which that DID should be registered. */
export type DwnRegistrationTarget = {
  did: string;
  dwnEndpoints: string[];
};

interface RegistrationContextBase {
  /** The user agent with RPC access for getServerInfo(). */
  userAgent: EnboxUserAgent;

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

/** @internal */
export type RegistrationContext = RegistrationContextBase & {
  /** DID-scoped registration targets. Each DID is registered only at its own endpoints. */
  targets: DwnRegistrationTarget[];
};

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
 * Register each DID-scoped target with only its configured DWN endpoints.
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
  try {
    const registrationPlan = createRegistrationPlan(ctx);

    // Load initial tokens: when persistTokens is enabled, try the
    // vault-backed SecretStore first, then fall back to the legacy plaintext
    // StorageAdapter. This ensures upgraded clients that already have tokens
    // in localStorage can still read them (and migrate them on the next save).
    const seedTokens = await loadSeedRegistrationTokens(ctx, registration);
    const updatedTokens: Record<string, RegistrationTokenData> = { ...seedTokens };

    for (const [dwnEndpoint, dids] of registrationPlan) {
      await registerDidsAtEndpoint(ctx, registration, dwnEndpoint, dids, updatedTokens);
    }

    // Persist tokens: prefer vault-backed SecretStore over plaintext StorageAdapter.
    // When migrating to SecretStore, also clear the legacy plaintext copy so
    // bearer tokens no longer sit in localStorage.
    await persistUpdatedRegistrationTokens(ctx, registration, updatedTokens);

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
    throw error;
  }
}

// ─── registerWithDwnEndpoints helpers ─────────────────────────────

function createRegistrationPlan(ctx: RegistrationContext): Map<string, string[]> {
  const targets: unknown = ctx.targets;
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('DWN registration requires at least one DID-scoped target.');
  }

  const plan = new Map<string, string[]>();
  for (const [index, target] of targets.entries()) {
    if (!isDwnRegistrationTarget(target)) {
      throw new TypeError(
        `DWN registration target at index ${index} must contain a non-empty DID and an endpoint array.`
      );
    }

    const endpoints = validateDwnServiceEndpointUrls({
      didUri    : target.did,
      endpoints : target.dwnEndpoints,
    });
    for (const endpoint of endpoints) {
      const dids = plan.get(endpoint) ?? [];
      if (!dids.includes(target.did)) {
        dids.push(target.did);
      }
      plan.set(endpoint, dids);
    }
  }

  return plan;
}

function isDwnRegistrationTarget(target: unknown): target is DwnRegistrationTarget {
  if (typeof target !== 'object' || target === null) {
    return false;
  }

  const candidate = target as Partial<DwnRegistrationTarget>;
  return typeof candidate.did === 'string'
    && candidate.did.length > 0
    && Array.isArray(candidate.dwnEndpoints);
}

/**
 * Load the initial registration-token seed set: from persisted storage
 * (vault-backed SecretStore first, then legacy plaintext StorageAdapter)
 * when `persistTokens` is enabled, otherwise from the caller-supplied
 * `registrationTokens` option.
 */
async function loadSeedRegistrationTokens(
  ctx: RegistrationContext,
  registration: RegistrationOptions,
): Promise<Record<string, RegistrationTokenData>> {
  const { secretStore, storage } = ctx;

  if (registration.persistTokens) {
    return runRegistrationMutation(ctx, async (): Promise<Record<string, RegistrationTokenData>> => {
      let storedTokens: Record<string, RegistrationTokenData> = {};
      if (secretStore) {
        storedTokens = await loadTokensFromSecretStore(secretStore);
      }
      if (Object.keys(storedTokens).length === 0 && storage) {
        storedTokens = await loadTokensFromStorage(storage);
      }
      return storedTokens;
    });
  }

  return registration.registrationTokens ?? {};
}

/**
 * Register the planned DIDs with a single DWN endpoint: fetch
 * server info, skip endpoints with no registration requirements, then use
 * provider-auth (when advertised and supported) or fall back to PoW/general
 * registration.
 */
async function registerDidsAtEndpoint(
  ctx: RegistrationContext,
  registration: RegistrationOptions,
  dwnEndpoint: string,
  didsToRegister: string[],
  updatedTokens: Record<string, RegistrationTokenData>,
): Promise<void> {
  const { userAgent } = ctx;

  assertRegistrationActive(ctx);
  const serverInfo = await userAgent.rpc.getServerInfo(dwnEndpoint);
  assertRegistrationActive(ctx);

  if (serverInfo.registrationRequirements.length === 0) {
    return;
  }

  const hasProviderAuth =
    serverInfo.registrationRequirements.includes('provider-auth-v0')
    && serverInfo.providerAuth !== undefined;

  if (hasProviderAuth && registration.onProviderAuthRequired) {
    // --- Provider Auth Path ---
    const tokenData = await resolveProviderAuthToken(
      ctx, registration, serverInfo, dwnEndpoint, updatedTokens,
    );

    // Register each DID using the provider auth token.
    await runRegistrationMutation(ctx, async (): Promise<void> => {
      for (const did of didsToRegister) {
        await DwnRegistrar.registerTenantWithToken(
          dwnEndpoint, did, tokenData.registrationToken,
        );
      }
    });
    return;
  }

  // --- Default Path (PoW / general registration) ---
  await runRegistrationMutation(ctx, async (): Promise<void> => {
    for (const did of didsToRegister) {
      await DwnRegistrar.registerTenant(dwnEndpoint, did);
    }
  });
}

/**
 * Resolve a valid provider-auth token for `dwnEndpoint`: reuse or refresh an
 * existing token when possible, otherwise run the OAuth authorization-code
 * flow. Updates `updatedTokens[dwnEndpoint]` as a side effect whenever a new
 * or refreshed token is obtained.
 */
async function resolveProviderAuthToken(
  ctx: RegistrationContext,
  registration: RegistrationOptions,
  serverInfo: ServerInfo,
  dwnEndpoint: string,
  updatedTokens: Record<string, RegistrationTokenData>,
): Promise<RegistrationTokenData> {
  const initialTokenData = updatedTokens[dwnEndpoint] as RegistrationTokenData | undefined;

  // Refresh expired tokens.
  let tokenData = await refreshExpiredProviderAuthToken(ctx, dwnEndpoint, initialTokenData, updatedTokens);

  // Run the auth flow if no valid token exists.
  if (tokenData === undefined) {
    tokenData = await runProviderAuthFlow(ctx, registration, serverInfo, dwnEndpoint, updatedTokens);
  }

  return tokenData;
}

/**
 * Refresh a provider-auth token that has expired, when refresh credentials
 * are available. Returns the token unchanged when it isn't expired, the
 * refreshed token (recorded in `updatedTokens`) when it is, or `undefined`
 * when it is expired and cannot be refreshed.
 */
async function refreshExpiredProviderAuthToken(
  ctx: RegistrationContext,
  dwnEndpoint: string,
  tokenData: RegistrationTokenData | undefined,
  updatedTokens: Record<string, RegistrationTokenData>,
): Promise<RegistrationTokenData | undefined> {
  if (tokenData?.expiresAt !== undefined && tokenData.expiresAt < Date.now()) {
    if (tokenData.refreshUrl && tokenData.refreshToken) {
      const expiredToken = tokenData;
      const refreshedToken = await runRegistrationMutation(ctx, async (): Promise<RegistrationTokenData> => {
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
      updatedTokens[dwnEndpoint] = refreshedToken;
      return refreshedToken;
    }
    return undefined;
  }

  return tokenData;
}

/**
 * Run the OAuth-style provider-auth flow: build the authorize URL, invoke
 * the app's `onProviderAuthRequired` callback, validate the returned CSRF
 * state, and exchange the authorization code for a registration token.
 * Records the resulting token in `updatedTokens`.
 */
async function runProviderAuthFlow(
  ctx: RegistrationContext,
  registration: RegistrationOptions,
  serverInfo: ServerInfo,
  dwnEndpoint: string,
  updatedTokens: Record<string, RegistrationTokenData>,
): Promise<RegistrationTokenData> {
  const state = crypto.randomUUID();
  const providerAuth = serverInfo.providerAuth!;
  const separator = providerAuth.authorizeUrl.includes('?') ? '&' : '?';
  const authorizeUrl = `${providerAuth.authorizeUrl}${separator}`
    + `redirect_uri=${encodeURIComponent(dwnEndpoint)}`
    + `&state=${encodeURIComponent(state)}`;

  const authResult = await registration.onProviderAuthRequired!({
    authorizeUrl,
    dwnEndpoint,
    state,
  });
  assertRegistrationActive(ctx);

  if (authResult.state !== state) {
    throw new Error('Provider auth state mismatch \u2014 possible CSRF attack.');
  }

  const tokenData = await runRegistrationMutation(ctx, async (): Promise<RegistrationTokenData> => {
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
  return tokenData;
}

/**
 * Persist updated registration tokens: prefer the vault-backed SecretStore
 * over the plaintext StorageAdapter. When migrating to SecretStore, also
 * clear the legacy plaintext copy so bearer tokens no longer sit in
 * localStorage.
 */
async function persistUpdatedRegistrationTokens(
  ctx: RegistrationContext,
  registration: RegistrationOptions,
  updatedTokens: Record<string, RegistrationTokenData>,
): Promise<void> {
  if (!registration.persistTokens) {
    return;
  }

  const { secretStore, storage } = ctx;
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
