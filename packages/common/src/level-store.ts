import type { AbstractLevel } from 'abstract-level';
import type { KeyValueStore } from './types.js';

import { Level } from 'level';

export type LevelStoreOptions<K = string, V = any> = {
  db?: AbstractLevel<string | Buffer | Uint8Array, K, V>;
  location?: string;
};

export class LevelStore<K = string, V = any> implements KeyValueStore<K, V> {
  private readonly store: AbstractLevel<string | Buffer | Uint8Array, K, V>;

  public constructor({ db, location = 'DATASTORE' }: LevelStoreOptions<K, V> = {}) {
    this.store = db ?? new Level<K, V>(location);
  }

  public async open(): Promise<void> {
    await this.store.open();
  }

  public async clear(): Promise<void> {
    await this.store.clear();
  }

  public async close(): Promise<void> {
    await this.store.close();
  }

  public async delete(key: K): Promise<void> {
    await this.store.del(key);
  }

  public async get(key: K): Promise<V | undefined> {
    try {
      return await this.store.get(key);
    } catch (error: any) {
      // Don't throw when a key wasn't found.
      if (error.notFound) { return undefined; }
      throw error;
    }
  }

  public async set(key: K, value: V): Promise<void> {
    await this.store.put(key, value);
  }
}
