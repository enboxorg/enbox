import type { Record } from './record.js';
import type { RecordData } from './record-data.js';

/** Encoded plaintext ready for a DWN RecordsWrite operation. */
export type EncodedRecordData = {
  /** Encoded payload bytes. */
  data: Blob;

  /** Canonical MIME type written into the RecordsWrite descriptor. */
  dataFormat: string;
};

/**
 * Converts one protocol record type between its application value and stored
 * plaintext representation. Encryption remains below this boundary.
 */
export interface RecordCodec<T> {
  /** Encode an application value for a RecordsWrite operation. */
  encode(value: T): EncodedRecordData | Promise<EncodedRecordData>;

  /** Decode a record's lazy plaintext data into its application value. */
  decode(data: RecordData, dataFormat: string): Promise<T>;
}

/** Runtime codecs keyed by protocol type name. */
export type RecordCodecMap = globalThis.Record<string, RecordCodec<unknown>>;

/** Extract the application value type accepted by a record codec. */
export type RecordCodecValue<C> = C extends RecordCodec<infer T> ? T : never;

/** Built-in codecs for the common DWN record representations. */
export const recordCodecs = {
  /**
   * JSON values encoded with a caller-selected JSON MIME type.
   *
   * `T` is the trusted application type asserted after `JSON.parse()`; this
   * codec does not perform runtime JSON Schema validation.
   */
  json<T>(dataFormat = 'application/json'): RecordCodec<T> {
    return {
      encode(value: T): EncodedRecordData {
        const serialized = JSON.stringify(value);
        if (serialized === undefined) {
          throw new TypeError('RecordCodec: JSON values must be serializable.');
        }
        return {
          data: new Blob([serialized], { type: dataFormat }),
          dataFormat,
        };
      },
      async decode(data: RecordData): Promise<T> {
        // Runtime schema validation is intentionally outside the codec contract;
        // this is the single trusted boundary declared by json<T>().
        return await data.json() as T;
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
} as const;

type RecordCodecBinding<T> = {
  codec: RecordCodec<T>;
  dataFormats?: readonly string[];
};

const codecByRecord = new WeakMap<object, RecordCodecBinding<unknown>>();

/** @internal Bind a protocol codec to one canonical Record handle. */
export function bindRecordCodec<T, Existing = unknown>(
  record : Record<Existing>,
  codec : RecordCodec<T>,
  dataFormats?: readonly string[],
): Record<T> {
  // The WeakMap owns the sole runtime erasure point; callers stay fully typed.
  codecByRecord.set(record, { codec: codec as RecordCodec<unknown>, dataFormats });
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
): Promise<EncodedRecordData> {
  const encoded = await codec.encode(value);
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
