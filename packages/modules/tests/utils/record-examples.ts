import type { ModuleRecordExample } from '../../src/catalog-types.js';
import type { FileEnvelopeData, RecordData } from '@enbox/api';

import { expect } from 'bun:test';

/** Real Blob/stream access with the same consumption contract as record.data. */
export function recordData(blob: Blob): RecordData {
  const stream = async (): Promise<ReadableStream> => blob.stream();
  return {
    stream,
    blob  : async (): Promise<Blob> => blob,
    bytes : async (): Promise<Uint8Array> => new Uint8Array(await blob.arrayBuffer()),
    json  : async (): Promise<unknown> => JSON.parse(await blob.text()),
    text  : async (): Promise<string> => blob.text(),
    then  : (onFulfilled, onRejected): Promise<ReadableStream> => stream().then(onFulfilled, onRejected),
    catch : (onRejected): Promise<ReadableStream> => stream().catch(onRejected),
  };
}

export function exampleValue(example: ModuleRecordExample): unknown {
  if (example.encoding === 'json') {
    return structuredClone(example.data);
  }
  if (example.encoding === 'file-envelope') {
    const value = example.data as { filename: string; mimeType: string; contentBase64: string };
    return { filename: value.filename, mimeType: value.mimeType, blob: new Blob([Buffer.from(value.contentBase64, 'base64')]) };
  }
  const bytes = Uint8Array.from(Buffer.from(example.data as string, 'base64'));
  return example.dataFormat === undefined ? bytes : new Blob([bytes], { type: example.dataFormat });
}

export async function expectExample(actual: unknown, expected: unknown, example: ModuleRecordExample): Promise<void> {
  if (example.encoding === 'file-envelope') {
    const value = actual as FileEnvelopeData;
    const input = expected as FileEnvelopeData;
    expect(value.filename).toBe(input.filename);
    expect(value.mimeType).toBe(input.mimeType);
    expect(await value.blob.bytes()).toEqual(await input.blob.bytes());
  } else if (actual instanceof Blob && expected instanceof Blob) {
    expect(actual.type).toBe(expected.type);
    expect(await actual.bytes()).toEqual(await expected.bytes());
  } else {
    expect(actual).toEqual(expected);
  }
}
