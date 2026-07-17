import type { CID } from 'multiformats';
import type { Blockstore, InputPair, Pair } from 'interface-blockstore';
import type { BlockstoreAbortOptions, BlockstoreInput, BlockstoreSource } from './blockstore-utils.js';

import {
  deleteManyBlockstoreItems,
  getManyBlockstoreItems,
  putManyBlockstoreItems,
} from './blockstore-utils.js';

/**
 * Mock implementation for the Blockstore interface.
 *
 * WARNING!!! Purely to be used with `ipfs-unixfs-importer` to compute CID without needing consume any memory.
 * This is particularly useful when dealing with large files and a necessity in a large-scale production service environment.
 */
export class BlockstoreMock implements Blockstore {

  async open(): Promise<void> {
    // no-op: mock blockstore has no underlying storage to open
  }

  async close(): Promise<void> {
    // no-op: mock blockstore has no underlying storage to close
  }

  async put(key: CID, _val: BlockstoreInput, _options?: BlockstoreAbortOptions): Promise<CID> {
    return key;
  }

  async * get(_key: CID, _options?: BlockstoreAbortOptions): AsyncGenerator<Uint8Array> {
    yield new Uint8Array();
  }

  async has(_key: CID, _options?: BlockstoreAbortOptions): Promise<boolean> {
    return false;
  }

  async delete(_key: CID, _options?: BlockstoreAbortOptions): Promise<void> {
    return;
  }

  async isEmpty(_options?: BlockstoreAbortOptions): Promise<boolean> {
    return true;
  }

  async * putMany(source: BlockstoreSource<InputPair>, options?: BlockstoreAbortOptions): AsyncGenerator<CID> {
    yield * putManyBlockstoreItems(this, source, options);
  }

  async * getMany(source: BlockstoreSource<CID>, options?: BlockstoreAbortOptions): AsyncGenerator<Pair> {
    yield * getManyBlockstoreItems(this, source, options);
  }

  async * getAll(_options?: BlockstoreAbortOptions): AsyncGenerator<Pair> {
    yield * [];
  }

  async * deleteMany(source: BlockstoreSource<CID>, options?: BlockstoreAbortOptions): AsyncGenerator<CID> {
    yield * deleteManyBlockstoreItems(this, source, options);
  }

  /**
   * deletes all entries
   */
  async clear(): Promise<void> {
    // no-op: mock blockstore has no underlying storage to clear
  }
}
