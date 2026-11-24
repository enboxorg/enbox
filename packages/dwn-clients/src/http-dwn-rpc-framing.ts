import type { JsonRpcRequest, JsonRpcResponse } from './json-rpc.js';

import { createHttpDwnRpcRequestHeaders } from './http-dwn-rpc-headers.js';

/** Vendor media type used for DWN JSON-RPC HTTP body framing. */
export const HTTP_DWN_RPC_MEDIA_TYPE = 'application/vnd.enbox.dwn-rpc';

/** Maximum JSON-RPC request envelope size accepted by HTTP DWN RPC body framing. */
export const HTTP_DWN_RPC_MAX_ENVELOPE_BYTES = 1_048_576;

/**
 * Maximum JSON-RPC response envelope size accepted by HTTP DWN RPC body framing.
 * A response envelope can carry both the latest and the initial write of a
 * record, so it is allowed to be larger than a request envelope.
 */
export const HTTP_DWN_RPC_MAX_RESPONSE_ENVELOPE_BYTES = 16_777_216;

const FRAME_DATA_FOLLOWS_FLAG = 0x01;
const FRAME_HEADER_BYTES = 5;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export type ParsedHttpDwnRpcRequestBody = {
  jsonRpcRequest: JsonRpcRequest;
  dataStream?: ReadableStream<Uint8Array>;
};

export type ParsedHttpDwnRpcResponseBody = {
  jsonRpcResponse: JsonRpcResponse;
  dataStream?: ReadableStream<Uint8Array>;
};

type ParsedFramedBody = {
  envelope: unknown;
  dataStream?: ReadableStream<Uint8Array>;
};

/** The body and headers of an HTTP DWN RPC request. */
export type HttpDwnRpcRequest = {
  body: BodyInit;
  headers: Record<string, string>;
};

/**
 * Creates the framed body and the headers of an HTTP DWN RPC request:
 * `content-type` plus the `dwn-*` projections of the envelope. The envelope is
 * serialized once, so the headers project exactly the JSON that the body carries.
 */
export async function createHttpDwnRpcRequest(
  jsonRpcRequest: JsonRpcRequest,
  data?: BodyInit,
): Promise<HttpDwnRpcRequest> {
  const envelopeJson = JSON.stringify(jsonRpcRequest);
  const envelopeBytes = encodeEnvelope(envelopeJson, HTTP_DWN_RPC_MAX_ENVELOPE_BYTES);
  const projectedHeaders = await createHttpDwnRpcRequestHeaders(envelopeJson, data !== undefined);

  return {
    body    : createFramedBody(envelopeBytes, data),
    headers : { 'content-type': HTTP_DWN_RPC_MEDIA_TYPE, ...projectedHeaders },
  };
}

/**
 * Frames a JSON-RPC request and optional raw record data in one HTTP request body.
 *
 * The first byte contains flags, the next four bytes contain the unsigned
 * big-endian JSON envelope length, and the remaining bytes contain the UTF-8
 * JSON envelope followed by the optional raw data stream.
 *
 * Returns a `ReadableStream` exactly when the body is one-shot, so callers can
 * derive both `duplex` and replayability from the returned body's type.
 */
export function createHttpDwnRpcRequestBody(
  jsonRpcRequest: JsonRpcRequest,
  data?: BodyInit,
): BodyInit {
  return createFramedBody(encodeEnvelope(JSON.stringify(jsonRpcRequest), HTTP_DWN_RPC_MAX_ENVELOPE_BYTES), data);
}

/**
 * Frames a JSON-RPC response and the raw record data it carries in one HTTP
 * response body, using the same layout as {@link createHttpDwnRpcRequestBody}.
 */
export function createHttpDwnRpcResponseBody(
  jsonRpcResponse: JsonRpcResponse,
  data: BodyInit,
): BodyInit {
  return createFramedBody(encodeEnvelope(JSON.stringify(jsonRpcResponse), HTTP_DWN_RPC_MAX_RESPONSE_ENVELOPE_BYTES), data);
}

/** Returns whether a Content-Type header selects DWN RPC body framing. */
export function isHttpDwnRpcContentType(value: string | null): boolean {
  // Media type parameters are not part of the protocol, so any `;` is rejected.
  if (value === null || value.includes(';')) {
    return false;
  }

  return value === HTTP_DWN_RPC_MEDIA_TYPE || value.trim().toLowerCase() === HTTP_DWN_RPC_MEDIA_TYPE;
}

/**
 * Parses a streaming DWN RPC request body without buffering its raw record data.
 */
export async function parseHttpDwnRpcRequestBody(
  body: ReadableStream<Uint8Array>,
): Promise<ParsedHttpDwnRpcRequestBody> {
  const { envelope, dataStream } = await parseFramedBody(body, HTTP_DWN_RPC_MAX_ENVELOPE_BYTES);
  return { jsonRpcRequest: envelope as JsonRpcRequest, dataStream };
}

/**
 * Parses a streaming DWN RPC response body without buffering its raw record data.
 */
export async function parseHttpDwnRpcResponseBody(
  body: ReadableStream<Uint8Array>,
): Promise<ParsedHttpDwnRpcResponseBody> {
  const { envelope, dataStream } = await parseFramedBody(body, HTTP_DWN_RPC_MAX_RESPONSE_ENVELOPE_BYTES);
  return { jsonRpcResponse: envelope as JsonRpcResponse, dataStream };
}

