import type { RecordData } from '../src/record-data.js';
import type { FileEnvelopeCodec, FileEnvelopeData } from '../src/file-envelope-codec.js';

import { describe, expect, it } from 'bun:test';

import { createRecordData } from '../src/record-data.js';
import { recordCodecs } from '../src/record-codec.js';

const CONTENT_BLOCK_BYTES = 64 * 1_024;
const DATA_FORMAT = 'application/octet-stream';
const FORMAT_ID = 'notesd';
const PREFIX_BYTES = 12;
const encoder = new TextEncoder();

type StreamCounters = {
  cancellations: number;
  pulls: number;
};

function dataForChunks(chunks: readonly Uint8Array[], counters?: StreamCounters): RecordData {
  return createRecordData(async (): Promise<ReadableStream> => {
    let index = 0;
    return new ReadableStream<Uint8Array>({
      cancel(): void {
        if (counters !== undefined) {
          counters.cancellations += 1;
        }
      },
      pull(controller): void {
        const chunk = chunks[index];
        if (chunk === undefined) {
          controller.close();
          return;
        }
        index += 1;
        if (counters !== undefined) {
          counters.pulls += 1;
        }
        controller.enqueue(chunk);
      },
    });
  }, DATA_FORMAT);
}

function dataForByteFragments(bytes: Uint8Array, contentOffset: number): RecordData {
  return createRecordData(async (): Promise<ReadableStream> => {
    let offset = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller): void {
        if (offset === 0) {
          controller.enqueue(bytes.subarray(0, contentOffset));
          offset = contentOffset;
        } else if (offset < bytes.byteLength) {
          controller.enqueue(bytes.subarray(offset, offset + 1));
          offset += 1;
        } else {
          controller.close();
        }
      },
    });
  }, DATA_FORMAT);
}

function dataFor(blob: Blob): RecordData {
  return createRecordData(async (): Promise<ReadableStream> => blob.stream(), blob.type || DATA_FORMAT);
}

