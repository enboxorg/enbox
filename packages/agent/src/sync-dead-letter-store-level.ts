import type { AbstractLevel } from 'abstract-level';

import type { DeadLetterEntry } from './types/sync.js';
import type { SyncMessageStoreLevelKey } from './sync-message-store-level.js';

import { buildSyncMessageStoreLevelKey, isSyncMessageStoreLevelNotFound, syncMessageStoreLevelTenantKeyRange } from './sync-message-store-level.js';

/** Level-backed persistence for terminal sync failures. */
export class SyncDeadLetterStoreLevel {
  private readonly _db: AbstractLevel<SyncMessageStoreLevelKey>;

  constructor(db: AbstractLevel<SyncMessageStoreLevelKey>) {
    this._db = db;
  }

  private get deadLetters(): AbstractLevel<SyncMessageStoreLevelKey, string, string> {
    return this._db.sublevel('deadLetters');
  }

  public async clear(): Promise<void> {
    await this.deadLetters.clear();
  }

  public async deleteExact(
    tenantDid: string,
    messageCid: string,
    remoteEndpoint: string,
  ): Promise<boolean> {
    const key = buildSyncMessageStoreLevelKey(tenantDid, messageCid, remoteEndpoint);
    try {
      await this.deadLetters.get(key);
    } catch (error: unknown) {
      if (isSyncMessageStoreLevelNotFound(error)) {
        return false;
      }
      throw error;
    }
    await this.deadLetters.del(key);
    return true;
  }

  /** Delete one tenant's entries by key range without parsing potentially corrupt values. */
  public async deleteForTenant(tenantDid: string): Promise<void> {
    await this.deadLetters.clear(syncMessageStoreLevelTenantKeyRange(tenantDid));
  }

  public async get(tenantDid: string, messageCid: string, remoteEndpoint: string): Promise<DeadLetterEntry | undefined> {
    try {
      const value = await this.deadLetters.get(buildSyncMessageStoreLevelKey(tenantDid, messageCid, remoteEndpoint));
      return JSON.parse(value) as DeadLetterEntry;
    } catch (error: unknown) {
      if (isSyncMessageStoreLevelNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  public async getAll(): Promise<DeadLetterEntry[]> {
    return this.readEntries(this.deadLetters.iterator());
  }

  public async getForTenant(tenantDid: string): Promise<DeadLetterEntry[]> {
    const entries = await this.readEntries(this.deadLetters.iterator(syncMessageStoreLevelTenantKeyRange(tenantDid)));
    return entries.filter((entry): boolean => entry.tenantDid === tenantDid);
  }

  public async put(entry: DeadLetterEntry): Promise<void> {
    const key = buildSyncMessageStoreLevelKey(entry.tenantDid, entry.messageCid, entry.remoteEndpoint);
    await this.deadLetters.put(key, JSON.stringify(entry));
  }

  private async readEntries(entries: AsyncIterable<[string, string]>): Promise<DeadLetterEntry[]> {
    const deadLetters: DeadLetterEntry[] = [];
    for await (const [, value] of entries) {
      deadLetters.push(JSON.parse(value) as DeadLetterEntry);
    }
    return deadLetters;
  }
}
