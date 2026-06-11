import type { Dialect } from './dialect/dialect.js';
import type { DwnDatabaseType } from './types.js';
import type { DataStore, DataStoreGetResult, DataStorePutResult } from '@enbox/dwn-sdk-js';

import * as DataRefs from './utils/data-refs.js';
import { drainReadableStream } from './utils/stream.js';
import { Readable } from 'stream';
import { Upload } from '@aws-sdk/lib-storage';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Kysely, sql } from 'kysely';

/**
 * S3-backed implementation of {@link DataStore} with SQL-based reference
 * tracking for content-addressed deduplication.
 *
 * Data is stored as whole S3 objects keyed by `dataCid`. The same `dataCid`
 * maps to a single S3 object regardless of how many (tenant, recordId) pairs
 * reference it. A `dataRefs` SQL table tracks references; blocks are
 * garbage-collected from S3 when the last ref is deleted.
 *
 * For files over `partSize` (default 5MB), the AWS SDK Upload helper
 * automatically uses multipart upload with bounded memory
 * (`queueSize * partSize`).
 */
export class DataStoreS3 implements DataStore {
  readonly #dialect: Dialect;
  #db: Kysely<DwnDatabaseType> | null = null;
  readonly #s3: S3Client;
  readonly #bucket: string;
  readonly #partSize: number;
  readonly #queueSize: number;

  constructor(config: DataStoreS3Config) {
    this.#dialect = config.dialect;
    this.#bucket = config.bucket;
    this.#partSize = config.partSize ?? 5 * 1024 * 1024; // 5 MB
    this.#queueSize = config.queueSize ?? 4;

    this.#s3 = config.s3Client ?? new S3Client({
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

    const response = await this.#s3.send(new GetObjectCommand({
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
      await this.#s3.send(new DeleteObjectCommand({
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
      const list = await this.#s3.send(new ListObjectsV2Command({
        Bucket            : this.#bucket,
        ContinuationToken : continuationToken,
      }));

      const objects = (list.Contents ?? [])
        .filter((obj): obj is { Key: string } => obj.Key !== undefined)
        .map((obj): { Key: string } => ({ Key: obj.Key }));

      if (objects.length > 0) {
        await this.#s3.send(new DeleteObjectsCommand({
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

    // For small files, a simple PutObject suffices. For large files,
    // Upload handles multipart automatically with bounded memory.
    if (this.#partSize > 0) {
      const upload = new Upload({
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
    } else {
      // Single-part upload still streams from the caller; it does not buffer the body in-process.
      await this.#s3.send(new PutObjectCommand({
        Bucket : this.#bucket,
        Key    : dataCid,
        Body   : nodeStream,
      }));
    }

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
  s3Client?: S3Client;

  /** AWS region. Default: `'us-east-1'`. */
  region?: string;

  /** Custom S3 endpoint URL (e.g. MinIO `http://localhost:9000`). */
  endpoint?: string;

  /** Use path-style access (`http://host/bucket/key`). Required for MinIO. Default: `false`. */
  forcePathStyle?: boolean;

  /** AWS credentials. When omitted, the SDK uses the default credential chain (IAM role, env vars, etc.). */
  credentials?: { accessKeyId: string; secretAccessKey: string };

  /** Multipart upload part size in bytes. Default: `5 * 1024 * 1024` (5 MB). */
  partSize?: number;

  /** Number of concurrent multipart upload parts. Default: `4`. */
  queueSize?: number;
};
