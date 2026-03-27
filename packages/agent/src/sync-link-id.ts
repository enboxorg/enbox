/** Separator used in compound runtime/legacy cursor keys. */
export const LINK_ID_SEPARATOR = '^';

/** Opaque runtime identifier for a replication link. */
export type LinkId = string;

/**
 * Build the runtime identifier for a replication link.
 *
 * Runtime identity is `(tenantDid, remoteEndpoint, scopeId)`.
 */
export function buildLinkId(tenantDid: string, remoteEndpoint: string, scopeId: string): LinkId {
  return `${tenantDid}${LINK_ID_SEPARATOR}${remoteEndpoint}${LINK_ID_SEPARATOR}${scopeId}`;
}

/**
 * Build the legacy cursor key used by the deprecated `syncCursors` sublevel.
 *
 * This remains only for one-time migration of pre-Phase-1f data.
 */
export function buildLegacyCursorKey(tenantDid: string, remoteEndpoint: string, protocol?: string): string {
  const base = `${tenantDid}${LINK_ID_SEPARATOR}${remoteEndpoint}`;
  return protocol ? `${base}${LINK_ID_SEPARATOR}${protocol}` : base;
}
