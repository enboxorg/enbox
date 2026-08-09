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

  /** Optional local ceiling for encoded and decoded file content. Omit it to add no dapp size policy. */
  maxContentBytes?: number;
}>;

/** A private-file codec with a protocol-size calculation helper. */
export type FileEnvelopeCodec = RecordCodec<FileEnvelopeData> & Readonly<{
  /** Worst-case encoded size for the supplied content bytes and maximum permitted metadata. */
  maxEncodedBytesFor(contentBytes: number): number;
}>;

type FileEnvelopeMetadata = { filename: string; mimeType: string };

const DATA_FORMAT = 'application/octet-stream';
const FILENAME_MAX_BYTES = 1_024;
const FORMAT_ID_BYTES = 6;
const MAGIC_BYTES = 8;
const METADATA_MAX_BYTES = 4_096;
const MIME_TYPE_MAX_BYTES = 255;
const PREFIX_BYTES = 12;
const MAX_SAFE_CONTENT_BYTES = Number.MAX_SAFE_INTEGER - PREFIX_BYTES - METADATA_MAX_BYTES;
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+*-]*$/;

const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

function fail(detail: string): never {
  throw new TypeError(`File envelope: ${detail}`);
}

function normalizeByteCount(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_SAFE_CONTENT_BYTES) {
    return fail(`${name} must be a non-negative safe integer with room for the envelope.`);
  }
  return value;
}

function createMagic(formatId: unknown): Uint8Array {
  if (typeof formatId !== 'string' || formatId.length !== FORMAT_ID_BYTES || encoder.encode(formatId).byteLength !== FORMAT_ID_BYTES) {
    return fail(`formatId must contain exactly ${FORMAT_ID_BYTES} ASCII bytes.`);
  }

  const magic = new Uint8Array(MAGIC_BYTES);
  magic.set(encoder.encode(formatId));
  magic[FORMAT_ID_BYTES] = 1;
  return magic;
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
  if (normalized === '' || encoder.encode(normalized).byteLength > MIME_TYPE_MAX_BYTES || !MIME_TYPE.test(normalized)) {
    return DATA_FORMAT;
  }
  return normalized;
}

function metadataFrom(value: unknown): FileEnvelopeMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('metadata must be an object.');
  }
  const candidate = value as Partial<FileEnvelopeMetadata>;
  return {
    filename : validateFilename(candidate.filename),
    mimeType : normalizeMimeType(candidate.mimeType),
  };
}

function guardStream(stream: ReadableStream<Uint8Array>, maxContentBytes: number): ReadableStream<Uint8Array> {
  // Bound buffering before metadata is known; the exact content size is checked after slicing.
  const maxEnvelopeBytes = PREFIX_BYTES + METADATA_MAX_BYTES + maxContentBytes;
  let envelopeBytes = 0;

  return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller): void {
      if (!(chunk instanceof Uint8Array)) {
        return fail('record stream must contain byte chunks.');
      }
      if (chunk.byteLength > maxEnvelopeBytes - envelopeBytes) {
        return fail(`content exceeds ${maxContentBytes} bytes.`);
      }
      envelopeBytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
  }));
}

async function decodeEnvelope(data: RecordData, dataFormat: string, magic: Uint8Array, maxContentBytes: number): Promise<FileEnvelopeData> {
  if (dataFormat !== DATA_FORMAT) {
    return fail(`dataFormat must be '${DATA_FORMAT}'.`);
  }

  const stream = await data.stream() as ReadableStream<Uint8Array>;
  const envelope = await new Response(guardStream(stream, maxContentBytes)).blob();
  if (envelope.size < PREFIX_BYTES) {
    return fail('record is shorter than its fixed prefix.');
  }

  const prefix = new Uint8Array(await envelope.slice(0, PREFIX_BYTES).arrayBuffer());
  for (let index = 0; index < magic.byteLength; index += 1) {
    if (prefix[index] !== magic[index]) {
      return fail('format identifier or version does not match this codec.');
    }
  }

  const metadataLength = new DataView(prefix.buffer).getUint32(MAGIC_BYTES, false);
  if (metadataLength === 0 || metadataLength > METADATA_MAX_BYTES) {
    return fail('metadata length is outside the allowed range.');
  }
  const contentOffset = PREFIX_BYTES + metadataLength;
  if (envelope.size < contentOffset) {
    return fail('metadata extends past the record.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(await envelope.slice(PREFIX_BYTES, contentOffset).arrayBuffer()));
  } catch {
    return fail('metadata is not valid UTF-8 JSON.');
  }
  const metadata = metadataFrom(parsed);
  const blob = envelope.slice(contentOffset, envelope.size, metadata.mimeType);
  if (blob.size > maxContentBytes) {
    return fail(`content exceeds ${maxContentBytes} bytes.`);
  }

  return { filename: metadata.filename, mimeType: metadata.mimeType, blob };
}

/** @internal Create one V1 private-file envelope codec. */
export function createFileEnvelopeCodec(options: FileEnvelopeCodecOptions): FileEnvelopeCodec {
  if (typeof options !== 'object' || options === null) {
    return fail('options must be an object.');
  }
  const magic = createMagic(options.formatId);
  const maxContentBytes = options.maxContentBytes === undefined
    ? MAX_SAFE_CONTENT_BYTES
    : normalizeByteCount(options.maxContentBytes, 'maxContentBytes');

  return {
    maxEncodedBytesFor(contentBytes: number): number {
      return PREFIX_BYTES + METADATA_MAX_BYTES + normalizeByteCount(contentBytes, 'contentBytes');
    },

    encode(value: FileEnvelopeData): EncodedRecordData {
      if (!(value?.blob instanceof Blob)) {
        return fail('blob must be a Blob.');
      }
      if (value.blob.size > maxContentBytes) {
        return fail(`content exceeds ${maxContentBytes} bytes.`);
      }

      const metadataBytes = encoder.encode(JSON.stringify(metadataFrom(value)));
      if (metadataBytes.byteLength > METADATA_MAX_BYTES) {
        return fail(`metadata exceeds ${METADATA_MAX_BYTES} bytes.`);
      }
      const prefix = new Uint8Array(PREFIX_BYTES);
      prefix.set(magic);
      new DataView(prefix.buffer).setUint32(MAGIC_BYTES, metadataBytes.byteLength, false);

      return {
        data       : new Blob([prefix as BlobPart, metadataBytes as BlobPart, value.blob], { type: DATA_FORMAT }),
        dataFormat : DATA_FORMAT,
      };
    },

    decode(data: RecordData, dataFormat: string): Promise<FileEnvelopeData> {
      return decodeEnvelope(data, dataFormat, magic, maxContentBytes);
    },
  };
}
