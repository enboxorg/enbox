import type { AbstractLevel } from 'abstract-level';

import type { SyncQuotaBlockState, SyncQuotaStore } from './sync-quota-store.js';

type LevelKey = string | Buffer | Uint8Array;
type DeleteBatchEntry = { type: 'del'; key: string };

/** Level-backed persistence for durable per-link quota blocks. */
export class SyncQuotaStoreLevel implements SyncQuotaStore {
  private readonly _db: AbstractLevel<LevelKey>;

  constructor(db: AbstractLevel<LevelKey>) {
    this._db = db;
  }

  private get blocks(): AbstractLevel<LevelKey, string, string> {
    return this._db.sublevel('quotaBlocks');
  }

  public async clear(): Promise<void> {
    await this.blocks.clear();
  }

  public async delete(tenantDid: string, linkKey: string, messageCid: string): Promise<boolean> {
    const key = SyncQuotaStoreLevel.buildKey(tenantDid, linkKey, messageCid);
    try {
      await this.blocks.get(key);
    } catch (error: unknown) {
      if (SyncQuotaStoreLevel.isNotFound(error)) {
        return false;
      }
      throw error;
    }

    try {
      await this.blocks.del(key);
    } catch (error: unknown) {
      if (!SyncQuotaStoreLevel.isNotFound(error)) {
        throw error;
      }
    }
    return true;
  }

  public async deleteMany(states: SyncQuotaBlockState[]): Promise<void> {
    const batch = states.map((state): DeleteBatchEntry => ({
      type : 'del',
      key  : SyncQuotaStoreLevel.buildKey(state.tenantDid, state.linkKey, state.messageCid),
    }));
    if (batch.length > 0) {
      await this.blocks.batch(batch);
    }
  }

  public async deleteForTenant(tenantDid: string): Promise<void> {
    const batch: DeleteBatchEntry[] = [];
    for await (const [key] of this.blocks.iterator(SyncQuotaStoreLevel.tenantKeyRange(tenantDid))) {
      batch.push({ type: 'del', key });
    }
    if (batch.length > 0) {
      await this.blocks.batch(batch);
    }
  }

  public async get(
    tenantDid: string,
    linkKey: string,
    messageCid: string,
  ): Promise<SyncQuotaBlockState | undefined> {
    const key = SyncQuotaStoreLevel.buildKey(tenantDid, linkKey, messageCid);
    try {
      return JSON.parse(await this.blocks.get(key)) as SyncQuotaBlockState;
    } catch (error: unknown) {
      if (SyncQuotaStoreLevel.isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  public async getAll(): Promise<SyncQuotaBlockState[]> {
    return this.readStates(this.blocks.iterator());
  }

  public async getForTenant(tenantDid: string): Promise<SyncQuotaBlockState[]> {
    return this.readStates(this.blocks.iterator(SyncQuotaStoreLevel.tenantKeyRange(tenantDid)));
  }

  public async put(state: SyncQuotaBlockState): Promise<void> {
    const key = SyncQuotaStoreLevel.buildKey(state.tenantDid, state.linkKey, state.messageCid);
    await this.blocks.put(key, JSON.stringify(state));
  }

  private static buildKey(tenantDid: string, linkKey: string, messageCid: string): string {
    return `${tenantDid}|${messageCid}|${encodeURIComponent(linkKey)}`;
  }

  /** Tenant DIDs and CIDs cannot contain `|`, making this prefix range exact. */
  private static tenantKeyRange(tenantDid: string): { gte: string; lte: string } {
    return {
      gte : `${tenantDid}|`,
      lte : `${tenantDid}|\xff`,
    };
  }

  private static isNotFound(error: unknown): boolean {
    return (error as { code?: string }).code === 'LEVEL_NOT_FOUND';
  }

  private async readStates(
    entries: AsyncIterable<[string, string]>,
  ): Promise<SyncQuotaBlockState[]> {
    const states: SyncQuotaBlockState[] = [];
    for await (const [, value] of entries) {
      states.push(JSON.parse(value) as SyncQuotaBlockState);
    }
    return states;
  }
}
