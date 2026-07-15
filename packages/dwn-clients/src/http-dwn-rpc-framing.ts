import type { JsonRpcRequest } from './json-rpc.js';

/** Capability advertised by servers that accept DWN JSON-RPC envelopes in the HTTP request body. */
export const HTTP_DWN_RPC_BODY_V1 = 'body-v1' as const;

/** Vendor media type used for versioned DWN JSON-RPC HTTP body framing. */
export const HTTP_DWN_RPC_MEDIA_TYPE = 'application/vnd.enbox.dwn-rpc';

/** Media type used by the version-one streaming HTTP request body. */
export const HTTP_DWN_RPC_BODY_V1_CONTENT_TYPE = `${HTTP_DWN_RPC_MEDIA_TYPE}; version=1`;

/** Maximum JSON-RPC envelope size accepted by the version-one body framing. */
export const HTTP_DWN_RPC_BODY_V1_MAX_ENVELOPE_BYTES = 1_048_576;

const BODY_V1_DATA_FOLLOWS_FLAG = 0x01;
const BODY_V1_HEADER_BYTES = 5;

export type HttpDwnRpcRequestBody = {
  body: BodyInit;
  replayable: boolean;
};

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
 */
export function createHttpDwnRpcRequestBody(
  jsonRpcRequest: JsonRpcRequest,
  data?: BodyInit,
): HttpDwnRpcRequestBody {
  const envelopeBytes = new TextEncoder().encode(JSON.stringify(jsonRpcRequest));
  if (envelopeBytes.byteLength > HTTP_DWN_RPC_BODY_V1_MAX_ENVELOPE_BYTES) {
    throw new Error(
      `HTTP DWN RPC envelope exceeds the ${HTTP_DWN_RPC_BODY_V1_MAX_ENVELOPE_BYTES}-byte body-v1 limit`,
    );
  }

  const prefix = new Uint8Array(BODY_V1_HEADER_BYTES + envelopeBytes.byteLength);
  prefix[0] = data === undefined ? 0 : BODY_V1_DATA_FOLLOWS_FLAG;
  new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).setUint32(1, envelopeBytes.byteLength, false);
  prefix.set(envelopeBytes, BODY_V1_HEADER_BYTES);

  if (data instanceof ReadableStream) {
    return {
      body       : prependBytesToStream(prefix, data as ReadableStream<Uint8Array>),
      replayable : false,
    };
  }

  if (data !== undefined && !isReplayableBlobPart(data)) {
    const dataStream = new Response(data).body;
    if (dataStream === null) {
      throw new Error('HTTP DWN RPC record data could not be converted to a byte stream');
    }
    return {
      body       : prependBytesToStream(prefix, dataStream),
      replayable : false,
    };
  }

  const parts: BlobPart[] = data === undefined ? [prefix] : [prefix, data];
  return {
    body       : new Blob(parts),
    replayable : true,
  };
}

function isReplayableBlobPart(data: BodyInit): data is BlobPart {
  return typeof data === 'string' ||
    data instanceof Blob ||
    data instanceof ArrayBuffer ||
    ArrayBuffer.isView(data);
}

/** Returns whether a Content-Type value selects version-one DWN RPC body framing. */
export function isHttpDwnRpcBodyV1ContentType(value: string | null): boolean {
  if (!isHttpDwnRpcContentType(value)) {
    return false;
  }

  const [, ...parameters] = value!.split(';').map(part => part.trim());
  const versions = parameters.filter(parameter => {
    const separator = parameter.indexOf('=');
    const name = separator === -1 ? parameter : parameter.slice(0, separator);
    return name.trim().toLowerCase() === 'version';
  });

  return versions.length === 1 && /^version\s*=\s*(?:1|"1")$/i.test(versions[0]);
}

/** Returns whether a Content-Type value uses the vendor DWN RPC media type, regardless of version. */
export function isHttpDwnRpcContentType(value: string | null): boolean {
  if (value === null) {
    return false;
  }

  const [mediaType] = value.split(';').map(part => part.trim());
  return mediaType.toLowerCase() === HTTP_DWN_RPC_MEDIA_TYPE;
}

/**
 * Parses a version-one streaming DWN RPC request body without buffering its raw record data.
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
    const header = await readExactly(BODY_V1_HEADER_BYTES);
    const flags = header[0];
    if ((flags & ~BODY_V1_DATA_FOLLOWS_FLAG) !== 0) {
      throw new Error(`HTTP DWN RPC body contains unsupported flags: ${flags}`);
    }

    const envelopeLength = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(1, false);
    if (envelopeLength > HTTP_DWN_RPC_BODY_V1_MAX_ENVELOPE_BYTES) {
      throw new Error(
        `HTTP DWN RPC envelope exceeds the ${HTTP_DWN_RPC_BODY_V1_MAX_ENVELOPE_BYTES}-byte body-v1 limit`,
      );
    }

    const envelopeBytes = await readExactly(envelopeLength);
    const envelopeJson = new TextDecoder('utf-8', { fatal: true }).decode(envelopeBytes);
    const jsonRpcRequest = JSON.parse(envelopeJson) as JsonRpcRequest;

    if ((flags & BODY_V1_DATA_FOLLOWS_FLAG) === 0) {
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
      dataStream: streamReaderRemainder(reader, remainder),
    };
  } catch (error) {
    await reader.cancel().catch((): void => {
      // Parsing already failed; cancellation is best-effort.
    });
    reader.releaseLock();
    throw error;
  }
}

function prependBytesToStream(
  prefix: Uint8Array,
  stream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let released = false;

  const releaseReader = (): void => {
    if (!released) {
      released = true;
      reader.releaseLock();
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(prefix);
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

function streamReaderRemainder(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  initialRemainder: Uint8Array | undefined,
): ReadableStream<Uint8Array> {
  let remainder = initialRemainder;
  let released = false;

  const releaseReader = (): void => {
    if (!released) {
      released = true;
      reader.releaseLock();
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      if (remainder !== undefined && remainder.byteLength > 0) {
        controller.enqueue(remainder);
        remainder = undefined;
        return;
      }

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
