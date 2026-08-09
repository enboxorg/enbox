import type { FileEnvelopeCodec, FileEnvelopeData } from '../src/index.js';

import { describe, expect, it } from 'bun:test';

import { recordCodecs } from '../src/index.js';

const DATA_FORMAT = 'application/octet-stream';

function fileCodec(): FileEnvelopeCodec {
  return recordCodecs.fileEnvelope({
    formatId: 'photos',
  });
}

function value(): FileEnvelopeData {
  return {
    filename : 'photo.png',
    mimeType : 'Image/PNG; charset=binary',
    blob     : new Blob([new Uint8Array([0, 1, 2, 3]) as BlobPart]),
  };
}

async function expectFile(decoded: FileEnvelopeData): Promise<void> {
  expect(decoded.filename).toBe('photo.png');
  expect(decoded.mimeType).toBe('image/png');
  expect(new Uint8Array(await decoded.blob.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 3]));
}

describe('@enbox/browser file-envelope codec', () => {
  it('round-trips with browser Blob and ReadableStream primitives', async () => {
    const codec = fileCodec();
    const encoded = codec.encode(value());

    expect(encoded.dataFormat).toBe(DATA_FORMAT);
    await expectFile(await codec.decode({
      stream: async (): Promise<ReadableStream> => encoded.data.stream(),
    } as never, encoded.dataFormat));
  });

  it('decodes a byte-fragmented browser stream', async () => {
    const codec = fileCodec();
    const encoded = codec.encode(value());
    const bytes = new Uint8Array(await encoded.data.arrayBuffer());
    let offset = 0;

    await expectFile(await codec.decode({
      stream: async (): Promise<ReadableStream> => new ReadableStream<Uint8Array>({
        pull(controller): void {
          if (offset === bytes.byteLength) {
            controller.close();
            return;
          }
          controller.enqueue(bytes.subarray(offset, offset + 1));
          offset += 1;
        },
      }),
    } as never, encoded.dataFormat));
  });
});
