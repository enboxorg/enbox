import type { AbstractLevel } from 'abstract-level';

import type { SyncEndpointStore } from './sync-endpoint-store.js';

type LevelKey = string | Buffer | Uint8Array;

const SUPPLEMENTAL_ENDPOINT_KEY = 'supplementalDwnEndpoint';

/** Level-backed persistence for the supplemental sync endpoint. */
export class SyncEndpointStoreLevel implements SyncEndpointStore {
  private readonly _db: AbstractLevel<LevelKey>;

  constructor(db: AbstractLevel<LevelKey>) {
    this._db = db;
  }

  private get metadata(): AbstractLevel<LevelKey, string, string> {
    return this._db.sublevel('syncMetadata');
  }

  public async clear(): Promise<void> {
    await this.metadata.del(SUPPLEMENTAL_ENDPOINT_KEY);
  }

  public async get(): Promise<string | undefined> {
    try {
      return await this.metadata.get(SUPPLEMENTAL_ENDPOINT_KEY);
    } catch (error: unknown) {
      if ((error as { code?: string }).code === 'LEVEL_NOT_FOUND') {
        return undefined;
      }
      throw error;
    }
  }

  public async set(endpoint: string): Promise<void> {
    await this.metadata.put(SUPPLEMENTAL_ENDPOINT_KEY, endpoint);
  }
}
