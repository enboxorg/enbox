import type * as AwsClientS3 from '@aws-sdk/client-s3';
import type * as AwsLibStorage from '@aws-sdk/lib-storage';
import type { Dialect } from './dialect/dialect.js';
import type { DwnDatabaseType } from './types.js';
import type { DataStore, DataStoreGetResult, DataStorePutResult } from '@enbox/dwn-sdk-js';

import * as DataRefs from './utils/data-refs.js';
import { createRequire } from 'node:module';
import { drainReadableStream } from './utils/stream.js';
import { Readable } from 'stream';
import { Kysely, sql } from 'kysely';

const MIN_PART_SIZE = 5 * 1024 * 1024;
const DEFAULT_PART_SIZE = MIN_PART_SIZE;
const DEFAULT_QUEUE_SIZE = 4;
const require = createRequire(import.meta.url);

type AwsS3Modules = {
  DeleteObjectCommand : typeof AwsClientS3.DeleteObjectCommand;
  DeleteObjectsCommand : typeof AwsClientS3.DeleteObjectsCommand;
  GetObjectCommand : typeof AwsClientS3.GetObjectCommand;
  ListObjectsV2Command : typeof AwsClientS3.ListObjectsV2Command;
  S3Client : typeof AwsClientS3.S3Client;
  Upload : typeof AwsLibStorage.Upload;
};

let awsS3Modules: AwsS3Modules | undefined;

function loadAwsS3Modules(): AwsS3Modules {
  if (awsS3Modules !== undefined) {
    return awsS3Modules;
  }

  try {
    const clientS3 = require('@aws-sdk/client-s3') as typeof AwsClientS3;
    const libStorage = require('@aws-sdk/lib-storage') as typeof AwsLibStorage;

    awsS3Modules = {
      DeleteObjectCommand  : clientS3.DeleteObjectCommand,
      DeleteObjectsCommand : clientS3.DeleteObjectsCommand,
      GetObjectCommand     : clientS3.GetObjectCommand,
      ListObjectsV2Command : clientS3.ListObjectsV2Command,
      S3Client             : clientS3.S3Client,
      Upload               : libStorage.Upload,
    };
    return awsS3Modules;
  } catch {
    throw new Error(
      'DataStoreS3 requires @aws-sdk/client-s3 and @aws-sdk/lib-storage. Install them alongside @enbox/dwn-sql-store.'
    );
  }
}

/**
 * S3-backed implementation of {@link DataStore} with SQL-based reference
 * tracking for content-addressed deduplication.
 *
 * Data is stored as whole S3 objects keyed by `dataCid`. The same `dataCid`
 * maps to a single S3 object regardless of how many (tenant, recordId) pairs
 * reference it. A `dataRefs` SQL table tracks references; blocks are
 * garbage-collected from S3 when the last ref is deleted.
 *
 * The AWS SDK Upload helper accepts unknown-length stream bodies, using a
 * single PUT for small payloads and multipart upload for larger payloads with
 * bounded memory (`queueSize * partSize`).
 */
export class DataStoreS3 implements DataStore {
  readonly #dialect: Dialect;
  readonly #aws: AwsS3Modules;
  #db: Kysely<DwnDatabaseType> | null = null;
  readonly #s3: AwsClientS3.S3Client;
  readonly #bucket: string;
  readonly #partSize: number;
  readonly #queueSize: number;

  constructor(config: DataStoreS3Config) {
    this.#aws = loadAwsS3Modules();
    this.#dialect = config.dialect;
    this.#bucket = config.bucket;
    this.#partSize = config.partSize ?? DEFAULT_PART_SIZE;
    this.#queueSize = config.queueSize ?? DEFAULT_QUEUE_SIZE;

    if (!Number.isInteger(this.#partSize) || this.#partSize < MIN_PART_SIZE) {
      throw new Error('DataStoreS3: partSize must be at least 5 MiB.');
    }

    if (!Number.isInteger(this.#queueSize) || this.#queueSize <= 0) {
      throw new Error('DataStoreS3: queueSize must be a positive integer.');
    }

    this.#s3 = config.s3Client ?? new this.#aws.S3Client({
      region         : config.region ?? 'us-east-1',
      endpoint       : config.endpoint,
      forcePathStyle : config.forcePathStyle ?? false,
      credentials    : config.credentials,
    });
  }

