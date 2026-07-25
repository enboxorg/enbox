import type { JsonRpcRequest } from '../src/json-rpc.js';

import { createJsonRpcRequest } from '../src/json-rpc.js';
import { DataStream } from '@enbox/dwn-sdk-js';

import {
  createHttpDwnRpcRequestBody,
  HTTP_DWN_RPC_BODY_V1_CONTENT_TYPE,
  HTTP_DWN_RPC_BODY_V1_MAX_ENVELOPE_BYTES,
  isHttpDwnRpcBodyV1ContentType,
  isHttpDwnRpcContentType,
  maxHttpDwnRpcRequestBodyBytes,
  parseHttpDwnRpcRequestBody,
} from '../src/http-dwn-rpc-framing.js';
import { describe, expect, it } from 'bun:test';

describe('HTTP DWN RPC request body framing', () => {
  it('should include framing overhead in the maximum request body size', () => {
    expect(maxHttpDwnRpcRequestBodyBytes(123)).toBe(HTTP_DWN_RPC_BODY_V1_MAX_ENVELOPE_BYTES + 5 + 123);
  });

  it('should round-trip a JSON-RPC request without record data', async () => {
    const request = testJsonRpcRequest();
    const body = createHttpDwnRpcRequestBody(request);

    expect(body).toBeInstanceOf(Blob);
    const parsed = await parseHttpDwnRpcRequestBody(bodyStream(body));
    expect(parsed.jsonRpcRequest).toEqual(request);
    expect(parsed.dataStream).toBeUndefined();
  });

  it('should preserve replayable record data as raw bytes', async () => {
    const request = testJsonRpcRequest();
    const data = new Uint8Array([0, 1, 2, 127, 128, 255]);
    const body = createHttpDwnRpcRequestBody(request, data);

    expect(body).toBeInstanceOf(Blob);
    const parsed = await parseHttpDwnRpcRequestBody(bodyStream(body));
    expect(parsed.jsonRpcRequest).toEqual(request);
    expect(await DataStream.toBytes(parsed.dataStream!)).toEqual(data);
  });

  it('should stream ReadableStream record data without marking the request replayable', async () => {
    const request = testJsonRpcRequest();
    const data = new Uint8Array([3, 5, 8, 13]);
    const body = createHttpDwnRpcRequestBody(request, DataStream.fromAsyncIterable([data.subarray(0, 2), data.subarray(2)]));

    expect(body).toBeInstanceOf(ReadableStream);
    const parsed = await parseHttpDwnRpcRequestBody(body as ReadableStream<Uint8Array>);
    expect(parsed.jsonRpcRequest).toEqual(request);
    expect(await DataStream.toBytes(parsed.dataStream!)).toEqual(data);
  });

  it('should stream BodyInit values that cannot be safely replayed as Blob parts', async () => {
    const request = testJsonRpcRequest();
    const data = new URLSearchParams({ alpha: 'one', beta: 'two words' });
    const body = createHttpDwnRpcRequestBody(request, data);

    expect(body).toBeInstanceOf(ReadableStream);
    const parsed = await parseHttpDwnRpcRequestBody(body as ReadableStream<Uint8Array>);
    expect(new TextDecoder().decode(await DataStream.toBytes(parsed.dataStream!))).toBe(data.toString());
  });

  it('should parse a framing prefix and envelope split across arbitrary chunks', async () => {
    const request = testJsonRpcRequest();
    const data = new Uint8Array([21, 34]);
    const body = createHttpDwnRpcRequestBody(request, data);
    const bytes = await bodyBytes(body);
    const oneByteChunks = Array.from(bytes, byte => new Uint8Array([byte]));

    const parsed = await parseHttpDwnRpcRequestBody(DataStream.fromAsyncIterable(oneByteChunks));
    expect(parsed.jsonRpcRequest).toEqual(request);
    expect(await DataStream.toBytes(parsed.dataStream!)).toEqual(data);
  });

  it('should reject an envelope larger than the body-v1 limit before framing', () => {
    const request = createJsonRpcRequest('request-id', 'test.method', {
      value: 'x'.repeat(HTTP_DWN_RPC_BODY_V1_MAX_ENVELOPE_BYTES),
    });

    expect(() => createHttpDwnRpcRequestBody(request)).toThrow('body-v1 limit');
  });

  it('should reject malformed, unsupported, and truncated frames', async () => {
    const oversizedLength = new Uint8Array([0, 0, 16, 0, 1]);
    await expect(parseHttpDwnRpcRequestBody(DataStream.fromAsyncIterable([oversizedLength]))).rejects.toThrow('body-v1 limit');

    const unsupportedFlags = new Uint8Array([2, 0, 0, 0, 0]);
    await expect(parseHttpDwnRpcRequestBody(DataStream.fromAsyncIterable([unsupportedFlags]))).rejects.toThrow('unsupported flags');

    const truncatedEnvelope = new Uint8Array([0, 0, 0, 0, 4, 123]);
    await expect(parseHttpDwnRpcRequestBody(DataStream.fromAsyncIterable([truncatedEnvelope]))).rejects.toThrow('ended before');
  });

  it('should reject raw data when the data-follows flag is absent', async () => {
    const body = createHttpDwnRpcRequestBody(testJsonRpcRequest());
    const bytes = await bodyBytes(body);
    const withUnexpectedData = new Uint8Array(bytes.byteLength + 1);
    withUnexpectedData.set(bytes);
    withUnexpectedData[bytes.byteLength] = 42;

    await expect(parseHttpDwnRpcRequestBody(DataStream.fromAsyncIterable([withUnexpectedData]))).rejects.toThrow('data-follows flag');
  });

  it('should not wait for EOF after a no-data envelope', async () => {
    const body = createHttpDwnRpcRequestBody(testJsonRpcRequest());
    const bytes = await bodyBytes(body);
    let cancelled = false;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const neverEndingBody = new ReadableStream<Uint8Array>({
      start(streamController): void {
        controller = streamController;
        streamController.enqueue(bytes);
      },
      cancel(): void {
        cancelled = true;
      },
    });

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const parsed = await Promise.race([
        parseHttpDwnRpcRequestBody(neverEndingBody),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('parser waited for request EOF')), 250);
        }),
      ]);
      expect(parsed.jsonRpcRequest).toEqual(testJsonRpcRequest());
      expect(cancelled).toBe(true);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      if (!cancelled) {
        controller.close();
      }
    }
  });

  it('should propagate parsed data stream cancellation to the underlying request body', async () => {
    const body = createHttpDwnRpcRequestBody(testJsonRpcRequest(), new Uint8Array([1, 2, 3]));
    const bytes = await bodyBytes(body);
    let cancellationReason: unknown;
    const requestBody = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(bytes);
      },
      cancel(reason): void {
        cancellationReason = reason;
      },
    });

    const parsed = await parseHttpDwnRpcRequestBody(requestBody);
    await parsed.dataStream!.cancel('no longer needed');
    expect(cancellationReason).toBe('no longer needed');
  });

  it('should identify the version-one media type without accepting other versions', () => {
    expect(isHttpDwnRpcBodyV1ContentType(HTTP_DWN_RPC_BODY_V1_CONTENT_TYPE)).toBe(true);
    expect(isHttpDwnRpcBodyV1ContentType('Application/Vnd.Enbox.Dwn-Rpc; charset=utf-8; VERSION="1"')).toBe(true);
    expect(isHttpDwnRpcBodyV1ContentType('application/vnd.enbox.dwn-rpc; version=2')).toBe(false);
    expect(isHttpDwnRpcBodyV1ContentType('application/vnd.enbox.dwn-rpc; version="1')).toBe(false);
    expect(isHttpDwnRpcBodyV1ContentType('application/vnd.enbox.dwn-rpc; version=1"')).toBe(false);
    expect(isHttpDwnRpcBodyV1ContentType('application/vnd.enbox.dwn-rpc; version=1=garbage')).toBe(false);
    expect(isHttpDwnRpcContentType('application/vnd.enbox.dwn-rpc; version=2')).toBe(true);
    expect(isHttpDwnRpcBodyV1ContentType('application/octet-stream')).toBe(false);
    expect(isHttpDwnRpcContentType('application/octet-stream')).toBe(false);
    expect(isHttpDwnRpcBodyV1ContentType(null)).toBe(false);
    expect(isHttpDwnRpcContentType(null)).toBe(false);
  });
});

function bodyStream(body: BodyInit): ReadableStream<Uint8Array> {
  return new Response(body).body!;
}

async function bodyBytes(body: BodyInit): Promise<Uint8Array> {
  return DataStream.toBytes(bodyStream(body));
}

function testJsonRpcRequest(): JsonRpcRequest {
  return createJsonRpcRequest('request-id', 'dwn.applyReplicatedMessage', {
    message : { descriptor: { interface: 'Records', method: 'Write' } },
    target  : 'did:example:alice',
  });
}
