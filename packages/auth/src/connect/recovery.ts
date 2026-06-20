/**
 * Seed phrase recovery helpers.
 *
 * When a vault is re-derived from a recovery phrase on a new device,
 * the local DWN is empty. This module provides the building blocks
 * for pulling identity metadata, keys, and user data from the remote
 * DWN in a controlled two-phase sequence.
 *
 * @module
 * @internal
 */

import type { BearerIdentity, EnboxUserAgent } from '@enbox/agent';
import type { IdentitySyncProtocols, RegistrationOptions, StorageAdapter } from '../types.js';

import { IdentityProtocolDefinition, JwkProtocolDefinition } from '@enbox/agent';

import { registerWithDwnEndpoints } from '../registration.js';

/**
 * Internal protocols that store recovery-critical data in the agent DID's DWN.
 * Syncing these ensures that seed phrase recovery can pull identity metadata,
 * portable DIDs, and encrypted private keys from the remote.
 */
export const AGENT_DID_SYNC_PROTOCOLS: [string, ...string[]] = [
  IdentityProtocolDefinition.protocol,
  JwkProtocolDefinition.protocol,
];

/**
 * Register the agent DID for sync with the recovery-critical protocols.
 *
 * This is a prerequisite for both normal operation (pushing identity
 * metadata to the remote) and seed phrase recovery (pulling it back).
 * Repairs the registration if the agent DID was already registered with stale options.
 */
export async function registerAgentDidForSync(userAgent: EnboxUserAgent): Promise<void> {
  const options = { protocols: AGENT_DID_SYNC_PROTOCOLS };
  try {
    await userAgent.sync.registerIdentity({
      did: userAgent.agentDid.uri,
      options,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('already registered')) {
      await userAgent.sync.updateIdentityOptions({
        did: userAgent.agentDid.uri,
        options,
      });
      return;
    }

    throw error;
  }
}

/**
 * Recover identities and their data from remote DWN endpoints.
 *
 * Assumes the agent DID is already registered for sync (via
 * {@link registerAgentDidForSync}) and as a DWN tenant.
 *
 * Phase 1 — pull identity metadata and DID private keys stored in the
 *   agent DID's DWN.
 *
 * Phase 2 — register each recovered identity DID as a tenant and for
 *   explicitly scoped sync, then pull the requested protocol data. If no
 *   `identitySyncProtocols` is provided, auth recovers identity metadata only
 *   and leaves product-scoped record sync to the application.
 *
 * Returns the recovered identities, or an empty array if the remote
 * had nothing (e.g. first-ever setup with a pre-generated phrase).
 */
export async function recoverIdentitiesFromRemote(params: {
  userAgent: EnboxUserAgent;
  dwnEndpoints: string[];
  identitySyncProtocols?: IdentitySyncProtocols;
  registration?: RegistrationOptions;
  storage: StorageAdapter;
}): Promise<BearerIdentity[]> {
  const { userAgent, dwnEndpoints, identitySyncProtocols, registration, storage } = params;
  const agentDid = userAgent.agentDid.uri;

  // Install the KeyDeliveryProtocol for the agent DID before pulling.
  // Encrypted JwkProtocol records (private keys) require this protocol
  // to be present locally for the sync engine's closure resolver to
  // accept them. Without it, the encrypted records are skipped during
  // pull and private keys are never recovered.
  await userAgent.dwn.ensureKeyDeliveryProtocol(agentDid);

  // Phase 1: pull identity metadata + encrypted DID keys.
  await userAgent.sync.sync('pull');

  const identities = await userAgent.identity.list();
  if (identities.length === 0) {
    return [];
  }

  // Register each recovered identity DID as a DWN tenant. Register for sync
  // only when the application supplied an explicit identity protocol scope.
  // Tenant registration must come first — sync('pull') reads the durable
  // MessagesQuery feed, which requires the DID to be a recognised tenant.
  let registeredIdentityForSync = false;
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

    if (identitySyncProtocols !== undefined) {
      try {
        await userAgent.sync.registerIdentity({ did, options: { protocols: identitySyncProtocols } });
      } catch {
        // Already registered from a previous session.
      }
      registeredIdentityForSync = true;
    }
  }

  if (registeredIdentityForSync) {
    // Phase 2: pull explicitly scoped protocol configurations and records.
    await userAgent.sync.sync('pull');
  }

  return userAgent.identity.list();
}
