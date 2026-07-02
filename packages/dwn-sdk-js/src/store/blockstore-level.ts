import type { Blockstore, InputPair, Pair } from 'interface-blockstore';
import type { BlockstoreAbortOptions, BlockstoreInput, BlockstoreSource } from './blockstore-utils.js';

import { CID } from 'multiformats';
import { NotFoundError } from 'interface-store';
import {
  collectBlockstoreBytes,
  deleteManyBlockstoreItems,
  getManyBlockstoreItems,
  putManyBlockstoreItems,
  yieldBlockstoreBytes,
} from './blockstore-utils.js';
import { createLevelDatabase, LevelWrapper } from './level-wrapper.js';

// `level` works in Node.js 12+ and Electron 5+ on Linux, Mac OS, Windows and
// FreeBSD, including any future Node.js and Electron release thanks to Node-API, including ARM
// platforms like Raspberry Pi and Android, as well as in Chrome, Firefox, Edge, Safari, iOS Safari
//  and Chrome for Android.

/**
 * Blockstore implementation using LevelDB for storing the actual messages (in the case of MessageStore)
 * or the data associated with messages (in the case of a DataStore).
 */
export class BlockstoreLevel implements Blockstore {
  config: BlockstoreLevelConfig;

  db: LevelWrapper<Uint8Array>;

  constructor(config: BlockstoreLevelConfig, db?: LevelWrapper<Uint8Array>) {
    this.config = {
      createLevelDatabase,
      ...config
    };

    this.db = db ?? new LevelWrapper<Uint8Array>({ ...this.config, valueEncoding: 'binary' });
  }

  async open(): Promise<void> {
    return this.db.open();
  }

  async close(): Promise<void> {
    return this.db.close();
  }

  async partition(name: string): Promise<BlockstoreLevel> {
    const db = await this.db.partition(name);
    return new BlockstoreLevel({ ...this.config, location: '' }, db);
  }

  async put(key: CID | string, val: BlockstoreInput, options?: BlockstoreAbortOptions): Promise<CID> {
    const bytes = await collectBlockstoreBytes(val);
    await this.db.put(String(key), bytes, options);
    return CID.parse(key.toString());
  }

  async * get(key: CID | string, options?: BlockstoreAbortOptions): AsyncGenerator<Uint8Array> {
    const result = await this.db.get(String(key), options);
    if (result === undefined) {
      throw new NotFoundError();
    }

    yield result;
  }

  async has(key: CID | string, options?: BlockstoreAbortOptions): Promise<boolean> {
    return this.db.has(String(key), options);
  }

  async delete(key: CID | string, options?: BlockstoreAbortOptions): Promise<void> {
    return this.db.delete(String(key), options);
  }

  async isEmpty(options?: BlockstoreAbortOptions): Promise<boolean> {
    return this.db.isEmpty(options);
  }

  async * putMany(source: BlockstoreSource<InputPair>, options?: BlockstoreAbortOptions): AsyncGenerator<CID> {
    yield * putManyBlockstoreItems(this, source, options);
  }

  async * getMany(source: BlockstoreSource<CID>, options?: BlockstoreAbortOptions): AsyncGenerator<Pair> {
    yield * getManyBlockstoreItems(this, source, options);
  }

  async * getAll(options?: BlockstoreAbortOptions): AsyncGenerator<Pair> {
    const li: AsyncGenerator<[string, Uint8Array]> = this.db.iterator({ keys: true }, options);

    for await (const [key, value] of li) {
      yield { cid: CID.parse(key), bytes: yieldBlockstoreBytes(value) };
    }
  }

  async * deleteMany(source: BlockstoreSource<CID>, options?: BlockstoreAbortOptions): AsyncGenerator<CID> {
    yield * deleteManyBlockstoreItems(this, source, options);
  }

  /**
   * deletes all entries
   */
  async clear(): Promise<void> {
    return this.db.clear();
  }
}

export type BlockstoreLevelConfig = {
  location: string,
  createLevelDatabase?: typeof createLevelDatabase,
};
