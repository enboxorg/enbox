import type { CID } from 'multiformats';
import type { InputPair, Pair } from 'interface-blockstore';

export type BlockstoreAbortOptions = { signal?: AbortSignal };
export type BlockstoreInput = Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>;
export type BlockstoreSource<T> = Iterable<T> | AsyncIterable<T>;

type BlockstorePutDelegate = {
  put(key: CID, val: BlockstoreInput, options?: BlockstoreAbortOptions): Promise<CID>;
};

type BlockstoreGetDelegate = {
  get(key: CID, options?: BlockstoreAbortOptions): AsyncGenerator<Uint8Array>;
};

type BlockstoreDeleteDelegate = {
  delete(key: CID, options?: BlockstoreAbortOptions): Promise<void>;
};

export async function collectBlockstoreBytes(input: BlockstoreInput): Promise<Uint8Array> {
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

export async function* yieldBlockstoreBytes(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

export async function* putManyBlockstoreItems(
  blockstore: BlockstorePutDelegate,
  source: BlockstoreSource<InputPair>,
  options?: BlockstoreAbortOptions,
): AsyncGenerator<CID> {
  for await (const entry of source) {
    await blockstore.put(entry.cid, entry.bytes, options);

    yield entry.cid;
  }
}

export async function* getManyBlockstoreItems(
  blockstore: BlockstoreGetDelegate,
  source: BlockstoreSource<CID>,
  options?: BlockstoreAbortOptions,
): AsyncGenerator<Pair> {
  for await (const key of source) {
    yield {
      cid   : key,
      bytes : blockstore.get(key, options),
    };
  }
}

export async function* deleteManyBlockstoreItems(
  blockstore: BlockstoreDeleteDelegate,
  source: BlockstoreSource<CID>,
  options?: BlockstoreAbortOptions,
): AsyncGenerator<CID> {
  for await (const key of source) {
    await blockstore.delete(key, options);

    yield key;
  }
}
