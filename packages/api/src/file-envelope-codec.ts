import type { RecordData } from './record-data.js';
import type { EncodedRecordData, RecordCodec } from './record-codec.js';

/** One private file payload carried inside a protocol record. */
export type FileEnvelopeData = Readonly<{
  /** Safe basename used when presenting or downloading the file. */
  filename: string;

  /** Canonicalized, untrusted media type stored inside the envelope. */
  mimeType: string;

  /** File content without the envelope metadata. */
  blob: Blob;
}>;

/** Configuration for one versioned private-file representation. */
export type FileEnvelopeCodecOptions = Readonly<{
  /** Exactly six ASCII bytes identifying the application format. */
  formatId: string;

  /** Maximum accepted file-content size in bytes. */
  maxContentBytes: number;
}>;

/** A file codec with the exact bounds needed by a protocol `$size` rule. */
export type FileEnvelopeCodec = RecordCodec<FileEnvelopeData> & Readonly<{
  maxContentBytes: number;
  maxEncodedBytes: number;
}>;

type FileEnvelopeMetadata = Readonly<{
  filename: string;
  mimeType: string;
}>;

type ContentBlocks = {
  blocks: Uint8Array[];
  pending: Uint8Array | undefined;
  pendingBytes: number;
};

const CONTENT_BLOCK_BYTES = 64 * 1_024;
const DATA_FORMAT = 'application/octet-stream';
const FILENAME_MAX_BYTES = 1_024;
const FORMAT_ID_BYTES = 6;
const METADATA_MAX_BYTES = 4_096;
const MIME_TYPE_MAX_BYTES = 255;
const PREFIX_BYTES = 12;
const RESERVED_BYTE = 0;
const VERSION = 1;
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+*-]*$/;

const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

function fail(detail: string): never {
  throw new TypeError(`File envelope: ${detail}`);
}

