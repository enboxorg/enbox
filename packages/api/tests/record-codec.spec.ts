import type { RecordData } from '../src/record-data.js';
import type {
  EncodedRecordData,
  RecordCodec,
  RecordValidationFailure,
  RecordValidator,
} from '../src/record-codec.js';

import { describe, expect, it } from 'bun:test';

import { createRecordData } from '../src/record-data.js';
import { encodeRecordValue, recordCodecs, RecordValidationError } from '../src/record-codec.js';

function dataFor(encoded: EncodedRecordData): RecordData {
  return createRecordData(async (): Promise<ReadableStream> => encoded.data.stream(), encoded.dataFormat);
}

function titleValidator(onValue?: (value: unknown) => void): RecordValidator {
  const failure: RecordValidationFailure = {
    instancePath : '/title',
    keyword      : 'type',
    message      : 'must be string',
    params       : { type: 'string' },
  };
  const validator = ((value: unknown): boolean => {
    onValue?.(value);
    const valid = typeof (value as { title?: unknown } | null)?.title === 'string';
    validator.errors = valid ? null : [failure];
    return valid;
  }) as ((value: unknown) => boolean) & { errors: readonly RecordValidationFailure[] | null };
  validator.errors = null;
  return validator;
}

describe('recordCodecs', () => {
  it('round-trips JSON values', async () => {
    const codec = recordCodecs.json<{ title: string }>();
    const encoded = await encodeRecordValue(codec, { title: 'hello' }, ['application/json']);

    expect(encoded.dataFormat).toBe('application/json');
    expect(await codec.decode(dataFor(encoded), encoded.dataFormat)).toEqual({ title: 'hello' });
  });

  it('round-trips JSON through a standalone validator and custom MIME type', async () => {
    const codec = recordCodecs.json<{ title: string }>({
      dataFormat : 'application/merge-patch+json',
      validator  : titleValidator(),
    });
    const encoded = await encodeRecordValue(codec, { title: 'hello' });

    expect(encoded.dataFormat).toBe('application/merge-patch+json');
    expect(await codec.decode(dataFor(encoded), encoded.dataFormat)).toEqual({ title: 'hello' });
  });

  it('validates the serialized JSON value and reports structured failures', async () => {
    let validatedValue: unknown;
    const validator = titleValidator((value): void => { validatedValue = value; });
    const codec = recordCodecs.json<{ title: string }>({ validator });
    const input = {
      title  : 'valid before serialization',
      toJSON : (): { title: number } => ({ title: 42 }),
    };

    const thrown = await encodeRecordValue(codec, input, undefined, {
      protocolPath : 'notebook/page',
      recordId     : 'page-1',
      schema       : 'https://example.com/schemas/page',
    }).catch((error: unknown): unknown => error);

    expect(validatedValue).toEqual({ title: 42 });
    expect(thrown).toBeInstanceOf(RecordValidationError);
    const error = thrown as RecordValidationError;
    expect(error.protocolPath).toBe('notebook/page');
    expect(error.recordId).toBe('page-1');
    expect(error.schema).toBe('https://example.com/schemas/page');
    expect(error.failures).toEqual([{
      instancePath : '/title',
      keyword      : 'type',
      message      : 'must be string',
      params       : { type: 'string' },
    }]);
  });

  it('rejects asynchronous validators instead of treating their promises as success', async () => {
    const validator = (async (): Promise<boolean> => {
      throw new Error('async validator rejection');
    }) as unknown as RecordValidator;
    const codec = recordCodecs.json<{ title: string }>({ validator });

    await expect(encodeRecordValue(codec, { title: 'hello' }))
      .rejects.toThrow('validator must be synchronous');
  });

  it('reports an empty failure list when a rejecting validator provides no diagnostics', async () => {
    const codec = recordCodecs.json<{ title: string }>({
      validator: (() => false) as RecordValidator,
    });

    const thrown = await encodeRecordValue(codec, { title: 'hello' })
      .catch((error: unknown): unknown => error);

    expect(thrown).toBeInstanceOf(RecordValidationError);
    expect((thrown as RecordValidationError).failures).toEqual([]);
    expect((thrown as RecordValidationError).message).toBe('Record data failed JSON Schema validation.');
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
