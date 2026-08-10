import type { Record } from './record.js';
import type { RecordData } from './record-data.js';
import type { FileEnvelopeCodec, FileEnvelopeCodecOptions } from './file-envelope-codec.js';

import { createFileEnvelopeCodec } from './file-envelope-codec.js';

/** Encoded plaintext ready for a DWN RecordsWrite operation. */
export type EncodedRecordData = {
  /** Encoded payload bytes. */
  data: Blob;

  /** Canonical MIME type written into the RecordsWrite descriptor. */
  dataFormat: string;
};

/** Structured failure returned by a standalone JSON Schema validator. */
export type RecordValidationFailure = Readonly<{
  instancePath: string;
  keyword: string;
  message?: string;
  params: Readonly<globalThis.Record<string, unknown>>;
}>;

/** Synchronous contract compatible with standalone JSON Schema validators. */
export type RecordValidator = ((value: unknown) => boolean) & {
  readonly errors?: readonly RecordValidationFailure[] | null;
};

/** Metadata available when a protocol codec processes one record value. */
export type RecordCodecContext = Readonly<{
  protocolPath?: string;
  recordId?: string;
  schema?: string;
}>;

/** Options for a JSON record codec backed by a standalone validator. */
export type JsonRecordCodecOptions = {
  dataFormat?: string;
  validator: RecordValidator;
};

/** A record value did not conform to its declared JSON Schema. */
export class RecordValidationError extends Error {
  /** Validator diagnostics, or an empty array when the validator supplied none. */
  public readonly failures: readonly RecordValidationFailure[];
  public readonly protocolPath?: string;
  public readonly recordId?: string;
  public readonly schema?: string;

  constructor(
    failures : readonly RecordValidationFailure[],
    context: RecordCodecContext = {},
  ) {
    const subject = context.recordId === undefined ? 'Record data' : `Record '${context.recordId}' data`;
    const path = context.protocolPath === undefined ? '' : ` at protocol path '${context.protocolPath}'`;
    const schema = context.schema === undefined ? '' : ` against schema '${context.schema}'`;
    const firstFailure = failures[0];
    const detail = firstFailure === undefined
      ? ''
      : ` ${firstFailure.instancePath || '/'}: ${firstFailure.message ?? firstFailure.keyword}.`;

    super(`${subject}${path} failed JSON Schema validation${schema}.${detail}`);
    this.name = 'RecordValidationError';
    this.failures = [...failures];
    this.protocolPath = context.protocolPath;
    this.recordId = context.recordId;
    this.schema = context.schema;
  }
}

/**
 * Converts one protocol record type between its application value and stored
 * plaintext representation. Encryption remains below this boundary.
 */
export interface RecordCodec<T> {
  /** Encode an application value for a RecordsWrite operation. */
  encode(value: T, context?: RecordCodecContext): EncodedRecordData | Promise<EncodedRecordData>;

  /** Decode a record's lazy plaintext data into its application value. */
  decode(data: RecordData, dataFormat: string, context?: RecordCodecContext): Promise<T>;
}

/** Runtime codecs keyed by protocol type name. */
export type RecordCodecMap = globalThis.Record<string, RecordCodec<unknown>>;

/** Extract the application value type accepted by a record codec. */
export type RecordCodecValue<C> = C extends RecordCodec<infer T> ? T : never;

function validateRecordValue<T>(
  value : unknown,
  validator : RecordValidator,
  context : RecordCodecContext | undefined,
): T {
  const valid: unknown = validator(value);
  if (typeof valid !== 'boolean') {
    if (valid instanceof Promise) {
      void valid.catch((): void => {});
    }
    throw new TypeError('RecordCodec: validator must be synchronous; async schemas are not supported.');
  }
  if (valid) {
    return value as T;
  }
  throw new RecordValidationError(validator.errors ?? [], context);
}

