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
