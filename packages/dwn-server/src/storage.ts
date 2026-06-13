import type { Dialect } from '@enbox/dwn-sql-store';
import type { DidResolver } from '@enbox/dids';
import type { DwnServerConfig } from './config.js';
import type {
  DataStore,
  DwnConfig,
  EventLog,
  MessageStore,
  ResumableTaskStore,
  StateIndex,
  TenantGate,
} from '@enbox/dwn-sdk-js';

import * as fs from 'fs';
import Cursor from 'pg-cursor';
import { createPool as MySQLCreatePool } from 'mysql2';
import pg from 'pg';

import { Kysely } from 'kysely';

import { createBunSqliteDatabase } from '@enbox/dwn-sql-store';
import { PluginLoader } from './plugin-loader.js';
import { runServerMigrations } from './server-migration-runner.js';

import {
  DataStoreLevel,
  MessageStoreLevel,
  ResumableTaskStoreLevel,
  StateIndexLevel,
} from '@enbox/dwn-sdk-js';
import {
  DataStoreSql,
  MessageStoreSql,
  MysqlDialect,
  PostgresDialect,
  ResumableTaskStoreSql,
  runDwnStoreMigrations,
  SqliteDialect,
  StateIndexSql,
} from '@enbox/dwn-sql-store';

export enum StoreType {
  DataStore,
  MessageStore,
  StateIndex,
  ResumableTaskStore,
}

export enum BackendTypes {
  LEVEL = 'level',
  SQLITE = 'sqlite',
  MYSQL = 'mysql',
  POSTGRES = 'postgres',
}

export type DwnStore = DataStore | StateIndex | MessageStore | ResumableTaskStore;

/**
 * Returns a (potentially cached) dialect for the given connection URL. For
 * Postgres, creates a pool with configurable sizing from the server config.
 * For other backends, delegates to `getDialectFromUrl()` which handles its
 * own caching (critical for in-memory SQLite).
 *
 * All Postgres dialects are cached in a separate map keyed by URL so that
 * multiple DWN stores sharing the same Postgres URL reuse a single
 * `pg.Pool`, reducing connection count from 4 × pool_max to 1 × pool_max.
 */
const postgresDialectCache: Map<string, Dialect> = new Map();

function getOrCreateDialect(connectionUrl: URL, config: DwnServerConfig): Dialect {
  const protocol = connectionUrl.protocol.slice(0, -1);

  if (protocol !== BackendTypes.POSTGRES) {
    // getDialectFromUrl handles its own caching for SQLite/MySQL.
    return getDialectFromUrl(connectionUrl);
  }

  const key = connectionUrl.toString();
  const cached = postgresDialectCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  // Create a single pg.Pool instance with configurable sizing.
  const pool = new pg.Pool({
    connectionString  : connectionUrl.toString(),
    min               : config.pgPoolMin,
    max               : config.pgPoolMax,
    idleTimeoutMillis : config.pgPoolIdleTimeout,
  });

  const dialect = new PostgresDialect({
    pool   : async (): Promise<pg.Pool> => pool,
    cursor : Cursor,
  });

  postgresDialectCache.set(key, dialect);
  return dialect;
}

export async function getDwnConfig(
  config : DwnServerConfig,
  options : {
    didResolver? : DidResolver,
    tenantGate? : TenantGate,
    eventLog? : EventLog,
  }
): Promise<DwnConfig> {
  const { tenantGate, eventLog, didResolver } = options;

  // Run SQL schema migrations before creating stores. Uses the data store
  // connection to determine the dialect — all SQL stores typically share the
  // same database. Non-SQL backends (level://) are skipped.
  await runSqlMigrationsIfNeeded(config);

  const dataStore: DataStore = await getStore(config, config.dataStore, StoreType.DataStore);
  const stateIndex: StateIndex = await getStore(config, config.stateIndex, StoreType.StateIndex);
  const messageStore: MessageStore = await getStore(config, config.messageStore, StoreType.MessageStore);
  const resumableTaskStore: ResumableTaskStore = await getStore(config, config.resumableTaskStore, StoreType.ResumableTaskStore);

  return { didResolver, eventLog, stateIndex, dataStore, messageStore, resumableTaskStore, tenantGate };
}

