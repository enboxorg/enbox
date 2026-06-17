import type { Dialect } from '@enbox/dwn-sql-store';
import type { AdminMessageSummary, AdminProtocolSummary, GlobalStats, TenantExport, TenantStats } from './types.js';

import { Kysely } from 'kysely';

import { escapeLikeWildcards } from '../lib/sql-utils.js';
import { getDialectFromUrl } from '../storage.js';

/**
 * Provides cross-tenant SQL queries for admin operations.
 * The DWN SDK's store interfaces are always tenant-scoped — this store
 * runs direct SQL for operations like listing tenants and computing aggregates.
 */
export class AdminStore {
  private readonly db: Kysely<AdminDatabase>;
  private cachedGlobalStats: GlobalStats | undefined;
  private cachedGlobalStatsTimestamp = 0;
  private readonly cacheTtlMs: number;

  private constructor(dialect: Dialect, cacheTtlMs: number) {
    this.db = new Kysely<AdminDatabase>({ dialect });
    this.cacheTtlMs = cacheTtlMs;
  }

  /**
   * Creates an `AdminStore` from a storage URL string.
   * @param storageUrl - A SQL connection URL (sqlite://, postgres://, mysql://).
   * @param cacheTtlMs - TTL for cached global stats in milliseconds. Default: 60_000.
   * @returns An `AdminStore` instance, or `undefined` if the URL uses a non-SQL backend.
   */
  public static create(storageUrl: string, cacheTtlMs = 60_000): AdminStore | undefined {
    // LevelDB and file-path plugins cannot support cross-tenant queries.
    const isFilePath = storageUrl.startsWith('/') || storageUrl.startsWith('./') || storageUrl.startsWith('../');
    if (isFilePath || storageUrl.startsWith('level://')) {
      return undefined;
    }

    try {
      const dialect = getDialectFromUrl(new URL(storageUrl));
      return new AdminStore(dialect, cacheTtlMs);
    } catch {
      return undefined;
    }
  }

  /**
   * Creates an `AdminStore` from an already-initialized Kysely dialect.
   * Used when the admin store should share the same database connection as the DWN stores
   * (e.g., in-memory SQLite for tests).
   */
  public static createFromDialect(dialect: Dialect, cacheTtlMs = 60_000): AdminStore {
    return new AdminStore(dialect, cacheTtlMs);
  }

  // ---------------------------------------------------------------------------
  // Tenant discovery
  // ---------------------------------------------------------------------------

