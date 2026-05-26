/**
 * Seed phrase recovery flow.
 *
 * When a vault is re-derived from a recovery phrase on a new device,
 * the local DWN is empty. This module pulls identity metadata, keys,
 * and user data from the remote DWN in a controlled two-phase sequence.
 *
 * @module
 * @internal
 */

import type { BearerIdentity, EnboxUserAgent } from '@enbox/agent';

import type { RegistrationOptions, StorageAdapter } from '../types.js';

import { registerWithDwnEndpoints } from '../registration.js';

/**
 * Recover identities and their data from remote DWN endpoints.
 *
 * Assumes the agent DID is already registered for sync (with the
 * IdentityProtocol + JwkProtocol) and as a DWN tenant.
 *
 * Phase 1 — pull identity metadata and DID private keys stored in the
 *   agent DID's DWN.
 *
 * Phase 2 — register each recovered identity DID as a tenant and for
 *   sync, then pull their profile data, protocol configurations, and
 *   records.
 *
 * Returns the recovered identities, or an empty array if the remote
 * had nothing (e.g. first-ever setup with a pre-generated phrase).
 */
export async function recoverIdentitiesFromRemote(params: {
  userAgent: EnboxUserAgent;
  dwnEndpoints: string[];
  registration?: RegistrationOptions;
  storage: StorageAdapter;
}): Promise<BearerIdentity[]> {
  const { userAgent, dwnEndpoints, registration, storage } = params;
  const agentDid = userAgent.agentDid.uri;

  // Phase 1: pull identity metadata + encrypted DID keys.
  await userAgent.sync.sync('pull');

  const identities = await userAgent.identity.list();
  if (identities.length === 0) {
    return [];
  }

  // Register each recovered identity DID as a DWN tenant, then for sync.
  // Tenant registration must come first — sync('pull') issues
  // MessagesSync which requires the DID to be a recognised tenant.
  for (const identity of identities) {
    const did = identity.metadata.connectedDid ?? identity.did.uri;

    if (registration) {
      try {
        await registerWithDwnEndpoints(
          { userAgent, dwnEndpoints, agentDid, connectedDid: did, secretStore: userAgent.secrets, storage },
          registration,
        );
      } catch {
        // Best effort — the DID may already be registered, or the
        // endpoint may be temporarily unreachable.
      }
    }

    try {
      await userAgent.sync.registerIdentity({ did, options: { protocols: 'all' } });
    } catch {
      // Already registered from a previous session.
    }
  }

  // Phase 2: pull profile data, protocol configurations, and records.
  await userAgent.sync.sync('pull');

  return userAgent.identity.list();
}
