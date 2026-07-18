/** Durable retry state for a remote message whose admission is temporarily deferred. */
export type SyncDeferredPullState = {
  attempts: number;
  detail?: string;
  firstDeferredAt: string;
  lastDeferredAt: string;
};

/**
 * Backend-neutral persistence contract for temporarily deferred pull admissions.
 * Backing-store lifecycle is owned by the enclosing sync storage backend.
 */
export interface SyncDeferredPullStore {
  /** Remove every deferred-pull entry. */
  clear(): Promise<void>;

  /** Remove one exact tenant, message, and remote entry. */
  delete(tenantDid: string, messageCid: string, remoteEndpoint: string): Promise<void>;

  /** Remove every deferred-pull entry belonging to one tenant. */
  deleteTenant(tenantDid: string): Promise<void>;

  /** Read one exact tenant, message, and remote entry. */
  get(tenantDid: string, messageCid: string, remoteEndpoint: string): Promise<SyncDeferredPullState | undefined>;

  /** Persist one exact tenant, message, and remote entry. */
  put(tenantDid: string, messageCid: string, remoteEndpoint: string, state: SyncDeferredPullState): Promise<void>;
}
