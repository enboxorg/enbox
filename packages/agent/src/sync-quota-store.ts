/** Source path that first produced a durable quota block. */
export type SyncQuotaBlockSource = 'feed' | 'permission-grant';

/**
 * Durable state for a push message the remote rejected for tenant quota.
 *
 * The complete replication-link identity is retained so one projection or
 * authorization epoch cannot suppress another link's delivery attempt.
 */
export type SyncQuotaBlockState = {
  attempts: number;
  authorizationEpoch: string;
  blockedCid?: string;
  detail?: string;
  firstBlockedAt: string;
  lastBlockedAt: string;
  linkKey: string;
  messageCid: string;
  nextProbeAt: string;
  projectionId: string;
  protocol?: string;
  remoteEndpoint: string;
  source?: SyncQuotaBlockSource;
  /** Retained only to explain an intentional feed omission. Never probed or surfaced as blocked. */
  supersededAt?: string;
  tenantDid: string;
};

/** Backend-neutral persistence contract for durable quota-block state. */
export interface SyncQuotaStore {
  /** Remove every quota-block row. */
  clear(): Promise<void>;

  /** Delete one exact per-link quota block, returning whether it existed. */
  delete(tenantDid: string, linkKey: string, messageCid: string): Promise<boolean>;

  /** Delete a set of exact quota-block rows as one logical mutation. */
  deleteMany(states: SyncQuotaBlockState[]): Promise<void>;

  /** Delete every quota-block row for one tenant. */
  deleteForTenant(tenantDid: string): Promise<void>;

  /** Read one exact per-link quota block. */
  get(tenantDid: string, linkKey: string, messageCid: string): Promise<SyncQuotaBlockState | undefined>;

  /** Read every persisted quota-block row. */
  getAll(): Promise<SyncQuotaBlockState[]>;

  /** Read every persisted quota-block row for one tenant. */
  getForTenant(tenantDid: string): Promise<SyncQuotaBlockState[]>;

  /** Persist one complete quota-block row. */
  put(state: SyncQuotaBlockState): Promise<void>;
}
