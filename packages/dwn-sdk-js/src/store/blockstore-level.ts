import { CID } from 'multiformats';
import type { Blockstore, InputPair, Pair } from 'interface-blockstore';

import { NotFoundError } from 'interface-store';
import { createLevelDatabase, LevelWrapper } from './level-wrapper.js';

type AbortOptions = { signal?: AbortSignal };
type BlockstoreInput = Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>;
type BlockstoreSource<T> = Iterable<T> | AsyncIterable<T>;

async function collectBytes(input: BlockstoreInput): Promise<Uint8Array> {
  if (input instanceof Uint8Array) {
    return input;
  }

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of input) {
    chunks.push(chunk);
    byteLength += chunk.byteLength;
  }

  if (chunks.length === 1) {
    return chunks[0];
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

async function* yieldBytes(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

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

  async put(key: CID | string, val: BlockstoreInput, options?: AbortOptions): Promise<CID> {
    const bytes = await collectBytes(val);
    await this.db.put(String(key), bytes, options);
    return CID.parse(key.toString());
  }

  async * get(key: CID | string, options?: AbortOptions): AsyncGenerator<Uint8Array> {
    const result = await this.db.get(String(key), options);
    if (result === undefined) {
      throw new NotFoundError();
    }

    yield result;
  }

  async has(key: CID | string, options?: AbortOptions): Promise<boolean> {
    return this.db.has(String(key), options);
  }

  async delete(key: CID | string, options?: AbortOptions): Promise<void> {
    return this.db.delete(String(key), options);
  }

  async isEmpty(options?: AbortOptions): Promise<boolean> {
    return this.db.isEmpty(options);
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

  async * getAll(options?: AbortOptions): AsyncGenerator<Pair> {
    const li: AsyncGenerator<[string, Uint8Array]> = this.db.iterator({ keys: true }, options);

    for await (const [key, value] of li) {
      yield { cid: CID.parse(key), bytes: yieldBytes(value) };
    }
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
    return this.db.clear();
  }
}

export type BlockstoreLevelConfig = {
  location: string,
  createLevelDatabase?: typeof createLevelDatabase,
};
