import type { AbstractLevel } from 'abstract-level';

import type { DeadLetterEntry } from './types/sync.js';
import type { DeletedDeadLetter, SyncDeadLetterStore } from './sync-dead-letter-store.js';
import type { SyncMessageStoreLevelDelete, SyncMessageStoreLevelKey } from './sync-message-store-level.js';

import { buildSyncMessageStoreLevelKey, isSyncMessageStoreLevelNotFound, syncMessageStoreLevelTenantKeyRange } from './sync-message-store-level.js';

/** Level-backed persistence for terminal sync failures. */
export class SyncDeadLetterStoreLevel implements SyncDeadLetterStore {
  private readonly _db: AbstractLevel<SyncMessageStoreLevelKey>;

  constructor(db: AbstractLevel<SyncMessageStoreLevelKey>) {
    this._db = db;
  }

  private get deadLetters(): AbstractLevel<SyncMessageStoreLevelKey, string, string> {
    return this._db.sublevel('deadLetters');
  }

  public clear(): Promise<DeletedDeadLetter[]> {
    return this.deleteKeys(this.deadLetters.keys());
  }

  public deleteForMessage(messageCid: string, remoteEndpoint?: string): Promise<DeletedDeadLetter[]> {
    return this.deleteWhere(
      (entry): boolean => entry.messageCid === messageCid &&
        (remoteEndpoint === undefined || entry.remoteEndpoint === remoteEndpoint),
    );
  }

  public async deleteExact(
    tenantDid: string,
    messageCid: string,
    remoteEndpoint: string,
  ): Promise<DeletedDeadLetter | undefined> {
    const key = buildSyncMessageStoreLevelKey(tenantDid, messageCid, remoteEndpoint);
    try {
      await this.deadLetters.get(key);
    } catch (error: unknown) {
      if (isSyncMessageStoreLevelNotFound(error)) {
        return undefined;
      }
      throw error;
    }
    await this.deadLetters.del(key);
    return { tenantDid, messageCid, remoteEndpoint };
  }

  public deleteForTenant(tenantDid: string): Promise<DeletedDeadLetter[]> {
    return this.deleteKeys(this.deadLetters.keys(syncMessageStoreLevelTenantKeyRange(tenantDid)));
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

  private async deleteWhere(match: (entry: DeletedDeadLetter) => boolean): Promise<DeletedDeadLetter[]> {
    return this.deleteKeys(this.deadLetters.keys(), match);
  }

  private async deleteKeys(
    keys: AsyncIterable<string>,
    match?: (entry: DeletedDeadLetter) => boolean,
  ): Promise<DeletedDeadLetter[]> {
    const batch: SyncMessageStoreLevelDelete[] = [];
    const deleted: DeletedDeadLetter[] = [];
    for await (const key of keys) {
      const entry = SyncDeadLetterStoreLevel.identityFromKey(key);
      if (match === undefined || (entry !== undefined && match(entry))) {
        batch.push({ type: 'del', key });
        if (entry !== undefined) {
          deleted.push(entry);
        }
      }
    }
    if (batch.length > 0) {
      await this.deadLetters.batch(batch);
    }
    return deleted;
  }

  private static identityFromKey(key: string): DeletedDeadLetter | undefined {
    const firstSeparator = key.indexOf('|');
    const secondSeparator = key.indexOf('|', firstSeparator + 1);
    if (firstSeparator < 1 || secondSeparator <= firstSeparator + 1) {
      return undefined;
    }
    return {
      tenantDid      : key.slice(0, firstSeparator),
      messageCid     : key.slice(firstSeparator + 1, secondSeparator),
      remoteEndpoint : key.slice(secondSeparator + 1),
    };
  }

  private async readEntries(entries: AsyncIterable<[string, string]>): Promise<DeadLetterEntry[]> {
    const deadLetters: DeadLetterEntry[] = [];
    for await (const [, value] of entries) {
      deadLetters.push(JSON.parse(value) as DeadLetterEntry);
    }
    return deadLetters;
  }
}
