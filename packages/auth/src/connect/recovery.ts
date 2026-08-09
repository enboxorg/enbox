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

import { DidErrorCode } from '@enbox/dids';
import { IdentityProtocolDefinition, JwkProtocolDefinition } from '@enbox/agent';

import { registerWithDwnEndpoints } from '../registration.js';

type RecoveryLifecycle = {
  /** Throws when teardown invalidated the recovery flow. */
  assertActive?: () => void;
  /** Serializes agent mutations against session teardown. */
  runMutation?: <T>(operation: () => Promise<T>) => Promise<T>;
};

function assertRecoveryActive(lifecycle: RecoveryLifecycle): void {
  lifecycle.assertActive?.();
}

async function runRecoveryMutation<T>(
  lifecycle: RecoveryLifecycle,
  operation: () => Promise<T>,
): Promise<T> {
  return lifecycle.runMutation === undefined ? operation() : lifecycle.runMutation(operation);
}

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

function isAlreadyRegisteredError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('already registered');
}

async function registerRecoveredIdentityTenant(params: {
  userAgent: EnboxUserAgent;
  dwnEndpoints: string[];
  agentDid: string;
  connectedDid: string;
  registration?: RegistrationOptions;
  storage: StorageAdapter;
} & RecoveryLifecycle): Promise<void> {
  const { userAgent, dwnEndpoints, agentDid, connectedDid, registration, storage, assertActive, runMutation } = params;

  if (registration === undefined) {
    return;
  }

  try {
    await registerWithDwnEndpoints(
      {
        userAgent,
        dwnEndpoints,
        agentDid,
        connectedDid,
        secretStore: userAgent.secrets,
        storage,
        assertActive,
        runMutation,
      },
      registration,
    );
  } catch {
    // Best effort — the DID may already be registered, or the
    // endpoint may be temporarily unreachable.
  }
}

async function registerRecoveredIdentityForSync(params: {
  userAgent: EnboxUserAgent;
  did: string;
  identitySyncProtocols?: IdentitySyncProtocols;
}): Promise<boolean> {
  const { userAgent, did, identitySyncProtocols } = params;

  if (identitySyncProtocols === undefined) {
    return false;
  }

  try {
    await userAgent.sync.registerIdentity({ did, options: { protocols: identitySyncProtocols } });
  } catch (error: unknown) {
    if (!isAlreadyRegisteredError(error)) {
      throw error;
    }
  }

  return true;
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
  replaceDwnEndpoints?: boolean;
  identitySyncProtocols?: IdentitySyncProtocols;
  registration?: RegistrationOptions;
  storage: StorageAdapter;
} & RecoveryLifecycle): Promise<BearerIdentity[]> {
  const { userAgent, dwnEndpoints, replaceDwnEndpoints = false, identitySyncProtocols, registration, storage } = params;
  // Phase 1: pull identity metadata + encrypted DID keys.
  const identities = await runRecoveryMutation(params, async (): Promise<BearerIdentity[]> => {
    await userAgent.sync.sync('pull');
    return userAgent.identity.list();
  });
  if (identities.length === 0) {
    return [];
  }

  // Resolve every recovered DID before publishing or registering any of them.
  const resolvedIdentities = await Promise.all(identities.map(async identity => {
    const ownedDid = identity.did.uri;
    const routingDid = identity.metadata.connectedDid ?? ownedDid;
    const status = await userAgent.identity.getDwnEndpointStatus({ didUri: routingDid, refresh: true });
    const canBootstrap = status.status === 'resolution-failed'
      && status.resolutionError === DidErrorCode.NotFound;
    if (status.status !== 'ready' && !canBootstrap
      && (!replaceDwnEndpoints || status.status === 'resolution-failed')) {
      throw new Error(status.message);
    }
    return { ownedDid, routingDid, status, canBootstrap };
  }));

  // Register each recovered identity DID as a DWN tenant. Register for sync
  // only when the application supplied an explicit identity protocol scope.
  // Tenant registration must come first — sync('pull') reads the durable
  // MessagesQuery feed, which requires the DID to be a recognised tenant.
  let registeredIdentityForSync = false;
  for (const { ownedDid, routingDid, status, canBootstrap } of resolvedIdentities) {
    let resolvedEndpoints = status.status === 'ready' ? status.endpoints : undefined;
    const canReplaceRoutingDid = ownedDid === routingDid;
    if ((replaceDwnEndpoints || canBootstrap) && canReplaceRoutingDid) {
      await userAgent.identity.setDwnEndpoints({ didUri: ownedDid, endpoints: dwnEndpoints });
      const updatedStatus = await userAgent.identity.getDwnEndpointStatus({ didUri: routingDid });
      if (updatedStatus.status !== 'ready') {
        throw new Error(updatedStatus.message);
      }
      resolvedEndpoints = updatedStatus.endpoints;
    }
    if (resolvedEndpoints === undefined) {
      throw new Error(`Recovered DID '${routingDid}' does not advertise a DWN endpoint.`);
    }

    // Registration may wait on app-owned provider-auth UI, so it must remain
    // outside the lifecycle mutation mutex. Re-check the flow before making
    // any further local agent mutations.
    await registerRecoveredIdentityTenant({
      userAgent,
      dwnEndpoints : resolvedEndpoints,
      agentDid     : routingDid,
      connectedDid : routingDid,
      registration,
      storage,
      assertActive : params.assertActive,
      runMutation  : params.runMutation,
    });
    assertRecoveryActive(params);
    registeredIdentityForSync = await runRecoveryMutation(
      params,
      () => registerRecoveredIdentityForSync({ userAgent, did: routingDid, identitySyncProtocols }),
    ) || registeredIdentityForSync;
  }

  return runRecoveryMutation(params, async (): Promise<BearerIdentity[]> => {
    if (registeredIdentityForSync) {
      // Phase 2: pull explicitly scoped protocol configurations and records.
      await userAgent.sync.sync('pull');
    }

    return userAgent.identity.list();
  });
}