/** Built-in codecs for the common DWN record representations. */
export const recordCodecs = {
  /**
   * JSON values encoded with a caller-selected JSON MIME type.
   *
   * Without a validator, `T` is the trusted application type asserted after
   * `JSON.parse()`. A standalone validator checks the serialized value on
   * encode and the parsed value on decode.
   */
  json<T>(options: string | JsonRecordCodecOptions = 'application/json'): RecordCodec<T> {
    const dataFormat = typeof options === 'string' ? options : options.dataFormat ?? 'application/json';
    const validator = typeof options === 'string' ? undefined : options.validator;
    return {
      encode(value: T, context?: RecordCodecContext): EncodedRecordData {
        const serialized = JSON.stringify(value);
        if (serialized === undefined) {
          throw new TypeError('RecordCodec: JSON values must be serializable.');
        }
        if (validator !== undefined) {
          validateRecordValue(JSON.parse(serialized), validator, context);
        }
        return {
          data: new Blob([serialized], { type: dataFormat }),
          dataFormat,
        };
      },
      async decode(data: RecordData, _dataFormat: string, context?: RecordCodecContext): Promise<T> {
        const value: unknown = await data.json();
        return validator === undefined ? value as T : validateRecordValue(value, validator, context);
      },
    };
  },

  /** UTF-8 text encoded with a caller-selected text MIME type. */
  text(dataFormat = 'text/plain'): RecordCodec<string> {
    return {
      encode(value: string): EncodedRecordData {
        return {
          data: new Blob([value], { type: dataFormat }),
          dataFormat,
        };
      },
      async decode(data: RecordData): Promise<string> {
        return await data.text();
      },
    };
  },

  /** Raw bytes encoded with a caller-selected binary MIME type. */
  bytes(dataFormat = 'application/octet-stream'): RecordCodec<Uint8Array> {
    return {
      encode(value: Uint8Array): EncodedRecordData {
        return {
          data: new Blob([value as BlobPart], { type: dataFormat }),
          dataFormat,
        };
      },
      async decode(data: RecordData): Promise<Uint8Array> {
        return await data.bytes();
      },
    };
  },

  /**
   * Blob data. A fixed format overrides `Blob.type`; otherwise each value
   * must carry a non-empty MIME type.
   */
  blob(dataFormat?: string): RecordCodec<Blob> {
    return {
      encode(value: Blob): EncodedRecordData {
        const resolvedDataFormat = dataFormat ?? value.type;
        if (resolvedDataFormat === '') {
          throw new TypeError('RecordCodec: Blob values require a MIME type.');
        }
        return { data: value, dataFormat: resolvedDataFormat };
      },
      async decode(data: RecordData): Promise<Blob> {
        return await data.blob();
      },
    };
  },

  /**
   * A private-file envelope with filename and media type inside the payload.
   * Use it with a protocol type declaring `encryptionRequired: true`.
   */
  fileEnvelope(options: FileEnvelopeCodecOptions): FileEnvelopeCodec {
    return createFileEnvelopeCodec(options);
  },
} as const;

type RecordCodecBinding<T> = {
  codec: RecordCodec<T>;
  dataFormats?: readonly string[];
  signal?: AbortSignal;
};

const codecByRecord = new WeakMap<object, RecordCodecBinding<unknown>>();

/** @internal Bind a protocol codec to one canonical Record handle. */
export function bindRecordCodec<T, Existing = unknown>(
  record : Record<Existing>,
  codec : RecordCodec<T>,
  dataFormats?: readonly string[],
  signal?: AbortSignal,
): Record<T> {
  // The WeakMap owns the sole runtime erasure point; callers stay fully typed.
  codecByRecord.set(record, { codec: codec as RecordCodec<unknown>, dataFormats, signal });
  return record as unknown as Record<T>;
}

/** @internal Return the protocol codec binding for a canonical Record handle. */
export function getRecordCodecBinding<T>(record: Record<T>): RecordCodecBinding<T> | undefined {
  return codecByRecord.get(record) as RecordCodecBinding<T> | undefined;
}

/** @internal Encode and validate one value before starting a DWN operation. */
export async function encodeRecordValue<T>(
  codec : RecordCodec<T>,
  value : T,
  dataFormats?: readonly string[],
  context?: RecordCodecContext,
): Promise<EncodedRecordData> {
  const encoded = await codec.encode(value, context);
  if (!(encoded?.data instanceof Blob) || typeof encoded.dataFormat !== 'string' || encoded.dataFormat === '') {
    throw new TypeError('RecordCodec: encode() must return a Blob and a non-empty dataFormat.');
  }
  if (dataFormats !== undefined && !dataFormats.includes(encoded.dataFormat)) {
    throw new TypeError(
      `RecordCodec: dataFormat '${encoded.dataFormat}' is not declared by this protocol type.`,
    );
  }
  return encoded;
}
