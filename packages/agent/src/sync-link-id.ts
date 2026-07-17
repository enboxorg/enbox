/** Separator used in compound replication link identifiers. */
export const LINK_ID_SEPARATOR = '^';

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
  return `${tenantDid}${LINK_ID_SEPARATOR}${projectionId}${LINK_ID_SEPARATOR}${authorizationEpoch}`;
}

/**
 * Build the runtime identifier for a replication link.
 *
 * Runtime identity is `(tenantDid, remoteEndpoint, projectionId, authorizationEpoch)`.
 */
export function buildLinkId(
  tenantDid: string,
  remoteEndpoint: string,
  projectionId: string,
  authorizationEpoch: string,
): string {
  return `${tenantDid}${LINK_ID_SEPARATOR}${remoteEndpoint}${LINK_ID_SEPARATOR}${projectionId}${LINK_ID_SEPARATOR}${authorizationEpoch}`;
}
