import type { SyncIdentityOptions } from './types/sync.js';

/** A decoded registration returned by a {@link SyncIdentityStore}. */
export type SyncIdentityStoreEntry = {
  status: 'valid';
  did: string;
  options: SyncIdentityOptions;
} | {
  status: 'corrupt';
  did: string;
  error: unknown;
};

/**
 * Backend-neutral persistence contract for sync identity registrations.
 *
 * Enumeration isolates corrupt records so engine policy can report or skip
 * one registration without hiding healthy registrations that follow it.
 * Backing-store lifecycle is owned by the enclosing sync storage backend.
 */
export interface SyncIdentityStore {
  /** Remove every registered identity. */
  clear(): Promise<void>;

  /** Remove one registered identity. */
  delete(did: string): Promise<void>;

  /** Enumerate every registration, including individually corrupt records. */
  entries(): AsyncIterable<SyncIdentityStoreEntry>;

  /** Get one registration, or `undefined` when it does not exist. */
  get(did: string): Promise<SyncIdentityOptions | undefined>;

  /** Create or replace one registration. */
  set(did: string, options: SyncIdentityOptions): Promise<void>;
}
