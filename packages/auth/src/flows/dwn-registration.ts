/**
 * DWN registration flow.
 *
 * Registers the agent DID and connected DID with DWN endpoints.
 * Supports two registration paths:
 * 1. Provider auth (`provider-auth-v0`) — OAuth-style with tokens
 * 2. Proof of Work (default) — PoW challenge-response
 *
 * This matches the registration logic from `Web5.connect()` but as a
 * standalone, reusable function.
 * @module
 */

import type { EnboxUserAgent } from '@enbox/agent';

import { DwnRegistrar } from '@enbox/dwn-clients';

import type {
  RegistrationOptions,
  RegistrationTokenData,
} from '../types.js';

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
  const { userAgent, dwnEndpoints, agentDid, connectedDid } = ctx;

  const updatedTokens: Record<string, RegistrationTokenData> = {
    ...(registration.registrationTokens ?? {}),
  };

  try {
    for (const dwnEndpoint of dwnEndpoints) {
      const serverInfo = await userAgent.rpc.getServerInfo(dwnEndpoint);

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
            const refreshed = await DwnRegistrar.refreshRegistrationToken(
              tokenData.refreshUrl, tokenData.refreshToken,
            );
            tokenData = {
              registrationToken : refreshed.registrationToken,
              refreshToken      : refreshed.refreshToken,
              expiresAt         : refreshed.expiresIn !== undefined
                ? Date.now() + (refreshed.expiresIn * 1000) : undefined,
              tokenUrl   : tokenData.tokenUrl,
              refreshUrl : tokenData.refreshUrl,
            };
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

          if (authResult.state !== state) {
            throw new Error('Provider auth state mismatch \u2014 possible CSRF attack.');
          }

          const tokenResponse = await DwnRegistrar.exchangeAuthCode(
            providerAuth.tokenUrl, authResult.code, dwnEndpoint,
          );

          tokenData = {
            registrationToken : tokenResponse.registrationToken,
            refreshToken      : tokenResponse.refreshToken,
            expiresAt         : tokenResponse.expiresIn !== undefined
              ? Date.now() + (tokenResponse.expiresIn * 1000) : undefined,
            tokenUrl   : providerAuth.tokenUrl,
            refreshUrl : providerAuth.refreshUrl,
          };
          updatedTokens[dwnEndpoint] = tokenData;
        }

        // Register each DID using the provider auth token.
        for (const did of didsToRegister) {
          await DwnRegistrar.registerTenantWithToken(
            dwnEndpoint, did, tokenData.registrationToken,
          );
        }
      } else {
        // --- Default Path (PoW / general registration) ---
        for (const did of didsToRegister) {
          await DwnRegistrar.registerTenant(dwnEndpoint, did);
        }
      }
    }

    // Notify app of updated tokens for persistence.
    if (registration.onRegistrationTokens) {
      registration.onRegistrationTokens(updatedTokens);
    }

    registration.onSuccess();
  } catch (error: unknown) {
    registration.onFailure(error);
  }
}
