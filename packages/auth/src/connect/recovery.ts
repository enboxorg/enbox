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
import type { IdentitySyncProtocols, RegistrationOptions } from '../types.js';

import { DidErrorCode, getDwnEndpointStatus } from '@enbox/dids';
import { IdentityProtocolDefinition, JwkProtocolDefinition } from '@enbox/agent';

import { registerDwnTenants } from '../registration.js';
import { applyIdentitySyncScope, registerSyncScopeForIdentity } from './lifecycle.js';

type RecoveryLifecycle = {
  operationSignal: AbortSignal;
  /** Throws when teardown invalidated the recovery flow. */
  assertActive: () => void;
  /** Serializes agent mutations against session teardown. */
  runMutation: <T>(operation: () => Promise<T>) => Promise<T>;
};

type RecoveredIdentityRouting = {
  bootstrapEndpoints?: string[];
  prepareBootstrap?: boolean;
  ownedDid: string;
  replacementEndpoints?: string[];
  routingDid: string;
};

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

async function resolveRecoveredIdentityRouting(
  identity: BearerIdentity,
  userAgent: EnboxUserAgent,
  replacementDwnEndpoints: string[] | undefined,
): Promise<RecoveredIdentityRouting> {
  const ownedDid = identity.did.uri;
  const routingDid = identity.metadata.connectedDid ?? ownedDid;
  const status = await userAgent.identity.getDwnEndpointStatus({ didUri: routingDid, refresh: true });
  const routing = { ownedDid, routingDid };
  const ownsRoutingDid = ownedDid === routingDid;

  if (status.status === 'ready') {
    // Repeating the current route is recovery, not new tenant preparation.
    return {
      ...routing,
      replacementEndpoints: ownsRoutingDid && status.endpoints.join('\n') !== replacementDwnEndpoints?.join('\n')
        ? replacementDwnEndpoints : undefined,
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
        replacementEndpoints : storedStatus.endpoints.join('\n') === replacementDwnEndpoints?.join('\n')
          ? undefined : replacementDwnEndpoints,
      };
    }
    if (replacementDwnEndpoints === undefined) {
      throw new Error(storedStatus.message);
    }
  }

  if (replacementDwnEndpoints === undefined) {
    throw new Error(status.message);
  }
  return { ...routing, bootstrapEndpoints: replacementDwnEndpoints, prepareBootstrap: true };
}

/** Prepare tenancy before publishing newly requested recovery endpoints. */
async function setRecoveredDwnEndpoints(
  params: RecoveryLifecycle & { userAgent: EnboxUserAgent },
  didUri: string,
  endpoints: string[],
  registration?: RegistrationOptions,
): Promise<void> {
  const { userAgent } = params;
  if (registration !== undefined) {
    await registerDwnTenants(params, { dids: [didUri], dwnEndpoints: endpoints }, registration);
    params.assertActive();
  }
  await params.runMutation(() => userAgent.identity.setDwnEndpoints({ didUri, endpoints }));
}

/**
 * Recover identities and their data from remote DWN endpoints.
 *
 * Assumes the agent DID is registered for sync (via
 * {@link registerAgentDidForSync}) and keeps its existing remote tenancy.
 *
 * Phase 1 — pull identity metadata and DID private keys stored in the
 *   agent DID's DWN.
 *
 * Phase 2 — restore explicitly scoped sync for each recovered identity,
 *   then pull the requested protocol data. If no
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
} & RecoveryLifecycle): Promise<BearerIdentity[]> {
  const { userAgent, replacementDwnEndpoints, identitySyncProtocols, registration } = params;
  // Phase 1: pull identity metadata + encrypted DID keys.
  const identities = await params.runMutation(async (): Promise<BearerIdentity[]> => {
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

  // Preserve existing tenancy. Newly requested bootstrap endpoints must be
  // prepared before publication or scoped recovery can start using them.
  // Sync stores one authorization per routing owner. Prefer a recovered local
  // owner, otherwise keep the first delegate with usable grants.
  const localOwnerDids = new Set(resolvedIdentities
    .filter(({ ownedDid, routingDid }) => ownedDid === routingDid)
    .map(({ routingDid }) => routingDid));
  const registeredRoutingDids = new Set<string>();
  for (const { bootstrapEndpoints, prepareBootstrap, ownedDid, routingDid } of resolvedIdentities) {
    if (bootstrapEndpoints !== undefined) {
      await setRecoveredDwnEndpoints( // NOSONAR S9382: prepare each owner before publishing new endpoints.
        params, ownedDid, bootstrapEndpoints, prepareBootstrap ? registration : undefined,
      );
    }

    if (identitySyncProtocols === undefined || registeredRoutingDids.has(routingDid)
      || (ownedDid !== routingDid && localOwnerDids.has(routingDid))) {
      continue;
    }
    const registered = await params.runMutation( // NOSONAR S9382: prepare each recovered signer before the data pull.
      () => registerSyncScopeForIdentity({
        userAgent,
        connectedDid : routingDid,
        delegateDid  : ownedDid === routingDid ? undefined : ownedDid,
        identitySyncProtocols,
      }),
    );
    if (registered) {
      registeredRoutingDids.add(routingDid);
    }
  }

  await params.runMutation(async (): Promise<void> => {
    if (registeredRoutingDids.size > 0) {
      // Phase 2: pull explicitly scoped protocol configurations and records.
      await userAgent.sync.sync('pull');
    }
  });

  // Deliberate endpoint migrations happen only after recovery has read the
  // authoritative endpoints and completed both pulls.
  for (const { ownedDid, replacementEndpoints } of resolvedIdentities) {
    if (replacementEndpoints !== undefined) {
      await setRecoveredDwnEndpoints(params, ownedDid, replacementEndpoints, registration); // NOSONAR S9382: preserve owner publication order.
    }
  }

  return params.runMutation(() => userAgent.identity.list());
}
