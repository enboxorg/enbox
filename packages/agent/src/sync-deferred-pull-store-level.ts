import type { AbstractLevel } from 'abstract-level';

import type { SyncMessageStoreLevelKey } from './sync-message-store-level.js';
import type { SyncDeferredPullState, SyncDeferredPullStore } from './sync-deferred-pull-store.js';

import { buildSyncMessageStoreLevelKey, isSyncMessageStoreLevelNotFound, syncMessageStoreLevelTenantKeyRange } from './sync-message-store-level.js';

/** Level-backed persistence for temporarily deferred pull admissions. */
export class SyncDeferredPullStoreLevel implements SyncDeferredPullStore {
  private readonly _db: AbstractLevel<SyncMessageStoreLevelKey>;

  constructor(db: AbstractLevel<SyncMessageStoreLevelKey>) {
    this._db = db;
  }

  private get deferredPulls(): AbstractLevel<SyncMessageStoreLevelKey, string, string> {
    return this._db.sublevel('deferredPulls');
  }

  public async clear(): Promise<void> {
    await this.deferredPulls.clear();
  }

  public async delete(tenantDid: string, messageCid: string, remoteEndpoint: string): Promise<void> {
    try {
      await this.deferredPulls.del(buildSyncMessageStoreLevelKey(tenantDid, messageCid, remoteEndpoint));
    } catch (error: unknown) {
      if (!isSyncMessageStoreLevelNotFound(error)) {
        throw error;
      }
    }
  }

  public async deleteForTenant(tenantDid: string): Promise<void> {
    await this.deferredPulls.clear(syncMessageStoreLevelTenantKeyRange(tenantDid));
  }

  public async get(
    tenantDid: string,
    messageCid: string,
    remoteEndpoint: string,
  ): Promise<SyncDeferredPullState | undefined> {
    try {
      const value = await this.deferredPulls.get(buildSyncMessageStoreLevelKey(tenantDid, messageCid, remoteEndpoint));
      return JSON.parse(value) as SyncDeferredPullState;
    } catch (error: unknown) {
      if (isSyncMessageStoreLevelNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  public async put(
    tenantDid: string,
    messageCid: string,
    remoteEndpoint: string,
    state: SyncDeferredPullState,
  ): Promise<void> {
    const key = buildSyncMessageStoreLevelKey(tenantDid, messageCid, remoteEndpoint);
    await this.deferredPulls.put(key, JSON.stringify(state));
  }
}