  /**
   * Returns `true` if the DWN SQL tables exist (i.e. the admin store shares the same DB as the DWN).
   */
  public async isAvailable(): Promise<boolean> {
    try {
      await this.db
        .selectFrom('messageStoreMessages')
        .select(this.db.fn.countAll<number>().as('count'))
        .limit(1)
        .execute();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns a paginated list of distinct tenant DIDs from the message store.
   *
   * @see https://github.com/enboxorg/enbox/issues/390
   */
  public async getDistinctTenants(options?: {
    cursor? : string;
    limit? : number;
    search? : string;
  }): Promise<{ tenants: string[]; cursor?: string }> {
    const limit = options?.limit ?? 20;

    let query = this.db
      .selectFrom('messageStoreMessages')
      .select(this.db.fn.agg<string>('distinct', ['tenant']).as('tenant'))
      .orderBy('tenant', 'asc')
      .limit(limit + 1); // fetch one extra to detect next page

    if (options?.cursor) {
      query = query.where('tenant', '>', options.cursor);
    }

    if (options?.search) {
      query = query.where('tenant', 'like', `%${escapeLikeWildcards(options.search)}%`);
    }

    const results = await query.execute();
    const tenants = results.map((r: { tenant: string }): string => r.tenant);

    let cursor: string | undefined;
    if (tenants.length > limit) {
      tenants.pop();
      cursor = tenants[tenants.length - 1];
    }

    return { tenants, cursor };
  }

  /**
   * Returns the total count of distinct tenants.
   */
  public async getTenantCount(): Promise<number> {
    const result = await this.db
      .selectFrom('messageStoreMessages')
      .select(this.db.fn.countAll<number>().as('count'))
      .select('tenant')
      .groupBy('tenant')
      .execute();

    return result.length;
  }

  // ---------------------------------------------------------------------------
  // Per-tenant aggregates
  // ---------------------------------------------------------------------------

  /**
   * Returns aggregate statistics for a single tenant.
   */
  public async getTenantStats(did: string): Promise<TenantStats> {
    const [messageCount, dataStorageBytes, protocols] = await Promise.all([
      this.getTenantMessageCount(did),
      this.getTenantStorageSize(did),
      this.getTenantProtocols(did),
    ]);

    return {
      messageCount,
      dataStorageBytes,
      protocolCount: protocols.length,
      protocols,
    };
  }

  /**
   * Returns the total number of messages for a tenant.
   */
  public async getTenantMessageCount(did: string): Promise<number> {
    const result = await this.db
      .selectFrom('messageStoreMessages')
      .select(this.db.fn.countAll<number>().as('count'))
      .where('tenant', '=', did)
      .executeTakeFirstOrThrow();

    return Number(result.count);
  }

  /**
   * Returns the total data storage in bytes for a tenant.
   *
   * Uses `messageStoreMessages.dataSize` rather than `dataRefs.dataSize` so that
   * **all** data is accounted for — including small payloads (<=30 KB) that the
   * DWN SDK stores inline as `encodedData` and never writes to the data store.
   */
  public async getTenantStorageSize(did: string): Promise<number> {
    const result = await this.db
      .selectFrom('messageStoreMessages')
      .select(this.db.fn.sum<number>('dataSize').as('totalBytes'))
      .where('tenant', '=', did)
      .executeTakeFirstOrThrow();

    return Number(result.totalBytes) || 0;
  }

  /**
   * Returns the list of distinct protocols used by a tenant.
   */
  public async getTenantProtocols(did: string): Promise<string[]> {
    const results = await this.db
      .selectFrom('messageStoreMessages')
      .select('protocol')
      .distinct()
      .where('tenant', '=', did)
      .where('protocol', 'is not', null)
      .execute();

    return results.map((r: { protocol: string | null }): string => r.protocol!);
  }

  // ---------------------------------------------------------------------------
  // Global aggregates (cached)
  // ---------------------------------------------------------------------------

  /**
   * Returns global server statistics. Results are cached with the configured TTL.
   * Pass `refresh: true` to force recalculation.
   */
  public async getGlobalStats(options?: { refresh?: boolean }): Promise<GlobalStats> {
    const now = Date.now();
    if (
      !options?.refresh &&
      this.cachedGlobalStats !== undefined &&
      (now - this.cachedGlobalStatsTimestamp) < this.cacheTtlMs
    ) {
      return this.cachedGlobalStats;
    }

    const [tenantCount, messageStats, dataStats, protocolStats] = await Promise.all([
      this.getTenantCount(),
      this.db
        .selectFrom('messageStoreMessages')
        .select(this.db.fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow(),
      this.db
        .selectFrom('messageStoreMessages')
        .select(this.db.fn.sum<number>('dataSize').as('totalBytes'))
        .executeTakeFirstOrThrow(),
      this.db
        .selectFrom('messageStoreMessages')
        .select(
          this.db.fn.count<number>('protocol').distinct().as('count')
        )
        .where('protocol', 'is not', null)
        .executeTakeFirstOrThrow(),
    ]);

    this.cachedGlobalStats = {
      tenantCount,
      totalMessages  : Number(messageStats.count),
      totalDataBytes : Number(dataStats.totalBytes) || 0,
      totalProtocols : Number(protocolStats.count),
    };
    this.cachedGlobalStatsTimestamp = now;

    return this.cachedGlobalStats;
  }

  // ---------------------------------------------------------------------------
  // Tenant data purge
  // ---------------------------------------------------------------------------

  /**
   * Deletes all DWN data for a tenant from every SQL table.
   * @returns The number of messages deleted.
   */
  public async purgeTenantData(did: string): Promise<number> {
    // Delete messages (cascades to tags via FK).
    const messageResult = await this.db
      .deleteFrom('messageStoreMessages')
      .where('tenant', '=', did)
      .executeTakeFirstOrThrow();

    // Delete data refs for this tenant and garbage-collect orphaned blocks.
    const tenantRefs = await this.db
      .selectFrom('dataRefs')
      .select('dataCid')
      .where('tenant', '=', did)
      .execute();

    await this.db
      .deleteFrom('dataRefs')
      .where('tenant', '=', did)
      .execute();

    // GC: delete blocks for dataCids that no longer have any refs.
    for (const ref of tenantRefs) {
      const remaining = await this.db
        .selectFrom('dataRefs')
        .select('dataCid')
        .where('dataCid', '=', ref.dataCid)
        .executeTakeFirst();

      if (!remaining) {
        await this.db
          .deleteFrom('dataBlocks')
          .where('rootDataCid', '=', ref.dataCid)
          .execute();
      }
    }

    // Delete derived replication fingerprints for the purged tenant. Keep the
    // tenant's replication counter so stale high-water cursors cannot skip rows
    // if the tenant is later repopulated.
    await this.db.deleteFrom('replicationFingerprints').where('tenant', '=', did).execute();

    // Invalidate cache.
    this.cachedGlobalStats = undefined;

    return Number(messageResult.numDeletedRows);
  }

  /**
   * Returns the number of suspended tenants from the registration table.
   * Returns 0 if the registration table doesn't exist.
   */
  public async getSuspendedTenantCount(): Promise<number> {
    try {
      const result = await this.db
        .selectFrom('registeredTenants' as any)
        .select(this.db.fn.countAll<number>().as('count'))
        .where('suspended' as any, '=', true)
        .executeTakeFirstOrThrow();

      return Number(result.count);
    } catch {
      return 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Tenant data browser
  // ---------------------------------------------------------------------------

  /**
   * Returns paginated message metadata for a single tenant.
   * Only returns metadata columns — never returns `encodedMessageBytes` (raw message content).
   */
  public async getTenantMessages(did: string, options?: {
    interface? : string;
    method? : string;
    protocol? : string;
    limit? : number;
    cursor? : number;
  }): Promise<{ messages: AdminMessageSummary[]; cursor?: number }> {
    const limit = Math.min(options?.limit ?? 20, 100);

    let query = this.db
      .selectFrom('messageStoreMessages')
      .select([
        'messageCid', 'interface', 'method', 'protocol', 'protocolPath',
        'schema', 'dataFormat', 'dataSize', 'dateCreated', 'messageTimestamp', 'id',
      ])
      .where('tenant', '=', did)
      .orderBy('id', 'desc')
      .limit(limit + 1);

    if (options?.cursor !== undefined) {
      query = query.where('id', '<', options.cursor);
    }

    if (options?.interface !== undefined) {
      query = query.where('interface', '=', options.interface);
    }

    if (options?.method !== undefined) {
      query = query.where('method', '=', options.method);
    }

    if (options?.protocol !== undefined) {
      query = query.where('protocol', '=', options.protocol);
    }

    const results = await query.execute();

    const messages: (AdminMessageSummary & { _id: number })[] = results.map((row): AdminMessageSummary & { _id: number } => ({
      _id              : Number(row.id),
      messageCid       : row.messageCid,
      interface        : row.interface,
      method           : row.method,
      protocol         : row.protocol,
      protocolPath     : row.protocolPath,
      schema           : row.schema,
      dataFormat       : row.dataFormat,
      dataSize         : row.dataSize === null ? null : Number(row.dataSize),
      dateCreated      : row.dateCreated,
      messageTimestamp : row.messageTimestamp,
    }));

    let cursor: number | undefined;
    if (messages.length > limit) {
      messages.pop();
      cursor = messages[messages.length - 1]._id;
    }

    // Strip internal _id before returning.
    const cleaned: AdminMessageSummary[] = messages.map(({ _id, ...rest }): AdminMessageSummary => rest);

    return { messages: cleaned, cursor };
  }

  /**
   * Returns per-protocol message counts for a tenant.
   */
  public async getTenantProtocolCounts(did: string): Promise<AdminProtocolSummary[]> {
    const results = await this.db
      .selectFrom('messageStoreMessages')
      .select([
        'protocol',
        this.db.fn.countAll<number>().as('messageCount'),
      ])
      .where('tenant', '=', did)
      .where('protocol', 'is not', null)
      .groupBy('protocol')
      .orderBy('messageCount', 'desc')
      .execute();

    return results.map((row): AdminProtocolSummary => ({
      protocol     : row.protocol!,
      messageCount : Number(row.messageCount),
    }));
  }

  /**
   * Exports all message metadata and data records for a tenant as an array.
   * Returns `{ messages, data, metadata }` for streaming/serialization.
   *
   * @see https://github.com/enboxorg/enbox/issues/391
   */
  public async exportTenantData(did: string): Promise<TenantExport> {
    const messages = await this.db
      .selectFrom('messageStoreMessages')
      .select([
        'messageCid', 'interface', 'method', 'recordId', 'protocol',
        'protocolPath', 'schema', 'author', 'recipient', 'messageTimestamp',
        'dateCreated', 'datePublished', 'published', 'dataFormat', 'dataCid', 'dataSize',
      ])
      .where('tenant', '=', did)
      .orderBy('id', 'asc')
      .execute();

    const dataRecords = await this.db
      .selectFrom('dataRefs')
      .select(['recordId', 'dataCid', 'dataSize'])
      .where('tenant', '=', did)
      .execute();

    return {
      metadata: {
        tenant          : did,
        exportedAt      : new Date().toISOString(),
        messageCount    : messages.length,
        dataRecordCount : dataRecords.length,
      },
      messages    : messages.map((m): Record<string, unknown> => ({ ...m })),
      dataRecords : dataRecords.map((d): Record<string, unknown> => ({
        recordId : d.recordId,
        dataCid  : d.dataCid,
        dataSize : Number(d.dataSize),
      })),
    };
  }

  /**
   * Closes the underlying database connection.
   */
  public async close(): Promise<void> {
    await this.db.destroy();
  }
}

// ---------------------------------------------------------------------------
// Kysely type definitions for the DWN SQL tables
// ---------------------------------------------------------------------------

interface MessageStoreMessages {
  id : number;
  tenant : string;
  messageCid : string;
  interface : string | null;
  method : string | null;
  recordId : string | null;
  protocol : string | null;
  protocolPath : string | null;
  schema : string | null;
  author : string | null;
  recipient : string | null;
  messageTimestamp : string | null;
  dateCreated : string | null;
  datePublished : string | null;
  published : boolean | null;
  dataFormat : string | null;
  dataCid : string | null;
  dataSize : number | null;
  encodedMessageBytes : Uint8Array;
}

interface DataRefsRow {
  tenant : string;
  recordId : string;
  dataCid : string;
  dataSize : number;
}

interface DataBlocksRow {
  rootDataCid : string;
  blockCid : string;
  data : Uint8Array;
}

interface ReplicationCounters {
  tenant : string;
  seq : number | string | bigint;
}

interface ReplicationFingerprints {
  tenant : string;
  scope : string;
  fingerprint : string;
}

interface AdminDatabase {
  messageStoreMessages : MessageStoreMessages;
  dataRefs : DataRefsRow;
  dataBlocks : DataBlocksRow;
  replicationCounters : ReplicationCounters;
  replicationFingerprints : ReplicationFingerprints;
}