function normalizeFormatId(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length !== FORMAT_ID_BYTES) {
    return fail(`formatId must contain exactly ${FORMAT_ID_BYTES} ASCII bytes.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) {
      return fail(`formatId must contain exactly ${FORMAT_ID_BYTES} ASCII bytes.`);
    }
  }
  return encoder.encode(value);
}

function normalizeMaxContentBytes(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return fail('maxContentBytes must be a non-negative safe integer.');
  }
  const maxContentBytes = value as number;
  if (maxContentBytes > Number.MAX_SAFE_INTEGER - PREFIX_BYTES - METADATA_MAX_BYTES) {
    return fail('maxContentBytes is too large to calculate a safe encoded-size bound.');
  }
  return maxContentBytes;
}

function validateFilename(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    return fail('filename must be a non-empty string.');
  }
  if (value.trim() === '.' || value.trim() === '..') {
    return fail('filename must identify a file, not a relative directory.');
  }
  // eslint-disable-next-line no-control-regex
  if (/[/\\\x00-\x1f\x7f]/.test(value)) {
    return fail('filename must be a basename without control characters.');
  }
  if (encoder.encode(value).byteLength > FILENAME_MAX_BYTES) {
    return fail(`filename exceeds ${FILENAME_MAX_BYTES} UTF-8 bytes.`);
  }
  return value;
}

function normalizeMimeType(value: unknown): string {
  if (typeof value !== 'string') {
    return DATA_FORMAT;
  }
  const normalized = value.split(';', 1)[0].trim().toLowerCase();
  if (
    normalized === ''
    || encoder.encode(normalized).byteLength > MIME_TYPE_MAX_BYTES
    || !MIME_TYPE.test(normalized)
  ) {
    return DATA_FORMAT;
  }
  return normalized;
}

function metadataFrom(value: unknown, exactShape: boolean): FileEnvelopeMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('metadata must be an object.');
  }
  if (exactShape) {
    const keys = Object.keys(value);
    if (keys.length !== 2 || !Object.hasOwn(value, 'filename') || !Object.hasOwn(value, 'mimeType')) {
      return fail('metadata must contain only filename and mimeType.');
    }
  }
  const candidate = value as Partial<FileEnvelopeMetadata>;
  return {
    filename : validateFilename(candidate.filename),
    mimeType : normalizeMimeType(candidate.mimeType),
  };
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Preserve the envelope validation error if the source also fails during cancellation.
  }
}

function appendContent(blocks: ContentBlocks, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const block = blocks.pending ?? new Uint8Array(CONTENT_BLOCK_BYTES);
    blocks.pending = block;
    const copied = Math.min(CONTENT_BLOCK_BYTES - blocks.pendingBytes, bytes.byteLength - offset);
    block.set(bytes.subarray(offset, offset + copied), blocks.pendingBytes);
    blocks.pendingBytes += copied;
    offset += copied;

    if (blocks.pendingBytes === CONTENT_BLOCK_BYTES) {
      blocks.blocks.push(block);
      blocks.pending = undefined;
      blocks.pendingBytes = 0;
    }
  }
}

function finishContent(blocks: ContentBlocks): Uint8Array[] {
  if (blocks.pending !== undefined && blocks.pendingBytes > 0) {
    blocks.blocks.push(blocks.pending.subarray(0, blocks.pendingBytes));
    blocks.pending = undefined;
    blocks.pendingBytes = 0;
  }
  return blocks.blocks;
}

/** @internal Create one bounded V1 private-file envelope codec. */
export function createFileEnvelopeCodec(options: FileEnvelopeCodecOptions): FileEnvelopeCodec {
  if (typeof options !== 'object' || options === null) {
    return fail('options must be an object.');
  }
  const formatId = normalizeFormatId(options.formatId);
  const maxContentBytes = normalizeMaxContentBytes(options.maxContentBytes);
  const maxEncodedBytes = PREFIX_BYTES + METADATA_MAX_BYTES + maxContentBytes;

  return Object.freeze({
    maxContentBytes,
    maxEncodedBytes,

    encode(value: FileEnvelopeData): EncodedRecordData {
      if (!(value?.blob instanceof Blob)) {
        return fail('blob must be a Blob.');
      }
      if (value.blob.size > maxContentBytes) {
        return fail(`content exceeds ${maxContentBytes} bytes.`);
      }

      const metadataBytes = encoder.encode(JSON.stringify(metadataFrom(value, false)));
      if (metadataBytes.byteLength > METADATA_MAX_BYTES) {
        return fail(`metadata exceeds ${METADATA_MAX_BYTES} bytes.`);
      }

      const prefix = new Uint8Array(PREFIX_BYTES);
      prefix.set(formatId);
      prefix[FORMAT_ID_BYTES] = VERSION;
      prefix[FORMAT_ID_BYTES + 1] = RESERVED_BYTE;
      new DataView(prefix.buffer).setUint32(8, metadataBytes.byteLength, false);

      return {
        data       : new Blob([prefix as BlobPart, metadataBytes as BlobPart, value.blob], { type: DATA_FORMAT }),
        dataFormat : DATA_FORMAT,
      };
    },

    async decode(data: RecordData, dataFormat: string): Promise<FileEnvelopeData> {
      if (dataFormat !== DATA_FORMAT) {
        return fail(`dataFormat must be '${DATA_FORMAT}'.`);
      }

      const stream = await data.stream() as ReadableStream<Uint8Array>;
      const reader = stream.getReader();
      const header = new Uint8Array(PREFIX_BYTES + METADATA_MAX_BYTES);
      const content: ContentBlocks = { blocks: [], pending: undefined, pendingBytes: 0 };
      let contentBytes = 0;
      let headerBytes = 0;
      let metadata: FileEnvelopeMetadata | undefined;
      let requiredHeaderBytes = PREFIX_BYTES;
      let streamFinished = false;
      let totalBytes = 0;

      try {
        while (true) {
          const result = await reader.read();
          if (result.done) {
            streamFinished = true;
            break;
          }
          const chunk = result.value;
          if (!(chunk instanceof Uint8Array)) {
            return fail('record stream must contain byte chunks.');
          }
          if (chunk.byteLength > maxEncodedBytes - totalBytes) {
            return fail(`record exceeds ${maxEncodedBytes} bytes.`);
          }
          totalBytes += chunk.byteLength;

          let chunkOffset = 0;
          while (chunkOffset < chunk.byteLength) {
            if (headerBytes < requiredHeaderBytes) {
              const copied = Math.min(requiredHeaderBytes - headerBytes, chunk.byteLength - chunkOffset);
              header.set(chunk.subarray(chunkOffset, chunkOffset + copied), headerBytes);
              headerBytes += copied;
              chunkOffset += copied;

              if (headerBytes === PREFIX_BYTES && requiredHeaderBytes === PREFIX_BYTES) {
                for (let index = 0; index < formatId.byteLength; index += 1) {
                  if (header[index] !== formatId[index]) {
                    return fail('format identifier does not match this codec.');
                  }
                }
                if (header[FORMAT_ID_BYTES] !== VERSION) {
                  return fail(`unsupported envelope version '${header[FORMAT_ID_BYTES]}'.`);
                }
                if (header[FORMAT_ID_BYTES + 1] !== RESERVED_BYTE) {
                  return fail('reserved envelope byte must be zero.');
                }

                const metadataLength = new DataView(header.buffer).getUint32(8, false);
                if (metadataLength === 0 || metadataLength > METADATA_MAX_BYTES) {
                  return fail('metadata length is outside the allowed range.');
                }
                requiredHeaderBytes = PREFIX_BYTES + metadataLength;
              }

              if (headerBytes === requiredHeaderBytes && requiredHeaderBytes > PREFIX_BYTES) {
                let parsed: unknown;
                try {
                  parsed = JSON.parse(decoder.decode(header.subarray(PREFIX_BYTES, requiredHeaderBytes)));
                } catch {
                  return fail('metadata is not valid UTF-8 JSON.');
                }
                metadata = metadataFrom(parsed, true);
              }
              continue;
            }

            const remaining = chunk.byteLength - chunkOffset;
            if (remaining > maxContentBytes - contentBytes) {
              return fail(`content exceeds ${maxContentBytes} bytes.`);
            }
            appendContent(content, chunk.subarray(chunkOffset));
            contentBytes += remaining;
            chunkOffset = chunk.byteLength;
          }
        }

        if (headerBytes < PREFIX_BYTES) {
          return fail('record is shorter than its fixed prefix.');
        }
        if (headerBytes < requiredHeaderBytes || metadata === undefined) {
          return fail('metadata extends past the record.');
        }

        return {
          filename : metadata.filename,
          mimeType : metadata.mimeType,
          blob     : new Blob(finishContent(content) as BlobPart[], { type: metadata.mimeType }),
        };
      } finally {
        if (!streamFinished) {
          await cancelReader(reader);
        }
        reader.releaseLock();
      }
    },
  });
}
