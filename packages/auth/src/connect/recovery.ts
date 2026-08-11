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

import type { DwnEndpointResolution } from '@enbox/dids';
import type { BearerIdentity, EnboxUserAgent } from '@enbox/agent';
import type { IdentitySyncProtocols, RegistrationOptions, StorageAdapter } from '../types.js';

import { DidErrorCode, getDwnEndpointStatus } from '@enbox/dids';
import { IdentityProtocolDefinition, JwkProtocolDefinition } from '@enbox/agent';

import { applyIdentitySyncScope } from './lifecycle.js';
import { registerWithDwnEndpoints } from '../registration.js';

type RecoveryLifecycle = {
  /** Throws when teardown invalidated the recovery flow. */
  assertActive?: () => void;
  /** Serializes agent mutations against session teardown. */
  runMutation?: <T>(operation: () => Promise<T>) => Promise<T>;
};

type RecoveredIdentityRouting = {
  bootstrapEndpoints?: string[];
  ownedDid: string;
  replacementEndpoints?: string[];
  routingDid: string;
  status: DwnEndpointResolution;
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
 * Set the agent DID's recovery-critical sync protocols.
 *
 * This is a prerequisite for both normal operation (pushing identity
 * metadata to the remote) and seed phrase recovery (pulling it back).
 */
export async function registerAgentDidForSync(userAgent: EnboxUserAgent): Promise<void> {
  await applyIdentitySyncScope({
    userAgent,
    connectedDid : userAgent.agentDid.uri,
    scope        : AGENT_DID_SYNC_PROTOCOLS,
  });
}

async function registerRecoveredIdentityTenant(params: {
  userAgent: EnboxUserAgent;
  dwnEndpoints: string[];
  agentDid: string;
  connectedDid: string;
  registration?: RegistrationOptions;
  storage: StorageAdapter;
} & RecoveryLifecycle): Promise<boolean> {
  const { userAgent, dwnEndpoints, agentDid, connectedDid, registration, storage, assertActive, runMutation } = params;

  if (registration === undefined) {
    return true;
  }

  try {
    return await registerWithDwnEndpoints(
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
    return false;
  }
}

async function resolveRecoveredIdentityRouting(
  identity: BearerIdentity,
  userAgent: EnboxUserAgent,
  replacementDwnEndpoints: string[] | undefined,
): Promise<RecoveredIdentityRouting> {
  const ownedDid = identity.did.uri;
  const routingDid = identity.metadata.connectedDid ?? ownedDid;
  const status = await userAgent.identity.getDwnEndpointStatus({ didUri: routingDid, refresh: true });
  const routing = { ownedDid, routingDid, status };
  const ownsRoutingDid = ownedDid === routingDid;

  if (status.status === 'ready') {
    return {
      ...routing,
      replacementEndpoints: ownsRoutingDid ? replacementDwnEndpoints : undefined,
    };
  }
  if (!ownsRoutingDid
    || (status.status === 'resolution-failed' && status.resolutionError !== DidErrorCode.NotFound)) {
    throw new Error(status.message);
  }
  if (status.status === 'resolution-failed') {
    const storedStatus = getDwnEndpointStatus(ownedDid, identity.did.document);
    if (storedStatus.status === 'ready') {
      return {
        ...routing,
        bootstrapEndpoints   : storedStatus.endpoints,
        replacementEndpoints : replacementDwnEndpoints,
      };
    }
    if (replacementDwnEndpoints === undefined) {
      throw new Error(storedStatus.message);
    }
  }

  if (replacementDwnEndpoints === undefined) {
    throw new Error(status.message);
  }
  return { ...routing, bootstrapEndpoints: replacementDwnEndpoints };
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
  replacementDwnEndpoints?: string[];
  identitySyncProtocols?: IdentitySyncProtocols;
  registration?: RegistrationOptions;
  storage: StorageAdapter;
} & RecoveryLifecycle): Promise<BearerIdentity[]> {
  const { userAgent, replacementDwnEndpoints, identitySyncProtocols, registration, storage } = params;
  // Phase 1: pull identity metadata + encrypted DID keys.
  const identities = await runRecoveryMutation(params, async (): Promise<BearerIdentity[]> => {
    await userAgent.sync.sync('pull');
    return userAgent.identity.list();
  });
  if (identities.length === 0) {
    return [];
  }

  // Resolve every recovered DID before publishing or registering any of them.
  const resolvedIdentities = await Promise.all(identities.map(identity =>
    resolveRecoveredIdentityRouting(identity, userAgent, replacementDwnEndpoints)
  ));

  // Register each recovered identity DID as a DWN tenant. Register for sync
  // only when the application supplied an explicit identity protocol scope.
  // Tenant registration must come first — sync('pull') reads the durable
  // MessagesQuery feed, which requires the DID to be a recognised tenant.
  let registeredIdentityForSync = false;
  for (const { bootstrapEndpoints, ownedDid, routingDid, status } of resolvedIdentities) {
    let resolvedEndpoints = status.status === 'ready' ? status.endpoints : undefined;
    if (bootstrapEndpoints !== undefined) {
      await runRecoveryMutation(
        params,
        () => userAgent.identity.setDwnEndpoints({ didUri: ownedDid, endpoints: bootstrapEndpoints }),
      );
      resolvedEndpoints = await userAgent.identity.getDwnEndpoints({ didUri: routingDid });
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
      () => applyIdentitySyncScope({
        userAgent,
        connectedDid : routingDid,
        scope        : identitySyncProtocols,
      }),
    ) || registeredIdentityForSync;
  }

  await runRecoveryMutation(params, async (): Promise<void> => {
    if (registeredIdentityForSync) {
      // Phase 2: pull explicitly scoped protocol configurations and records.
      await userAgent.sync.sync('pull');
    }
  });

  // Deliberate endpoint migrations happen only after recovery has read the
  // authoritative endpoints and completed both pulls.
  for (const { ownedDid, replacementEndpoints } of resolvedIdentities) {
    if (replacementEndpoints !== undefined) {
      const isReplacementReady = await registerRecoveredIdentityTenant({
        userAgent,
        dwnEndpoints : replacementEndpoints,
        agentDid     : ownedDid,
        connectedDid : ownedDid,
        registration,
        storage,
        assertActive : params.assertActive,
        runMutation  : params.runMutation,
      });
      assertRecoveryActive(params);
      if (!isReplacementReady) {
        continue;
      }
      await runRecoveryMutation(
        params,
        () => userAgent.identity.setDwnEndpoints({ didUri: ownedDid, endpoints: replacementEndpoints }),
      );
    }
  }

  return runRecoveryMutation(params, () => userAgent.identity.list());
}