/**
 * Runs DWN SQL schema migrations if the data store is configured with a SQL
 * backend. Creates a temporary Kysely instance, runs all pending migrations,
 * then destroys it. The subsequent store `open()` calls will reuse the shared
 * dialect/pool and find the schema already in place.
 */
async function runSqlMigrationsIfNeeded(config: DwnServerConfig): Promise<void> {
  // Skip if the data store config is a file path (plugin) or non-SQL backend
  if (isFilePath(config.dataStore)) {
    return;
  }

  let storeUrl: URL;
  try {
    storeUrl = new URL(config.dataStore);
  } catch {
    return; // Not a valid URL — skip
  }

  const protocol = storeUrl.protocol.slice(0, -1);
  const sqlBackends: string[] = [BackendTypes.SQLITE, BackendTypes.MYSQL, BackendTypes.POSTGRES];
  if (!sqlBackends.includes(protocol)) {
    return;
  }

  const dialect = getOrCreateDialect(storeUrl, config);
  const db = new Kysely<Record<string, unknown>>({ dialect });
  try {
    const applied = await runDwnStoreMigrations(db, dialect);
    if (applied.length > 0) {
      console.log(`DWN migrations applied: ${applied.join(', ')}`);
    }
  } finally {
    // Do NOT destroy the Kysely instance — the dialect is cached and will be
    // reused by stores. For in-memory SQLite, destroying would close the
    // database and lose all migrated schema. For Postgres, the pool is shared.
  }
}

/**
 * Runs DWN server schema migrations (admin stores, registration, TTL cache)
 * if the given URL points to a SQL backend. Uses the `registrationStoreUrl`
 * (or the TTL cache URL) as the target database.
 *
 * Server migrations use a separate tracking table (`dwn_server_migration`)
 * so they do not conflict with the DWN store migrations.
 *
 * Call this once during server startup, before creating admin stores.
 *
 * @returns The dialect used for the target database (so the caller can reuse
 *          it for the TTL cache and admin stores), or `undefined` if no SQL
 *          backend was configured or needed.
 */
export async function runServerMigrationsIfNeeded(config: DwnServerConfig): Promise<Dialect | undefined> {
  const sqlBackends: string[] = [BackendTypes.SQLITE, BackendTypes.MYSQL, BackendTypes.POSTGRES];

  // Determine the target URL for server migrations. Prefer registrationStoreUrl
  // since admin stores and the TTL cache share that database. Fall back to
  // ttlCacheUrl when no registration store is configured (the cacheEntries
  // table still needs a schema).
  const targetUrl = config.registrationStoreUrl ?? config.ttlCacheUrl;
  if (!targetUrl) {
    return undefined;
  }

  if (isFilePath(targetUrl)) {
    return undefined;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    return undefined;
  }

  const protocol = parsedUrl.protocol.slice(0, -1);
  if (!sqlBackends.includes(protocol)) {
    return undefined;
  }

  // When both registrationStoreUrl and ttlCacheUrl are set and differ,
  // validate they point at the same database — the cacheEntries table is
  // included in the server migration so it must live alongside the other
  // server tables.
  if (config.registrationStoreUrl && config.ttlCacheUrl
    && config.ttlCacheUrl !== config.registrationStoreUrl) {
    let ttlUrl: URL | undefined;
    try {
      ttlUrl = new URL(config.ttlCacheUrl);
    } catch { /* not a URL */ }

    if (ttlUrl) {
      const ttlProtocol = ttlUrl.protocol.slice(0, -1);
      if (sqlBackends.includes(ttlProtocol)) {
        throw new Error(
          'DWN server misconfiguration: DWN_TTL_CACHE_URL must point to the same database as ' +
          'DWN_REGISTRATION_STORE_URL (or DWN_STORAGE) because the cacheEntries table is managed ' +
          'by the server migration system. ' +
          `Got registrationStoreUrl="${config.registrationStoreUrl}", ttlCacheUrl="${config.ttlCacheUrl}".`
        );
      }
    }
  }

  const dialect = getOrCreateDialect(parsedUrl, config);
  const db = new Kysely<Record<string, unknown>>({ dialect });
  try {
    const applied = await runServerMigrations(db, dialect);
    if (applied.length > 0) {
      console.log(`Server migrations applied: ${applied.join(', ')}`);
    }
  } finally {
    // For Postgres, don't destroy — the pool is cached in sharedDialectCache.
    // For SQLite/MySQL, we also keep the Kysely instance alive so the caller
    // can reuse the same dialect (critical for in-memory SQLite).
    if (protocol === BackendTypes.POSTGRES) {
      // Pool stays alive via sharedDialectCache.
    }
    // NOTE: We intentionally do NOT destroy the Kysely instance for any
    // backend. The dialect is returned to the caller for reuse (e.g. by the
    // TTL cache and admin stores). For in-memory SQLite, destroying would
    // lose the database.
  }

  return dialect;
}

