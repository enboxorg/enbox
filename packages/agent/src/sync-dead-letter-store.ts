import type { DeadLetterEntry } from './types/sync.js';

/** Compound-key identity of one removed dead-letter entry. */
export type DeletedDeadLetter = Pick<DeadLetterEntry, 'messageCid' | 'remoteEndpoint' | 'tenantDid'>;

/**
 * Backend-neutral persistence contract for terminal sync failures.
 * Backing-store lifecycle is owned by the enclosing sync storage backend.
 */
export interface SyncDeadLetterStore {
  /** Remove every dead letter and return its compound-key identity. */
  clear(): Promise<DeletedDeadLetter[]>;

  /** Remove matching dead letters and return their compound-key identities. */
  deleteForMessage(messageCid: string, remoteEndpoint?: string): Promise<DeletedDeadLetter[]>;

  /** Remove an exact dead letter and return its compound-key identity. */
  deleteExact(tenantDid: string, messageCid: string, remoteEndpoint: string): Promise<DeletedDeadLetter | undefined>;

  /** Remove one tenant's dead letters and return their compound-key identities. */
  deleteForTenant(tenantDid: string): Promise<DeletedDeadLetter[]>;

  /** Read one exact tenant, message, and remote entry. */
  get(tenantDid: string, messageCid: string, remoteEndpoint: string): Promise<DeadLetterEntry | undefined>;

  /** Read every persisted dead-letter entry. */
  getAll(): Promise<DeadLetterEntry[]>;

  /** Read every persisted dead-letter entry for one tenant. */
  getForTenant(tenantDid: string): Promise<DeadLetterEntry[]>;

  /** Persist one complete dead-letter entry. */
  put(entry: DeadLetterEntry): Promise<void>;
}
