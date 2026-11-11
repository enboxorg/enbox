import type { JsonRpcRequest } from './json-rpc.js';

/** Vendor media type used for DWN JSON-RPC HTTP body framing. */
export const HTTP_DWN_RPC_MEDIA_TYPE = 'application/vnd.enbox.dwn-rpc';

/** Maximum JSON-RPC envelope size accepted by HTTP DWN RPC body framing. */
export const HTTP_DWN_RPC_MAX_ENVELOPE_BYTES = 1_048_576;

const FRAME_DATA_FOLLOWS_FLAG = 0x01;
const FRAME_HEADER_BYTES = 5;
const ENVELOPE_TOO_LARGE_MESSAGE = `HTTP DWN RPC envelope exceeds the ${HTTP_DWN_RPC_MAX_ENVELOPE_BYTES}-byte limit`;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export type ParsedHttpDwnRpcRequestBody = {
  jsonRpcRequest: JsonRpcRequest;
  dataStream?: ReadableStream<Uint8Array>;
};

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
  const envelopeBytes = textEncoder.encode(JSON.stringify(jsonRpcRequest));
  if (envelopeBytes.byteLength > HTTP_DWN_RPC_MAX_ENVELOPE_BYTES) {
    throw new Error(ENVELOPE_TOO_LARGE_MESSAGE);
  }

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

/** Returns whether a Content-Type header selects DWN RPC body framing. */
export function isHttpDwnRpcContentType(value: string | null): boolean {
  if (value === null) {
    return false;
  }

  // Media type parameters are not part of the protocol, so any `;` is rejected.
  const [mediaType, ...parameters] = value.split(';');
  return parameters.length === 0 && mediaType.trim().toLowerCase() === HTTP_DWN_RPC_MEDIA_TYPE;
}

/**
 * Parses a streaming DWN RPC request body without buffering its raw record data.
 */
export async function parseHttpDwnRpcRequestBody(
  body: ReadableStream<Uint8Array>,
): Promise<ParsedHttpDwnRpcRequestBody> {
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
    if (envelopeLength > HTTP_DWN_RPC_MAX_ENVELOPE_BYTES) {
      throw new Error(ENVELOPE_TOO_LARGE_MESSAGE);
    }

    const envelopeBytes = await readExactly(envelopeLength);
    const jsonRpcRequest = JSON.parse(textDecoder.decode(envelopeBytes)) as JsonRpcRequest;

    if ((flags & FRAME_DATA_FOLLOWS_FLAG) === 0) {
      if (remainder !== undefined && remainder.byteLength > 0) {
        throw new Error('HTTP DWN RPC body contains data without the data-follows flag');
      }

      // The flag is authoritative. Do not wait for EOF: a slow client could
      // otherwise hold request processing open by never finishing a trailing
      // chunked body. Stop reading as soon as the envelope is complete.
      void reader.cancel().catch((): void => {
        // The envelope is already parsed; cancellation is best-effort.
      });
      reader.releaseLock();
      return { jsonRpcRequest };
    }

    return {
      jsonRpcRequest,
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