function envelopeTooLargeMessage(maxEnvelopeBytes: number): string {
  return `HTTP DWN RPC envelope exceeds the ${maxEnvelopeBytes}-byte limit`;
}

function encodeEnvelope(envelopeJson: string, maxEnvelopeBytes: number): Uint8Array {
  const envelopeBytes = textEncoder.encode(envelopeJson);
  if (envelopeBytes.byteLength > maxEnvelopeBytes) {
    throw new Error(envelopeTooLargeMessage(maxEnvelopeBytes));
  }

  return envelopeBytes;
}

function createFramedBody(envelopeBytes: Uint8Array, data?: BodyInit): BodyInit {
  const prefix = new Uint8Array(FRAME_HEADER_BYTES + envelopeBytes.byteLength);
  prefix[0] = data === undefined ? 0 : FRAME_DATA_FOLLOWS_FLAG;
  new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).setUint32(1, envelopeBytes.byteLength, false);
  prefix.set(envelopeBytes, FRAME_HEADER_BYTES);

  if (data instanceof ReadableStream) {
    return readerToStream((data as ReadableStream<Uint8Array>).getReader(), prefix);
  }

  if (data !== undefined && !isReplayableBlobPart(data)) {
    const dataStream = new Response(data).body;
    if (dataStream === null) {
      throw new Error('HTTP DWN RPC record data could not be converted to a byte stream');
    }
    return readerToStream(dataStream.getReader(), prefix);
  }

  return new Blob(data === undefined ? [prefix] : [prefix, data]);
}

function isReplayableBlobPart(data: BodyInit): data is BlobPart {
  return typeof data === 'string' ||
    data instanceof Blob ||
    data instanceof ArrayBuffer ||
    ArrayBuffer.isView(data);
}

async function parseFramedBody(
  body: ReadableStream<Uint8Array>,
  maxEnvelopeBytes: number,
): Promise<ParsedFramedBody> {
  const reader = body.getReader();
  let remainder: Uint8Array | undefined;

  const readExactly = async (length: number): Promise<Uint8Array> => {
    const result = new Uint8Array(length);
    let offset = 0;

    while (offset < length) {
      if (remainder === undefined || remainder.byteLength === 0) {
        const next = await reader.read();
        if (next.done) {
          throw new Error('HTTP DWN RPC body ended before its framed envelope was complete');
        }
        remainder = next.value;
        if (remainder.byteLength === 0) {
          continue;
        }
      }

      const bytesToCopy = Math.min(length - offset, remainder.byteLength);
      result.set(remainder.subarray(0, bytesToCopy), offset);
      offset += bytesToCopy;
      remainder = bytesToCopy === remainder.byteLength
        ? undefined
        : remainder.subarray(bytesToCopy);
    }

    return result;
  };

  try {
    const header = await readExactly(FRAME_HEADER_BYTES);
    const flags = header[0];
    if ((flags & ~FRAME_DATA_FOLLOWS_FLAG) !== 0) {
      throw new Error(`HTTP DWN RPC body contains unsupported flags: ${flags}`);
    }

    const envelopeLength = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(1, false);
    if (envelopeLength > maxEnvelopeBytes) {
      throw new Error(envelopeTooLargeMessage(maxEnvelopeBytes));
    }

    const envelopeBytes = await readExactly(envelopeLength);
    const envelope: unknown = JSON.parse(textDecoder.decode(envelopeBytes));
    if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
      throw new Error('HTTP DWN RPC envelope is not a JSON object');
    }

    if ((flags & FRAME_DATA_FOLLOWS_FLAG) === 0) {
      if (remainder !== undefined && remainder.byteLength > 0) {
        throw new Error('HTTP DWN RPC body contains data without the data-follows flag');
      }

      // The flag is authoritative. Do not wait for EOF: a slow peer could
      // otherwise hold processing open by never finishing a trailing chunked
      // body. Stop reading as soon as the envelope is complete.
      void reader.cancel().catch((): void => {
        // The envelope is already parsed; cancellation is best-effort.
      });
      reader.releaseLock();
      return { envelope };
    }

    return {
      envelope,
      dataStream: readerToStream(reader, remainder),
    };
  } catch (error) {
    await reader.cancel().catch((): void => {
      // Parsing already failed; cancellation is best-effort.
    });
    reader.releaseLock();
    throw error;
  }
}

/**
 * Adapts a reader back into a stream, optionally emitting `prefix` ahead of the
 * reader's remaining bytes. Cancellation and its reason propagate to the
 * underlying source, and the reader's lock is released exactly once.
 */
function readerToStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  prefix?: Uint8Array,
): ReadableStream<Uint8Array> {
  let released = false;

  const releaseReader = (): void => {
    if (!released) {
      released = true;
      reader.releaseLock();
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller): void {
      if (prefix !== undefined && prefix.byteLength > 0) {
        controller.enqueue(prefix);
      }
    },
    async pull(controller): Promise<void> {
      try {
        const next = await reader.read();
        if (next.done) {
          releaseReader();
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        releaseReader();
        controller.error(error);
      }
    },
    async cancel(reason): Promise<void> {
      try {
        await reader.cancel(reason);
      } finally {
        releaseReader();
      }
    },
  });
}
