import type { Dialect } from '@enbox/dwn-sql-store';
import { Kysely, sql } from 'kysely';

/**
 * The SqlTtlCache is responsible for storing and retrieving cache data with TTL (Time-to-Live).
 */
export class SqlTtlCache {
  private static readonly cacheTableName = 'cacheEntries';
  private static readonly cleanupIntervalInSeconds = 60;

  private readonly db: Kysely<CacheDatabase>;
  private cleanupTimer: NodeJS.Timeout;

  private constructor(sqlDialect: Dialect) {
    this.db = new Kysely<CacheDatabase>({ dialect: sqlDialect });
  }

  /**
   * Creates a new SqlTtlCache instance.
   */
  public static async create(sqlDialect: Dialect): Promise<SqlTtlCache> {
    const cacheManager = new SqlTtlCache(sqlDialect);

    await cacheManager.initialize();

    return cacheManager;
  }

  /**
   * Verifies that the required table exists and starts the cleanup timer.
   * Throws a clear error directing the caller to run server migrations first.
   */
  private async initialize(): Promise<void> {
    try {
      await sql`SELECT 1 FROM ${sql.table(SqlTtlCache.cacheTableName)} LIMIT 0`.execute(this.db);
    } catch {
      throw new Error(
        `SqlTtlCache: table '${SqlTtlCache.cacheTableName}' does not exist. Run server migrations before starting.`
      );
    }

    // Start the cleanup timer
    this.startCleanupTimer();
  }

  /**
   * Starts a timer to periodically clean up expired cache entries.
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(async () => {
      await this.cleanUpExpiredEntries();
    }, SqlTtlCache.cleanupIntervalInSeconds * 1000);
  }

  /**
   * Inserts a cache entry.
   * @param ttl The time-to-live in seconds.
   */
  public async insert(key: string, value: object, ttl: number): Promise<void> {
    const expiry = Date.now() + (ttl * 1000);

    const objectString = JSON.stringify(value);

    await this.db
      .insertInto(SqlTtlCache.cacheTableName)
      .values({ key, value: objectString, expiry })
      .execute();
  }

  /**
   * Inserts a cache entry only when the key is unused.
   *
   * The primary-key constraint is the serialization point, so concurrent
   * callers have exactly one winner on every supported SQL dialect.
   */
  public async insertIfAbsent(key: string, value: object, ttl: number): Promise<boolean> {
    const now = Date.now();
    const expiry = now + (ttl * 1000);
    const objectString = JSON.stringify(value);

    await this.db
      .deleteFrom(SqlTtlCache.cacheTableName)
      .where('key', '=', key)
      .where('expiry', '<=', now)
      .execute();

    try {
      await this.db
        .insertInto(SqlTtlCache.cacheTableName)
        .values({ key, value: objectString, expiry })
        .execute();
      return true;
    } catch (error) {
      // Do not mistake an operational database failure for a uniqueness
      // conflict. A conflicting row must still be readable before this can
      // be reported as a lost race.
      if (await this.get(key) !== undefined) {
        return false;
      }

      throw error;
    }
  }

  /**
   * Retrieves a cache entry if it is not expired and cleans up expired entries.
   */
  public async get(key: string): Promise<object | undefined> {
    const result = await this.db
      .selectFrom(SqlTtlCache.cacheTableName)
      .select('key')
      .select('value')
      .select('expiry')
      .where('key', '=', key)
      .execute();

    if (result.length === 0) {
      return undefined;
    }

    const entry = result[0];

    // if the entry is expired, don't return it and delete it
    const expiry = typeof entry.expiry === 'string' ? Number.parseInt(entry.expiry, 10) : entry.expiry;
    if (Date.now() >= expiry) {
      this.delete(key); // no need to await
      return undefined;
    }

    try {
      return JSON.parse(entry.value);
    } catch {
      // Corrupt entry — remove it and return undefined.
      this.delete(key); // no need to await
      return undefined;
    }
  }

  /**
   * Deletes a cache entry.
   */
  public async delete(key: string): Promise<void> {
    await this.db
      .deleteFrom(SqlTtlCache.cacheTableName)
      .where('key', '=', key)
      .execute();
  }

  /**
   * Cleans up expired cache entries.
   */
  public async cleanUpExpiredEntries(): Promise<void> {
    await this.db
      .deleteFrom(SqlTtlCache.cacheTableName)
      .where('expiry', '<', Date.now())
      .execute();
  }

  /**
   * Stops the background cleanup timer. The underlying database connection is
   * NOT destroyed here because the dialect is shared with other components
   * (e.g. DWN stores, registration store) and its lifecycle is managed by the
   * dialect owner.
   */
  public close(): void {
    clearInterval(this.cleanupTimer);
  }
}

interface CacheEntry {
  key: string;
  value: string;
  expiry: number | string; // bigint is returned as string by PostgreSQL driver
}

interface CacheDatabase {
  cacheEntries: CacheEntry;
}
