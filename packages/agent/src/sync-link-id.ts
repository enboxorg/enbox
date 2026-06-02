/** Separator used in compound runtime/legacy cursor keys. */
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

/**
 * Build the legacy cursor key used by the deprecated `syncCursors` sublevel.
 *
 * This remains only for one-time migration from the legacy cursor-key format.
 */
export function buildLegacyCursorKey(tenantDid: string, remoteEndpoint: string, protocol?: string): string {
  const base = `${tenantDid}${LINK_ID_SEPARATOR}${remoteEndpoint}`;
  return protocol ? `${base}${LINK_ID_SEPARATOR}${protocol}` : base;
}
