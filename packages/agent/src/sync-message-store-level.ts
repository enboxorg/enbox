/** Key representation accepted by the Level-backed sync stores. */
export type SyncMessageStoreLevelKey = string | Buffer | Uint8Array;

/** Level batch entry used when deleting selected sync-message state. */
export type SyncMessageStoreLevelDelete = { type: 'del'; key: string };

/** Preserve the existing tenant/message/remote compound key representation. */
export function buildSyncMessageStoreLevelKey(
  tenantDid: string,
  messageCid: string,
  remoteEndpoint: string,
): string {
  return `${tenantDid}|${messageCid}|${remoteEndpoint}`;
}

export function isSyncMessageStoreLevelNotFound(error: unknown): boolean {
  return (error as { code?: string }).code === 'LEVEL_NOT_FOUND';
}

/** Tenant DIDs cannot contain `|`, making this prefix range exact. */
export function syncMessageStoreLevelTenantKeyRange(tenantDid: string): { gte: string; lte: string } {
  return {
    gte : `${tenantDid}|`,
    lte : `${tenantDid}|\xff`,
  };
}
