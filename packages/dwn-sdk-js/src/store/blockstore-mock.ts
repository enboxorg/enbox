import type { CID } from 'multiformats';
import type { Blockstore, InputPair, Pair } from 'interface-blockstore';

type AbortOptions = { signal?: AbortSignal };
type BlockstoreSource<T> = Iterable<T> | AsyncIterable<T>;

/**
 * Mock implementation for the Blockstore interface.
 *
 * WARNING!!! Purely to be used with `ipfs-unixfs-importer` to compute CID without needing consume any memory.
 * This is particularly useful when dealing with large files and a necessity in a large-scale production service environment.
 */
export class BlockstoreMock implements Blockstore {

  async open(): Promise<void> {
  }

  async close(): Promise<void> {
  }

  async put(key: CID, _val: Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>, _options?: AbortOptions): Promise<CID> {
    return key;
  }

  async * get(_key: CID, _options?: AbortOptions): AsyncGenerator<Uint8Array> {
    yield new Uint8Array();
  }

  async has(_key: CID, _options?: AbortOptions): Promise<boolean> {
    return false;
  }

  async delete(_key: CID, _options?: AbortOptions): Promise<void> {
  }

  async isEmpty(_options?: AbortOptions): Promise<boolean> {
    return true;
  }

  async * putMany(source: BlockstoreSource<InputPair>, options?: AbortOptions): AsyncGenerator<CID> {
    for await (const entry of source) {
      await this.put(entry.cid, entry.bytes, options);

      yield entry.cid;
    }
  }

  async * getMany(source: BlockstoreSource<CID>, options?: AbortOptions): AsyncGenerator<Pair> {
    for await (const key of source) {
      yield {
        cid   : key,
        bytes : this.get(key, options)
      };
    }
  }

  async * getAll(_options?: AbortOptions): AsyncGenerator<Pair> {
  }

  async * deleteMany(source: BlockstoreSource<CID>, options?: AbortOptions): AsyncGenerator<CID> {
    for await (const key of source) {
      await this.delete(key, options);

      yield key;
    }
  }

  /**
   * deletes all entries
   */
  async clear(): Promise<void> {
  }
}
