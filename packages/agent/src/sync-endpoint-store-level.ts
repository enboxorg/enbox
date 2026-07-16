import type { AbstractLevel } from 'abstract-level';

import type { SyncEndpointStore } from './sync-endpoint-store.js';

const SUPPLEMENTAL_ENDPOINT_KEY = 'supplementalDwnEndpoint';

/** Level-backed persistence for the supplemental sync endpoint. */
export class SyncEndpointStoreLevel implements SyncEndpointStore {
  private readonly _db: AbstractLevel<string | Buffer | Uint8Array>;

  constructor(db: AbstractLevel<string | Buffer | Uint8Array>) {
    this._db = db;
  }

  private get metadata(): AbstractLevel<string | Buffer | Uint8Array, string, string> {
    return this._db.sublevel('syncMetadata');
  }

  public async clear(): Promise<void> {
    await this.metadata.clear();
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
