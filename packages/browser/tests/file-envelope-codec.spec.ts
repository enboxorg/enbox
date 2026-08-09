import { describe, expect, it } from 'bun:test';

import { recordCodecs } from '../src/index.js';

describe('@enbox/browser file-envelope codec', () => {
  it('round-trips a byte-fragmented native browser stream', async () => {
    const codec = recordCodecs.fileEnvelope({ formatId: 'photos' });
    const encoded = codec.encode({
      filename : 'photo.png',
      mimeType : 'Image/PNG; charset=binary',
      blob     : new Blob([new Uint8Array([0, 1, 2, 3]) as BlobPart]),
    });
    const bytes = new Uint8Array(await encoded.data.arrayBuffer());

    const decoded = await codec.decode({
      stream: async (): Promise<ReadableStream> => new ReadableStream<Uint8Array>({
        start(controller): void {
          for (let offset = 0; offset < bytes.byteLength; offset += 1) {
            controller.enqueue(bytes.subarray(offset, offset + 1));
          }
          controller.close();
        },
      }),
    } as never, encoded.dataFormat);

    expect(encoded.dataFormat).toBe('application/octet-stream');
    expect(decoded.filename).toBe('photo.png');
    expect(decoded.mimeType).toBe('image/png');
    expect(decoded.blob.type).toBe('image/png');
    expect(new Uint8Array(await decoded.blob.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 3]));
  });
});
