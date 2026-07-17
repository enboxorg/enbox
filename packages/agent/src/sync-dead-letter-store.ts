import type { DeadLetterEntry } from './types/sync.js';

/**
 * Backend-neutral persistence contract for terminal sync failures.
 * Backing-store lifecycle is owned by the enclosing sync storage backend.
 */
export interface SyncDeadLetterStore {
  /** Remove every dead-letter entry. */
  clear(): Promise<void>;

  /** Remove every entry for a message CID and optional remote, returning the number removed. */
  deleteForMessage(messageCid: string, remoteEndpoint?: string): Promise<number>;

  /** Remove one exact tenant, message, and remote entry. */
  deleteExact(tenantDid: string, messageCid: string, remoteEndpoint?: string): Promise<void>;

  /** Remove every entry for one tenant. */
  deleteForTenant(tenantDid: string): Promise<void>;

  /** Read one exact tenant, message, and remote entry. */
  get(tenantDid: string, messageCid: string, remoteEndpoint?: string): Promise<DeadLetterEntry | undefined>;

  /** Read every persisted dead-letter entry. */
  getAll(): Promise<DeadLetterEntry[]>;

  /** Read every persisted dead-letter entry for one tenant. */
  getForTenant(tenantDid: string): Promise<DeadLetterEntry[]>;

  /** Persist one complete dead-letter entry. */
  put(entry: DeadLetterEntry): Promise<void>;
}
