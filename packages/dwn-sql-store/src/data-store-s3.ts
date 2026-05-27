import type { Dialect } from './dialect/dialect.js';
import type { DwnDatabaseType } from './types.js';
import type { DataStore, DataStoreGetResult, DataStorePutResult } from '@enbox/dwn-sdk-js';

import { DataStream } from '@enbox/dwn-sdk-js';
import { isDuplicateKeyError } from './utils/duplicate-key-error.js';
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

    const ref = await db
      .selectFrom('dataRefs')
      .select('dataSize')
      .where('tenant', '=', tenant)
      .where('recordId', '=', recordId)
      .where('dataCid', '=', dataCid)
      .executeTakeFirst();

    if (!ref) {
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
      dataSize: Number(ref.dataSize),
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

    // Check if this exact ref already exists (idempotent put).
    const existingRef = await db
      .selectFrom('dataRefs')
      .select('dataSize')
      .where('tenant', '=', tenant)
      .where('recordId', '=', recordId)
      .where('dataCid', '=', dataCid)
      .executeTakeFirst();

    if (existingRef) {
      await DataStream.toBytes(dataStream);
      return { dataSize: Number(existingRef.dataSize) };
    }

    // Check if another ref for this dataCid already exists (dedup path).
    const otherRef = await db
      .selectFrom('dataRefs')
      .select('dataSize')
      .where('dataCid', '=', dataCid)
      .executeTakeFirst();

    let dataSize: number;

    if (otherRef) {
      // S3 object already exists — skip upload.
      await DataStream.toBytes(dataStream);
      dataSize = Number(otherRef.dataSize);
    } else {
      // New data — upload to S3 with a counting passthrough.
      dataSize = await this.#uploadToS3(dataCid, dataStream);
    }

    // Insert the reference. If an overlapping identical write inserted the
    // ref first, treat it as an idempotent put and return the stored size.
    try {
      await db
        .insertInto('dataRefs')
        .values({ tenant, recordId, dataCid, dataSize })
        .execute();
    } catch (error: unknown) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }

      const racedRef = await db
        .selectFrom('dataRefs')
        .select('dataSize')
        .where('tenant', '=', tenant)
        .where('recordId', '=', recordId)
        .where('dataCid', '=', dataCid)
        .executeTakeFirst();

      if (!racedRef) {
        throw error;
      }

      dataSize = Number(racedRef.dataSize);
    }

    return { dataSize };
  }

  public async delete(
    tenant: string,
    recordId: string,
    dataCid: string,
  ): Promise<void> {
    const db = this.#getDb('delete');

    // Remove the reference.
    await db
      .deleteFrom('dataRefs')
      .where('tenant', '=', tenant)
      .where('recordId', '=', recordId)
      .where('dataCid', '=', dataCid)
      .execute();

    // Garbage-collect the S3 object if no more refs point to this dataCid.
    const remaining = await db
      .selectFrom('dataRefs')
      .select('dataCid')
      .where('dataCid', '=', dataCid)
      .executeTakeFirst();

    if (!remaining) {
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
    const nodeStream = new Readable({
      async read(): Promise<void> {
        const { done, value } = await reader.read();
        if (done) {
          this.push(null);
        } else {
          dataSize += value.byteLength;
          this.push(Buffer.from(value));
        }
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
      // Fallback: buffer entire stream (only for tiny test payloads).
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { break; }
        dataSize += value.byteLength;
        chunks.push(value);
      }
      const body = Buffer.concat(chunks);
      await this.#s3.send(new PutObjectCommand({
        Bucket : this.#bucket,
        Key    : dataCid,
        Body   : body,
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