function getLevelStore(
  storeURI: URL,
  storeType: StoreType,
): DwnStore {
  switch (storeType) {
    case StoreType.DataStore:
      return new DataStoreLevel({
        blockstoreLocation: storeURI.host + storeURI.pathname + '/DATASTORE',
      });
    case StoreType.MessageStore:
      return new MessageStoreLevel({
        location: storeURI.host + storeURI.pathname + '/MESSAGESTORE',
      });
    case StoreType.StateIndex:
      return new StateIndexLevel({
        location: storeURI.host + storeURI.pathname + '/STATEINDEX',
      });
    case StoreType.ResumableTaskStore:
      return new ResumableTaskStoreLevel({
        location: storeURI.host + storeURI.pathname + '/RESUMABLE-TASK-STORE',
      });
    default:
      throw new Error('Unexpected level store type');
  }
}

function getSqlStore(
  config: DwnServerConfig,
  connectionUrl: URL,
  storeType: StoreType,
): DwnStore {
  const dialect = getOrCreateDialect(connectionUrl, config);

  switch (storeType) {
    case StoreType.DataStore:
      return new DataStoreSql(dialect);
    case StoreType.MessageStore:
      return new MessageStoreSql(dialect);
    case StoreType.StateIndex:
      return new StateIndexSql(dialect);
    case StoreType.ResumableTaskStore:
      return new ResumableTaskStoreSql(dialect);
    default:
      throw new Error(`Unsupported store type ${storeType} for SQL store.`);
  }
}

/**
 * Check if the given string is a file path.
 */
function isFilePath(configString: string): boolean {
  const filePathPrefixes = ['/', './', '../'];
  return filePathPrefixes.some(prefix => configString.startsWith(prefix));
}

async function getStore(config: DwnServerConfig, storeString: string, storeType: StoreType.DataStore): Promise<DataStore>;
async function getStore(config: DwnServerConfig, storeString: string, storeType: StoreType.StateIndex): Promise<StateIndex>;
async function getStore(config: DwnServerConfig, storeString: string, storeType: StoreType.MessageStore): Promise<MessageStore>;
async function getStore(config: DwnServerConfig, storeString: string, storeType: StoreType.ResumableTaskStore): Promise<ResumableTaskStore>;
async function getStore(config: DwnServerConfig, storeConfigString: string, storeType: StoreType): Promise<DwnStore> {
  if (isFilePath(storeConfigString)) {
    return await loadStoreFromFilePath(storeConfigString, storeType);
  }
  // else treat the `storeConfigString` as a connection string

  const storeURI = new URL(storeConfigString);

  switch (storeURI.protocol.slice(0, -1)) {
    case BackendTypes.LEVEL:
      return getLevelStore(storeURI, storeType);

    case BackendTypes.SQLITE:
    case BackendTypes.MYSQL:
    case BackendTypes.POSTGRES:
      return getSqlStore(config, storeURI, storeType);

    default:
      throw invalidStorageSchemeMessage(storeURI.protocol);
  }
}

