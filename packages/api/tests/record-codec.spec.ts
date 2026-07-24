import type { RecordData } from '../src/record-data.js';
import type { EncodedRecordData, RecordCodec } from '../src/record-codec.js';

import { describe, expect, it } from 'bun:test';

import { createRecordData } from '../src/record-data.js';
import { encodeRecordValue, recordCodecs } from '../src/record-codec.js';

function dataFor(encoded: EncodedRecordData): RecordData {
  return createRecordData(async (): Promise<ReadableStream> => encoded.data.stream(), encoded.dataFormat);
}

describe('recordCodecs', () => {
  it('round-trips JSON values', async () => {
    const codec = recordCodecs.json<{ title: string }>();
    const encoded = await encodeRecordValue(codec, { title: 'hello' }, ['application/json']);

    expect(encoded.dataFormat).toBe('application/json');
    expect(await codec.decode(dataFor(encoded), encoded.dataFormat)).toEqual({ title: 'hello' });
  });

  it('round-trips text and byte values without JSON serialization', async () => {
    const textCodec = recordCodecs.text('text/markdown');
    const encodedText = await encodeRecordValue(textCodec, '# title', ['text/markdown']);
    expect(await textCodec.decode(dataFor(encodedText), encodedText.dataFormat)).toBe('# title');

    const bytesCodec = recordCodecs.bytes();
    const value = new Uint8Array([0, 1, 255]);
    const encodedBytes = await encodeRecordValue(bytesCodec, value, ['application/octet-stream']);
    expect(await bytesCodec.decode(dataFor(encodedBytes), encodedBytes.dataFormat)).toEqual(value);
  });

  it('uses each Blob value MIME type when the codec has no fixed format', async () => {
    const codec = recordCodecs.blob();
    const value = new Blob(['image'], { type: 'image/png' });
    const encoded = await encodeRecordValue(codec, value, ['image/png', 'image/jpeg']);

    expect(encoded.data).toBe(value);
    expect(encoded.dataFormat).toBe('image/png');
    expect((await codec.decode(dataFor(encoded), encoded.dataFormat)).type).toBe('image/png');
  });

  it('rejects missing and undeclared encoded formats before dispatch', async () => {
    expect(() => recordCodecs.blob().encode(new Blob(['untyped']))).toThrow('require a MIME type');
    await expect(encodeRecordValue(recordCodecs.text(), 'value', ['text/markdown']))
      .rejects.toThrow('dataFormat \'text/plain\' is not declared');
  });

  it('supports an application-defined codec through the same boundary', async () => {
    const codec: RecordCodec<number> = {
      encode(value: number): EncodedRecordData {
        return {
          data       : new Blob([String(value)]),
          dataFormat : 'application/x-number',
        };
      },
      async decode(data, dataFormat): Promise<number> {
        expect(dataFormat).toBe('application/x-number');
        return Number(await data.text());
      },
    };

    const encoded = await encodeRecordValue(codec, 42, ['application/x-number']);
    expect(await codec.decode(dataFor(encoded), encoded.dataFormat)).toBe(42);
  });
});
