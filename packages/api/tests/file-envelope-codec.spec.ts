import type { FileEnvelopeCodec, FileEnvelopeData } from '../src/file-envelope-codec.js';

import { describe, expect, it } from 'bun:test';

import { createRecordData } from '../src/record-data.js';
import { recordCodecs } from '../src/record-codec.js';

const DATA_FORMAT = 'application/octet-stream';
const FORMAT_ID = 'notesd';
const PREFIX_BYTES = 12;
const encoder = new TextEncoder();

async function decode(codec: FileEnvelopeCodec, blob: Blob, dataFormat = DATA_FORMAT): Promise<FileEnvelopeData> {
  const data = createRecordData(async (): Promise<ReadableStream> => blob.stream(), blob.type || DATA_FORMAT);
  return codec.decode(data, dataFormat);
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

async function hex(blob: Blob): Promise<string> {
  return [...await bytesOf(blob)].map((byte): string => byte.toString(16).padStart(2, '0')).join('');
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
  return new Blob([prefix as BlobPart, metadata as BlobPart, (options.content ?? new Uint8Array()) as BlobPart], { type: DATA_FORMAT });
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

  it('supports an optional local content limit and calculates protocol size bounds', () => {
    for (const options of [
      undefined,
      { formatId: 'short' },
      { formatId: 'notéss' },
      { formatId: FORMAT_ID, maxContentBytes: -1 },
      { formatId: FORMAT_ID, maxContentBytes: 1.5 },
      { formatId: FORMAT_ID, maxContentBytes: Number.MAX_SAFE_INTEGER },
      { formatId: FORMAT_ID, maxContentBytes: null },
    ]) {
      expect(() => recordCodecs.fileEnvelope(options as never)).toThrow('File envelope');
    }

    const unbounded = recordCodecs.fileEnvelope({ formatId: FORMAT_ID });
    expect(unbounded.maxEncodedBytesFor(3)).toBe(4_111);
    expect(() => unbounded.maxEncodedBytesFor(Number.MAX_SAFE_INTEGER)).toThrow('File envelope');

    const zeroLimit = recordCodecs.fileEnvelope({ formatId: FORMAT_ID, maxContentBytes: 0 });
    expect(() => zeroLimit.encode(file('empty.bin', new Blob()))).not.toThrow();
    expect(() => zeroLimit.encode(file('nonempty.bin'))).toThrow('content exceeds 0 bytes');
  });

  it('validates file values, basenames, and MIME claims', async () => {
    const codec = recordCodecs.fileEnvelope({ formatId: FORMAT_ID });
    expect(() => codec.encode({ ...file('bad.bin'), blob: 'bytes' } as unknown as FileEnvelopeData))
      .toThrow('blob must be a Blob');

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
      [rawEnvelope({ version: 2 }), 'format identifier or version'],
      [rawEnvelope({ reserved: 1 }), 'format identifier or version'],
      [rawEnvelope({ declaredMetadataLength: 0 }), 'metadata length'],
      [rawEnvelope({ declaredMetadataLength: 4_097 }), 'metadata length'],
      [rawEnvelope({ declaredMetadataLength: 100 }), 'metadata extends past'],
      [rawEnvelope({ metadata: new Uint8Array([0xc3, 0x28]) }), 'not valid UTF-8 JSON'],
      [rawEnvelope({ metadata: 'not-json' }), 'not valid UTF-8 JSON'],
      [rawEnvelope({ metadata: '[]' }), 'metadata must be an object'],
      [rawEnvelope({ metadata: '{"mimeType":"text/plain"}' }), 'filename'],
      [rawEnvelope({ metadata: '{"filename":"..","mimeType":"text/plain"}' }), 'relative directory'],
      [rawEnvelope({ content: encoder.encode('1234') }), 'content exceeds 3 bytes'],
      [rawEnvelope(), `dataFormat must be '${DATA_FORMAT}'`, 'text/plain'],
    ];

    for (const [blob, message, dataFormat] of cases) {
      await expect(decode(codec, blob, dataFormat)).rejects.toThrow(message);
    }

    const extended = await decode(codec, rawEnvelope({
      metadata: '{"filename":"file.txt","extra":true}',
    }));
    expect(extended.mimeType).toBe(DATA_FORMAT);

    const exact = rawEnvelope({
      content  : encoder.encode('123'),
      metadata : '{"filename":"file.txt","mimeType":"text/plain"}'.padEnd(4_096, ' '),
    });
    expect(exact.size).toBe(codec.maxEncodedBytesFor(3));
    expect(await (await decode(codec, exact)).blob.text()).toBe('123');
  });

  it('cancels an oversized fragmented stream before consuming it', async () => {
    const codec = recordCodecs.fileEnvelope({ formatId: FORMAT_ID, maxContentBytes: 3 });
    const bytes = await bytesOf(rawEnvelope({ content: new Uint8Array(5_000) }));
    const counters = { cancellations: 0, pulls: 0 };
    let offset = 0;
    const data = createRecordData(async (): Promise<ReadableStream> => new ReadableStream<Uint8Array>({
      cancel(): void {
        counters.cancellations += 1;
      },
      pull(controller): void {
        if (offset === bytes.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.subarray(offset, offset + 1));
        counters.pulls += 1;
        offset += 1;
      },
    }), DATA_FORMAT);

    await expect(codec.decode(data, DATA_FORMAT)).rejects.toThrow('content exceeds 3 bytes');
    expect(counters.cancellations).toBe(1);
    expect(counters.pulls).toBeLessThan(bytes.byteLength);
  });
});
