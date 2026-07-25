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

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export type ParsedHttpDwnRpcRequestBody = {
  jsonRpcRequest: JsonRpcRequest;
  dataStream?: ReadableStream<Uint8Array>;
};

/** Maximum HTTP request body needed for body-v1 framing at a record-data limit. */
export function maxHttpDwnRpcRequestBodyBytes(maxRecordDataSize: number): number {
  return BODY_V1_HEADER_BYTES + HTTP_DWN_RPC_BODY_V1_MAX_ENVELOPE_BYTES + maxRecordDataSize;
}

/** A Content-Type value split into its lower-cased media type and parameters. */
type ParsedContentType = {
  mediaType: string;
  parameters: Array<[string, string]>;
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

/**
 * Splits a Content-Type value into its lower-cased media type and parameters.
 * Parameter names are lower-cased and values are unquoted; a value that is not
 * consistently quoted is left as-is so callers reject it.
 */
function parseContentType(value: string | null): ParsedContentType | undefined {
  if (value === null) {
    return undefined;
  }

  const [mediaType, ...rest] = value.split(';').map(part => part.trim());
  const parameters = rest.map((parameter): [string, string] => {
    const separator = parameter.indexOf('=');
    if (separator === -1) {
      return [parameter.toLowerCase(), ''];
    }
    return [
      parameter.slice(0, separator).trim().toLowerCase(),
      parameter.slice(separator + 1).trim().replace(/^"(.*)"$/, '$1'),
    ];
  });

  return { mediaType: mediaType.toLowerCase(), parameters };
}

/** Returns whether a Content-Type value selects version-one DWN RPC body framing. */
export function isHttpDwnRpcBodyV1ContentType(value: string | null): boolean {
  const parsed = parseContentType(value);
  if (parsed?.mediaType !== HTTP_DWN_RPC_MEDIA_TYPE) {
    return false;
  }

  // A repeated `version` parameter is ambiguous, so require exactly one.
  const versions = parsed.parameters.filter(([name]) => name === 'version');
  return versions.length === 1 && versions[0][1] === '1';
}

/** Returns whether a Content-Type value uses the vendor DWN RPC media type, regardless of version. */
export function isHttpDwnRpcContentType(value: string | null): boolean {
  return parseContentType(value)?.mediaType === HTTP_DWN_RPC_MEDIA_TYPE;
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
    const jsonRpcRequest = JSON.parse(textDecoder.decode(envelopeBytes)) as JsonRpcRequest;

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