async function decode(codec: FileEnvelopeCodec, blob: Blob, dataFormat = DATA_FORMAT): Promise<FileEnvelopeData> {
  return codec.decode(dataFor(blob), dataFormat);
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

async function hex(blob: Blob): Promise<string> {
  return [...await bytesOf(blob)].map((byte): string => byte.toString(16).padStart(2, '0')).join('');
}

function splitEveryByte(bytes: Uint8Array): Uint8Array[] {
  return Array.from(bytes, (_byte, index): Uint8Array => bytes.subarray(index, index + 1));
}

function rawEnvelope(options: Readonly<{
  content?: Uint8Array;
  declaredMetadataLength?: number;
  formatId?: string;
  metadata?: string | Uint8Array;
  reserved?: number;
  version?: number;
}> = {}): Blob {
  const metadata = typeof options.metadata === 'string'
    ? encoder.encode(options.metadata)
    : options.metadata ?? encoder.encode('{"filename":"file.txt","mimeType":"text/plain"}');
  const prefix = new Uint8Array(PREFIX_BYTES);
  prefix.set(encoder.encode(options.formatId ?? FORMAT_ID).subarray(0, 6));
  prefix[6] = options.version ?? 1;
  prefix[7] = options.reserved ?? 0;
  new DataView(prefix.buffer).setUint32(8, options.declaredMetadataLength ?? metadata.byteLength, false);
  return new Blob(
    [prefix as BlobPart, metadata as BlobPart, (options.content ?? new Uint8Array()) as BlobPart],
    { type: DATA_FORMAT },
  );
}

function file(filename: string, blob = new Blob(['x']), mimeType = 'text/plain'): FileEnvelopeData {
  return { filename, mimeType, blob };
}

describe('recordCodecs.fileEnvelope', () => {
  it('preserves the Notesd V1 bytes and round-trips private file metadata', async () => {
    const codec = recordCodecs.fileEnvelope({ formatId: FORMAT_ID });
    const encoded = codec.encode({
      filename : 'hello.txt',
      mimeType : 'Text/Plain; charset=utf-8',
      blob     : new Blob([new Uint8Array([0, 1, 255]) as BlobPart]),
    });

    expect(encoded.dataFormat).toBe(DATA_FORMAT);
    expect(encoded.data.type).toBe(DATA_FORMAT);
    expect(await hex(encoded.data)).toBe(
      '6e6f746573640100000000307b2266696c656e616d65223a2268656c6c6f2e747874222c226d696d6554797065223a22746578742f706c61696e227d0001ff',
    );

    const decoded = await decode(codec, encoded.data);
    expect(decoded.filename).toBe('hello.txt');
    expect(decoded.mimeType).toBe('text/plain');
    expect(await bytesOf(decoded.blob)).toEqual(new Uint8Array([0, 1, 255]));
  });

  it('supports an optional local content limit and calculates protocol size bounds', async () => {
    for (const options of [
      undefined,
      null,
      { formatId: 'short' },
      { formatId: 'toolong' },
      { formatId: 'notéss' },
      { formatId: FORMAT_ID, maxContentBytes: -1 },
      { formatId: FORMAT_ID, maxContentBytes: 1.5 },
      { formatId: FORMAT_ID, maxContentBytes: Number.MAX_SAFE_INTEGER },
      { formatId: FORMAT_ID, maxContentBytes: null },
    ]) {
      expect(() => recordCodecs.fileEnvelope(options as never)).toThrow('File envelope');
    }

    const unbounded = recordCodecs.fileEnvelope({ formatId: FORMAT_ID });
    expect(() => recordCodecs.fileEnvelope({ formatId: FORMAT_ID, maxContentBytes: undefined })).not.toThrow();
    expect(Object.isFrozen(unbounded)).toBe(true);
    expect(unbounded.maxEncodedBytesFor(0)).toBe(4_108);
    expect(unbounded.maxEncodedBytesFor(3)).toBe(4_111);
    for (const contentBytes of [-1, 1.5, Number.MAX_SAFE_INTEGER, null]) {
      expect(() => unbounded.maxEncodedBytesFor(contentBytes as never)).toThrow('File envelope');
    }

    const zeroLimit = recordCodecs.fileEnvelope({ formatId: FORMAT_ID, maxContentBytes: 0 });
    expect(() => zeroLimit.encode(file('empty.bin', new Blob()))).not.toThrow();
    expect(() => zeroLimit.encode(file('nonempty.bin'))).toThrow('content exceeds 0 bytes');

    const codec = recordCodecs.fileEnvelope({ formatId: FORMAT_ID, maxContentBytes: 3 });
    const larger = file('larger.bin', new Blob(['1234']));
    const encoded = unbounded.encode(larger);
    expect(await (await decode(unbounded, encoded.data)).blob.text()).toBe('1234');
    expect(() => codec.encode(larger)).toThrow('content exceeds 3 bytes');
  });

  it('validates file values, basenames, and MIME claims', async () => {
    const codec = recordCodecs.fileEnvelope({ formatId: FORMAT_ID, maxContentBytes: 3 });
    expect(() => codec.encode({ ...file('bad.bin'), blob: 'bytes' } as unknown as FileEnvelopeData))
      .toThrow('blob must be a Blob');
    expect(() => codec.encode(file('three.bin', new Blob(['123'])))).not.toThrow();
    expect(() => codec.encode(file('four.bin', new Blob(['1234'])))).toThrow('content exceeds 3 bytes');

    for (const filename of ['', '  ', '.', '..', ' . ', ' .. ', '../secret', 'a/b', 'a\\b', 'bad\nname', 'bad\0name', 'bad\x7fname']) {
      expect(() => codec.encode(file(filename))).toThrow('filename');
    }
    expect(() => codec.encode(file('🚀'.repeat(256)))).not.toThrow();
    expect(() => codec.encode(file('🚀'.repeat(257)))).toThrow('1024 UTF-8 bytes');

    for (const [mimeType, expected] of [
      [' Image/PNG; charset=binary ', 'image/png'],
      ['', DATA_FORMAT],
      ['not-a-mime', DATA_FORMAT],
      [`a/${'b'.repeat(254)}`, DATA_FORMAT],
    ] as const) {
      const roundTrip = await decode(codec, codec.encode(file('file.bin', new Blob(), mimeType)).data);
      expect(roundTrip.mimeType).toBe(expected);
    }
  });

  it('rejects malformed prefixes, lengths, metadata, and outer formats', async () => {
    const codec = recordCodecs.fileEnvelope({ formatId: FORMAT_ID, maxContentBytes: 3 });
    const cases: ReadonlyArray<readonly [Blob, string, string?]> = [
      [new Blob([new Uint8Array(11) as BlobPart], { type: DATA_FORMAT }), 'fixed prefix'],
      [rawEnvelope({ formatId: 'other!' }), 'format identifier'],
      [rawEnvelope({ version: 2 }), 'unsupported envelope version'],
      [rawEnvelope({ reserved: 1 }), 'reserved envelope byte'],
      [rawEnvelope({ declaredMetadataLength: 0 }), 'metadata length'],
      [rawEnvelope({ declaredMetadataLength: 4_097 }), 'metadata length'],
      [rawEnvelope({ declaredMetadataLength: 100 }), 'metadata extends past'],
      [rawEnvelope({ metadata: new Uint8Array([0xc3, 0x28]) }), 'not valid UTF-8 JSON'],
      [rawEnvelope({ metadata: 'not-json' }), 'not valid UTF-8 JSON'],
      [rawEnvelope({ metadata: '[]' }), 'metadata must be an object'],
      [rawEnvelope({ metadata: '{"filename":"file.txt"}' }), 'only filename and mimeType'],
      [rawEnvelope({ metadata: '{"filename":"file.txt","mimeType":"text/plain","extra":true}' }), 'only filename and mimeType'],
      [rawEnvelope({ metadata: '{"filename":"..","mimeType":"text/plain"}' }), 'relative directory'],
      [rawEnvelope({ content: encoder.encode('1234') }), 'content exceeds 3 bytes'],
      [rawEnvelope(), `dataFormat must be '${DATA_FORMAT}'`, 'text/plain'],
    ];

    for (const [blob, message, dataFormat] of cases) {
      await expect(decode(codec, blob, dataFormat)).rejects.toThrow(message);
    }

    const exact = rawEnvelope({
      content  : encoder.encode('123'),
      metadata : '{"filename":"file.txt","mimeType":"text/plain"}'.padEnd(4_096, ' '),
    });
    expect(exact.size).toBe(codec.maxEncodedBytesFor(3));
    expect(await (await decode(codec, exact)).blob.text()).toBe('123');
  });

  it('decodes fragmented RecordData streams without convenience buffering', async () => {
    const codec = recordCodecs.fileEnvelope({ formatId: FORMAT_ID, maxContentBytes: 3 });
    const encoded = codec.encode(file('file.txt', new Blob(['123'])));
    const data = dataForChunks(splitEveryByte(await bytesOf(encoded.data)));
    data.blob = async (): Promise<Blob> => { throw new Error('blob() must not be used'); };
    data.bytes = async (): Promise<Uint8Array> => { throw new Error('bytes() must not be used'); };

    const decoded = await codec.decode(data, DATA_FORMAT);
    expect(decoded.filename).toBe('file.txt');
    expect(await decoded.blob.text()).toBe('123');
  });

  it('coalesces byte-fragmented content into fixed-size output blocks', async () => {
    const contentBytes = (CONTENT_BLOCK_BYTES * 2) + 17;
    const codec = recordCodecs.fileEnvelope({ formatId: FORMAT_ID, maxContentBytes: contentBytes });
    const content = Uint8Array.from({ length: contentBytes }, (_, index): number => index % 256);
    const envelope = await bytesOf(rawEnvelope({ content }));
    const contentOffset = envelope.byteLength - content.byteLength;
    const NativeBlob = globalThis.Blob;
    let outputPartSizes: number[] = [];

    class TrackingBlob extends NativeBlob {
      public constructor(parts: BlobPart[] = [], options?: BlobPropertyBag) {
        outputPartSizes = parts.map((part): number => {
          if (typeof part === 'string') {
            return encoder.encode(part).byteLength;
          }
          return part instanceof NativeBlob ? part.size : part.byteLength;
        });
        super(parts, options);
      }
    }

    globalThis.Blob = TrackingBlob;
    try {
      const decoded = await codec.decode(dataForByteFragments(envelope, contentOffset), DATA_FORMAT);
      expect(await bytesOf(decoded.blob)).toEqual(content);
    } finally {
      globalThis.Blob = NativeBlob;
    }
    expect(outputPartSizes).toEqual([CONTENT_BLOCK_BYTES, CONTENT_BLOCK_BYTES, 17]);
  });

  it('cancels an oversized fragmented stream before consuming it', async () => {
    const codec = recordCodecs.fileEnvelope({ formatId: FORMAT_ID, maxContentBytes: 3 });
    const chunks = splitEveryByte(await bytesOf(rawEnvelope({ content: new Uint8Array(100) })));
    const counters: StreamCounters = { cancellations: 0, pulls: 0 };

    await expect(codec.decode(dataForChunks(chunks, counters), DATA_FORMAT))
      .rejects.toThrow('content exceeds 3 bytes');
    expect(counters.cancellations).toBe(1);
    expect(counters.pulls).toBeLessThan(chunks.length);
  });
});