  public async open(): Promise<void> {
    if (this.#db) {
      return;
    }

    this.#db = new Kysely<DwnDatabaseType>({ dialect: this.#dialect });

    // Fail fast if migrations have not been run — the dataRefs table must already exist.
    await this.#assertTablesExist();
  }

  public async close(): Promise<void> {
    await this.#db?.destroy();
    this.#db = null;
  }

  public async get(
    tenant: string,
    recordId: string,
    dataCid: string,
  ): Promise<DataStoreGetResult | undefined> {
    const db = this.#getDb('get');

    const dataSize = await DataRefs.getDataRefSize(db, { tenant, recordId, dataCid });
    if (dataSize === undefined) {
      return undefined;
    }

    const response = await this.#s3.send(new this.#aws.GetObjectCommand({
      Bucket : this.#bucket,
      Key    : dataCid,
    }));

    if (!response.Body) {
      return undefined;
    }

    const dataStream = response.Body.transformToWebStream() as ReadableStream<Uint8Array>;

    return {
      dataSize,
      dataStream,
    };
  }

  public async put(
    tenant: string,
    recordId: string,
    dataCid: string,
    dataStream: ReadableStream<Uint8Array>,
  ): Promise<DataStorePutResult> {
    const db = this.#getDb('put');

    const existingDataSize = await DataRefs.getDataRefSize(db, { tenant, recordId, dataCid });
    if (existingDataSize !== undefined) {
      await drainReadableStream(dataStream);
      return { dataSize: existingDataSize };
    }

    // Check if another ref for this dataCid already exists (dedup path).
    const otherDataSize = await DataRefs.getAnyDataRefSize(db, dataCid);

    let dataSize: number;

    if (otherDataSize === undefined) {
      // New data — upload to S3 with a counting passthrough.
      dataSize = await this.#uploadToS3(dataCid, dataStream);
    } else {
      // S3 object already exists — skip upload.
      await drainReadableStream(dataStream);
      dataSize = otherDataSize;
    }

    dataSize = await DataRefs.insertDataRef(db, { tenant, recordId, dataCid }, dataSize);
    return { dataSize };
  }

  public async delete(
    tenant: string,
    recordId: string,
    dataCid: string,
  ): Promise<void> {
    const db = this.#getDb('delete');

    await DataRefs.deleteDataRef(db, { tenant, recordId, dataCid });

    // Garbage-collect the S3 object if no more refs point to this dataCid.
    if (!await DataRefs.hasAnyDataRef(db, dataCid)) {
      await this.#s3.send(new this.#aws.DeleteObjectCommand({
        Bucket : this.#bucket,
        Key    : dataCid,
      }));
    }
  }

  public async clear(): Promise<void> {
    const db = this.#getDb('clear');

    // Clear the refs table.
    await db.deleteFrom('dataRefs').execute();

    // Delete all S3 objects in the bucket.
    let continuationToken: string | undefined;
    do {
      const list = await this.#s3.send(new this.#aws.ListObjectsV2Command({
        Bucket            : this.#bucket,
        ContinuationToken : continuationToken,
      }));

      const objects = (list.Contents ?? [])
        .filter((obj): obj is { Key: string } => obj.Key !== undefined)
        .map((obj): { Key: string } => ({ Key: obj.Key }));

      if (objects.length > 0) {
        await this.#s3.send(new this.#aws.DeleteObjectsCommand({
          Bucket : this.#bucket,
          Delete : { Objects: objects },
        }));
      }

      continuationToken = list.NextContinuationToken;
    } while (continuationToken);
  }

  // ─── Private helpers ────────────────────────────────────────────────

  #getDb(method: string): Kysely<DwnDatabaseType> {
    if (!this.#db) {
      throw new Error(
        `Connection to database not open. Call \`open\` before using \`${method}\`.`
      );
    }
    return this.#db;
  }

  /**
   * Uploads data to S3, counting bytes as they stream through.
   * Uses multipart upload for large files via `@aws-sdk/lib-storage`.
   * @returns The total number of bytes uploaded.
   */
  async #uploadToS3(dataCid: string, dataStream: ReadableStream<Uint8Array>): Promise<number> {
    let dataSize = 0;

    // Create a Node Readable from the web ReadableStream, counting bytes.
    const reader = dataStream.getReader();
    let readerReleased = false;
    const releaseReader = (): void => {
      if (!readerReleased) {
        reader.releaseLock();
        readerReleased = true;
      }
    };
    const cancelReader = async (reason?: unknown): Promise<void> => {
      if (readerReleased) {
        return;
      }

      try {
        await reader.cancel(reason);
      } finally {
        releaseReader();
      }
    };

    const nodeStream = new Readable({
      async read(): Promise<void> {
        try {
          const { done, value } = await reader.read();
          if (done) {
            releaseReader();
            this.push(null);
          } else {
            dataSize += value.byteLength;
            this.push(Buffer.from(value));
          }
        } catch (error: unknown) {
          try {
            await cancelReader(error);
          } catch {
            // Preserve the original stream read error.
          }
          this.destroy(error as Error);
        }
      },
      destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        void (async (): Promise<void> => {
          try {
            await cancelReader(error ?? undefined);
            callback(error);
          } catch (cancelError: unknown) {
            callback((error ?? cancelError) as Error);
          }
        })();
      },
    });

    const upload = new this.#aws.Upload({
      client : this.#s3,
      params : {
        Bucket : this.#bucket,
        Key    : dataCid,
        Body   : nodeStream,
      },
      queueSize : this.#queueSize,
      partSize  : this.#partSize,
    });

    await upload.done();

    return dataSize;
  }

  /**
   * Verifies that the required `dataRefs` table exists by executing a
   * zero-row SELECT. Throws a clear error directing the caller to run
   * migrations first.
   */
  async #assertTablesExist(): Promise<void> {
    try {
      await sql`SELECT 1 FROM ${sql.table('dataRefs')} LIMIT 0`.execute(this.#db!);
    } catch {
      throw new Error(
        'DataStoreS3: table \'dataRefs\' does not exist. Run DWN store migrations before opening stores.'
      );
    }
  }
}

/**
 * Configuration for {@link DataStoreS3}.
 */
export type DataStoreS3Config = {
  /** Kysely dialect for the SQL `dataRefs` table. */
  dialect: Dialect;

  /** S3 bucket name for content storage. */
  bucket: string;

  /** Optional pre-configured S3Client instance. If omitted, one is created from region/endpoint. */
  s3Client?: AwsClientS3.S3Client;

  /** AWS region. Default: `'us-east-1'`. */
  region?: string;

  /** Custom S3 endpoint URL (e.g. MinIO `http://localhost:9000`). */
  endpoint?: string;

  /** Use path-style access (`http://host/bucket/key`). Required for MinIO. Default: `false`. */
  forcePathStyle?: boolean;

  /** AWS credentials. When omitted, the SDK uses the default credential chain (IAM role, env vars, etc.). */
  credentials?: { accessKeyId: string; secretAccessKey: string };

  /** Multipart upload part size in bytes. Minimum and default: `5 * 1024 * 1024` (5 MiB). */
  partSize?: number;

  /** Number of concurrent multipart upload parts. Must be a positive integer. Default: `4`. */
  queueSize?: number;
};
