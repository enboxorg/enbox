import type { AbstractLevel } from 'abstract-level';

import type { SyncIdentityOptions } from './types/sync.js';
import type { SyncIdentityStore, SyncIdentityStoreEntry } from './sync-identity-store.js';

type LevelKey = string | Buffer | Uint8Array;

/** Level-backed persistence for sync identity registrations. */
export class SyncIdentityStoreLevel implements SyncIdentityStore {
  private readonly _db: AbstractLevel<LevelKey>;

  constructor(db: AbstractLevel<LevelKey>) {
    this._db = db;
  }

  private get identities(): AbstractLevel<LevelKey, string, string> {
    return this._db.sublevel('registeredIdentities');
  }

  public async clear(): Promise<void> {
    await this.identities.clear();
  }

  public async delete(did: string): Promise<void> {
    await this.identities.del(did);
  }

  public async *entries(): AsyncIterable<SyncIdentityStoreEntry> {
    for await (const [did, value] of this.identities.iterator()) {
      let options: SyncIdentityOptions;
      try {
        options = JSON.parse(value) as SyncIdentityOptions;
      } catch (error: unknown) {
        yield { status: 'corrupt', did, error };
        continue;
      }

      yield { status: 'valid', did, options };
    }
  }

  public async get(did: string): Promise<SyncIdentityOptions | undefined> {
    try {
      const value = await this.identities.get(did);
      return value ? JSON.parse(value) as SyncIdentityOptions : undefined;
    } catch (error: unknown) {
      if ((error as { code?: string }).code === 'LEVEL_NOT_FOUND') {
        return undefined;
      }
      throw error;
    }
  }

  public async set(did: string, options: SyncIdentityOptions): Promise<void> {
    await this.identities.put(did, JSON.stringify(options));
  }
}
