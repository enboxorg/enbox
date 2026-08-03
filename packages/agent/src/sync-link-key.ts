import type { SyncAuthorization } from './types/sync.js';

/** Separator used in compound replication link identifiers. */
export const LINK_KEY_SEPARATOR = '^';

/**
 * Build the endpoint-independent identity of a durable replication link.
 *
 * One projection and authorization epoch can have a link per remote endpoint;
 * this key identifies whether that projection/epoch is still current.
 */
export function buildDurableLinkIdentityKey(
  tenantDid: string,
  projectionId: string,
  authorizationEpoch: string,
): string {
  return `${tenantDid}${LINK_KEY_SEPARATOR}${projectionId}${LINK_KEY_SEPARATOR}${authorizationEpoch}`;
}

/**
 * Build the runtime identifier for a replication link.
 *
 * Runtime identity is `(tenantDid, remoteEndpoint, projectionId, authorizationEpoch)`.
 */
export function buildLinkKey(
  tenantDid: string,
  remoteEndpoint: string,
  projectionId: string,
  authorizationEpoch: string,
): string {
  return `${tenantDid}${LINK_KEY_SEPARATOR}${remoteEndpoint}${LINK_KEY_SEPARATOR}${projectionId}${LINK_KEY_SEPARATOR}${authorizationEpoch}`;
}

/**
 * Build the identity used to decide whether a durable link still belongs to
 * the current target plan. Role-authorized foreign contexts are bound to the
 * exact endpoints advertised by their authority; owned projections retain
 * their endpoint-independent identity.
 */
export function buildCurrentLinkIdentityKey(
  tenantDid: string,
  remoteEndpoint: string,
  projectionId: string,
  authorizationEpoch: string,
  authorizationKind: SyncAuthorization['kind'],
): string {
  return authorizationKind === 'role'
    ? buildLinkKey(tenantDid, remoteEndpoint, projectionId, authorizationEpoch)
    : buildDurableLinkIdentityKey(tenantDid, projectionId, authorizationEpoch);
}
