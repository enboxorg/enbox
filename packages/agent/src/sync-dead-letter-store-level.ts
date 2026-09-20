import type { AbstractBatchOperation, AbstractLevel, AbstractSublevel } from 'abstract-level';

import type { DeadLetterEntry } from './types/sync.js';

import { buildLinkKey, LINK_KEY_SEPARATOR } from './sync-link-key.js';
import { buildSyncMessageStoreLevelKey, isSyncMessageStoreLevelNotFound, syncMessageStoreLevelTenantKeyRange } from './sync-message-store-level.js';

type LevelKey = string | Buffer | Uint8Array;
type SyncLevelDatabase = AbstractLevel<LevelKey>;

export type SyncDeadLetterBatchOperation = AbstractBatchOperation<SyncLevelDatabase, string, string>;

/** Level-backed persistence for terminal sync failures. */
export class SyncDeadLetterStoreLevel {
  private readonly _db: SyncLevelDatabase;

  constructor(db: SyncLevelDatabase) {
    this._db = db;
  }

  private get deadLetters(): AbstractSublevel<SyncLevelDatabase, LevelKey, string, string> {
    return this._db.sublevel('deadLetters');
  }

  private get preciseDeadLetters(): AbstractSublevel<SyncLevelDatabase, LevelKey, string, string> {
    return this._db.sublevel('deadLettersV2');
  }

  public async clear(): Promise<void> {
    await Promise.all([this.deadLetters.clear(), this.preciseDeadLetters.clear()]);
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
    await Promise.all([
      this.deadLetters.clear(syncMessageStoreLevelTenantKeyRange(tenantDid)),
      this.preciseDeadLetters.clear(SyncDeadLetterStoreLevel.preciseTenantRange(tenantDid)),
    ]);
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

  public async getPrecise(entry: Pick<
    Required<DeadLetterEntry>,
    'authorizationEpoch' | 'direction' | 'messageCid' | 'projectionId' | 'remoteEndpoint' | 'tenantDid'
  >): Promise<DeadLetterEntry | undefined> {
    try {
      const value = await this.preciseDeadLetters.get(SyncDeadLetterStoreLevel.buildPreciseKey(entry));
      return JSON.parse(value) as DeadLetterEntry;
    } catch (error: unknown) {
      if (isSyncMessageStoreLevelNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  public async deletePrecise(entry: Pick<
    Required<DeadLetterEntry>,
    'authorizationEpoch' | 'direction' | 'messageCid' | 'projectionId' | 'remoteEndpoint' | 'tenantDid'
  >): Promise<boolean> {
    const key = SyncDeadLetterStoreLevel.buildPreciseKey(entry);
    try {
      await this.preciseDeadLetters.get(key);
    } catch (error: unknown) {
      if (isSyncMessageStoreLevelNotFound(error)) {
        return false;
      }
      throw error;
    }
    await this.preciseDeadLetters.del(key);
    return true;
  }

  public async getAll(): Promise<DeadLetterEntry[]> {
    const [legacy, precise] = await Promise.all([
      this.readEntries(this.deadLetters.iterator()),
      this.readEntries(this.preciseDeadLetters.iterator()),
    ]);
    return [...legacy, ...precise];
  }

  public async getForTenant(tenantDid: string): Promise<DeadLetterEntry[]> {
    const [legacy, precise] = await Promise.all([
      this.readEntries(this.deadLetters.iterator(syncMessageStoreLevelTenantKeyRange(tenantDid))),
      this.readEntries(this.preciseDeadLetters.iterator(SyncDeadLetterStoreLevel.preciseTenantRange(tenantDid))),
    ]);
    const entries = [...legacy, ...precise];
    return entries.filter((entry): boolean => entry.tenantDid === tenantDid);
  }

  public async put(entry: DeadLetterEntry): Promise<void> {
    if (entry.version === 2) {
      await this._db.batch([this.putOperation(entry)]);
      return;
    }
    const key = buildSyncMessageStoreLevelKey(entry.tenantDid, entry.messageCid, entry.remoteEndpoint);
    await this.deadLetters.put(key, JSON.stringify(entry));
  }

  public putOperation(entry: DeadLetterEntry): SyncDeadLetterBatchOperation {
    if (
      entry.version !== 2 ||
      entry.direction === undefined ||
      entry.projectionId === undefined ||
      entry.authorizationEpoch === undefined
    ) {
      throw new Error('SyncDeadLetterStoreLevel: precise batch entries require v2 direction and link identity.');
    }
    return {
      type : 'put',
      key  : SyncDeadLetterStoreLevel.buildPreciseKey({
        authorizationEpoch : entry.authorizationEpoch,
        direction          : entry.direction,
        messageCid         : entry.messageCid,
        projectionId       : entry.projectionId,
        remoteEndpoint     : entry.remoteEndpoint,
        tenantDid          : entry.tenantDid,
      }),
      value    : JSON.stringify(entry),
      sublevel : this.preciseDeadLetters,
    };
  }

  public deletePreciseOperation(entry: Pick<
    Required<DeadLetterEntry>,
    'authorizationEpoch' | 'direction' | 'messageCid' | 'projectionId' | 'remoteEndpoint' | 'tenantDid'
  >): SyncDeadLetterBatchOperation {
    return {
      type     : 'del',
      key      : SyncDeadLetterStoreLevel.buildPreciseKey(entry),
      sublevel : this.preciseDeadLetters,
    };
  }

  public deleteLegacyOperation(
    tenantDid: string,
    messageCid: string,
    remoteEndpoint: string,
  ): SyncDeadLetterBatchOperation {
    return {
      type     : 'del',
      key      : buildSyncMessageStoreLevelKey(tenantDid, messageCid, remoteEndpoint),
      sublevel : this.deadLetters,
    };
  }

  private async readEntries(entries: AsyncIterable<[string, string]>): Promise<DeadLetterEntry[]> {
    const deadLetters: DeadLetterEntry[] = [];
    for await (const [, value] of entries) {
      deadLetters.push(JSON.parse(value) as DeadLetterEntry);
    }
    return deadLetters;
  }

  private static buildPreciseKey(entry: Pick<
    Required<DeadLetterEntry>,
    'authorizationEpoch' | 'direction' | 'messageCid' | 'projectionId' | 'remoteEndpoint' | 'tenantDid'
  >): string {
    const linkKey = buildLinkKey(
      entry.tenantDid,
      entry.remoteEndpoint,
      entry.projectionId,
      entry.authorizationEpoch,
    );
    return `${entry.tenantDid}${LINK_KEY_SEPARATOR}${entry.direction}${LINK_KEY_SEPARATOR}${linkKey}${LINK_KEY_SEPARATOR}${entry.messageCid}`;
  }

  private static preciseTenantRange(tenantDid: string): { gte: string; lte: string } {
    const prefix = `${tenantDid}${LINK_KEY_SEPARATOR}`;
    return { gte: prefix, lte: `${prefix}\xff` };
  }
}