/**
 * Loads a DWN store plugin of the given type from the given file path.
 */
async function loadStoreFromFilePath(
  filePath: string,
  storeType: StoreType,
): Promise<DwnStore> {
  switch (storeType) {
    case StoreType.DataStore:
      return await PluginLoader.loadPlugin<DataStore>(filePath);
    case StoreType.StateIndex:
      return await PluginLoader.loadPlugin<StateIndex>(filePath);
    case StoreType.MessageStore:
      return await PluginLoader.loadPlugin<MessageStore>(filePath);
    case StoreType.ResumableTaskStore:
      return await PluginLoader.loadPlugin<ResumableTaskStore>(filePath);
    default:
      throw new Error(`Loading store for unsupported store type ${storeType} from path ${filePath}`);
  }
}

/**
 * Cache for the in-memory SQLite dialect. Since every call to
 * `createBunSqliteDatabase(':memory:')` creates a separate, empty database,
 * we must ensure that `getDialectFromUrl(new URL('sqlite://'))` always
 * returns the same dialect (and thus the same underlying database) within a
 * process. This is critical for the DWN server startup flow where migrations,
 * the registration store, and the TTL cache all need to share the same
 * in-memory database.
 *
 * File-based SQLite and other backends are NOT cached here — file-based SQLite
 * connections naturally share state through the filesystem, and caching would
 * break test isolation when multiple test files run in the same process.
 */
let inMemorySqliteDialect: Dialect | undefined;

export function getDialectFromUrl(connectionUrl: URL): Dialect {
  switch (connectionUrl.protocol.slice(0, -1)) {
    case BackendTypes.SQLITE: {
      const path = connectionUrl.host + connectionUrl.pathname;
      console.log('SQL-lite relative path:', path ? path : undefined); // NOTE, using ? for lose equality comparison

      if (connectionUrl.host && !fs.existsSync(connectionUrl.host)) {
        console.log('SQL-lite directory does not exist, creating:', connectionUrl.host);
        fs.mkdirSync(connectionUrl.host, { recursive: true });
      }

      // Use in-memory database if no path is provided (for tests).
      const dbPath = path || ':memory:';

      // For in-memory SQLite, return a cached dialect so that all callers
      // (migrations, registration store, TTL cache) share the same database.
      // The wrapper makes close() a no-op so that individual consumers (e.g.
      // DwnServer.stop() → Dwn.close() → store.close()) cannot destroy the
      // shared database out from under other consumers.
      if (dbPath === ':memory:') {
        if (inMemorySqliteDialect === undefined) {
          const sharedDb = createBunSqliteDatabase(':memory:');
          const nonCloseableDb = {
            close(): void {
              // no-op — shared instance must survive the process
            },
            prepare(sql: string): ReturnType<typeof sharedDb.prepare> {
              return sharedDb.prepare(sql);
            },
          };
          inMemorySqliteDialect = new SqliteDialect({
            database: async (): Promise<typeof nonCloseableDb> => nonCloseableDb,
          });
        }
        return inMemorySqliteDialect;
      }

      return new SqliteDialect({
        database: async () => createBunSqliteDatabase(dbPath),
      });
    }
    case BackendTypes.MYSQL:
      return new MysqlDialect({
        pool: async () => MySQLCreatePool(connectionUrl.toString()),
      });
    case BackendTypes.POSTGRES:
      return new PostgresDialect({
        pool   : async () => new pg.Pool({ connectionString: connectionUrl.toString() }),
        cursor : Cursor,
      });
    default:
      throw new Error(`Unsupported database protocol: ${connectionUrl.protocol}`);
  }
}

function invalidStorageSchemeMessage(protocol: string): string {
  const schemes = [];
  for (const [_, value] of Object.entries(BackendTypes)) {
    schemes.push(value);
  }
  return (
    'Unknown storage protocol ' +
    protocol.slice(0, -1) +
    '! Please use one of: ' +
    schemes.join(', ') +
    '. For details, see README'
  );
}
