/** Separator used in compound replication link identifiers. */
export const LINK_ID_SEPARATOR = '^';

/** Opaque runtime identifier for a replication link. */
export type LinkId = string;

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
): LinkId {
  return `${tenantDid}${LINK_ID_SEPARATOR}${remoteEndpoint}${LINK_ID_SEPARATOR}${projectionId}${LINK_ID_SEPARATOR}${authorizationEpoch}`;
}
